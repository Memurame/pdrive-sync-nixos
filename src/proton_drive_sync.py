#!/usr/bin/env python3
"""proton-drive-sync: periodic two-way sync between local folders and Proton Drive.

Uses the official Proton Drive CLI (`proton-drive`) for all remote operations. Every run is a
three-way comparison between the local tree, the remote tree and the snapshot
saved after the previous successful run. Nothing watches the filesystem; the
program is meant to be started on an interval (systemd timer).
"""

from __future__ import annotations

import argparse
import fcntl
import fnmatch
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

STATE_VERSION = 1
CHECKPOINT_SECONDS = 20  # save progress at least this often during a long run
# Replaced with the package version at build time (package.nix); "dev" when run from source.
__version__ = "@VERSION@"
VERSION = "dev" if __version__.startswith("@") else __version__
DEFAULT_EXCLUDES = [
    ".proton-sync-*",
    "*.part",
    "*.tmp",
    "*.swp",
    "*~",
    ".~lock.*#",
    "~$*",
    ".DS_Store",
    "Thumbs.db",
]

EXIT_AUTH = 2
EXIT_NOT_FOUND = 3
EXIT_CONFLICT = 4
EXIT_NETWORK = 5


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def log(msg: str) -> None:
    print(msg, flush=True)


def warn(msg: str) -> None:
    print(f"WARN: {msg}", file=sys.stderr, flush=True)


def xdg(var: str, default: str) -> Path:
    return Path(os.environ.get(var) or os.path.expanduser(default))


def rjoin(*parts: str) -> str:
    """Join remote path parts into an absolute POSIX path."""
    p = PurePosixPath("/")
    for part in parts:
        if part:
            p = p / part.strip("/")
    return str(p)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def conflict_name(rel: str) -> str:
    p = PurePosixPath(rel)
    stamp = time.strftime("%Y-%m-%d_%H%M%S")
    host = socket.gethostname()
    new = f"{p.stem} (Konflikt {host} {stamp}){p.suffix}"
    return str(p.with_name(new))

class ProtonError(Exception):
    def __init__(self, code: int, msg: str):
        super().__init__(msg)
        self.code = code


# --------------------------------------------------------------------------- #
# proton-drive CLI wrapper (offizielles Proton Drive CLI)
# --------------------------------------------------------------------------- #

# Top-level sections of the official CLI. Remote paths in the config may omit
# the leading /my-files; everything else is treated as relative to it.
ROOT_SECTIONS = ("my-files", "devices", "shared-with-me")

_AUTH_HINTS = ("need to login", "not logged in", "login first", "session expired", "unauthorized")
_NOT_FOUND_HINTS = ("not found", "nicht gefunden", "existiert nicht")
_EXISTS_HINTS = ("already exists", "same name", "existiert bereits")
_NETWORK_HINTS = ("rate limit", "zu viele anfragen", "verbindung", "netzwerk", "too many requests", "connection", "network", "timeout",
                  "timed out", "econnreset", "socket", "503", "502", "504")


def classify_error(msg: str) -> int:
    m = msg.lower()
    if any(h in m for h in _AUTH_HINTS):
        return EXIT_AUTH
    if any(h in m for h in _NOT_FOUND_HINTS):
        return EXIT_NOT_FOUND
    if any(h in m for h in _EXISTS_HINTS):
        return EXIT_CONFLICT
    if any(h in m for h in _NETWORK_HINTS):
        return EXIT_NETWORK
    return 1


def to_cli_path(path: str) -> str:
    """'/Dokumente' -> '/my-files/Dokumente'; '/my-files/...' stays as is."""
    p = PurePosixPath(rjoin(path))
    if len(p.parts) > 1 and p.parts[1] in ROOT_SECTIONS:
        return str(p)
    return str(PurePosixPath("/my-files") / p.relative_to("/"))


