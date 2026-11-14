# proton-drive-sync: Bun/TypeScript-Agent direkt auf Protons Drive-SDK.
#
# Gebaut wird im Quellbaum des offiziellen Proton Drive CLI (ProtonDriveApps/sdk,
# MIT), das nixpkgs bereits als `proton-drive-cli` paketiert – inklusive der
# fest gehashten node_modules. Unser Code (./src) kommt nach cli/src/sync/ und
# nutzt die Initialisierung des CLI (Anmeldung, HTTP, Krypto, Cache) mit:
#   - eigener App-Kennung (x-pm-appversion: external-drive-proton_drive_sync@…),
#   - eigenem Datenverzeichnis (~/.cache|.local/share|.local/state/proton-drive-sync),
#   - eigenem Schlüsselbund-Eintrag (getrennte Sitzung vom offiziellen CLI).
{ lib
, proton-drive-cli
, inotify-tools
, makeWrapper
, glib
, libsecret
}:

let
  version = "0.6.0";
  channel = "beta";
in
proton-drive-cli.overrideAttrs (old: {
  pname = "proton-drive-sync";
  inherit version;
  # same SDK source as proton-drive-cli; only our version number differs
  __intentionallyOverridingVersion = true;
  # reuse the (binary-cached) node_modules of proton-drive-cli unchanged –
  # taken from the original package so name and hash stay identical
  passthru = old.passthru // { inherit (proton-drive-cli.passthru) nodeModules; };

  nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ makeWrapper ];

  postPatch = (old.postPatch or "") + ''
    # Ältere nixpkgs: exakte Bun-Version in engines lockern (no-op bei neueren)
    sed -i -E 's/"bun": "([0-9])/"bun": ">=\1/' package.json

    # eigene Datenverzeichnisse und eigener Sitzungsspeicher
    substituteInPlace src/config.ts \
      --replace-fail "const APP_DIR_NAME = 'proton-drive-cli';" "const APP_DIR_NAME = 'proton-drive-sync';"
    substituteInPlace src/credentials/constants.ts \
      --replace-fail "'ch.proton.drive/drive-sdk-cli'" "'proton-drive-sync'"

    mkdir -p src/sync
    cp ${./src}/*.ts src/sync/
  '';

  env = old.env // {
    CLI_APP_VERSION_NAME = "external-drive-proton_drive_sync";
    CLI_VERSION = "${version}-${channel}";
  };

  buildPhase = ''
    runHook preBuild
    CLI_OUTPUT_DIR=release bun ./scripts/build-cli.mjs src/sync/main.ts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 release/main $out/bin/proton-drive-sync
    runHook postInstall
  '';

  postInstall = ''
    wrapProgram $out/bin/proton-drive-sync \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ glib libsecret ]} \
      --suffix PATH : ${lib.makeBinPath [ inotify-tools ]}
  '';

  # versionCheckHook of the base package expects `proton-drive --version`
  doInstallCheck = false;

  meta = old.meta // {
    description = "Two-way sync agent between local folders and Proton Drive (unofficial, uses the Proton Drive SDK)";
    homepage = "https://github.com/Memurame/protondrive-sync-nixos";
    license = lib.licenses.mit;
    mainProgram = "proton-drive-sync";
    platforms = lib.platforms.linux;
  };
})
