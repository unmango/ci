import { test } from "node:test";
import assert from "node:assert/strict";
import { baseSha, evalArgs, installable, parseJobs, plan, run } from "../.github/actions/drv-diff/diff.mjs";

/** One nix-eval-jobs line. */
const job = (type, system, name, drv, extra = {}) => ({
  attr: `${type}.${system}.${name}`,
  attrPath: [type, system, name],
  drvPath: `/nix/store/${drv}-${name}.drv`,
  system,
  ...extra,
});
const broken = (type, system, name, error) => ({ attr: `${type}.${system}.${name}`, attrPath: [type, system, name], error });
const jsonl = (...jobs) => jobs.map((j) => JSON.stringify(j)).join("\n") + "\n";

test("parseJobs reads one job per line and skips blank lines", () => {
  const jobs = parseJobs(jsonl(job("packages", "x86_64-linux", "a", "1"), broken("checks", "x86_64-linux", "b", "boom")) + "\n");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].error, "boom");
});

test("installable quotes segments that aren't plain identifiers", () => {
  assert.equal(installable(["packages", "x86_64-linux", "hello"]), ".#packages.x86_64-linux.hello");
  assert.equal(installable(["packages", "x86_64-linux", "foo.bar"]), '.#packages.x86_64-linux."foo.bar"');
  assert.equal(installable(["checks", "aarch64-darwin", "1.37"]), '.#checks.aarch64-darwin."1.37"');
});

const base = [
  job("packages", "x86_64-linux", "a", "1"),
  job("packages", "x86_64-linux", "b", "1"),
  job("packages", "aarch64-darwin", "a", "1"),
  job("checks", "x86_64-linux", "fmt", "1"),
];

test("an unchanged head builds nothing", () => {
  const p = plan(base, base);
  assert.deepEqual(p.matrix, []);
  assert.deepEqual(p.errors, []);
});

test("only outputs whose drv changed or are new are built, per system", () => {
  const head = [
    job("packages", "x86_64-linux", "a", "2"),
    job("packages", "x86_64-linux", "b", "1"),
    job("packages", "aarch64-darwin", "a", "2"),
    job("checks", "x86_64-linux", "fmt", "1"),
    job("checks", "x86_64-linux", "new", "1"),
  ];
  assert.deepEqual(plan(head, base).matrix, [
    {
      system: "aarch64-darwin",
      runner: "macos-latest",
      packages: [".#packages.aarch64-darwin.a"],
      checks: [],
    },
    {
      system: "x86_64-linux",
      runner: "ubuntu-latest",
      packages: [".#packages.x86_64-linux.a"],
      checks: [".#checks.x86_64-linux.new"],
    },
  ]);
});

test("with no base everything is built", () => {
  const p = plan(base, null);
  assert.deepEqual(
    p.matrix.map((m) => [m.system, m.packages.length + m.checks.length]),
    [
      ["aarch64-darwin", 1],
      ["x86_64-linux", 3],
    ],
  );
});

test("aarch64-linux runs on the hosted arm runner", () => {
  assert.equal(plan([job("packages", "aarch64-linux", "a", "1")], null).matrix[0].runner, "ubuntu-24.04-arm");
});

test("a head eval error is reported unless base failed the same way", () => {
  const head = [...base, broken("packages", "x86_64-linux", "c", "new"), broken("packages", "x86_64-linux", "d", "old")];
  const p = plan(head, [...base, broken("packages", "x86_64-linux", "d", "old")]);
  assert.deepEqual(p.errors, [{ attr: "packages.x86_64-linux.c", error: "new" }]);
  assert.deepEqual(p.matrix, []);
});

test("errors differing only in their trace count as the same", () => {
  const at = (h, line) =>
    `error:\n  … while calling the 'throw' builtin\n  at /nix/store/${h.repeat(32)}-source/flake.nix:4:74:\n  3| ${line}\n\n  \x1b[31;1merror:\x1b[0m nope /nix/store/${h.repeat(32)}-x`;
  const p = plan([broken("packages", "x86_64-linux", "d", at("a", "one"))], [broken("packages", "x86_64-linux", "d", at("b", "two"))]);
  assert.deepEqual(p.errors, []);
  const q = plan([broken("packages", "x86_64-linux", "d", "error: new")], [broken("packages", "x86_64-linux", "d", "error: old")]);
  assert.equal(q.errors.length, 1);
  const r = plan([broken("packages", "x86_64-linux", "d", "missing 'foo'")], [broken("packages", "x86_64-linux", "d", "missing 'bar'")]);
  assert.equal(r.errors.length, 1);
});

test("with no base every eval error is reported", () => {
  assert.equal(plan([broken("packages", "x86_64-linux", "d", "old")], null).errors.length, 1);
});

test("a system with no hosted runner is an error", () => {
  const p = plan([job("packages", "x86_64-darwin", "a", "1")], null);
  assert.deepEqual(p.matrix, []);
  assert.deepEqual(p.errors, [{ attr: "packages.x86_64-darwin.a", error: "no hosted runner for x86_64-darwin" }]);
});

function fakeCore() {
  const outputs = {};
  const failed = [];
  const warnings = [];
  let summary = "";
  return {
    outputs,
    failed,
    warnings,
    get summary() {
      return { addRaw: (t) => ((summary += t), { write: async () => {} }) };
    },
    text: () => summary,
    info() {},
    warning: (m) => warnings.push(m),
    setOutput: (k, v) => (outputs[k] = v),
    setFailed: (m) => failed.push(m),
  };
}

const inputs = { head: "/w", systems: "x86_64-linux", full: "false", token: "t", "action-path": "/a/drv-diff" };
const pr = { eventName: "pull_request", payload: { pull_request: { base: { sha: "b1" } } } };
const HEAD = "git+file:///w";
const BASE = "git+file:///w?rev=b1&shallow=1";

