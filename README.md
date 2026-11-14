# proton-drive-sync

Zwei-Wege-Sync zwischen lokalen Ordnern und [Proton Drive](https://proton.me/drive) für **NixOS / Home Manager**.
Läuft als Hintergrund-Agent, überwacht deine Ordner und gleicht Änderungen in beide Richtungen ab.

Alle Zugriffe auf Proton laufen über das **offizielle** [Proton Drive CLI](https://github.com/ProtonDriveApps/sdk/tree/main/cli)
(`proton-drive`, in nixpkgs als `proton-drive-cli`). Es werden keine Zugangsdaten an Dritte weitergegeben.

> **Status:** experimentell. Das offizielle CLI ist noch vor Version 1.0. Lege vor dem ersten Sync wichtiger Daten ein Backup an.

## Funktionen

- **Agent mit Dateiwächter:** Ein systemd-User-Dienst überwacht die lokalen Ordner per inotify. 5 Sekunden nach der letzten
  Änderung (`debounce`) wird synchronisiert.
- **Remote-Abfrage:** Proton liefert dem CLI keine Benachrichtigungen. Der Agent fragt Proton Drive deshalb alle 60 Sekunden ab (`remotePoll`).
- **Echter Zwei-Wege-Abgleich:** Jeder Lauf vergleicht lokal, remote und den Stand nach dem letzten Lauf. So ist klar, auf welcher
  Seite sich etwas geändert hat.
- **Taskleisten-Symbol und Übersicht** (optional): Das Symbol zeigt den Status. Sein Menü bietet „Aktivität anzeigen“, „Jetzt synchronisieren“
  und „Einstellungen“. Die Übersicht zeigt jeden Ordner und die letzten Änderungen (hoch- und heruntergeladen, gelöscht, Konflikte, Fehler).
- **Einstellungen auf einer Seite** (GTK4/libadwaita): Anmeldung, Ordnerauswahl (lokal und in Proton Drive), Zeitverhalten, Ausnahmen,
  Taskleisten-Symbol. Alternativ lässt sich alles deklarativ in Nix festlegen.
- **Sicherheitsnetz:** Löschungen landen im Proton-Papierkorb bzw. in einem lokalen Papierkorb. Ein Lösch-Limit pro Lauf verhindert,
  dass z. B. ein nicht eingehängtes Laufwerk alles remote löscht.

### Was in welchem Fall passiert

| Situation | Aktion |
|---|---|
| nur lokal neu/geändert | Upload (bei Änderung als neue Revision) |
| nur remote neu/geändert | Download |
| beide Seiten geändert | **Konflikt:** Die lokale Version wird zu `name (Konflikt <host> <datum>).ext` und hochgeladen, die Remote-Version behält den Namen |
| lokal gelöscht | remote in den **Proton-Papierkorb** |
| remote gelöscht | lokal nach `~/.local/share/proton-drive-sync/trash/<ordner>/<datum>/` |
| beim ersten Lauf auf beiden Seiten vorhanden | gleiche Größe → Inhalt vergleichen, sonst Konflikt |
| Proton Docs / Sheets | werden ignoriert (nur online verfügbar) |

Plant ein Lauf mehr als `maxDeletes` Löschungen oder fehlt ein bereits synchronisierter Ordner, wird der Ordner übersprungen.
Mit `proton-drive-sync run --force` lässt sich das bewusst übergehen.

## Installation (Flake + Home Manager)

```nix
# flake.nix deiner NixOS-Konfiguration
inputs.proton-drive-sync = {
  url = "github:Memurame/protondrive-sync-nixos";
  inputs.nixpkgs.follows = "nixpkgs";
};

outputs = { self, nixpkgs, home-manager, proton-drive-sync, ... }: {
  # ...
  # im home-manager-Teil:
  home-manager.sharedModules = [ proton-drive-sync.homeManagerModules.default ];
};
```

### Variante A: Einrichtung per Einstellungsfenster

```nix
# home.nix
services.proton-drive-sync.enable = true;
```

Nach `nixos-rebuild switch` startet der Agent mit der grafischen Sitzung. Findet er keine Konfiguration, öffnen sich die Einstellungen.
Alles steht auf einer Seite:

- **Konto:** Anmeldestatus. „Anmelden“ öffnet den Proton-Login im Browser. Wähle außerdem, wo die Sitzung gespeichert wird (Schlüsselbund oder `pass`).
- **Ordner:** lokalen Ordner auswählen und den Zielordner in Proton Drive durchsuchen oder eintippen. Fehlende Remote-Ordner werden angelegt.
- **Zeitverhalten, Sicherheit, Ausnahmen:** Verzögerung, Abfrageintervall, Lösch-Limit.
- **Darstellung:** Symbol in der Taskleiste ein oder aus.

Die Einstellungen landen in `~/.config/proton-drive-sync/config.json`. Nach dem Speichern startet der Agent neu.

**Proton Drive Sync** im App-Menü öffnet die Übersicht mit Status und letzten Änderungen. Von dort (Zahnrad) oder über
`proton-drive-sync config` erreichst du die Einstellungen.

### Variante B: deklarativ in Nix

```nix
# home.nix
services.proton-drive-sync = {
  enable = true;
  debounce = 5;          # Sekunden Ruhe nach einer lokalen Änderung
  remotePoll = 60;       # Sekunden zwischen zwei Abfragen von Proton Drive
  maxDeletes = 50;       # Sicherheitsgrenze pro Lauf
  exclude = [ ".git" "node_modules" ];
  # credentialsStore = "pass";   # Standard: Schlüsselbund (Secret Service)
  folders = {
    Dokumente = { local = "~/Proton/Dokumente"; remote = "/Dokumente"; };
    Bilder    = { local = "~/Bilder/Proton";   remote = "/Bilder"; exclude = [ "*.xmp" ]; };
  };
};
```

Sind `folders` gesetzt, verwaltet Home Manager die Konfiguration. Das Einstellungsfenster zeigt sie dann nur an.
Remote-Pfade sind relativ zu „Meine Dateien“: `/Dokumente` entspricht `/my-files/Dokumente`.
Mit `remote = "/"` wird das ganze Proton Drive synchronisiert. „Für mich freigegeben“ und Geräte gehören nicht dazu.
Ordner dürfen sich nicht überschneiden, also z. B. nicht `/` und zusätzlich `/Dokumente`.

Einmalig anmelden:

```sh
proton-drive auth login
```

### Voraussetzungen

- **Anmeldung:** Das offizielle CLI speichert die Sitzung im **Secret Service** (GNOME Keyring, KWallet, …) oder in
  [`pass`](https://www.passwordstore.org/). Der Speicher muss entsperrt sein, solange der Agent läuft.
  Unter Fenstermanagern wie Hyprland oder Sway z. B. `services.gnome-keyring.enable = true;` setzen.
- **Grafische Sitzung:** Für Einstellungsfenster und Taskleisten-Symbol braucht der Dienst `WAYLAND_DISPLAY`/`DISPLAY`. Das HM-Modul für Hyprland, Sway und GNOME
  importiert diese Variablen standardmäßig in die systemd-User-Umgebung.

## Optionen

| Option | Standard | Beschreibung |
|---|---|---|
| `enable` | `false` | Agent aktivieren |
| `folders.<name>.local` | – | lokaler Ordner (absolut oder mit `~`) |
| `folders.<name>.remote` | `/<name>` | Ordner in Proton Drive |
| `folders.<name>.exclude` | `[ ]` | zusätzliche Ausnahmen für diesen Ordner |
| `debounce` | `5` | Sekunden Ruhe nach lokaler Änderung |
| `remotePoll` | `60` | Sekunden zwischen Remote-Abfragen |
| `maxDeletes` | `50` | maximale Löschungen pro Lauf und Ordner |
| `exclude` | `[ ".git" "node_modules" ]` | Glob-Muster (Name oder relativer Pfad), die nie synchronisiert werden |
| `credentialsStore` | `null` (Schlüsselbund) | `"keychain"` oder `"pass"` |
| `trayIcon` | `true` | Symbol in der Taskleiste (StatusNotifierItem). Unter GNOME ist die Erweiterung „AppIndicator“ nötig |
| `package` / `protonPackage` | aus diesem Flake | eigene Pakete |

Temporäre Dateien (`*.part`, `*.tmp`, `*.swp`, `*~`, `.~lock.*#`, `~$*`, `.DS_Store`, `Thumbs.db`) werden immer ignoriert.

## Befehle

```text
proton-drive-sync watch  [--debounce S] [--poll S] [--folder NAME]…   Agent (so läuft der Dienst)
proton-drive-sync run    [-n|--dry-run] [--force] [--folder NAME]…    einmaliger Lauf
proton-drive-sync config                                              Einstellungen öffnen
proton-drive-sync status                                              Übersicht (Status, letzte Änderungen) öffnen
proton-drive-sync tray                                                Taskleisten-Symbol (startet sonst der Agent selbst)
proton-drive-sync folders                                             Ordner und ihr Stand
proton-drive-sync reset NAME                                          gespeicherten Stand vergessen
proton-drive-sync --version                                           installierte Version anzeigen
```

`run` beendet sich, solange der Agent läuft. Alle Befehle akzeptieren `--config PFAD`.

## Wo liegt was?

| Was | Ort |
|---|---|
| Konfiguration | `~/.config/proton-drive-sync/config.json` |
| Logs des Agenten | `journalctl --user -u proton-drive-sync -f` |
| Stand pro Ordner | `~/.local/state/proton-drive-sync/<name>.json` |
| Status / letzte Änderungen (für Symbol und Übersicht) | `~/.local/state/proton-drive-sync/status.json`, `activity.jsonl` |
| lokaler Papierkorb | `~/.local/share/proton-drive-sync/trash/` |
| Log des Proton CLI | `~/.local/state/proton-drive-cli/proton-drive.log` |
| Cache / App-Daten des Proton CLI | `~/.cache/proton-drive-cli/`, `~/.local/share/proton-drive-cli/` |

## Wie funktioniert der Abgleich?

- **Lokal:** inotify meldet Änderungen. Nach `debounce` Sekunden Ruhe vergleicht der Agent den Ordner mit dem gespeicherten Stand.
  Eigene Downloads lösen dadurch keinen neuen Lauf aus.
- **Remote:** Alle `remotePoll` Sekunden liest der Agent den Ordnerbaum mit `proton-drive filesystem list --json`, einmal pro Ordner.
  Als Fingerprint einer Datei dient die ID ihrer aktiven Revision. Jeder Upload, egal von welchem Gerät, erzeugt eine neue.
  Bei großen Ordnerbäumen empfiehlt sich ein höherer `remotePoll`-Wert.

## Entwicklung

```sh
nix build                              # Paket bauen
nix run . -- --config test.json run -n # Probelauf mit eigener Konfiguration
nix run . -- config                    # Einstellungen öffnen
nix run . -- status                    # Übersicht öffnen
nix run .#proton-drive -- auth login   # offizielles CLI direkt
```

Aufbau:

- `src/proton_drive_sync.py`: Sync-Logik, Agent und CLI (nur Python-Standardbibliothek)
- `src/proton_drive_sync_gui.py`: Einstellungen (PyGObject, GTK4, libadwaita)
- `src/proton_drive_sync_tray.py`: Taskleisten-Symbol (StatusNotifierItem/DBusMenu über Gio) und Übersicht
- `icons/`: eigene Symbole (Wolke, je Zustand). Beim Build in mehreren Größen gerendert, für die Taskleiste als Pixmap übertragen
- `package.nix`: Paket. `inotify-tools` und das Proton CLI sind im `PATH` enthalten
- `nix/proton-drive-cli.nix`: `proton-drive-cli` aus nixpkgs. Ältere nixpkgs-Stände legen die Bun-Version exakt fest und brechen
  sonst den Build ab; hier wird die Vorgabe auf eine Mindestversion gelockert
- `hm-module.nix`: Home-Manager-Modul

## Lizenz

[MIT](LICENSE). Dieses Projekt ist kein offizielles Produkt von Proton AG.