class Proton:
    def __init__(self, binary: str, dry_run: bool):
        self.binary = binary
        self.dry_run = dry_run

    def run(self, args: list[str], mutating: bool = True, retries: int = 3):
        """Run `proton-drive <args> --json` and return the parsed JSON (or None)."""
        if mutating and self.dry_run:
            log(f"  [dry-run] proton-drive {' '.join(args)}")
            return None
        cmd = [self.binary, *args, "--json"]
        delay = 5
        for attempt in range(retries):
            proc = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL)
            out = proc.stdout.strip()
            if proc.returncode == 0:
                try:
                    return json.loads(out) if out else None
                except json.JSONDecodeError:
                    return out
            err = (proc.stderr.strip() or out or f"exit {proc.returncode}").splitlines()[-1]
            code = classify_error(proc.stderr + "\n" + out)
            if code in (EXIT_NETWORK, EXIT_AUTH) and attempt + 1 < retries:
                # "need to login" also shows up when the keyring entry is briefly
                # unreadable (e.g. while the previous call rewrites the rotated
                # session) – so retry before treating it as logged out.
                reason = "Netzwerk/Rate-Limit" if code == EXIT_NETWORK else "Sitzung nicht lesbar"
                warn(f"{reason} ({err}); neuer Versuch in {delay}s")
                time.sleep(delay)
                delay *= 3
                continue
            raise ProtonError(code, f"proton-drive {' '.join(args)}: {err}")
        raise AssertionError("unreachable")

    # -- listing ------------------------------------------------------------ #

    def list_folder(self, path: str) -> list[dict]:
        data = self.run(["filesystem", "list", to_cli_path(path)], mutating=False)
        return data if isinstance(data, list) else []

    def child_names(self, cli_path: str) -> dict[str, str]:
        """name -> type of the direct children of a folder (path already in CLI form)."""
        data = self.run(["filesystem", "list", cli_path], mutating=False)
        out = {}
        for item in data if isinstance(data, list) else []:
            name = item.get("name")
            if isinstance(name, dict):
                name = name.get("value") if name.get("ok") else None
            if name and not item.get("trashTime"):
                out[name] = item.get("type")
        return out

    # Proton's error texts follow the account language, so existence is checked
    # by listing the parent instead of parsing error messages.

    def exists(self, path: str) -> bool:
        p = PurePosixPath(to_cli_path(path))
        if len(p.parts) <= 2:  # /my-files itself
            return True
        if not self.exists(str(p.parent)):
            return False
        return p.name in self.child_names(str(p.parent))

    # -- mutations ---------------------------------------------------------- #

    def mkdir(self, path: str) -> None:
        """Create the folder and any missing parents (like mkdir -p)."""
        p = PurePosixPath(to_cli_path(path))
        parent_known_new = False
        for i in range(3, len(p.parts) + 1):  # parts[0]='/', parts[1]='my-files'
            parent, name = str(PurePosixPath(*p.parts[:i - 1])), p.parts[i - 1]
            if not parent_known_new and not self.dry_run:
                kind = self.child_names(parent).get(name)
                if kind == "folder":
                    continue
                if kind is not None:
                    raise ProtonError(EXIT_CONFLICT, f"{parent}/{name} existiert, ist aber kein Ordner")
            self.run(["filesystem", "create-folder", parent, name])
            parent_known_new = True

    def upload(self, local: Path, remote_dir: str) -> None:
        self.run(["filesystem", "upload", "--file-conflict-strategy", "create-new-revision",
                  "--folder-conflict-strategy", "merge", str(local), to_cli_path(remote_dir)])

    def download(self, remote: str, dest: Path) -> None:
        """Download one remote file to exactly `dest`."""
        with tempfile.TemporaryDirectory(prefix=".proton-sync-", dir=dest.parent) as td:
            self.run(["filesystem", "download", "--file-conflict-strategy", "remove",
                      to_cli_path(remote), td], mutating=False)
            got = [Path(td) / n for n in os.listdir(td)]
            if len(got) != 1 or not got[0].is_file():
                raise ProtonError(1, f"Download von {remote} lieferte keine Datei")
            os.replace(got[0], dest)

    def trash(self, remote: str) -> None:
        results = self.run(["filesystem", "trash", to_cli_path(remote)])
        for r in results or []:
            if isinstance(r, dict) and r.get("ok") is False:
                err = r.get("error")
                msg = err.get("message") if isinstance(err, dict) else str(err)
                raise ProtonError(classify_error(msg or ""), f"trash {remote}: {msg}")


@dataclass
class RemoteEntry:
    is_dir: bool
    size: int
    fp: str  # fingerprint, changes whenever the remote file changes


def normalize_remote(item: dict) -> tuple[str, RemoteEntry] | None:
    """Turn a NodeEntity from `filesystem list --json` into (name, RemoteEntry)."""
    name = item.get("name")
    if isinstance(name, dict):
        name = name.get("value") if name.get("ok") else None
    if not name or item.get("trashTime"):
        return None
    if str(item.get("mediaType") or "").startswith("application/vnd.proton."):
        return None  # Proton Docs/Sheets exist only online and cannot be downloaded
    kind = item.get("type")
    if kind == "folder":
        return name, RemoteEntry(is_dir=True, size=0, fp=f"uid={item.get('uid')}")
    if kind != "file":
        return None  # Proton Docs/Sheets, albums, ... are not synced
    rev = item.get("activeRevision") or {}
    size = int(rev.get("claimedSize") or 0)
    # The active revision UID changes with every new upload of the file.
    fp = f"rev={rev.get('uid')};size={size}" if rev.get("uid") else \
        f"uid={item.get('uid')};mtime={item.get('modificationTime')};size={size}"
    return name, RemoteEntry(is_dir=False, size=size, fp=fp)


# --------------------------------------------------------------------------- #
# scanning
# --------------------------------------------------------------------------- #

class Excluder:
    def __init__(self, patterns: list[str]):
        self.patterns = patterns

    def __call__(self, rel: str) -> bool:
        name = PurePosixPath(rel).name
        return any(fnmatch.fnmatch(name, p) or fnmatch.fnmatch(rel, p) for p in self.patterns)


