self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.proton-drive-sync;
  managed = cfg.folders != { };
  inherit (lib) mkOption mkEnableOption types mkIf;

  folderType = types.submodule ({ name, ... }: {
    options = {
      local = mkOption {
        type = types.str;
        description = "Lokaler Ordner (absolut oder mit ~).";
        example = "~/Proton/Dokumente";
      };
      remote = mkOption {
        type = types.str;
        default = "/${name}";
        description = "Ordner in Proton Drive, relativ zu „Meine Dateien“ (/my-files kann weggelassen werden).";
        example = "/Dokumente";
      };
      exclude = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Zusätzliche Glob-Muster, die nur für diesen Ordner ignoriert werden.";
      };
    };
  });

  configFile = pkgs.writeText "proton-drive-sync.json" (builtins.toJSON {
    protonBin = lib.getExe' cfg.protonPackage "proton-drive";
    credentialsStore = cfg.credentialsStore;
    maxDeletes = cfg.maxDeletes;
    debounce = cfg.debounce;
    remotePoll = cfg.remotePoll;
    trayIcon = cfg.trayIcon;
    exclude = cfg.exclude;
    folders = lib.mapAttrsToList (name: f: { inherit name; inherit (f) local remote exclude; }) cfg.folders;
  });
in
{
  options.services.proton-drive-sync = {
    enable = mkEnableOption "den Proton-Drive-Sync-Agenten";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "Das proton-drive-sync Paket.";
    };

    protonPackage = mkOption {
      type = types.package;
      default = pkgs.callPackage ./nix/proton-drive-cli.nix { };
      defaultText = lib.literalExpression "pkgs.proton-drive-cli (mit Bun-Versions-Fix)";
      description = "Paket mit dem offiziellen Proton Drive CLI (`proton-drive`).";
    };

    debounce = mkOption {
      type = types.ints.positive;
      default = 5;
      description = "Sekunden ohne weitere lokale Änderung, bevor synchronisiert wird.";
    };

    remotePoll = mkOption {
      type = types.ints.positive;
      default = 60;
      description = ''
        Sekunden zwischen zwei Abfragen von Proton Drive. Remote-Änderungen kommen
        nicht als Ereignis an, sondern werden in diesem Abstand abgefragt.
      '';
    };

    trayIcon = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Symbol in der Taskleiste (StatusNotifierItem) mit Status, letzten Änderungen und Menü.
        Unter GNOME wird die Erweiterung „AppIndicator“ benötigt.
      '';
    };

    credentialsStore = mkOption {
      type = types.nullOr (types.enum [ "keychain" "pass" ]);
      default = null;
      description = ''
        Wo `proton-drive` die Sitzung speichert (PROTON_DRIVE_CREDENTIALS_STORE).
        null/"keychain" = Secret Service (GNOME Keyring, KWallet), "pass" = password-store.
        Der Schlüsselbund muss entsperrt sein, solange der Agent läuft.
      '';
    };

    maxDeletes = mkOption {
      type = types.int;
      default = 50;
      description = ''
        Sicherheitsgrenze: Plant ein Lauf mehr Löschungen pro Ordner, wird er abgebrochen.
        Manuell mit `proton-drive-sync run --force` übergehen.
      '';
    };

    exclude = mkOption {
      type = types.listOf types.str;
      default = [ ".git" "node_modules" ];
      description = "Glob-Muster (Name oder relativer Pfad), die nie synchronisiert werden.";
    };

    folders = mkOption {
      type = types.attrsOf folderType;
      default = { };
      description = ''
        Zu synchronisierende Ordner. Der Attributname dient als ID.
        Leer lassen, um alles im grafischen Einrichtungsassistenten festzulegen
        (`proton-drive-sync config`). Dann schreibt Home Manager keine Konfiguration.
      '';
      example = lib.literalExpression ''
        {
          Dokumente = { local = "~/Proton/Dokumente"; remote = "/Dokumente"; };
          Fotos     = { local = "~/Bilder/Proton"; remote = "/Photos"; exclude = [ "*.xmp" ]; };
        }
      '';
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package cfg.protonPackage ];

    # Nur wenn Ordner in Nix definiert sind – sonst gehört die Datei dem Assistenten.
    xdg.configFile."proton-drive-sync/config.json" = mkIf managed { source = configFile; };

    systemd.user.services.proton-drive-sync = {
      Unit = {
        Description = "Proton Drive Sync Agent";
        # grafische Sitzung, damit der Assistent beim ersten Start ein Fenster öffnen kann
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
        X-Restart-Triggers = lib.optional managed "${configFile}";
      };
      Service = {
        ExecStart = "${lib.getExe cfg.package} watch";
        # Ende ohne Fehler (z. B. Assistent abgebrochen) → nicht neu starten
        Restart = "on-failure";
        RestartSec = 30;
        Nice = 10;
        IOSchedulingClass = "idle";
        Environment = [ "PROTON_DRIVE_LOG_LEVEL=INFO" "PYTHONUNBUFFERED=1" ];
      };
      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
