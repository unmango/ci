import { test } from "node:test";
import assert from "node:assert/strict";
import { commands, run } from "../.github/actions/nix-build/build.mjs";

const nix = (...i) => ["nix", ["build", "--keep-going", "--no-link", ...i]];

test("commands builds packages then checks", () => {
  assert.deepEqual(commands({ packages: [".#packages.s.a"], checks: [".#checks.s.b"], push: false, cache: "c" }), [
    nix(".#packages.s.a"),
    nix(".#checks.s.b"),
  ]);
});

test("commands pushes only packages", () => {
  const [pkgs, checks] = commands({ packages: [".#packages.s.a"], checks: [".#checks.s.b"], push: true, cache: "c" });
  assert.deepEqual(pkgs, ["cachix", ["watch-exec", "c", "--", ...nix(".#packages.s.a").flat()]]);
  assert.deepEqual(checks, nix(".#checks.s.b"));
});

test("commands skips an empty list", () => {
  assert.deepEqual(commands({ packages: [], checks: [".#checks.s.b"], push: true, cache: "c" }), [nix(".#checks.s.b")]);
  assert.deepEqual(commands({ packages: [], checks: [], push: false, cache: "c" }), []);
});

function fake(codes) {
  const ran = [];
  const failed = [];
  return {
    ran,
    failed,
    exec: {
      async exec(cmd, args, opts) {
        assert.deepEqual(opts, { ignoreReturnCode: true });
        ran.push([cmd, args]);
        return codes.shift() ?? 0;
      },
      async getExecOutput() {
        throw new Error("unexpected");
      },
    },
    core: { setFailed: (m) => failed.push(m) },
  };
}

const inputs = { packages: '[".#packages.s.a"]', checks: '[".#checks.s.b"]', cache: "c" };

test("run builds checks even when packages fail, then fails", async () => {
  const f = fake([1, 0]);
  await run({ exec: f.exec, core: f.core, inputs, push: false });
  assert.equal(f.ran.length, 2);
  assert.deepEqual(f.failed, ["1 of 2 builds failed"]);
});

test("run passes when every build does", async () => {
  const f = fake([]);
  await run({ exec: f.exec, core: f.core, inputs, push: true });
  assert.equal(f.ran[0][0], "cachix");
  assert.deepEqual(f.failed, []);
});