def scan_local(root: Path, excluded: Excluder) -> tuple[dict[str, dict], set[str]]:
    files: dict[str, dict] = {}
    dirs: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(root):
        base = Path(dirpath)
        rel_base = base.relative_to(root).as_posix()
        rel_base = "" if rel_base == "." else rel_base
        keep = []
        for d in dirnames:
            rel = f"{rel_base}/{d}" if rel_base else d
            if (base / d).is_symlink() or excluded(rel):
                continue
            keep.append(d)
            dirs.add(rel)
        dirnames[:] = keep
        for fn in filenames:
            rel = f"{rel_base}/{fn}" if rel_base else fn
            p = base / fn
            if excluded(rel) or p.is_symlink():
                continue
            try:
                st = p.stat()
            except FileNotFoundError:
                continue
            files[rel] = {"size": st.st_size, "mtime": st.st_mtime_ns}
    return files, dirs


def scan_remote(proton: Proton, root: str, excluded: Excluder
                ) -> tuple[dict[str, RemoteEntry], set[str]]:
    files: dict[str, RemoteEntry] = {}
    dirs: set[str] = set()
    queue = [""]
    while queue:
        rel_dir = queue.pop()
        for item in proton.list_folder(rjoin(root, rel_dir)):
            norm = normalize_remote(item)
            if not norm:
                continue
            name, entry = norm
            rel = f"{rel_dir}/{name}" if rel_dir else name
            if excluded(rel):
                continue
            if entry.is_dir:
                dirs.add(rel)
                queue.append(rel)
            else:
                files[rel] = entry
    return files, dirs


# --------------------------------------------------------------------------- #
# state
# --------------------------------------------------------------------------- #

@dataclass
class State:
    path: Path
    files: dict[str, dict] = field(default_factory=dict)  # rel -> {local:{size,mtime}, remote_fp}
    dirs: set[str] = field(default_factory=set)

    @classmethod
    def load(cls, path: Path) -> "State":
        if not path.exists():
            return cls(path)
        data = json.loads(path.read_text())
        if data.get("version") != STATE_VERSION:
            warn(f"state {path} has unknown version, starting fresh")
            return cls(path)
        return cls(path, data.get("files", {}), set(data.get("dirs", [])))

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(
            {"version": STATE_VERSION, "files": self.files, "dirs": sorted(self.dirs)},
            indent=1, sort_keys=True))
        os.replace(tmp, self.path)


# --------------------------------------------------------------------------- #
# sync
# --------------------------------------------------------------------------- #

@dataclass
class Pair:
    name: str
    local: Path
    remote: str
    exclude: list[str]


