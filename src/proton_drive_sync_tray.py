"""Taskleisten-Symbol und Aktivitätsfenster für proton-drive-sync.

Liest status.json und activity.jsonl, die der Agent in sein State-Verzeichnis
schreibt. Das Symbol nutzt das StatusNotifierItem-Protokoll (KDE, Waybar,
Quickshell, GNOME mit AppIndicator-Erweiterung) direkt über D-Bus.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Adw, Gdk, GdkPixbuf, Gio, GLib, Gtk  # noqa: E402

APP_ID = "io.github.protondrivesync.Activity"
SERVICE = "proton-drive-sync.service"

ACTIONS = {
    "up": ("go-up-symbolic", "Hochgeladen"),
    "down": ("go-down-symbolic", "Heruntergeladen"),
    "del_remote": ("user-trash-symbolic", "In Proton Drive gelöscht"),
    "del_local": ("user-trash-symbolic", "Lokal gelöscht"),
    "conflict": ("dialog-warning-symbolic", "Konflikt"),
    "error": ("dialog-error-symbolic", "Fehler"),
}
# our own icons (icons/*.svg, installed to share/icons/hicolor by package.nix)
APP_ICON = "proton-drive-sync"
STATE_ICONS = {
    "idle": "proton-drive-sync",
    "starting": "proton-drive-sync-syncing",
    "syncing": "proton-drive-sync-syncing",
    "error": "proton-drive-sync-error",
    "auth": "proton-drive-sync-error",
    "stopped": "proton-drive-sync-stopped",
}
FALLBACK_ICON = "folder-remote"
PIXMAP_SIZES = (16, 22, 24, 32, 48, 64)


def icon_roots() -> list[Path]:
    """share/icons of the installed package, or the repo's icons/ when run from source."""
    here = Path(__file__).resolve().parent
    return [here.parent.parent / "share" / "icons", here.parent / "icons"]


def _pixbuf(name: str, size: int):
    for root in icon_roots():
        for f in (root / "hicolor" / f"{size}x{size}" / "apps" / f"{name}.png", root / f"{name}.svg",
                  root / "hicolor" / "scalable" / "apps" / f"{name}.svg"):
            if f.exists():
                try:
                    return GdkPixbuf.Pixbuf.new_from_file_at_size(str(f), size, size)
                except GLib.Error:
                    pass
    return None


_PIXMAPS: dict[str, list] = {}


def pixmaps(name: str) -> list[tuple[int, int, bytes]]:
    """Icon as StatusNotifierItem pixmaps (ARGB32, network byte order) in several sizes."""
    if name in _PIXMAPS:
        return _PIXMAPS[name]
    out = []
    for size in PIXMAP_SIZES:
        pb = _pixbuf(name, size)
        if pb is None:
            continue
        if not pb.get_has_alpha():
            pb = pb.add_alpha(False, 0, 0, 0)
        w, h, rs = pb.get_width(), pb.get_height(), pb.get_rowstride()
        px = pb.get_pixels()
        data = bytearray(w * h * 4)
        for y in range(h):
            row = px[y * rs: y * rs + w * 4]
            o = y * w * 4
            data[o + 0:o + w * 4:4] = row[3::4]  # A
            data[o + 1:o + w * 4:4] = row[0::4]  # R
            data[o + 2:o + w * 4:4] = row[1::4]  # G
            data[o + 3:o + w * 4:4] = row[2::4]  # B
        out.append((w, h, bytes(data)))
    _PIXMAPS[name] = out
    return out


def add_icon_search_path() -> None:
    display = Gdk.Display.get_default()
    if display:
        theme = Gtk.IconTheme.get_for_display(display)
        for root in icon_roots():
            if root.exists():
                theme.add_search_path(str(root))


def ago(ts: float | None) -> str:
    if not ts:
        return "noch nie"
    d = time.time() - ts
    if d < 60:
        return "gerade eben"
    if d < 3600:
        return f"vor {int(d // 60)} Min."
    if d < 86400:
        return f"vor {int(d // 3600)} Std."
    return time.strftime("am %d.%m. um %H:%M", time.localtime(ts))


