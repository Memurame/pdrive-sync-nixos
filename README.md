# proton-drive-sync

Zwei-Wege-Sync zwischen lokalen Ordnern und [Proton Drive](https://proton.me/drive) für **NixOS / Home Manager**.
Ein Hintergrund-Agent überwacht deine Ordner und gleicht Änderungen in beide Richtungen ab. Bedient wird er komplett über die Kommandozeile.

Geschrieben in TypeScript für [Bun](https://bun.sh), direkt auf Protons offiziellem
[Drive-SDK](https://github.com/ProtonDriveApps/sdk) (MIT).

> **Drittanbieter-Programm:** nicht offiziell von Proton unterstützt. Es meldet sich gegenüber Proton ehrlich als
> `external-drive-proton_drive_sync@<version>` an.
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
| remote gelöscht | lokal nach `~/.local/share/proton-drive-sync/trash/<ordner>/<datum>/` |
| beim ersten Lauf auf beiden Seiten vorhanden | gleiche Prüfsumme → identisch, sonst Konflikt |
| Proton Docs / Sheets | werden ignoriert (nur online verfügbar) |

## Installation (Flake + Home Manager)

```nix
# flake.nix deiner NixOS-Konfiguration
inputs.proton-drive-sync = {
  url = "github:Memurame/protondrive-sync-nixos";
  inputs.nixpkgs.follows = "nixpkgs";
};

# im home-manager-Teil:
home-manager.sharedModules = [ proton-drive-sync.homeManagerModules.default ];
```

```nix
# home.nix
services.proton-drive-sync.enable = true;
```

Nach `nixos-rebuild switch` einmal anmelden und Ordner hinzufügen:

```sh
proton-drive-sync login                                      # Anmeldung im Browser
proton-drive-sync folder add Dokumente ~/Dokumente /Dokumente
proton-drive-sync status
proton-drive-sync log -f                                     # Änderungen live verfolgen
```

`folder add` und `login` starten den Agenten (systemd-User-Dienst `proton-drive-sync`) automatisch neu.

### Ordner deklarativ in Nix

```nix
services.proton-drive-sync = {
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
- **Eigene Sitzung:** Die Sitzung ist unabhängig vom offiziellen `proton-drive` CLI, nötig ist ein eigenes `proton-drive-sync login`.

## Befehle

```text
proton-drive-sync login | logout
proton-drive-sync folder list
proton-drive-sync folder add NAME LOKAL REMOTE [--exclude MUSTER]…
proton-drive-sync folder remove NAME
proton-drive-sync config [show] | config set SCHLÜSSEL WERT | config path
proton-drive-sync sync [-n|--dry-run] [--force] [--folder NAME]…
proton-drive-sync watch
proton-drive-sync status
proton-drive-sync log [-n ANZAHL] [-f]
proton-drive-sync reset NAME
proton-drive-sync version | help
```

Einstellbar mit `config set`: `debounce`, `fullScanHours`, `maxDeletes`, `exclude` (kommagetrennt), `credentialsStore`.

Läuft der Agent, stößt `sync` bei ihm einen vollständigen Abgleich an.

Temporäre Dateien (`*.part`, `*.tmp`, `*.swp`, `*~`, `.~lock.*#`, `~$*`, `.DS_Store`, `Thumbs.db`) werden immer ignoriert.

## Wo liegt was?

| Was | Ort |
|---|---|
| Konfiguration | `~/.config/proton-drive-sync/config.json` |
| Stand pro Ordner, Event-Stand, Status | `~/.local/state/proton-drive-sync/` |
| letzte Änderungen (`log`) | `~/.local/state/proton-drive-sync/activity.jsonl` |
| Agent-Ausgabe | `journalctl --user -u proton-drive-sync -f` |
| SDK-Log | `~/.local/state/proton-drive-sync/proton-drive.log` |
| SDK-Cache / Client-ID | `~/.cache/proton-drive-sync/`, `~/.local/share/proton-drive-sync/` |
| lokaler Papierkorb | `~/.local/share/proton-drive-sync/trash/` |
| Sitzung | Secret Service, Dienst `proton-drive-sync` (bzw. `pass`) |

## Umstieg von 0.5 (Python)

- **Config:** Die bestehende `config.json` wird weiter gelesen. Veraltete Schlüssel (`remotePoll`, `trayIcon`, `protonBin`) werden ignoriert.
- **Home Manager:** Die Optionen `remotePoll`, `trayIcon` und `protonPackage` sind entfernt. Home Manager meldet sie mit einem Hinweis.
- **Stand:** Der alte Sync-Stand wird nicht übernommen. Der erste Lauf vergleicht per Prüfsumme und überträgt nichts doppelt.
- **Anmeldung:** einmal neu mit `proton-drive-sync login`.
- **Oberfläche:** Die grafische Oberfläche (Einstellungsfenster, Übersicht, Taskleisten-Symbol) entfällt. Ersatz sind `status`, `log`,
  `folder` und `config`.

## Entwicklung

```sh
nix build                                       # Paket bauen
./result/bin/proton-drive-sync --config test.json sync -n
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
