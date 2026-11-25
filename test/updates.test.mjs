import { test } from "node:test";
import assert from "node:assert/strict";
import { parseList, classify, renderFailures, bumpAll, publish, report, UNBUILDABLE } from "../.github/actions/package-updates/updates.mjs";

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
const raw = ":100644 100644 o1 n1 M\0pkgs/a/default.nix\0";

// The publishing side: git with one staged file, and a recording API.
function fakePublish({ prs = [], diff = raw, refStatus } = {}) {
  const calls = [];
  const ran = [];
  return {
    calls,
    ran,
    exec: {
      async exec(cmd, args) {
        ran.push([cmd, ...args].join(" "));
        return 0;
      },
      async getExecOutput(cmd, args) {
        if (cmd === "git") return { exitCode: 0, stdout: diff, stderr: "" };
        return { exitCode: 0, stdout: `b64:${args[3]}`, stderr: "" };
      },
    },
    github: {
      async request(route, params) {
        calls.push([route, params]);
        if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}" && refStatus) {
          throw Object.assign(new Error("no ref"), { status: refStatus });
        }
        if (route === "POST /repos/{owner}/{repo}/pulls") return { data: { number: 9, node_id: "PR9" } };
        return { data: {} };
      },
      async paginate(route, params) {
        assert.equal(params.head, "o:update/a");
        return prs;
      },
      async graphql(query, variables) {
        calls.push(["graphql", variables]);
        if (variables.input) return { createCommitOnBranch: { commit: { oid: "c1" } } };
        return {};
      },
    },
  };
}

const opts = (over) => ({
  repo,
  result: { name: "a", kind: "bumped", title: "a: 1 -> 2" },
  base: "basesha000000000",
  defaultBranch: "main",
  patch: "/tmp/p/a.patch",
  label: "renovate:needs-human",
  dryRun: false,
  log() {},
  ...over,
});

const routes = (calls) => calls.map(([r]) => r);

test("publish opens a PR on a new update branch", async () => {
  const f = fakePublish({ refStatus: 422 });
  await publish({ github: f.github, exec: f.exec, ...opts() });
  assert.deepEqual(routes(f.calls), [
    "POST /repos/{owner}/{repo}/git/refs",
    "graphql",
    "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
    "POST /repos/{owner}/{repo}/git/refs",
    "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
    "POST /repos/{owner}/{repo}/pulls",
    "graphql",
  ]);
  assert.equal(f.calls[0][1].ref, "refs/heads/update/a-basesha00000");
  assert.equal(f.calls[1][1].input.branch.branchName, "update/a-basesha00000");
  assert.deepEqual(f.calls[3][1], { ...repo, ref: "refs/heads/update/a", sha: "c1" });
  assert.equal(f.calls[5][1].head, "update/a");
  assert.deepEqual(f.calls[6][1], { id: "PR9" });
  assert.deepEqual(f.ran, ["git reset --quiet --hard basesha000000000", "git apply --index /tmp/p/a.patch"]);
});

test("publish force-pushes and retitles an open PR for a newer version", async () => {
  const f = fakePublish({ prs: [{ number: 4, node_id: "PR4", title: "a: 1 -> 1.5", labels: [{ name: "renovate:needs-human" }] }] });
  await publish({ github: f.github, exec: f.exec, ...opts() });
  assert.deepEqual(routes(f.calls), [
    "POST /repos/{owner}/{repo}/git/refs",
    "graphql",
    "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
    "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
    "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
  ]);
  assert.deepEqual(f.calls[2][1], { ...repo, ref: "heads/update/a", sha: "c1", force: true });
  assert.equal(f.calls[4][1].title, "a: 1 -> 2");
});

test("publish labels a bump that doesn't build", async () => {
  const f = fakePublish({ refStatus: 404 });
  await publish({ github: f.github, exec: f.exec, ...opts({ result: { name: "a", kind: "unbuildable", title: "a: 1 -> 2" } }) });
  const [, params] = f.calls.find(([r]) => r === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels");
  assert.deepEqual(params, { ...repo, issue_number: 9, labels: ["renovate:needs-human"] });
});

test("publish leaves a PR that already has the version alone", async () => {
  const f = fakePublish({ prs: [{ number: 4, node_id: "PR4", title: "a: 1 -> 2", labels: [] }] });
  await publish({ github: f.github, exec: f.exec, ...opts() });
  assert.deepEqual(f.calls, []);
});

test("publish writes nothing on a dry run", async () => {
  const f = fakePublish();
  await publish({ github: f.github, exec: f.exec, ...opts({ dryRun: true }) });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.ran, []);
});

test("publish refuses a symlink before touching any branch", async () => {
  const f = fakePublish({ diff: ":000000 120000 o1 n1 A\0leak\0" });
  await assert.rejects(publish({ github: f.github, exec: f.exec, ...opts() }), /refused.*leak/);
  assert.deepEqual(f.calls, []);
});

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
