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
, librsvg
}:

let
  protonDrive = callPackage ./nix/proton-drive-cli.nix { inherit proton-drive-cli; };
  python = python3.withPackages (ps: [ ps.pygobject3 ]);
in
stdenvNoCC.mkDerivation {
  pname = "proton-drive-sync";
  version = "0.5.1";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [ ./src ./icons ];
  };

  nativeBuildInputs = [ makeWrapper wrapGAppsHook4 gobject-introspection librsvg ];
  buildInputs = [ gtk4 libadwaita ];
  dontBuild = true;
  # wrapGAppsHook4 only collects the GTK environment; we apply it in our own wrapper.
  dontWrapGApps = true;

  installPhase = ''
    runHook preInstall
    for f in proton_drive_sync proton_drive_sync_gui proton_drive_sync_tray; do
      install -Dm644 src/$f.py $out/lib/proton-drive-sync/$f.py
    done

    # icons: SVG for themes/menus, pre-rendered PNGs for the tray (IconPixmap)
    for svg in icons/*.svg; do
      name=$(basename "$svg" .svg)
      install -Dm644 "$svg" "$out/share/icons/hicolor/scalable/apps/$name.svg"
      for size in 16 22 24 32 48 64 128 256; do
        mkdir -p "$out/share/icons/hicolor/''${size}x''${size}/apps"
        rsvg-convert -w $size -h $size "$svg" -o "$out/share/icons/hicolor/''${size}x''${size}/apps/$name.png"
      done
    done
    substituteInPlace $out/lib/proton-drive-sync/proton_drive_sync.py \
      --replace-fail '__version__ = "@VERSION@"' "__version__ = \"$version\""

    install -Dm644 /dev/stdin $out/share/applications/proton-drive-sync.desktop <<DESKTOP
    [Desktop Entry]
    Type=Application
    Name=Proton Drive Sync
    Comment=Ordner mit Proton Drive synchronisieren – Status und letzte Änderungen
    Exec=$out/bin/proton-drive-sync status
    Icon=proton-drive-sync
    Terminal=false
    Categories=Network;FileTransfer;
    StartupWMClass=io.github.protondrivesync.Activity
    Actions=settings;

    [Desktop Action settings]
    Name=Einstellungen
    Exec=$out/bin/proton-drive-sync config
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
