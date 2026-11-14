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
        description = "Ordner in Proton Drive, relativ zu „Meine Dateien“ (\"/\" = ganzes Drive).";
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
    inherit (cfg) credentialsStore maxDeletes debounce fullScanHours exclude;
    folders = lib.mapAttrsToList (name: f: { inherit name; inherit (f) local remote exclude; }) cfg.folders;
  });
in
{
  imports = [
    (lib.mkRemovedOptionModule [ "services" "proton-drive-sync" "remotePoll" ]
      "Remote-Änderungen kommen seit 0.6 als Drive-Events; siehe fullScanHours.")
    (lib.mkRemovedOptionModule [ "services" "proton-drive-sync" "trayIcon" ]
      "Die grafische Oberfläche wurde in 0.6 durch CLI-Befehle ersetzt (proton-drive-sync status / log).")
    (lib.mkRemovedOptionModule [ "services" "proton-drive-sync" "protonPackage" ]
      "Seit 0.6 nutzt proton-drive-sync das Drive-SDK direkt, das offizielle CLI wird nicht mehr gebraucht.")
  ];

  options.services.proton-drive-sync = {
    enable = mkEnableOption "den proton-drive-sync-Agenten";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "Das proton-drive-sync Paket.";
    };

    debounce = mkOption {
      type = types.ints.positive;
      default = 5;
      description = "Sekunden ohne weitere lokale Änderung, bevor synchronisiert wird.";
    };

    fullScanHours = mkOption {
      type = types.ints.positive;
      default = 24;
      description = ''
        Stunden zwischen zwei vollständigen Abgleichen des Ordnerbaums in Proton Drive.
        Dazwischen kommen Remote-Änderungen als Drive-Events an (Protons Vorgabe:
        event-basiert statt Polling).
      '';
    };

    credentialsStore = mkOption {
      type = types.enum [ "keychain" "pass" ];
      default = "keychain";
      description = ''
        Wo die Sitzung gespeichert wird: "keychain" = Secret Service (GNOME Keyring, KWallet),
        "pass" = password-store. Der Speicher muss entsperrt sein, solange der Agent läuft.
      '';
    };

    maxDeletes = mkOption {
      type = types.ints.positive;
      default = 50;
      description = ''
        Sicherheitsgrenze: Plant ein Lauf mehr Löschungen pro Ordner, wird er abgebrochen.
        Manuell mit `proton-drive-sync sync --force` übergehen.
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
        Leer lassen, um Ordner und Einstellungen mit `proton-drive-sync folder add …` /
        `proton-drive-sync config set …` zu verwalten – dann schreibt Home Manager keine Konfiguration.
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
    home.packages = [ cfg.package ];

    # Nur wenn Ordner in Nix definiert sind – sonst gehört die Datei dem CLI.
    xdg.configFile."proton-drive-sync/config.json" = mkIf managed { source = configFile; };

    systemd.user.services.proton-drive-sync = {
      Unit = {
        Description = "proton-drive-sync Agent";
        After = [ "network-online.target" ];
        Wants = [ "network-online.target" ];
        X-Restart-Triggers = lib.optional managed "${configFile}";
      };
      Service = {
        ExecStart = "${lib.getExe cfg.package} watch";
        # Ende ohne Fehler (z. B. noch keine Ordner) → nicht neu starten;
        # `folder add` / `login` starten den Dienst selbst wieder.
        Restart = "on-failure";
        RestartSec = 30;
        Nice = 10;
        IOSchedulingClass = "idle";
        Environment = [ "PROTON_DRIVE_LOG_LEVEL=INFO" ];
      };
      Install.WantedBy = [ "default.target" ];
    };
  };
}