# --------------------------------------------------------------------------- #
# data written by the agent
# --------------------------------------------------------------------------- #

class Source:
    def __init__(self, state_dir: Path):
        self.status_path = state_dir / "status.json"
        self.log_path = state_dir / "activity.jsonl"

    def signature(self):
        sig = []
        for p in (self.status_path, self.log_path):
            try:
                st = p.stat()
                sig.append((st.st_mtime_ns, st.st_size))
            except OSError:
                sig.append(None)
        return tuple(sig)

    def status(self) -> dict:
        try:
            st = json.loads(self.status_path.read_text())
        except (OSError, ValueError):
            st = {}
        st.setdefault("folders", {})
        pid = st.get("pid")
        alive = False
        if pid:
            try:
                os.kill(pid, 0)
                alive = True
            except OSError:
                pass
        if not alive or not st.get("state"):
            st["state"] = "stopped"
        st["alive"] = alive and st["state"] != "stopped"
        return st

    def events(self, limit: int = 150) -> list[dict]:
        try:
            lines = self.log_path.read_text().splitlines()[-limit:]
        except OSError:
            return []
        out = []
        for line in reversed(lines):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
        return out


def summary(st: dict) -> tuple[str, str]:
    """(headline, detail) for the current state."""
    s = st.get("state")
    folders = st.get("folders", {})
    last = max((f.get("last_sync") or 0 for f in folders.values()), default=0)
    if s == "syncing":
        return f"Synchronisiere {st.get('folder') or ''} …", f"Letzter Abgleich {ago(last)}"
    if s == "auth":
        return "Nicht bei Proton angemeldet", "In den Einstellungen anmelden oder `proton-drive auth login` ausführen."
    if s == "error":
        return "Fehler beim letzten Abgleich", st.get("message") or "Details im Log"
    if s == "stopped":
        return "Agent läuft nicht", f"Letzter Abgleich {ago(last)}"
    if s == "starting":
        return "Agent startet …", ""
    return "Alles synchronisiert", f"Letzter Abgleich {ago(last)}"


# --------------------------------------------------------------------------- #
# StatusNotifierItem + DBusMenu
# --------------------------------------------------------------------------- #

SNI_XML = """
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
    <signal name="NewTitle"/>
    <signal name="NewIcon"/>
    <signal name="NewAttentionIcon"/>
    <signal name="NewOverlayIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
  </interface>
</node>"""

MENU_XML = """
<node>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg type="i" name="parentId" direction="in"/>
      <arg type="i" name="recursionDepth" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="u" name="revision" direction="out"/>
      <arg type="(ia{sv}av)" name="layout" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg type="ai" name="ids" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="a(ia{sv})" name="properties" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="name" direction="in"/>
      <arg type="v" name="value" direction="out"/>
    </method>
    <method name="Event">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="eventId" direction="in"/>
      <arg type="v" name="data" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg type="a(isvu)" name="events" direction="in"/>
      <arg type="ai" name="idErrors" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg type="i" name="id" direction="in"/>
      <arg type="b" name="needUpdate" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg type="ai" name="ids" direction="in"/>
      <arg type="ai" name="updatesNeeded" direction="out"/>
      <arg type="ai" name="idErrors" direction="out"/>
    </method>
    <signal name="ItemsPropertiesUpdated">
      <arg type="a(ia{sv})" name="updatedProps"/>
      <arg type="a(ias)" name="removedProps"/>
    </signal>
    <signal name="LayoutUpdated">
      <arg type="u" name="revision"/>
      <arg type="i" name="parent"/>
    </signal>
    <signal name="ItemActivationRequested">
      <arg type="i" name="id"/>
      <arg type="u" name="timestamp"/>
    </signal>
  </interface>
</node>"""

