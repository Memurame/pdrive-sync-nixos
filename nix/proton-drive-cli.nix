# Offizielles Proton Drive CLI (pkgs.proton-drive-cli) mit einer Absicherung:
# Ältere nixpkgs-Stände bauen es nicht, weil cli/package.json "engines.bun"
# exakt auf eine Version pinnt (z. B. "1.4.2") und scripts/build-cli.mjs bei
# jeder anderen Bun-Version abbricht. Wir lockern einen exakten Pin auf
# ">=<version>". Neuere nixpkgs haben das bereits ("^1.…") – dann ändert der
# sed-Aufruf nichts.
{ proton-drive-cli }:

proton-drive-cli.overrideAttrs (old: {
  postPatch = (old.postPatch or "") + ''
    sed -i -E 's/"bun": "([0-9])/"bun": ">=\1/' package.json
  '';
})
