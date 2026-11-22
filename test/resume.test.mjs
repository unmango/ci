import { test } from "node:test";
import assert from "node:assert/strict";
import { tickRebase, isCandidate, latestRun, previousRequiredFailed, resume, run as runResume } from "../src/resume.mjs";

const body = "Some text\n\n---\n\n - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box\n";

test("tickRebase ticks Renovate's rebase checkbox", () => {
  assert.equal(tickRebase(body), body.replace("[ ] <!-- rebase", "[x] <!-- rebase"));
});

test("tickRebase returns null without an unticked checkbox", () => {
  assert.equal(tickRebase("no box"), null);
  assert.equal(tickRebase(tickRebase(body)), null);
  assert.equal(tickRebase(null), null);
});

const pr = (n, over = {}) => ({
  number: n,
  head: { ref: `renovate/thing-${n}`, sha: `sha${n}`, repo: { full_name: "o/r" } },
  labels: [],
  body,
  ...over,
});
const repo = { owner: "o", repo: "r" };
const opts = { repo, prefix: "renovate/", label: "renovate:needs-human" };

test("isCandidate takes Renovate branches in the repo", () => {
  assert.ok(isCandidate(pr(1), opts));
});

test("isCandidate skips other branches, forks, and the needs-human label", () => {
  assert.ok(!isCandidate(pr(1, { head: { ref: "feature", sha: "s", repo: { full_name: "o/r" } } }), opts));
  assert.ok(!isCandidate(pr(1, { head: { ref: "renovate/x", sha: "s", repo: { full_name: "fork/r" } } }), opts));
  assert.ok(!isCandidate(pr(1, { labels: [{ name: "renovate:needs-human" }] }), opts));
});

const run = (id, status, conclusion, started) => ({ id, status, conclusion, started_at: started });

test("latestRun picks the most recently started run", () => {
  const runs = [run(1, "completed", "failure", "2026-01-01T00:00:00Z"), run(2, "completed", "success", "2026-01-02T00:00:00Z")];
  assert.equal(latestRun(runs).id, 2);
  assert.equal(latestRun(runs, { completed: true }).id, 2);
  assert.equal(latestRun([...runs, run(3, "in_progress", null, "2026-01-03T00:00:00Z")]).id, 3);
  assert.equal(latestRun([...runs, run(3, "in_progress", null, "2026-01-03T00:00:00Z")], { completed: true }).id, 2);
  assert.equal(latestRun([]), undefined);
});

// A fake API over commits on main and check runs per sha.
function fakeApi({ commits = [], runs = {}, prs = [] } = {}) {
  const patched = [];
  return {
    patched,
    async request(route, params) {
      assert.equal(params.owner, "o");
      assert.equal(params.repo, "r");
      if (route === "GET /repos/{owner}/{repo}/commits") {
        assert.equal(params.sha, commits[0]);
        return { data: commits.map((sha) => ({ sha })) };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        assert.equal(params.check_name, "required");
        assert.equal(params.app_id, 15368);
        return { data: { check_runs: runs[params.ref] ?? [] } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
        patched.push({ number: params.pull_number, body: params.body });
        return { data: {} };
      }
      throw new Error(`unexpected ${route}`);
    },
    async paginate(route, params) {
      assert.equal(route, "GET /repos/{owner}/{repo}/pulls");
      assert.equal(params.state, "open");
      return prs;
    },
  };
}

const red = [run(1, "completed", "failure", "2026-01-01T00:00:00Z")];
const green = [run(1, "completed", "success", "2026-01-01T00:00:00Z")];
const busy = [run(1, "in_progress", null, "2026-01-01T00:00:00Z")];
const base = { repo, checkName: "required", appId: 15368, depth: 20 };

test("previousRequiredFailed reads the before commit's last completed run", async () => {
  assert.equal(await previousRequiredFailed({ ...base, github: fakeApi({ commits: ["b"], runs: { b: red } }), before: "b" }), true);
  assert.equal(await previousRequiredFailed({ ...base, github: fakeApi({ commits: ["b"], runs: { b: green } }), before: "b" }), false);
});

test("previousRequiredFailed walks past commits with no completed run", async () => {
  const api = fakeApi({ commits: ["b", "c", "d"], runs: { b: busy, d: red } });
  assert.equal(await previousRequiredFailed({ ...base, github: api, before: "b" }), true);
});

test("previousRequiredFailed is false for a new branch or no history", async () => {
  assert.equal(await previousRequiredFailed({ ...base, github: fakeApi(), before: "0".repeat(40) }), false);
  assert.equal(await previousRequiredFailed({ ...base, github: fakeApi(), before: "" }), false);
  assert.equal(await previousRequiredFailed({ ...base, github: fakeApi({ commits: ["b"] }), before: "b" }), false);
});

const resumeOpts = { ...base, prefix: "renovate/", label: "renovate:needs-human", log: () => {} };

test("resume does nothing after a green main", async () => {
  const api = fakeApi({ commits: ["b"], runs: { b: green, sha1: red }, prs: [pr(1)] });
  assert.deepEqual(await resume({ ...resumeOpts, github: api, before: "b" }), []);
  assert.equal(api.patched.length, 0);
});

test("resume ticks failing Renovate PRs after a red main, but not labelled or passing ones", async () => {
  const prs = [
    pr(1),
    pr(2, { labels: [{ name: "renovate:needs-human" }] }),
    pr(3),
    pr(4),
    pr(5, { head: { ref: "feature/x", sha: "sha5", repo: { full_name: "o/r" } } }),
    pr(6),
  ];
  const runs = { b: red, sha1: red, sha2: red, sha3: green, sha4: busy, sha5: red, sha6: [...green, run(2, "completed", "failure", "2026-02-01T00:00:00Z")] };
  const api = fakeApi({ commits: ["b"], runs, prs });
  assert.deepEqual(await resume({ ...resumeOpts, github: api, before: "b" }), [1, 6]);
  assert.deepEqual(api.patched.map((p) => p.number), [1, 6]);
  assert.match(api.patched[0].body, /- \[x\] <!-- rebase-check -->/);
});

test("resume skips a failing PR whose checkbox is already ticked", async () => {
  const api = fakeApi({ commits: ["b"], runs: { b: red, sha1: red }, prs: [pr(1, { body: tickRebase(body) })] });
  assert.deepEqual(await resume({ ...resumeOpts, github: api, before: "b" }), []);
});

test("a timed-out run counts as failed, a cancelled one doesn't", async () => {
  const timedOut = [run(1, "completed", "timed_out", "2026-01-01T00:00:00Z")];
  const cancelled = [run(1, "completed", "cancelled", "2026-01-01T00:00:00Z")];
  assert.equal(await previousRequiredFailed({ ...base, github: fakeApi({ commits: ["b"], runs: { b: timedOut } }), before: "b" }), true);
  assert.equal(await previousRequiredFailed({ ...base, github: fakeApi({ commits: ["b"], runs: { b: cancelled } }), before: "b" }), false);
});

test("run reads the action's inputs and sets ticked", async () => {
  const api = fakeApi({ commits: ["b"], runs: { b: red, sha1: red }, prs: [pr(1)] });
  const outputs = {};
  const core = { info: () => {}, setOutput: (k, v) => (outputs[k] = v) };
  const inputs = { repository: "o/r", before: "b", "check-name": "required", "app-id": "15368", depth: "20", "branch-prefix": "renovate/", label: "renovate:needs-human" };
  await runResume({ github: api, core, inputs });
  assert.deepEqual(outputs, { ticked: "[1]" });
});
