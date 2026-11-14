{ lib
, stdenvNoCC
, python3
, makeWrapper
, wrapGAppsHook4
, gobject-introspection
, gtk4
, libadwaita
, callPackage
, proton-drive-cli
, inotify-tools
}:

let
  protonDrive = callPackage ./nix/proton-drive-cli.nix { inherit proton-drive-cli; };
  python = python3.withPackages (ps: [ ps.pygobject3 ]);
in
stdenvNoCC.mkDerivation {
  pname = "proton-drive-sync";
  version = "0.4.4";
  src = ./src;

  nativeBuildInputs = [ makeWrapper wrapGAppsHook4 gobject-introspection ];
  buildInputs = [ gtk4 libadwaita ];
  dontBuild = true;
  # wrapGAppsHook4 only collects the GTK environment; we apply it in our own wrapper.
  dontWrapGApps = true;

  installPhase = ''
    runHook preInstall
    install -Dm644 proton_drive_sync.py     $out/lib/proton-drive-sync/proton_drive_sync.py
    install -Dm644 proton_drive_sync_gui.py $out/lib/proton-drive-sync/proton_drive_sync_gui.py
    substituteInPlace $out/lib/proton-drive-sync/proton_drive_sync.py \
      --replace-fail '__version__ = "@VERSION@"' "__version__ = \"$version\""

    install -Dm644 /dev/stdin $out/share/applications/proton-drive-sync.desktop <<DESKTOP
    [Desktop Entry]
    Type=Application
    Name=Proton Drive Sync
    Comment=Ordner mit Proton Drive synchronisieren – Einstellungen
    Exec=$out/bin/proton-drive-sync config
    Icon=folder-remote
    Terminal=false
    Categories=Network;FileTransfer;Settings;
    DESKTOP
    runHook postInstall
  '';

  postFixup = ''
    makeWrapper ${python}/bin/python3 $out/bin/proton-drive-sync \
      --add-flags "$out/lib/proton-drive-sync/proton_drive_sync.py" \
      --suffix PATH : ${lib.makeBinPath [ protonDrive inotify-tools ]} \
      "''${gappsWrapperArgs[@]}"
  '';

  passthru.proton-drive = protonDrive;

  meta = {
    description = "Two-way sync agent between local folders and Proton Drive";
    mainProgram = "proton-drive-sync";
    license = lib.licenses.mit;
    homepage = "https://github.com/Memurame/protondrive-sync-nixos";
    platforms = lib.platforms.linux;
  };
}
