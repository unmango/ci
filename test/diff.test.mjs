import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installable, parseJobs, plan, run } from "../.github/actions/drv-diff/diff.mjs";

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

test("errors differing only in store paths count as the same", () => {
  const at = (h) => `error: nope\n at /nix/store/${h.repeat(32)}-source/flake.nix:4:74`;
  const p = plan([broken("packages", "x86_64-linux", "d", at("a"))], [broken("packages", "x86_64-linux", "d", at("b"))]);
  assert.deepEqual(p.errors, []);
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
  let summary = "";
  return {
    outputs,
    failed,
    get summary() {
      return { addRaw: (t) => ((summary += t), { write: async () => {} }) };
    },
    text: () => summary,
    info() {},
    warning() {},
    setOutput: (k, v) => (outputs[k] = v),
    setFailed: (m) => failed.push(m),
  };
}

async function files(head, baseText) {
  const dir = await mkdtemp(join(tmpdir(), "drv-diff-"));
  await writeFile(join(dir, "head.jsonl"), head);
  if (baseText !== undefined) await writeFile(join(dir, "base.jsonl"), baseText);
  return { head: join(dir, "head.jsonl"), base: baseText === undefined ? "" : join(dir, "base.jsonl") };
}

test("run sets the matrix and summarizes what it builds", async () => {
  const core = fakeCore();
  const head = jsonl(...base.slice(1), job("packages", "x86_64-linux", "a", "2"));
  await run({ core, read: (p) => readFile(p, "utf8"), inputs: await files(head, jsonl(...base)) });
  assert.deepEqual(JSON.parse(core.outputs.matrix), [
    { system: "x86_64-linux", runner: "ubuntu-latest", packages: [".#packages.x86_64-linux.a"], checks: [] },
  ]);
  assert.match(core.text(), /packages\.x86_64-linux\.a/);
  assert.deepEqual(core.failed, []);
});

test("run with no base builds everything", async () => {
  const core = fakeCore();
  await run({ core, read: (p) => readFile(p, "utf8"), inputs: await files(jsonl(...base)) });
  assert.equal(JSON.parse(core.outputs.matrix).length, 2);
});

test("run says when nothing changed", async () => {
  const core = fakeCore();
  await run({ core, read: (p) => readFile(p, "utf8"), inputs: await files(jsonl(...base), jsonl(...base)) });
  assert.equal(core.outputs.matrix, "[]");
  assert.match(core.text(), /Nothing to build/);
});

test("run fails on eval errors but still sets the matrix", async () => {
  const core = fakeCore();
  const head = jsonl(job("packages", "x86_64-linux", "a", "2"), broken("packages", "x86_64-linux", "c", "boom"));
  await run({ core, read: (p) => readFile(p, "utf8"), inputs: await files(head, jsonl(...base)) });
  assert.equal(JSON.parse(core.outputs.matrix).length, 1);
  assert.equal(core.failed.length, 1);
  assert.match(core.text(), /boom/);
});
