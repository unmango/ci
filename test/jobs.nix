# Pure eval tests for drv-diff's jobs.nix, built as a flake check.
{ runCommand, lib }:
let
  jobs = import ../.github/actions/drv-diff/jobs.nix;
  names = lib.mapAttrs (_: lib.mapAttrs (_: lib.attrNames));
  select = outputs: args: names (jobs ({ inherit outputs; } // args));

  each = {
    a = 1;
    b = 2;
    c = 3;
  };
  plain = {
    packages = {
      x86_64-linux = each;
      riscv64-linux = each;
      aarch64-darwin = {
        a = 1;
        c = 3;
        d = 4;
      };
    };
    checks.x86_64-linux.fmt = 1;
  };
  # What flakeModules.ci makes of exclude.packages = [ "c" ] and nightly.packages = [ "b" ].
  withLists = plain // {
    herculesCI = {
      ciSystems = [ "x86_64-linux" ];
      onPush.default.outputs = {
        packages.x86_64-linux.a = 1;
        checks.x86_64-linux.fmt = 1;
      };
      onSchedule.nightly.outputs = {
        packages.x86_64-linux.b = 2;
        checks.x86_64-linux = { };
        devShells.x86_64-linux = { };
      };
    };
  };
  systems = "x86_64-linux aarch64-darwin";

  results = lib.runTests {
    testPlainTakesEverythingOnTheWantedSystems = {
      expr = select plain { inherit systems; };
      expected = {
        checks.x86_64-linux = [ "fmt" ];
        packages = {
          x86_64-linux = [
            "a"
            "b"
            "c"
          ];
          aarch64-darwin = [
            "a"
            "c"
            "d"
          ];
        };
      };
    };
    testCiSystemsAloneIsNoList = {
      expr =
        (select (plain // { herculesCI.ciSystems = [ "x86_64-linux" ]; }) { inherit systems; })
        .packages.x86_64-linux;
      expected = [
        "a"
        "b"
        "c"
      ];
    };
    testDiffDropsExcludedAndNightly = {
      expr = select withLists { inherit systems; };
      expected = {
        checks.x86_64-linux = [ "fmt" ];
        packages = {
          x86_64-linux = [ "a" ];
          # d isn't on the reference system, so no list names it.
          aarch64-darwin = [
            "a"
            "d"
          ];
        };
      };
    };
    testFullAddsNightly = {
      expr =
        (select withLists {
          inherit systems;
          full = "true";
        }).packages;
      expected = {
        x86_64-linux = [
          "a"
          "b"
        ];
        aarch64-darwin = [
          "a"
          "d"
        ];
      };
    };
  };
in
if results == [ ] then
  runCommand "jobs-nix-tests" { } "touch $out"
else
  throw "jobs.nix tests failed: ${builtins.toJSON results}"