class Syncer:
    def __init__(self, pair: Pair, proton: Proton, state_dir: Path, trash_dir: Path,
                 max_deletes: int, force: bool, dry_run: bool):
        self.pair = pair
        self.proton = proton
        self.state = State.load(state_dir / f"{pair.name}.json")
        self.trash_dir = trash_dir / pair.name
        self.max_deletes = max_deletes
        self.force = force
        self.dry_run = dry_run
        self.excluded = Excluder(DEFAULT_EXCLUDES + pair.exclude)
        self.stats = {"up": 0, "down": 0, "del_remote": 0, "del_local": 0, "conflict": 0, "error": 0}
        self.activity: Activity | None = None

    def report(self, action: str, rel: str, message: str | None = None) -> None:
        """Record a change for the tray / activity window."""
        if self.activity and not self.dry_run:
            self.activity.event(self.pair.name, action, rel, str(self.lpath(rel)), message)

    def local_dirty(self) -> bool:
        """True if the local tree differs from what the last sync left behind.

        Cheap (no network). The watcher uses it to ignore filesystem events that
        were caused by our own downloads/renames.
        """
        if not self.pair.local.is_dir():
            return True
        files, dirs = scan_local(self.pair.local, self.excluded)
        known = {rel: e.get("local") for rel, e in self.state.files.items()}
        return files != known or dirs != self.state.dirs

    # -- primitive operations ---------------------------------------------- #

    def lpath(self, rel: str) -> Path:
        return self.pair.local / rel

    def rpath(self, rel: str) -> str:
        return rjoin(self.pair.remote, rel)

    def rparent(self, rel: str) -> str:
        return rjoin(self.pair.remote, str(PurePosixPath(rel).parent) if "/" in rel else "")

    def ensure_remote_dir(self, rel_dir: str, remote_dirs: set[str]) -> None:
        if not rel_dir or rel_dir in remote_dirs:
            return
        log(f"  mkdir remote  {rel_dir}/")
        self.proton.mkdir(self.rpath(rel_dir))
        # create marks every ancestor too
        p = PurePosixPath(rel_dir)
        while str(p) not in ("", "."):
            remote_dirs.add(str(p))
            p = p.parent

    def upload(self, rel: str, remote_dirs: set[str]) -> None:
        parent = str(PurePosixPath(rel).parent) if "/" in rel else ""
        self.ensure_remote_dir(parent, remote_dirs)
        log(f"  upload  ↑     {rel}")
        self.proton.upload(self.lpath(rel), self.rparent(rel))
        self.stats["up"] += 1
        self.report("up", rel)

    def download(self, rel: str) -> None:
        log(f"  download ↓    {rel}")
        if self.dry_run:
            self.stats["down"] += 1
            return
        target = self.lpath(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".proton-sync-", suffix=".part", dir=target.parent)
        os.close(fd)
        try:
            self.proton.download(self.rpath(rel), Path(tmp))
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        self.stats["down"] += 1
        self.report("down", rel)

    def trash_local(self, rel: str) -> None:
        log(f"  delete local  {rel}  (→ {self.trash_dir})")
        self.stats["del_local"] += 1
        if self.dry_run:
            return
        src = self.lpath(rel)
        dest = self.trash_dir / time.strftime("%Y-%m-%d") / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            dest = dest.with_name(f"{dest.name}.{int(time.time())}")
        shutil.move(str(src), str(dest))
        self.report("del_local", rel, f"verschoben nach {dest}")

    def trash_remote(self, rel: str) -> None:
        log(f"  delete remote {rel}  (→ Proton-Papierkorb)")
        self.proton.trash(self.rpath(rel))
        self.stats["del_remote"] += 1
        self.report("del_remote", rel, "im Proton-Papierkorb")

    def same_content(self, rel: str) -> bool:
        """Download the remote copy to a temp file and compare it byte-for-byte."""
        with tempfile.TemporaryDirectory(prefix="proton-sync-") as td:
            tmp = Path(td) / "cmp"
            self.proton.download(self.rpath(rel), tmp)
            return sha256_file(tmp) == sha256_file(self.lpath(rel))

    # -- main algorithm ----------------------------------------------------- #

    def run(self) -> bool:
        pair = self.pair
        log(f"== {pair.name}: {pair.local} ⇄ proton:{pair.remote}")
        if not pair.local.is_dir():
            if self.state.files:
                warn(f"{pair.local} fehlt, obwohl schon synchronisiert wurde – überspringe "
                     "(Laufwerk nicht eingehängt?)")
                return False
            log(f"  lege {pair.local} an")
            if not self.dry_run:
                pair.local.mkdir(parents=True)

        if not self.proton.exists(pair.remote):
            if self.state.files:
                warn(f"proton:{pair.remote} fehlt, obwohl schon synchronisiert wurde – überspringe")
                return False
            log(f"  lege proton:{pair.remote} an")
            self.proton.mkdir(pair.remote)
            remote_files, remote_dirs = {}, set()
        else:
            remote_files, remote_dirs = scan_remote(self.proton, pair.remote, self.excluded)
        local_files, local_dirs = (scan_local(pair.local, self.excluded)
                                   if pair.local.is_dir() else ({}, set()))
        old = self.state.files

        plan: list[tuple[str, str]] = []
        for rel in sorted(set(local_files) | set(remote_files) | set(old)):
            l, r, s = local_files.get(rel), remote_files.get(rel), old.get(rel)
            l_changed = l is not None and (s is None or l != s["local"])
            # remote_fp None = we uploaded it but never learned the new revision
            # (run was interrupted); an unchanged local file means remote is ours.
            r_changed = r is not None and (s is None or (s["remote_fp"] is not None
                                                        and r.fp != s["remote_fp"]))
            if rel in remote_dirs and l is not None or rel in local_dirs and r is not None:
                warn(f"{rel}: Datei auf der einen, Ordner auf der anderen Seite – übersprungen")
                continue
            if l and r:
                if s is None:
                    plan.append(("first_both", rel))
                elif l_changed and r_changed:
                    plan.append(("conflict", rel))
                elif l_changed:
                    plan.append(("up", rel))
                elif r_changed:
                    plan.append(("down", rel))
                else:
                    plan.append(("noop", rel))
            elif l and not r:
                if s is None or l_changed:
                    plan.append(("up", rel))  # new, or deleted remotely but edited locally
                else:
                    plan.append(("del_local", rel))
            elif r and not l:
                if s is None or r_changed:
                    plan.append(("down", rel))
                else:
                    plan.append(("del_remote", rel))
            else:
                plan.append(("forget", rel))

        deletes = sum(1 for a, _ in plan if a in ("del_local", "del_remote"))
        if deletes > self.max_deletes and not self.force:
            warn(f"{pair.name}: {deletes} Löschungen geplant (Limit {self.max_deletes}). "
                 "Abbruch zum Schutz – prüfe mit --dry-run und starte ggf. mit --force.")
            return False

        new_files: dict[str, dict] = {}
        touched_remote: set[str] = set()
        ok = True

        def checkpoint(next_index: int, refresh: bool = False) -> None:
            """Persist progress so an interrupted run does not start over.

            Done items get their new entry, items not processed yet keep their
            old one. Uploaded files whose new remote revision is not known yet
            are stored with remote_fp None (treated as in sync next run).
            """
            if self.dry_run:
                return
            files = dict(new_files)
            for _, rest in plan[next_index:]:
                if rest in old and rest not in files:
                    files[rest] = old[rest]
            if refresh:
                try:
                    self.refresh_remote_fps(files, touched_remote)
                except ProtonError:
                    pass
            files.update(getattr(self, "_extra", {}))
            self.state.files = files
            self.state.save()

        last_save = time.monotonic()
        for i, (action, rel) in enumerate(plan):
            try:
                kept = self.apply(action, rel, local_files, remote_files, remote_dirs,
                                  touched_remote)
                if kept:
                    new_files[rel] = kept
                if action != "noop" and time.monotonic() - last_save > CHECKPOINT_SECONDS:
                    checkpoint(i + 1)
                    last_save = time.monotonic()
            except (KeyboardInterrupt, SystemExit):
                checkpoint(i)  # stopped (e.g. systemctl stop / restart on rebuild)
                raise
            except (ProtonError, OSError) as e:
                if isinstance(e, ProtonError) and e.code == EXIT_AUTH:
                    checkpoint(i, refresh=True)
                    raise
                warn(f"{rel}: {e}")
                self.stats["error"] += 1
                self.report("error", rel, str(e))
                ok = False
                if rel in old:
                    new_files[rel] = old[rel]  # keep previous knowledge, retry next run

        # Directories: create missing ones, propagate deleted empty ones.
        new_dirs = self.sync_dirs(local_dirs, remote_dirs, new_files)

        if not self.dry_run:
            self.refresh_remote_fps(new_files, touched_remote)
            self.state.files = new_files
            self.state.dirs = new_dirs
            self.state.save()
        s = self.stats
        log(f"   fertig: ↑{s['up']} ↓{s['down']}  gelöscht lokal {s['del_local']} / "
            f"remote {s['del_remote']}  Konflikte {s['conflict']}  Fehler {s['error']}")
        return ok

    def local_snapshot(self, rel: str) -> dict:
        st = self.lpath(rel).stat()
        return {"size": st.st_size, "mtime": st.st_mtime_ns}

    def apply(self, action, rel, local_files, remote_files, remote_dirs, touched_remote):
        """Execute one plan step; return the new state entry or None to drop it."""
        if action == "noop":
            return {"local": self.state.files[rel]["local"], "remote_fp": remote_files[rel].fp}
        if action == "forget":
            return None
        if action == "up":
            self.upload(rel, remote_dirs)
            touched_remote.add(rel)
            return None if self.dry_run else {"local": self.local_snapshot(rel), "remote_fp": None}
        if action == "down":
            self.download(rel)
            if self.dry_run:
                return None
            return {"local": self.local_snapshot(rel), "remote_fp": remote_files[rel].fp}
        if action == "del_local":
            self.trash_local(rel)
            return None
        if action == "del_remote":
            self.trash_remote(rel)
            return None
        if action == "first_both":
            if local_files[rel]["size"] == remote_files[rel].size and \
                    (self.dry_run or self.same_content(rel)):
                log(f"  identisch     {rel}")
                if self.dry_run:
                    return None
                return {"local": self.local_snapshot(rel), "remote_fp": remote_files[rel].fp}
            action = "conflict"
        if action == "conflict":
            # Keep both: local version gets renamed and uploaded, remote version wins the name.
            cname = conflict_name(rel)
            log(f"  KONFLIKT      {rel}  → lokale Version als {cname}")
            self.stats["conflict"] += 1
            self.report("conflict", rel, f"lokale Version gespeichert als {PurePosixPath(cname).name}")
            if not self.dry_run:
                os.rename(self.lpath(rel), self.lpath(cname))
            self.download(rel)
            self.upload(cname, remote_dirs)
            touched_remote.add(cname)
            if self.dry_run:
                return None
            # the conflict copy is tracked too, so it isn't re-uploaded next time
            self._extra = getattr(self, "_extra", {})
            self._extra[cname] = {"local": self.local_snapshot(cname), "remote_fp": None}
            return {"local": self.local_snapshot(rel), "remote_fp": remote_files[rel].fp}
        raise ValueError(action)

    def sync_dirs(self, local_dirs, remote_dirs, new_files) -> set[str]:
        old_dirs = self.state.dirs
        result: set[str] = set()
        # deepest first so children are handled before parents
        for rel in sorted(local_dirs | remote_dirs | old_dirs, key=lambda d: -d.count("/")):
            in_l, in_r = rel in local_dirs, rel in remote_dirs
            has_files = any(f.startswith(rel + "/") for f in new_files)
            has_dirs = any(d.startswith(rel + "/") for d in result)
            try:
                if in_l and in_r:
                    result.add(rel)
                elif in_l and not in_r:
                    if rel in old_dirs and not has_files and not has_dirs:
                        log(f"  rmdir local   {rel}/")
                        if not self.dry_run:
                            self._rmdir_local(rel)
                    else:
                        self.ensure_remote_dir(rel, remote_dirs)
                        result.add(rel)
                elif in_r and not in_l:
                    if rel in old_dirs and not has_files and not has_dirs:
                        self.trash_remote(rel)
                    else:
                        log(f"  mkdir local   {rel}/")
                        if not self.dry_run:
                            self.lpath(rel).mkdir(parents=True, exist_ok=True)
                        result.add(rel)
            except (ProtonError, OSError) as e:
                if isinstance(e, ProtonError) and e.code == EXIT_AUTH:
                    raise
                warn(f"{rel}/: {e}")
                self.stats["error"] += 1
        return result

    def _rmdir_local(self, rel: str) -> None:
        p = self.lpath(rel)
        try:
            p.rmdir()
        except OSError:
            # contains only excluded files – move to local trash instead of deleting
            self.trash_local(rel)

    def refresh_remote_fps(self, new_files: dict, touched: set[str]) -> None:
        """After uploads, re-list the affected remote folders to learn the new fingerprints."""
        new_files.update(getattr(self, "_extra", {}))
        if not touched:
            return
        by_parent: dict[str, list[str]] = {}
        for rel in touched:
            parent = str(PurePosixPath(rel).parent) if "/" in rel else ""
            by_parent.setdefault(parent, []).append(rel)
        for parent, rels in by_parent.items():
            try:
                listing = {}
                for item in self.proton.list_folder(rjoin(self.pair.remote, parent)):
                    norm = normalize_remote(item)
                    if norm:
                        listing[norm[0]] = norm[1]
            except ProtonError as e:
                warn(f"konnte {parent or '/'} nach Upload nicht neu einlesen: {e}")
                listing = {}
            for rel in rels:
                entry = listing.get(PurePosixPath(rel).name)
                if entry and rel in new_files:
                    new_files[rel]["remote_fp"] = entry.fp
                else:
                    # unknown fingerprint: drop the entry so the next run re-checks it
                    new_files.pop(rel, None)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def load_config(path: Path) -> dict:
    cfg = json.loads(path.read_text())
    cfg.setdefault("folders", [])
    return cfg


