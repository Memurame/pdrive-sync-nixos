{
  description = "Zwei-Wege-Sync-Agent für Proton Drive (inoffiziell, auf Protons Drive-SDK)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Fester Stand nur für den Paket-Build: Das Drive-SDK (proton-drive-cli in
    # nixpkgs) bringt fest gehashte node_modules mit, die nur zur Bun-Version
    # desselben nixpkgs-Stands passen. Getrennt von `nixpkgs`, damit
    # `inputs.nixpkgs.follows = "nixpkgs"` den Build nicht verändert.
    nixpkgs-sdk.url = "github:NixOS/nixpkgs/d4f25a3e562008648d45bcf2d70bcc7422cad84e";
  };

  outputs = { self, nixpkgs, nixpkgs-sdk }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems f;
    in
    {
      packages = forAll (system: rec {
        proton-drive-sync = nixpkgs-sdk.legacyPackages.${system}.callPackage ./package.nix { };
        default = proton-drive-sync;
      });

      overlays.default = final: _prev: {
        proton-drive-sync = self.packages.${final.stdenv.hostPlatform.system}.default;
      };

      homeManagerModules.default = import ./hm-module.nix self;
      homeManagerModules.proton-drive-sync = self.homeManagerModules.default;
    };
}