SNI_PATH = "/StatusNotifierItem"
MENU_PATH = "/MenuBar"
SNI_IFACE = "org.kde.StatusNotifierItem"
MENU_IFACE = "com.canonical.dbusmenu"


def _props(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        out[k] = GLib.Variant("b", v) if isinstance(v, bool) else GLib.Variant("s", str(v))
    return out


class TrayIcon:
    def __init__(self, app: "ActivityApp"):
        self.app = app
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        self.icon = STATE_ICONS["idle"]
        self.title = "Proton Drive Sync"
        self.detail = ""
        self.status_label = "Proton Drive Sync"
        self.can_sync = False
        self.revision = 1

        sni = Gio.DBusNodeInfo.new_for_xml(SNI_XML).interfaces[0]
        menu = Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0]
        # PyGObject maps register_object() to register_object_with_closures2 on new GLib
        register = getattr(self.bus, "register_object_with_closures", None) or self.bus.register_object
        register(SNI_PATH, sni, self.on_sni_call, self.on_sni_prop, None)
        register(MENU_PATH, menu, self.on_menu_call, self.on_menu_prop, None)
        # own the name synchronously, so the watcher can find us right away
        self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                           "RequestName", GLib.Variant("(su)", (self.name, 4)), None,
                           Gio.DBusCallFlags.NONE, -1, None)
        Gio.bus_watch_name_on_connection(self.bus, "org.kde.StatusNotifierWatcher",
                                         Gio.BusNameWatcherFlags.NONE, self.on_watcher, None)

    # -- registration --------------------------------------------------------- #

    def on_watcher(self, *_):
        self.bus.call("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
                      "org.kde.StatusNotifierWatcher", "RegisterStatusNotifierItem",
                      GLib.Variant("(s)", (self.name,)), None, Gio.DBusCallFlags.NONE, -1, None, None)

    # -- state ---------------------------------------------------------------- #

    def update(self, st: dict):
        head, detail = summary(st)
        icon = STATE_ICONS.get(st.get("state"), APP_ICON)
        if icon != self.icon:
            self.icon = icon
            self.emit(SNI_PATH, SNI_IFACE, "NewIcon")
        if (head, detail) != (self.status_label, self.detail):
            self.status_label, self.detail = head, detail
            self.emit(SNI_PATH, SNI_IFACE, "NewToolTip")
            self.bump()
        if st.get("alive") != self.can_sync:
            self.can_sync = bool(st.get("alive"))
            self.bump()

    def bump(self):
        self.revision += 1
        self.emit(MENU_PATH, MENU_IFACE, "LayoutUpdated", GLib.Variant("(ui)", (self.revision, 0)))

    def emit(self, path, iface, name, params=None):
        try:
            self.bus.emit_signal(None, path, iface, name, params)
        except GLib.Error:
            pass

    # -- StatusNotifierItem ----------------------------------------------------- #

    def on_sni_call(self, conn, sender, path, iface, method, params, invocation):
        # ItemIsMenu = true: a click opens the menu (shown by the panel); clicks
        # deliberately do not open a window – "Aktivität anzeigen" does that.
        invocation.return_value(None)

    def on_sni_prop(self, conn, sender, path, iface, prop):
        return {
            "Category": GLib.Variant("s", "ApplicationStatus"),
            "Id": GLib.Variant("s", "proton-drive-sync"),
            "Title": GLib.Variant("s", self.title),
            "Status": GLib.Variant("s", "Active"),
            "WindowId": GLib.Variant("i", 0),
            # pixmaps work in every panel; the name is only a fallback without them
            "IconName": GLib.Variant("s", "" if pixmaps(self.icon) else FALLBACK_ICON),
            "IconPixmap": GLib.Variant("a(iiay)", pixmaps(self.icon)),
            "IconThemePath": GLib.Variant("s", ""),
            "OverlayIconName": GLib.Variant("s", ""),
            "AttentionIconName": GLib.Variant("s", ""),
            "ToolTip": GLib.Variant("(sa(iiay)ss)", ("", pixmaps(self.icon), self.status_label, self.detail)),
            "ItemIsMenu": GLib.Variant("b", True),
            "Menu": GLib.Variant("o", MENU_PATH),
        }.get(prop)

    # -- DBusMenu ------------------------------------------------------------- #

    def items(self) -> list[tuple[int, dict]]:
        return [
            (1, {"label": self.status_label, "enabled": False}),
            (2, {"type": "separator"}),
            (3, {"label": "Aktivität anzeigen"}),
            (4, {"label": "Jetzt synchronisieren" if self.can_sync else "Agent starten"}),
            (5, {"label": "Einstellungen …"}),
            (6, {"type": "separator"}),
            (7, {"label": "Symbol ausblenden"}),
        ]

    def on_menu_prop(self, conn, sender, path, iface, prop):
        return {
            "Version": GLib.Variant("u", 3),
            "TextDirection": GLib.Variant("s", "ltr"),
            "Status": GLib.Variant("s", "normal"),
            "IconThemePath": GLib.Variant("as", []),
        }.get(prop)

    def on_menu_call(self, conn, sender, path, iface, method, params, invocation):
        items = dict(self.items())
        if method == "GetLayout":
            children = [GLib.Variant("(ia{sv}av)", (i, _props(p), [])) for i, p in self.items()]
            root = (0, {"children-display": GLib.Variant("s", "submenu")}, children)
            invocation.return_value(GLib.Variant("(u(ia{sv}av))", (self.revision, root)))
        elif method == "GetGroupProperties":
            ids = params.unpack()[0] or list(items)
            invocation.return_value(GLib.Variant(
                "(a(ia{sv}))", ([(i, _props(items[i])) for i in ids if i in items],)))
        elif method == "GetProperty":
            i, name = params.unpack()
            value = items.get(i, {}).get(name, "")
            invocation.return_value(GLib.Variant("(v)", (_props({name: value})[name],)))
        elif method == "Event":
            i, event_id, _data, _ts = params.unpack()
            if event_id == "clicked":
                GLib.idle_add(lambda: (self.app.menu_clicked(i), False)[1])
            invocation.return_value(None)
        elif method == "EventGroup":
            for i, event_id, _data, _ts in params.unpack()[0]:
                if event_id == "clicked":
                    GLib.idle_add(lambda i=i: (self.app.menu_clicked(i), False)[1])
            invocation.return_value(GLib.Variant("(ai)", ([],)))
        elif method == "AboutToShow":
            invocation.return_value(GLib.Variant("(b)", (False,)))
        elif method == "AboutToShowGroup":
            invocation.return_value(GLib.Variant("(aiai)", ([], [])))
        else:
            invocation.return_value(None)