def has_display() -> bool:
    return bool(os.environ.get("WAYLAND_DISPLAY") or os.environ.get("DISPLAY"))


def state_dir_for(config_path: Path) -> Path:
    try:
        cfg = load_config(config_path)
    except (OSError, ValueError):
        cfg = {}
    return Path(cfg.get("stateDir") or xdg("XDG_STATE_HOME", "~/.local/state") / "proton-drive-sync")


def open_activity(config_path: Path, tray: bool) -> int:
    """Activity window (status) or tray icon + window (tray)."""
    if not has_display():
        warn("Kein Bildschirm gefunden (WAYLAND_DISPLAY/DISPLAY).")
        return 1
    try:
        from proton_drive_sync_tray import run_activity
    except ImportError as e:
        warn(f"GUI nicht verfügbar ({e}).")
        return 1
    return run_activity(config_path, state_dir_for(config_path), os.path.abspath(__file__),
                        VERSION, tray=tray)


def open_wizard(config_path: Path) -> bool:
    """Show the GTK setup wizard. Returns True if a config was saved."""
    if not has_display():
        warn("Kein Bildschirm gefunden (WAYLAND_DISPLAY/DISPLAY) – der Assistent braucht eine "
             "grafische Sitzung. Alternativ die Konfiguration per Home Manager setzen.")
        return False
    try:
        from proton_drive_sync_gui import run_wizard
    except ImportError as e:
        warn(f"GUI nicht verfügbar ({e}).")
        return False
    return run_wizard(config_path, version=VERSION) is not None


