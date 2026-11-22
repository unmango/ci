import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function serve(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body && JSON.parse(body) });
    const out = handler(req.method, new URL(req.url, "http://x"));
    res.writeHead(out === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out ?? { message: "Not Found" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

async function action(name, api, inputs) {
  const out = join(mkdtempSync(join(tmpdir(), "act-")), "out");
  const env = { PATH: process.env.PATH, GITHUB_API_URL: api, GITHUB_OUTPUT: out };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  const res = await run("node", [`.github/actions/${name}/index.mjs`], { env }).then(
    (r) => ({ ...r, code: 0 }),
    (e) => e,
  );
  let outputs = {};
  try {
    outputs = Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
  } catch {}
  return { code: res.code, stdout: res.stdout, outputs };
}

const gateInputs = { token: "t", repository: "o/r", sha: "abc", context: "ci/hercules/onPush/default", "app-slug": "hercules-ci", "app-id": "24794", "timeout-minutes": "0.001", "interval-seconds": "0.01" };
const app = { id: 24794, slug: "hercules-ci" };
const st = (id, state, login) => ({ id, state, context: "ci/hercules/onPush/default", creator: { login, type: "Bot" }, created_at: `2026-01-01T00:00:0${id}Z`, target_url: "https://hercules-ci.com/x" });

test("hercules-gate passes on a green status from Hercules", async (t) => {
  const s = await serve((m, u) => (u.pathname === "/apps/hercules-ci" ? app : u.pathname === "/repos/o/r/commits/abc/statuses" ? [st(1, "success", "hercules-ci[bot]")] : undefined));
  t.after(s.close);
  const r = await action("hercules-gate", s.url, gateInputs);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.outputs, { verdict: "pass", ignored: "0" });
});

test("hercules-gate rejects a spoofed green status and times out", async (t) => {
  const s = await serve((m, u) => (u.pathname === "/apps/hercules-ci" ? app : u.pathname === "/repos/o/r/commits/abc/statuses" ? [st(1, "success", "github-actions[bot]")] : undefined));
  t.after(s.close);
  const r = await action("hercules-gate", s.url, gateInputs);
  assert.equal(r.code, 1);
  assert.deepEqual(r.outputs, { verdict: "timeout", ignored: "1" });
  assert.match(r.stdout, /::warning::ignoring success .* from github-actions\[bot\]/);
});

test("hercules-gate fails on a red status from Hercules", async (t) => {
  const s = await serve((m, u) => (u.pathname === "/apps/hercules-ci" ? app : u.pathname === "/repos/o/r/commits/abc/statuses" ? [st(1, "failure", "hercules-ci[bot]")] : undefined));
  t.after(s.close);
  const r = await action("hercules-gate", s.url, gateInputs);
  assert.equal(r.code, 1);
  assert.equal(r.outputs.verdict, "fail");
  assert.match(r.stdout, /::error::.*failure \(https:\/\/hercules-ci.com\/x\)/);
});

test("renovate-resume ticks a failing Renovate PR after a red main", async (t) => {
  const runs = { b: "failure", sha1: "failure", sha2: "failure" };
  const s = await serve((m, u) => {
    if (u.pathname === "/repos/o/r/commits") return [{ sha: "b" }];
    const c = u.pathname.match(/^\/repos\/o\/r\/commits\/(\w+)\/check-runs$/);
    if (c) return { check_runs: [{ id: 1, status: "completed", conclusion: runs[c[1]], started_at: "2026-01-01T00:00:00Z" }] };
    if (u.pathname === "/repos/o/r/pulls" && m === "GET")
      return [1, 2].map((n) => ({ number: n, head: { ref: `renovate/x${n}`, sha: `sha${n}`, repo: { full_name: "o/r" } }, labels: n === 2 ? [{ name: "renovate:needs-human" }] : [], body: " - [ ] <!-- rebase-check -->rebase" }));
    if (u.pathname === "/repos/o/r/pulls/1" && m === "PATCH") return {};
  });
  t.after(s.close);
  const r = await action("renovate-resume", s.url, { token: "t", repository: "o/r", before: "b", "check-name": "required", "app-id": "15368", "branch-prefix": "renovate/", label: "renovate:needs-human", depth: "20" });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.outputs.ticked, "[1]");
  const patch = s.requests.find((q) => q.method === "PATCH");
  assert.equal(patch.body.body, " - [x] <!-- rebase-check -->rebase");
});