# --------------------------------------------------------------------------- #
# activity window
# --------------------------------------------------------------------------- #

class ActivityWindow(Adw.ApplicationWindow):
    def __init__(self, app: "ActivityApp"):
        super().__init__(application=app, title="Proton Drive Sync", default_width=560, default_height=680,
                         icon_name=APP_ICON)
        self.app = app
        self.toasts = Adw.ToastOverlay()
        tv = Adw.ToolbarView()
        header = Adw.HeaderBar()
        self.sync_btn = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Jetzt synchronisieren")
        self.sync_btn.connect("clicked", lambda *_: self.app.sync_now())
        settings = Gtk.Button(icon_name="emblem-system-symbolic", tooltip_text="Einstellungen")
        settings.connect("clicked", lambda *_: self.app.open_settings())
        header.pack_start(self.sync_btn)
        header.pack_end(settings)
        tv.add_top_bar(header)

        page = Adw.PreferencesPage()
        status_group = Adw.PreferencesGroup()
        self.status_row = Adw.ActionRow()
        self.status_icon = Gtk.Image(pixel_size=32)
        self.status_row.add_prefix(self.status_icon)
        status_group.add(self.status_row)
        page.add(status_group)

        self.folder_group = Adw.PreferencesGroup(title="Ordner")
        page.add(self.folder_group)
        self.event_group = Adw.PreferencesGroup(title="Letzte Änderungen")
        page.add(self.event_group)
        footer = Adw.PreferencesGroup()
        footer.add(Gtk.Label(label=f"Version {app.version}", css_classes=["dim-label", "caption"]))
        page.add(footer)

        tv.set_content(page)
        self.toasts.set_child(tv)
        self.set_content(self.toasts)
        self.folder_rows: list[Gtk.Widget] = []
        self.event_rows: list[Gtk.Widget] = []

    def toast(self, text: str):
        self.toasts.add_toast(Adw.Toast(title=text, timeout=3))

    def update(self, st: dict, events: list[dict]):
        head, detail = summary(st)
        self.status_row.set_title(GLib.markup_escape_text(head))
        self.status_row.set_subtitle(GLib.markup_escape_text(detail))
        self.status_icon.set_from_icon_name(STATE_ICONS.get(st.get("state"), APP_ICON))
        self.sync_btn.set_tooltip_text("Jetzt synchronisieren" if st.get("alive") else "Agent starten")

        for r in self.folder_rows:
            self.folder_group.remove(r)
        self.folder_rows = []
        folders = st.get("folders", {})
        if not folders:
            row = Adw.ActionRow(title="Noch keine Daten", subtitle="Der Agent hat noch keinen Ordner abgeglichen.")
            self.folder_rows.append(row)
            self.folder_group.add(row)
        for name, f in sorted(folders.items()):
            state = f.get("state")
            if state == "syncing":
                sub = "Wird synchronisiert …"
            elif state in ("error", "auth"):
                sub = f"Fehler: {f.get('message') or ''}"
            else:
                s = f.get("stats") or {}
                counts = "  ".join(t for t in (
                    f"↑{s['up']}" if s.get("up") else "", f"↓{s['down']}" if s.get("down") else "",
                    f"✕{s.get('del_local', 0) + s.get('del_remote', 0)}"
                    if s.get("del_local") or s.get("del_remote") else "") if t)
                sub = f"Synchronisiert {ago(f.get('last_sync'))}" + (f" · {counts}" if counts else "")
            row = Adw.ActionRow(title=GLib.markup_escape_text(name),
                                subtitle=GLib.markup_escape_text(f"{sub}\n{f.get('local', '')}  ⇄  Proton:{f.get('remote', '')}"),
                                subtitle_lines=2)
            row.add_prefix(Gtk.Image(icon_name={"syncing": "view-refresh-symbolic", "error": "dialog-warning-symbolic",
                                                "auth": "dialog-warning-symbolic"}.get(state, "folder-symbolic")))
            if f.get("local"):
                btn = Gtk.Button(label="Öffnen", valign=Gtk.Align.CENTER,
                                 tooltip_text="Lokalen Ordner öffnen", css_classes=["flat"])
                btn.connect("clicked", lambda _b, p=f["local"]: self.open_path(p))
                row.add_suffix(btn)
            self.folder_rows.append(row)
            self.folder_group.add(row)

        for r in self.event_rows:
            self.event_group.remove(r)
        self.event_rows = []
        if not events:
            row = Adw.ActionRow(title="Noch keine Änderungen")
            self.event_rows.append(row)
            self.event_group.add(row)
        for ev in events:
            icon, label = ACTIONS.get(ev.get("action"), ("document-edit-symbolic", ev.get("action", "")))
            path = ev.get("path", "")
            name = path.rsplit("/", 1)[-1]
            where = ev.get("folder", "") + ("/" + path.rsplit("/", 1)[0] if "/" in path else "")
            sub = f"{label} · {where} · {ago(ev.get('time'))}"
            row = Adw.ActionRow(title=GLib.markup_escape_text(name), subtitle=GLib.markup_escape_text(sub),
                                activatable=bool(ev.get("local")))
            if ev.get("message"):
                row.set_tooltip_text(ev["message"])
            img = Gtk.Image(icon_name=icon)
            if ev.get("action") in ("conflict", "error"):
                img.add_css_class("warning" if ev["action"] == "conflict" else "error")
            row.add_prefix(img)
            if ev.get("local"):
                row.connect("activated", lambda _r, p=ev["local"]: self.reveal(p))
            self.event_rows.append(row)
            self.event_group.add(row)

    def open_path(self, path: str):
        Gtk.FileLauncher.new(Gio.File.new_for_path(os.path.expanduser(path))).launch(self, None, None, None)

    def reveal(self, path: str):
        p = Path(path)
        if p.exists():
            Gtk.FileLauncher.new(Gio.File.new_for_path(str(p))).open_containing_folder(self, None, None, None)
        elif p.parent.exists():
            self.open_path(str(p.parent))
        else:
            self.toast("Datei existiert lokal nicht mehr")