def restart_agent() -> None:
    """(Re)start the agent service so it uses the new config (if the service is installed)."""
    unit = "proton-drive-sync.service"
    try:
        enabled = subprocess.run(["systemctl", "--user", "is-enabled", unit],
                                 capture_output=True).returncode == 0
        if enabled:
            subprocess.run(["systemctl", "--user", "restart", unit], capture_output=True)
            log("Agent mit neuer Konfiguration neu gestartet.")
    except OSError:
        pass


AUTH_HINT = "Nicht angemeldet / Sitzung abgelaufen. Bitte `proton-drive auth login` ausführen."


class Activity:
    """Status and change log for the tray icon / activity window.

    status.json   – current state of the agent and of every folder
    activity.jsonl – one JSON object per change (newest last, trimmed)
    """
    MAX_EVENTS = 500

    def __init__(self, state_dir: Path):
        self.status_path = state_dir / "status.json"
        self.log_path = state_dir / "activity.jsonl"
        self.data: dict = {"version": VERSION, "pid": os.getpid(), "state": "starting",
                           "message": None, "folder": None, "folders": {}}
        try:  # keep per-folder history (last sync time etc.) across restarts
            old = json.loads(self.status_path.read_text())
            self.data["folders"] = old.get("folders", {})
        except (OSError, ValueError):
            pass
        self.trim()
        self.save()

    def save(self) -> None:
        self.data["updated"] = time.time()
        tmp = self.status_path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(self.data, ensure_ascii=False))
            os.replace(tmp, self.status_path)
        except OSError:
            pass

    def set(self, state: str, message: str | None = None, folder: str | None = None) -> None:
        self.data.update(state=state, message=message, folder=folder)
        self.save()

    def folder_update(self, name: str, **kw) -> None:
        self.data["folders"].setdefault(name, {}).update(kw)
        self.save()

    def overall(self) -> None:
        """Agent is waiting: idle, or error if the last run of a folder failed."""
        bad = [n for n, f in self.data["folders"].items() if f.get("state") == "error"]
        self.set("error" if bad else "idle",
                 f"Fehler in: {', '.join(bad)}" if bad else None)

    def event(self, folder: str, action: str, rel: str, local: str, message: str | None = None) -> None:
        line = json.dumps({"time": time.time(), "folder": folder, "action": action, "path": rel,
                           "local": local, "message": message}, ensure_ascii=False)
        try:
            with open(self.log_path, "a") as f:
                f.write(line + "\n")
        except OSError:
            pass

    def trim(self) -> None:
        try:
            lines = self.log_path.read_text().splitlines()
        except OSError:
            return
        if len(lines) > self.MAX_EVENTS:
            tmp = self.log_path.with_suffix(".tmp")
            tmp.write_text("\n".join(lines[-self.MAX_EVENTS:]) + "\n")
            os.replace(tmp, self.log_path)


