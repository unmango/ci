import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarker, render, summarize } from "../.github/actions/ci-health/health.mjs";

const since = "2026-11-15T00:00:00Z";

/** Day `d` of November 2026, the gate finishing `minutes` after the run starts. */
const run = (d, conclusion, minutes = 4) => {
  const start = new Date(Date.UTC(2026, 10, d, 9));
  return {
    created_at: start.toISOString(),
    started_at: start.toISOString(),
    html_url: `https://example.test/runs/${d}`,
    conclusion,
    completed_at: conclusion ? new Date(start.getTime() + minutes * 60_000).toISOString() : null,
  };
};

test("unknown with no finished gate", () => {
  const r = summarize([run(22, null)], { prev: {}, since });
  assert.equal(r.state, "unknown");
  assert.equal(r.latest, null);
  assert.equal(r.p50, null);
});

test("green when the latest finished gate passed, skipping one still running", () => {
  const r = summarize([run(22, null), run(21, "success"), run(20, "failure")], { prev: {}, since });
  assert.equal(r.state, "green");
  assert.equal(r.red_since, null);
  assert.equal(r.latest?.html_url, "https://example.test/runs/21");
});

test("cancelled gates count toward nothing", () => {
  const r = summarize([run(22, "cancelled"), run(21, "success", 3)], { prev: {}, since });
  assert.equal(r.state, "green");
  assert.equal(r.runs, 1);
});

test("timed_out is red", () => {
  assert.equal(summarize([run(22, "timed_out")], { prev: {}, since }).state, "red");
});

test("a red streak starts at the first failure after the last green", () => {
  const runs = [run(22, "failure"), run(21, "cancelled"), run(20, "failure"), run(19, "success")];
  const r = summarize(runs, { prev: { state: "red", red_since: "2026-10-01T00:00:00Z" }, since });
  assert.equal(r.state, "red");
  assert.equal(r.red_since, run(20, "failure").created_at);
});

test("a streak older than the fetched runs keeps the recorded start", () => {
  const r = summarize([run(22, "failure"), run(21, "failure")], { prev: { state: "red", red_since: "2026-10-01T00:00:00Z" }, since });
  assert.equal(r.red_since, "2026-10-01T00:00:00Z");
});

test("a new streak with no green fetched starts at the oldest failure", () => {
  const r = summarize([run(22, "failure"), run(21, "failure")], { prev: { state: "green", red_since: null }, since });
  assert.equal(r.red_since, run(21, "failure").created_at);
});

test("percentiles are nearest-rank over runs in the window", () => {
  const runs = [run(22, "success", 2), run(21, "success", 8), run(20, "failure", 4), run(10, "success", 60)];
  const r = summarize(runs, { prev: {}, since });
  assert.equal(r.runs, 3);
  assert.equal(r.p50, 240);
  assert.equal(r.p90, 480);
  assert.equal(r.slow, false);
});

test("flags a p50 over five minutes", () => {
  assert.equal(summarize([run(22, "success", 6)], { prev: {}, since }).slow, true);
  assert.equal(summarize([run(22, "success", 5)], { prev: {}, since }).slow, false);
});

test("times a gate from the start of its own attempt", () => {
  const r = run(22, "success", 10);
  r.started_at = new Date(Date.parse(r.started_at) + 7 * 60_000).toISOString();
  assert.equal(summarize([r], { prev: {}, since }).p50, 180);
});

const opts = { prs: [], branch: "main", runUrl: "https://example.test/run", now: new Date("2026-11-22T15:36:00Z") };

test("the rendered marker reads back", () => {
  const report = summarize([run(22, "failure"), run(21, "success")], { prev: {}, since });
  assert.deepEqual(parseMarker(render(report, opts)), {
    state: "red",
    red_since: run(22, "failure").created_at,
    p50: 240,
    p90: 240,
  });
});

test("renders the table and the PR list", () => {
  const report = summarize([run(22, "failure", 6), run(21, "success", 6)], { prev: {}, since });
  const body = render(report, { ...opts, prs: [{ title: "chore(deps): x", html_url: "https://example.test/pr/3" }] });
  assert.match(body, /\| `main` \| 🔴 red since 2026-11-22 09:00 UTC \(\[latest\]\(https:\/\/example\.test\/runs\/22\)\) \|/);
  assert.match(body, /\| `required` p50, 7 days \| 6m 0s ⚠️ over 5m 0s \|/);
  assert.match(body, /\| `renovate:needs-human` \| 1 \|\n\n- \[chore\(deps\): x\]\(https:\/\/example\.test\/pr\/3\)\n\nMeasured/);
});

test("renders an empty report", () => {
  const body = render(summarize([], { prev: {}, since }), opts);
  assert.match(body, /No `required` result yet/);
  assert.match(body, /\| `required` p90, 7 days \| n\/a \|/);
  assert.match(body, /\| 0 \|\n\nMeasured/);
});

test("a missing, edited or CRLF marker", () => {
  assert.deepEqual(parseMarker(undefined), {});
  assert.deepEqual(parseMarker("no marker here"), {});
  assert.deepEqual(parseMarker("<!-- ci-health {broken -->"), {});
  assert.deepEqual(parseMarker('<!-- ci-health {"state":"red"} -->\r\nrest'), { state: "red" });
});
