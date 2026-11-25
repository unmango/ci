import { test } from "node:test";
import assert from "node:assert/strict";
import { parseList, classify, renderFailures, bumpAll, report, UNBUILDABLE } from "../.github/actions/package-updates/updates.mjs";

test("parseList drops blank lines and whitespace", () => {
  assert.deepEqual(parseList(" a\n\nb \n"), ["a", "b"]);
  assert.deepEqual(parseList(""), []);
});

test("classify reads the exit code and the work tree", () => {
  const base = { name: "p", stdout: "building\np: 1.0 -> 1.1\n", stderr: "" };
  assert.deepEqual(classify({ ...base, code: 0, changed: true }), { name: "p", kind: "bumped", title: "p: 1.0 -> 1.1" });
  assert.deepEqual(classify({ ...base, code: UNBUILDABLE, changed: true }), { name: "p", kind: "unbuildable", title: "p: 1.0 -> 1.1" });
  assert.deepEqual(classify({ ...base, code: 0, changed: false }), { name: "p", kind: "current" });
  assert.equal(classify({ ...base, code: UNBUILDABLE, changed: false }).kind, "failed");
  assert.deepEqual(classify({ ...base, code: 1, stderr: "x\nnix-update failed\n", changed: true }), {
    name: "p",
    kind: "failed",
    reason: "nix-update failed",
  });
  assert.deepEqual(classify({ name: "p", code: 0, stdout: "", stderr: "", changed: true }), { name: "p", kind: "bumped", title: "p: update" });
  assert.equal(classify({ name: "p", code: 2, stdout: "", stderr: "", changed: false }).reason, "exit 2");
});

test("renderFailures lists failures or says there are none", () => {
  const opts = { runUrl: "https://run", now: new Date("2026-11-27T00:30:00.123Z") };
  assert.equal(
    renderFailures([{ name: "p", kind: "failed", reason: "boom" }], opts),
    "Rewritten by each [package updates run](https://run); last 2026-11-27T00:30:00Z.\n\n- `p`: `boom`\n",
  );
  assert.match(renderFailures([], opts), /No package failed to update\./);
});

// A work tree whose bump command is a function of the package name.
function fakeTree(bumps) {
  const ran = [];
  let changed = false;
  return {
    ran,
    async exec(cmd, args) {
      ran.push([cmd, ...args].join(" "));
      if (args[0] === "reset") changed = false;
      return 0;
    },
    async getExecOutput(cmd, args, opts) {
      if (cmd === "timeout") {
        assert.equal(args[0], "1m");
        assert.ok(!Object.keys(opts.env).some((k) => k.startsWith("ACTIONS_") || k.startsWith("INPUT_")));
        const out = bumps[args[5]];
        changed = out.changed;
        return { exitCode: out.code, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
      }
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: "base\n", stderr: "" };
      assert.deepEqual(args, ["diff", "--cached", "--quiet"]);
      return { exitCode: changed ? 1 : 0, stdout: "", stderr: "" };
    },
  };
}

test("bumpAll runs each bump from a clean tree and writes a patch per bump", async () => {
  const exec = fakeTree({
    a: { code: 0, changed: true, stdout: "a: 1 -> 2" },
    b: { code: 0, changed: false },
    c: { code: 1, changed: true, stderr: "broke" },
    d: { code: 124, changed: true },
  });
  process.env.ACTIONS_RUNTIME_TOKEN = "secret";
  const results = await bumpAll({ exec, names: ["a", "b", "c", "d"], bump: "./bump", dir: "/tmp/p", timeout: "1m", log() {} });
  delete process.env.ACTIONS_RUNTIME_TOKEN;
  assert.deepEqual(results, [
    { name: "a", kind: "bumped", title: "a: 1 -> 2" },
    { name: "b", kind: "current" },
    { name: "c", kind: "failed", reason: "broke" },
    { name: "d", kind: "failed", reason: "timed out after 1m" },
  ]);
  assert.equal(exec.ran.filter((r) => r.startsWith("git diff --cached --binary")).length, 1);
  assert.ok(exec.ran.includes("git diff --cached --binary --output=/tmp/p/a.patch"));
  assert.equal(exec.ran.filter((r) => r === "git reset --quiet --hard base").length, 5);
});

const repo = { owner: "o", repo: "r" };
const routes = (calls) => calls.map(([r]) => r);

function fakeIssues(open) {
  const calls = [];
  return {
    calls,
    async paginate(route, params) {
      assert.equal(route, "GET /repos/{owner}/{repo}/issues");
      assert.equal(params.state, "open");
      return open;
    },
    async request(route, params) {
      calls.push([route, params]);
      return { data: { number: 3, node_id: "I3" } };
    },
    async graphql(query, variables) {
      calls.push(["graphql", variables]);
      return {};
    },
  };
}

test("report rewrites the open failures issue", async () => {
  const github = fakeIssues([{ number: 2, node_id: "I2", title: "Package update failures" }]);
  await report({ github, repo, body: "b", any: false, warn() {} });
  assert.deepEqual(github.calls, [["PATCH /repos/{owner}/{repo}/issues/{issue_number}", { ...repo, issue_number: 2, body: "b" }]]);
});

test("report opens and pins the issue on the first failure only", async () => {
  const quiet = fakeIssues([]);
  await report({ github: quiet, repo, body: "b", any: false, warn() {} });
  assert.deepEqual(quiet.calls, []);

  const github = fakeIssues([{ number: 5, node_id: "P5", title: "Other", pull_request: {} }]);
  await report({ github, repo, body: "b", any: true, warn() {} });
  assert.deepEqual(routes(github.calls), ["POST /repos/{owner}/{repo}/issues", "graphql"]);
  assert.deepEqual(github.calls[1][1], { id: "I3" });
});
