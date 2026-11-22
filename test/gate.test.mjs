import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, resolveAppLogin, waitFor } from "../src/gate.mjs";

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
  const api = { get: async (p) => (assert.equal(p, "/apps/hercules-ci"), { id: 24794, slug: "hercules-ci" }) };
  assert.equal(await resolveAppLogin(api, "hercules-ci", 24794), login);
});

test("resolveAppLogin refuses a slug owned by another app", async () => {
  const api = { get: async () => ({ id: 1, slug: "hercules-ci" }) };
  await assert.rejects(resolveAppLogin(api, "hercules-ci", 24794), /24794/);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

test("waitFor polls until Hercules posts success", async () => {
  const pages = [[], [status(1, "pending", hercules)], [status(2, "success", hercules), status(1, "pending", hercules)]];
  let calls = 0;
  const api = { paginate: async (p) => (assert.match(p, /\/repos\/o\/r\/commits\/abc\/statuses/), pages[Math.min(calls++, 2)]) };
  const r = await waitFor({ api, repo: "o/r", sha: "abc", context, login, timeoutMs: 60_000, intervalMs: 1000, log: () => {}, ...fakeClock() });
  assert.equal(r.verdict, "pass");
  assert.equal(calls, 3);
});

test("waitFor times out when only a spoofed success exists", async () => {
  const api = { paginate: async () => [status(1, "success", spoofer)] };
  const r = await waitFor({ api, repo: "o/r", sha: "abc", context, login, timeoutMs: 5000, intervalMs: 1000, log: () => {}, ...fakeClock() });
  assert.equal(r.verdict, "timeout");
  assert.equal(r.ignored.length, 1);
});