def sync_pair(make_syncer, pair: Pair, activity: Activity | None = None) -> bool:
    """One sync run for one folder; errors are logged, auth errors re-raised."""
    syncer = make_syncer(pair)
    syncer.activity = activity
    if activity:
        activity.set("syncing", folder=pair.name)
        activity.folder_update(pair.name, state="syncing", local=str(pair.local),
                               remote=pair.remote, started=time.time())
    ok, message = False, None
    try:
        ok = syncer.run()
        if not ok:
            message = f"{syncer.stats['error']} Fehler – Details im Log"
        return ok
    except ProtonError as e:
        warn(str(e))
        message = str(e)
        if e.code == EXIT_AUTH:
            if activity:
                activity.folder_update(pair.name, state="auth", message=AUTH_HINT)
                activity.set("auth", AUTH_HINT)
            raise
        return False
    except OSError as e:
        warn(f"{pair.name}: {e}")
        message = str(e)
        return False
    finally:
        if activity and activity.data["state"] != "auth":
            activity.folder_update(pair.name, state="ok" if ok else "error", message=message,
                                   last_sync=time.time(), stats=syncer.stats)


# --------------------------------------------------------------------------- #
# watch mode
# --------------------------------------------------------------------------- #

def watch(pairs: list[Pair], make_syncer, debounce: float, poll: float,
          activity: Activity | None = None, tray_cmd: list[str] | None = None) -> int:
    """Long-running agent: local changes are synced `debounce` seconds after the
    last filesystem event, remote changes are picked up every `poll` seconds."""
    import queue
    import threading

    for p in pairs:
        p.local.mkdir(parents=True, exist_ok=True)

    events: queue.Queue = queue.Queue()
    cmd = ["inotifywait", "-m", "-r", "-q", "--format", "%w%f",
           "-e", "close_write", "-e", "create", "-e", "delete", "-e", "moved_to",
           "-e", "moved_from", "-e", "delete_self",
           *[str(p.local) for p in pairs]]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)

    def reader():
        for line in proc.stdout:
            events.put(line.rstrip("\n"))
        events.put(None)  # inotifywait ended

    threading.Thread(target=reader, daemon=True).start()

    tray = None
    if tray_cmd:
        try:
            tray = subprocess.Popen(tray_cmd)
        except OSError as e:
            warn(f"Taskleisten-Symbol konnte nicht gestartet werden: {e}")
    try:
        return _watch_loop(pairs, make_syncer, debounce, poll, events, activity)
    finally:
        if activity:
            activity.set("stopped")
        if tray and tray.poll() is None:
            tray.terminate()
        proc.terminate()


