# pdrive-sync

Zwei-Wege-Sync zwischen lokalen Ordnern und [Proton Drive](https://proton.me/drive) für **NixOS / Home Manager**.
Ein Hintergrund-Agent überwacht deine Ordner und gleicht Änderungen in beide Richtungen ab. Bedient wird er komplett über die Kommandozeile.

Geschrieben in TypeScript für [Bun](https://bun.sh), direkt auf Protons offiziellem
[Drive-SDK](https://github.com/ProtonDriveApps/sdk) (MIT).

> **Drittanbieter-Programm:** nicht offiziell von Proton unterstützt. Es meldet sich gegenüber Proton ehrlich als
> `external-drive-pdrive_sync@<version>` an.
>
> **Status:** experimentell. Das Drive-SDK ist noch vor Version 1.0. Lege vor dem ersten Sync wichtiger Daten ein Backup an.

## Funktionen

- **Lokal:** inotify meldet Änderungen. `debounce` Sekunden (Standard 5) nach der letzten Änderung wird abgeglichen.
- **Remote über Drive-Events, wie Proton es verlangt:** Das SDK fragt alle 30 s die Event-Liste ab. Der Agent liest danach nur die
  betroffenen Ordner neu und durchsucht nicht den ganzen Baum. Ein vollständiger Abgleich läuft beim ersten Start und alle
  `fullScanHours` Stunden (Standard 24).
- **Echter Zwei-Wege-Abgleich:** Jeder Lauf vergleicht lokal, remote und den Stand nach dem letzten Lauf.
- **Schneller Erstabgleich:** Liegen Dateien auf beiden Seiten, vergleicht der Agent sie per SHA-1-Prüfsumme, die Proton zu jeder
  Datei speichert. Nichts wird doppelt übertragen.
- **Eine Anmeldung pro Sitzung:** Der Agent meldet sich einmal an und hält die Verbindung. Er startet kein Programm pro Datei.
- **Sicherheitsnetz:** Löschungen landen im Proton-Papierkorb bzw. in einem lokalen Papierkorb. Ein Lösch-Limit pro Lauf verhindert
  Massenlöschungen, z. B. wenn ein Laufwerk nicht eingehängt ist.

### Was in welchem Fall passiert

| Situation | Aktion |
|---|---|
| nur lokal neu/geändert | Upload (bei Änderung als neue Revision) |
| nur remote neu/geändert | Download (mit Prüfsummen-Kontrolle) |
| beide Seiten geändert | **Konflikt:** Die lokale Version wird zu `name (Konflikt <host> <datum>).ext` und hochgeladen, die Remote-Version behält den Namen |
| lokal gelöscht | remote in den **Proton-Papierkorb** |
| remote gelöscht | lokal nach `~/.local/share/pdrive-sync/trash/<ordner>/<datum>/` |
| beim ersten Lauf auf beiden Seiten vorhanden | gleiche Prüfsumme → identisch, sonst Konflikt |
| Proton Docs / Sheets | werden ignoriert (nur online verfügbar) |

## Installation (Flake + Home Manager)

```nix
# flake.nix deiner NixOS-Konfiguration
inputs.pdrive-sync = {
  url = "github:Memurame/pdrive-sync";
  inputs.nixpkgs.follows = "nixpkgs";
};

# im home-manager-Teil:
home-manager.sharedModules = [ pdrive-sync.homeManagerModules.default ];
```

```nix
# home.nix
services.pdrive-sync.enable = true;
```

Nach `nixos-rebuild switch` einmal anmelden und Ordner hinzufügen:

```sh
pdrive-sync login                                      # Anmeldung im Browser
pdrive-sync folder add Dokumente ~/Dokumente /Dokumente
pdrive-sync status
pdrive-sync log -f                                     # Änderungen live verfolgen
```

`folder add` und `login` starten den Agenten (systemd-User-Dienst `pdrive-sync`) automatisch neu.

### Ordner deklarativ in Nix

```nix
services.pdrive-sync = {
  enable = true;
  debounce = 5;          # Sekunden Ruhe nach einer lokalen Änderung
  fullScanHours = 24;    # vollständiger Abgleich (dazwischen Drive-Events)
  maxDeletes = 50;       # Sicherheitsgrenze pro Lauf
  exclude = [ ".git" "node_modules" ];
  # credentialsStore = "pass";   # Standard: "keychain" (Secret Service)
  folders = {
    Dokumente = { local = "~/Dokumente"; remote = "/Dokumente"; };
    Alles     = { local = "~/ProtonDrive"; remote = "/"; };      # "/" = ganzes Drive
  };
};
```

Sind `folders` gesetzt, verwaltet Home Manager die Konfiguration. `folder add` und `config set` verweisen dann auf `home.nix`.

### Voraussetzungen

- **Sitzungsspeicher:** Die Sitzung liegt im **Secret Service** (GNOME Keyring, KWallet, …) oder in [`pass`](https://www.passwordstore.org/).
  Der Speicher muss entsperrt sein, solange der Agent läuft. Unter Fenstermanagern wie Hyprland oder Sway z. B.
  `services.gnome-keyring.enable = true;` setzen.
- **Eigene Sitzung:** Die Sitzung ist unabhängig vom offiziellen `proton-drive` CLI, nötig ist ein eigenes `pdrive-sync login`.

## Befehle

```text
pdrive-sync login | logout
pdrive-sync folder list
pdrive-sync folder add NAME LOKAL REMOTE [--exclude MUSTER]…
pdrive-sync folder remove NAME
pdrive-sync config [show] | config set SCHLÜSSEL WERT | config path
pdrive-sync sync [-n|--dry-run] [--force] [--folder NAME]…
pdrive-sync watch
pdrive-sync status
pdrive-sync log [-n ANZAHL] [-f]
pdrive-sync reset NAME
pdrive-sync version | help
```

Einstellbar mit `config set`: `debounce`, `fullScanHours`, `maxDeletes`, `exclude` (kommagetrennt), `credentialsStore`.

Läuft der Agent, stößt `sync` bei ihm einen vollständigen Abgleich an.

Temporäre Dateien (`*.part`, `*.tmp`, `*.swp`, `*~`, `.~lock.*#`, `~$*`, `.DS_Store`, `Thumbs.db`) werden immer ignoriert.

## Wo liegt was?

| Was | Ort |
|---|---|
| Konfiguration | `~/.config/pdrive-sync/config.json` |
| Stand pro Ordner, Event-Stand, Status | `~/.local/state/pdrive-sync/` |
| letzte Änderungen (`log`) | `~/.local/state/pdrive-sync/activity.jsonl` |
| Agent-Ausgabe | `journalctl --user -u pdrive-sync -f` |
| SDK-Log | `~/.local/state/pdrive-sync/proton-drive.log` |
| SDK-Cache / Client-ID | `~/.cache/pdrive-sync/`, `~/.local/share/pdrive-sync/` |
| lokaler Papierkorb | `~/.local/share/pdrive-sync/trash/` |
| Sitzung | Secret Service, Dienst `pdrive-sync` (bzw. `pass`) |

## Umstieg von 0.6 (Umbenennung in pdrive-sync)

Ab 0.7 heißen Programm, Repo, Dienst und Option **pdrive-sync** (ohne Proton-Marke im Namen).

- **Flake:** `url = "github:Memurame/pdrive-sync";`. Die alte Repo-Adresse leitet GitHub weiter.
- **Home Manager:** `services.proton-drive-sync` funktioniert weiter. Home Manager weist auf den neuen Namen `services.pdrive-sync` hin.
- **Programm:** `pdrive-sync` statt `proton-drive-sync`. Der Dienst heißt jetzt `pdrive-sync.service`.
- **Automatische Übernahme beim ersten Start:** Verzeichnisse (`~/.local/state`, `~/.local/share`, `~/.cache`), eine selbst angelegte
  Config und die Anmeldung (Schlüsselbund bzw. `pass`) werden übernommen. Ein neues `login` ist nicht nötig.

## Umstieg von 0.5 (Python)

- **Config:** Die bestehende `config.json` wird weiter gelesen. Veraltete Schlüssel (`remotePoll`, `trayIcon`, `protonBin`) werden ignoriert.
- **Home Manager:** Die Optionen `remotePoll`, `trayIcon` und `protonPackage` sind entfernt. Home Manager meldet sie mit einem Hinweis.
- **Stand:** Der alte Sync-Stand wird nicht übernommen. Der erste Lauf vergleicht per Prüfsumme und überträgt nichts doppelt.
- **Anmeldung:** einmal neu mit `pdrive-sync login`.
- **Oberfläche:** Die grafische Oberfläche (Einstellungsfenster, Übersicht, Taskleisten-Symbol) entfällt. Ersatz sind `status`, `log`,
  `folder` und `config`.

## Entwicklung

```sh
nix build                                       # Paket bauen
./result/bin/pdrive-sync --config test.json sync -n
```

Gebaut wird im Quellbaum des offiziellen CLI (`ProtonDriveApps/sdk`, in nixpkgs als `proton-drive-cli`). Dessen Initialisierung
(Anmeldung, HTTP, Verschlüsselung, Cache) wird wiederverwendet, mit eigener App-Kennung, eigenen Verzeichnissen und eigenem
Sitzungsspeicher. Unser Code liegt in `src/` und landet beim Build in `cli/src/sync/`:

- `main.ts`: Befehle
- `agent.ts`: Agent (inotify, Drive-Events, Zeitsteuerung)
- `syncer.ts`: Abgleich (Planen, Hoch- und Herunterladen, Konflikte, Checkpoints)
- `remote.ts`: Zugriff auf Proton Drive über das SDK
- `local.ts`: lokaler Scan, Ausnahmen, Prüfsummen
- `state.ts`: Stand, Event-IDs, Status, Änderungsprotokoll
- `settings.ts`: Konfiguration

## Lizenz

[MIT](LICENSE). Dieses Projekt ist kein offizielles Produkt von Proton AG.