test("baseSha diffs a PR against its base and a push against before", () => {
  assert.equal(baseSha(pr, false), "b1");
  assert.equal(baseSha({ eventName: "push", payload: { before: "b0", created: false } }, false), "b0");
});

test("baseSha builds everything for a new branch, a schedule, a manual run, or full", () => {
  assert.equal(baseSha({ eventName: "push", payload: { before: "0".repeat(40), created: true } }, false), "");
  assert.equal(baseSha({ eventName: "schedule", payload: {} }, false), "");
  assert.equal(baseSha({ eventName: "workflow_dispatch", payload: {} }, false), "");
  assert.equal(baseSha(pr, true), "");
});

/** nix-eval-jobs output, or a failure, per flake; git fetch fails when `fetch` is false. */
function fakeExec(out, { fetch = true } = {}) {
  const calls = [];
  return {
    calls,
    async exec() {
      throw new Error("unexpected exec");
    },
    async getExecOutput(cmd, args, opts) {
      assert.deepEqual(opts, { silent: true, ignoreReturnCode: true });
      calls.push([cmd, args]);
      if (cmd === "git") {
        assert.deepEqual(args.slice(0, 3), ["-C", "/w", "-c"]);
        assert.equal(args[3], `http.extraheader=AUTHORIZATION: basic ${btoa("x-access-token:t")}`);
        assert.deepEqual(args.slice(4), ["fetch", "--depth", "1", "origin", "b1"]);
        return fetch ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 128, stdout: "", stderr: "not our ref" };
      }
      assert.equal(cmd, "nix");
      const stdout = out[args[args.indexOf("flake") + 1]];
      return stdout === undefined ? { exitCode: 1, stdout: "", stderr: "eval broke" } : { exitCode: 0, stdout, stderr: "" };
    },
  };
}

test("evalArgs runs this repo's nix-eval-jobs over jobs.nix", () => {
  const args = evalArgs({ actionPath: "/a/drv-diff", flake: HEAD, systems: "x86_64-linux aarch64-darwin", full: true });
  assert.deepEqual(args.slice(0, 5), ["run", "--inputs-from", "path:/a/drv-diff/../../..", "nixpkgs#nix-eval-jobs", "--"]);
  assert.equal(args.at(-1), "/a/drv-diff/jobs.nix");
  assert.deepEqual(args.slice(args.indexOf("flake") - 1, args.indexOf("flake") + 2), ["--argstr", "flake", HEAD]);
  assert.deepEqual(args.slice(args.indexOf("full") - 1, args.indexOf("full") + 2), ["--arg", "full", "true"]);
  assert.equal(args[args.indexOf("systems") + 1], "x86_64-linux aarch64-darwin");
});

test("run fetches the base and builds what changed", async () => {
  const core = fakeCore();
  const exec = fakeExec({ [HEAD]: jsonl(...base.slice(1), job("packages", "x86_64-linux", "a", "2")), [BASE]: jsonl(...base) });
  await run({ exec, core, context: pr, inputs });
  assert.deepEqual(JSON.parse(core.outputs.matrix), [
    { system: "x86_64-linux", runner: "ubuntu-latest", packages: [".#packages.x86_64-linux.a"], checks: [] },
  ]);
  assert.match(core.text(), /packages\.x86_64-linux\.a/);
  assert.deepEqual(core.failed, []);
  assert.deepEqual(exec.calls.map(([cmd]) => cmd), ["nix", "git", "nix"]);
});

test("run with no base builds everything, with the nightly list", async () => {
  const core = fakeCore();
  const exec = fakeExec({ [HEAD]: jsonl(...base) });
  await run({ exec, core, context: { eventName: "schedule", payload: {} }, inputs });
  assert.equal(JSON.parse(core.outputs.matrix).length, 2);
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0][1][exec.calls[0][1].indexOf("full") + 1], "true");
});

test("run builds everything when the base can't be fetched", async () => {
  const core = fakeCore();
  await run({ exec: fakeExec({ [HEAD]: jsonl(...base) }, { fetch: false }), core, context: pr, inputs });
  assert.equal(JSON.parse(core.outputs.matrix).length, 2);
  assert.match(core.warnings[0], /not our ref/);
});

test("run builds everything when the base fails to evaluate", async () => {
  const core = fakeCore();
  await run({ exec: fakeExec({ [HEAD]: jsonl(...base) }), core, context: pr, inputs });
  assert.equal(JSON.parse(core.outputs.matrix).length, 2);
  assert.match(core.warnings[0], /eval broke/);
  assert.deepEqual(core.failed, []);
});

test("run throws when the head fails to evaluate", async () => {
  await assert.rejects(run({ exec: fakeExec({}), core: fakeCore(), context: pr, inputs }), /eval broke/);
});

test("run says when nothing changed", async () => {
  const core = fakeCore();
  await run({ exec: fakeExec({ [HEAD]: jsonl(...base), [BASE]: jsonl(...base) }), core, context: pr, inputs });
  assert.equal(core.outputs.matrix, "[]");
  assert.match(core.text(), /Nothing to build/);
});

test("run fails on eval errors but still sets the matrix", async () => {
  const core = fakeCore();
  const head = jsonl(job("packages", "x86_64-linux", "a", "2"), broken("packages", "x86_64-linux", "c", "boom"));
  await run({ exec: fakeExec({ [HEAD]: head, [BASE]: jsonl(...base) }), core, context: pr, inputs });
  assert.equal(JSON.parse(core.outputs.matrix).length, 1);
  assert.equal(core.failed.length, 1);
  assert.match(core.text(), /boom/);
});
