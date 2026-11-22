{
  description = "Reusable GitHub Actions workflows for Nix repositories";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    systems.url = "github:UnstoppableMango/nix-systems";

    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = import inputs.systems;

      imports = with inputs; [
        systems.flakeModule or { }
        treefmt-nix.flakeModule
      ];

      perSystem =
        { pkgs, lib, ... }:
        {
          checks.actions =
            pkgs.runCommand "actions-tests"
              {
                src = lib.fileset.toSource {
                  root = ./.;
                  fileset = lib.fileset.unions [
                    ./package.json
                    ./src
                    ./test
                    ./.github/actions
                  ];
                };
                nativeBuildInputs = [ pkgs.nodejs_24 ];
              }
              ''
                cd $src
                node --test 'test/*.test.mjs'
                touch $out
              '';

          devShells.default = pkgs.mkShellNoCC {
            packages = with pkgs; [
              nixfmt
              nodejs_24
            ];
          };

          treefmt.programs = {
            nixfmt.enable = true;
          };
        };
    };
}
