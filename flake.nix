{
  description = "Intervall-basierter Zwei-Wege-Sync für Proton Drive (über das offizielle Proton Drive CLI)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      packages = forAll (pkgs: rec {
        proton-drive-sync = pkgs.callPackage ./package.nix { };
        proton-drive = pkgs.callPackage ./nix/proton-drive-cli.nix { };
        default = proton-drive-sync;
      });

      overlays.default = final: _prev: {
        proton-drive-sync = final.callPackage ./package.nix { };
      };

      homeManagerModules.default = import ./hm-module.nix self;
      homeManagerModules.proton-drive-sync = self.homeManagerModules.default;
    };
}