def _watch_loop(pairs, make_syncer, debounce, poll, events, activity) -> int:
    import queue
    log(f"proton-drive-sync {VERSION} – Überwache {len(pairs)} Ordner (Verzögerung {debounce:g}s, Remote-Abfrage alle {poll:g}s)")

    excluders = {p.name: Excluder(DEFAULT_EXCLUDES + p.exclude) for p in pairs}
    dirty: dict[str, float] = {}          # pair name -> time of last local event
    next_poll = {p.name: 0.0 for p in pairs}  # 0 = sync right away on start
    backoff = poll

    def sync_now(*_):  # SIGUSR1, sent by the tray's "Jetzt synchronisieren"
        for name in next_poll:
            next_poll[name] = 0.0
    signal.signal(signal.SIGUSR1, sync_now)
    if activity:
        activity.overall()

    def pair_for(path: str) -> tuple[Pair, str] | None:
        for p in pairs:
            root = str(p.local)
            if path == root or path.startswith(root + "/"):
                return p, path[len(root) + 1:]
        return None

    while True:
        now = time.monotonic()
        due = [t + debounce for t in dirty.values()] + list(next_poll.values())
        # wake up at least every second so SIGUSR1 (sync now) is handled promptly
        timeout = min(1.0, max(0.0, min(due) - now) if due else poll)
        try:
            path = events.get(timeout=timeout)
            if path is None:
                warn("inotifywait wurde beendet")
                return 1
            hit = pair_for(path)
            if hit and hit[1] and not excluders[hit[0].name](hit[1]):
                dirty[hit[0].name] = time.monotonic()
            continue  # keep draining until things are quiet
        except queue.Empty:
            pass

        now = time.monotonic()
        for p in pairs:
            local_due = p.name in dirty and now - dirty[p.name] >= debounce
            poll_due = now >= next_poll[p.name]
            if not (local_due or poll_due):
                continue
            dirty.pop(p.name, None)
            if local_due and not poll_due and not make_syncer(p).local_dirty():
                continue  # only our own writes / nothing real changed
            try:
                sync_pair(make_syncer, p, activity)
                backoff = poll
                if activity:
                    activity.overall()
                    activity.trim()
            except ProtonError:  # auth
                warn(AUTH_HINT)
                backoff = min(backoff * 2, 3600)
            next_poll[p.name] = time.monotonic() + backoff


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="proton-drive-sync",
                                 description="Zwei-Wege-Sync zwischen lokalen Ordnern und Proton Drive")
    ap.add_argument("-V", "--version", action="version", version=f"%(prog)s {VERSION}")
    ap.add_argument("--config", type=Path,
                    default=xdg("XDG_CONFIG_HOME", "~/.config") / "proton-drive-sync" / "config.json")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="einen Sync-Durchlauf ausführen")
    r.add_argument("-n", "--dry-run", action="store_true", help="nur anzeigen, nichts ändern")
    r.add_argument("--force", action="store_true", help="Lösch-Limit ignorieren")
    r.add_argument("--folder", action="append", help="nur diesen Ordner (Name) synchronisieren")
    w = sub.add_parser("watch", help="als Agent laufen: Ordner überwachen und laufend synchronisieren")
    w.add_argument("--debounce", type=float, help="Sekunden Ruhe nach der letzten lokalen Änderung")
    w.add_argument("--poll", type=float, help="Sekunden zwischen zwei Remote-Abfragen")
    w.add_argument("--folder", action="append", help="nur diesen Ordner (Name) überwachen")
    sub.add_parser("config", help="Einrichtungsassistent (GUI) öffnen")
    sub.add_parser("status", help="Aktivitätsfenster (GUI) öffnen")
    sub.add_parser("tray", help="Taskleisten-Symbol starten (startet sonst der Agent selbst)")
    sub.add_parser("folders", help="konfigurierte Ordner anzeigen")
    rs = sub.add_parser("reset", help="gespeicherten Sync-Zustand eines Ordners vergessen")
    rs.add_argument("folder")
    args = ap.parse_args(argv)
    # systemd stops the agent with SIGTERM: turn it into SystemExit so running
    # syncs can save their progress before exiting.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    if args.cmd == "config":
        if not open_wizard(args.config):
            return 1
        restart_agent()
        return 0

    if args.cmd in ("status", "tray"):
        return open_activity(args.config, tray=args.cmd == "tray")

    if not args.config.exists():
        if args.cmd != "watch":
            warn(f"Keine Konfiguration unter {args.config}. Einrichten mit: proton-drive-sync config")
            return 1
        log(f"Keine Konfiguration unter {args.config} – starte Einrichtungsassistent.")
        if not open_wizard(args.config):
            log("Assistent ohne Speichern geschlossen – Agent beendet.")
            return 0

    cfg = load_config(args.config)
    state_dir = Path(cfg.get("stateDir") or xdg("XDG_STATE_HOME", "~/.local/state") / "proton-drive-sync")
    trash_dir = Path(cfg.get("trashDir") or xdg("XDG_DATA_HOME", "~/.local/share") / "proton-drive-sync" / "trash")
    pairs = [Pair(f["name"], Path(os.path.expanduser(f["local"])), rjoin(f["remote"]),
                  list(cfg.get("exclude", [])) + list(f.get("exclude", [])))
             for f in cfg["folders"]]

    if args.cmd == "folders":
        for p in pairs:
            st = state_dir / f"{p.name}.json"
            info = f"{len(State.load(st).files)} Dateien bekannt" if st.exists() else "noch nie synchronisiert"
            log(f"{p.name:20} {p.local} ⇄ proton:{p.remote}   ({info})")
        return 0
    if args.cmd == "reset":
        st = state_dir / f"{args.folder}.json"
        if st.exists():
            st.unlink()
        log(f"Zustand für {args.folder} gelöscht – nächster Lauf vergleicht neu.")
        return 0

    if args.folder:
        unknown = set(args.folder) - {p.name for p in pairs}
        if unknown:
            warn(f"unbekannte Ordner: {', '.join(sorted(unknown))}")
            return 1
        pairs = [p for p in pairs if p.name in args.folder]

    state_dir.mkdir(parents=True, exist_ok=True)
    lock = open(state_dir / ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("Ein anderer Sync (oder der Agent) läuft bereits – beende.")
        return 0

    if cfg.get("credentialsStore"):
        os.environ["PROTON_DRIVE_CREDENTIALS_STORE"] = cfg["credentialsStore"]
    dry_run = getattr(args, "dry_run", False)
    force = getattr(args, "force", False)
    proton = Proton(cfg.get("protonBin", "proton-drive"), dry_run)

    def make_syncer(pair: Pair) -> Syncer:
        return Syncer(pair, proton, state_dir, trash_dir,
                      int(cfg.get("maxDeletes", 50)), force, dry_run)

    activity = None if dry_run else Activity(state_dir)

    if args.cmd == "watch":
        debounce = args.debounce if args.debounce is not None else float(cfg.get("debounce", 5))
        poll = args.poll if args.poll is not None else float(cfg.get("remotePoll", 60))
        tray_cmd = None
        if cfg.get("trayIcon", True) and has_display():
            tray_cmd = [sys.executable, os.path.abspath(__file__), "--config", str(args.config), "tray"]
        try:
            return watch(pairs, make_syncer, debounce, poll, activity, tray_cmd)
        except KeyboardInterrupt:
            return 0

    ok = True
    try:
        for pair in pairs:
            ok &= sync_pair(make_syncer, pair, activity)
    except ProtonError:
        warn(AUTH_HINT)
        return EXIT_AUTH
    finally:
        if activity:
            activity.overall()
            activity.set("stopped")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
