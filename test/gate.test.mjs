import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, resolveAppLogin, run, waitFor } from "../.github/actions/hercules-gate/gate.mjs";

const context = "ci/hercules/onPush/default";
const login = "hercules-ci[bot]";
const hercules = { login, type: "Bot" };
const spoofer = { login: "github-actions[bot]", type: "Bot" };

const status = (id, state, creator, ctx = context) => ({
  id,
  context: ctx,
  state,
  creator,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
});

test("waits while no status has been posted", () => {
  assert.equal(evaluate([], { context, login }).verdict, "wait");
});

test("waits while Hercules's latest status is pending", () => {
  const r = evaluate([status(2, "pending", hercules), status(1, "success", hercules)], { context, login });
  assert.equal(r.verdict, "wait");
});

test("passes on Hercules's latest status being success", () => {
  const r = evaluate([status(1, "pending", hercules), status(2, "success", hercules)], { context, login });
  assert.equal(r.verdict, "pass");
});

test("fails on failure or error from Hercules", () => {
  for (const state of ["failure", "error"]) {
    assert.equal(evaluate([status(1, state, hercules)], { context, login }).verdict, "fail");
  }
});

test("ignores a success from another app on the same context", () => {
  const r = evaluate([status(1, "pending", hercules), status(2, "success", spoofer)], { context, login });
  assert.equal(r.verdict, "wait");
  assert.deepEqual(r.ignored.map((s) => s.id), [2]);
});

test("ignores a user posting under the bot's login shape", () => {
  const r = evaluate([status(1, "success", { login, type: "User" })], { context, login });
  assert.equal(r.verdict, "wait");
  assert.equal(r.ignored.length, 1);
});

test("a spoofed success does not mask Hercules's failure", () => {
  const r = evaluate([status(1, "failure", hercules), status(2, "success", spoofer)], { context, login });
  assert.equal(r.verdict, "fail");
});

test("ignores other contexts", () => {
  const r = evaluate([status(1, "success", hercules, "ci/hercules/evaluation")], { context, login });
  assert.equal(r.verdict, "wait");
  assert.equal(r.ignored.length, 0);
});

test("resolveAppLogin returns the bot login when the slug's id matches", async () => {
  const github = {
    request: async (route, params) => {
      assert.equal(route, "GET /apps/{app_slug}");
      assert.equal(params.app_slug, "hercules-ci");
      return { data: { id: 24794, slug: "hercules-ci" } };
    },
  };
  assert.equal(await resolveAppLogin(github, "hercules-ci", 24794), login);
});

test("resolveAppLogin refuses a slug owned by another app", async () => {
  const github = { request: async () => ({ data: { id: 1, slug: "hercules-ci" } }) };
  await assert.rejects(resolveAppLogin(github, "hercules-ci", 24794), /24794/);
});

const repo = { owner: "o", repo: "r" };

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

test("waitFor polls until Hercules posts success", async () => {
  const pages = [[], [status(1, "pending", hercules)], [status(2, "success", hercules), status(1, "pending", hercules)]];
  let calls = 0;
  const github = {
    paginate: async (route, params) => {
      assert.equal(route, "GET /repos/{owner}/{repo}/commits/{ref}/statuses");
      assert.deepEqual(params, { owner: "o", repo: "r", ref: "abc", per_page: 100 });
      return pages[Math.min(calls++, 2)];
    },
  };
  const r = await waitFor({ github, repo, sha: "abc", context, login, timeoutMs: 60_000, intervalMs: 1000, log: () => {}, ...fakeClock() });
  assert.equal(r.verdict, "pass");
  assert.equal(calls, 3);
});

test("waitFor times out when only a spoofed success exists", async () => {
  const github = { paginate: async () => [status(1, "success", spoofer)] };
  const r = await waitFor({ github, repo, sha: "abc", context, login, timeoutMs: 5000, intervalMs: 1000, log: () => {}, ...fakeClock() });
  assert.equal(r.verdict, "timeout");
  assert.equal(r.ignored.length, 1);
});

function fakeCore() {
  const out = { outputs: {}, info: [], warnings: [], failed: [] };
  return {
    out,
    info: (m) => out.info.push(m),
    warning: (m) => out.warnings.push(m),
    setOutput: (k, v) => (out.outputs[k] = v),
    setFailed: (m) => out.failed.push(m),
  };
}

const inputs = { repository: "o/r", sha: "abc", context, "app-slug": "hercules-ci", "app-id": "24794", "timeout-minutes": "1", "interval-seconds": "10" };

function fakeGithub(statuses) {
  return {
    request: async () => ({ data: { id: 24794, slug: "hercules-ci" } }),
    paginate: async () => statuses,
  };
}

test("run passes on a green status from Hercules", async () => {
  const core = fakeCore();
  await run({ github: fakeGithub([{ ...status(1, "success", hercules), target_url: "https://h/1" }]), core, inputs, ...fakeClock() });
  assert.deepEqual(core.out.outputs, { verdict: "pass", ignored: 0 });
  assert.deepEqual(core.out.failed, []);
  assert.match(core.out.info.at(-1), /passed \(https:\/\/h\/1\)/);
});

test("run fails on a red status from Hercules", async () => {
  const core = fakeCore();
  await run({ github: fakeGithub([status(1, "failure", hercules)]), core, inputs, ...fakeClock() });
  assert.equal(core.out.outputs.verdict, "fail");
  assert.match(core.out.failed[0], /is failure/);
});

test("run warns about and times out on a spoofed status", async () => {
  const core = fakeCore();
  await run({ github: fakeGithub([status(1, "success", spoofer)]), core, inputs, ...fakeClock() });
  assert.deepEqual(core.out.outputs, { verdict: "timeout", ignored: 1 });
  assert.match(core.out.warnings[0], /ignoring success .* from github-actions\[bot\]/);
  assert.match(core.out.failed[0], /no final .* within 1 minutes/);
});