# --------------------------------------------------------------------------- #
# application
# --------------------------------------------------------------------------- #

class ActivityApp(Adw.Application):
    def __init__(self, config_path: Path, state_dir: Path, main_script: str, version: str, tray: bool):
        super().__init__(application_id=APP_ID)
        self.config_path, self.main_script, self.version = config_path, main_script, version
        self.source = Source(state_dir)
        self.tray_mode = tray
        self.icon: TrayIcon | None = None
        self.window: ActivityWindow | None = None
        self.last_sig = None
        self.last_full = 0.0
        self.connect("activate", self.on_activate)

    def on_activate(self, _app):
        add_icon_search_path()
        if self.tray_mode and self.icon is None:
            self.hold()  # keep running without a window
            self.icon = TrayIcon(self)
            self.refresh(force=True)
            GLib.timeout_add_seconds(2, self.refresh)
            return
        if not self.tray_mode and self.window is None:
            GLib.timeout_add_seconds(2, self.refresh)
        self.show_window()

    def show_window(self):
        if self.window is None:
            self.window = ActivityWindow(self)
            self.window.connect("close-request", self.on_close)
        self.refresh(force=True)
        self.window.present()

    def on_close(self, *_):
        self.window = None
        return False

    def refresh(self, force: bool = False) -> bool:
        sig = self.source.signature()
        # also refresh every 30 s so relative times ("vor 2 Min.") stay correct
        if force or sig != self.last_sig or time.monotonic() - self.last_full > 30:
            self.last_sig, self.last_full = sig, time.monotonic()
            st = self.source.status()
            if self.icon:
                self.icon.update(st)
            if self.window:
                self.window.update(st, self.source.events())
        return True

    # -- actions -------------------------------------------------------------- #

    def menu_clicked(self, item: int):
        if item == 3:
            self.show_window()
        elif item == 4:
            self.sync_now()
        elif item == 5:
            self.open_settings()
        elif item == 7:
            self.quit()

    def sync_now(self):
        st = self.source.status()
        if st.get("alive"):
            try:
                os.kill(st["pid"], signal.SIGUSR1)
                msg = "Abgleich gestartet"
            except OSError as e:
                msg = f"Agent nicht erreichbar: {e}"
        else:
            r = subprocess.run(["systemctl", "--user", "start", SERVICE], capture_output=True, text=True)
            msg = "Agent gestartet" if r.returncode == 0 else "Agent konnte nicht gestartet werden"
        if self.window:
            self.window.toast(msg)
        GLib.timeout_add(800, lambda: (self.refresh(force=True), False)[1])

    def open_settings(self):
        subprocess.Popen([sys.executable, self.main_script, "--config", str(self.config_path), "config"])


def run_activity(config_path: Path, state_dir: Path, main_script: str, version: str, tray: bool) -> int:
    app = ActivityApp(config_path, state_dir, main_script, version, tray)
    return app.run([])
