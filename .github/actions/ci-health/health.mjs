/** @import { Core, Inputs, Octokit, Repo } from "../types.mjs" */

export const CHECK = "required";
export const WINDOW_DAYS = 7;
export const THRESHOLD_SECONDS = 5 * 60;
const LABEL = "ci-health";
const RED = "ci-health:red";
const NEEDS_HUMAN = "renovate:needs-human";
const MARKER = /^<!-- ci-health (.*) -->\r?$/m;
const FINISHED = ["success", "failure", "timed_out"];

/**
 * A push run of the caller's workflow, joined with its gate job.
 * @typedef {object} GateRun
 * @property {string} created_at
 * @property {string} started_at Start of the attempt that ran the gate job.
 * @property {string} html_url
 * @property {string | null} conclusion The gate job's.
 * @property {string | null} completed_at The gate job's.
 */

/**
 * @typedef {object} Marker
 * @property {"green" | "red" | "unknown"} state
 * @property {string | null} red_since
 * @property {number | null} p50
 * @property {number | null} p90
 */

/**
 * @typedef {Marker & { latest: GateRun | null, runs: number, slow: boolean }} Report
 */

/**
 * @typedef {{ conclusion: string, html_url: string }} ScheduledRun
 */

/**
 * @typedef {object} PullRequest
 * @property {string} title
 * @property {string} html_url
 */

/** @type {(xs: number[], p: number) => number | null} */
const percentile = (xs, p) => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
};

/**
 * @param {GateRun[]} runs Newest first.
 * @param {object} opts
 * @param {Partial<Marker>} opts.prev The marker the issue carried before this run.
 * @param {string} opts.since Start of the percentile window.
 * @returns {Report}
 */
export function summarize(runs, { prev, since }) {
  const done = runs.filter((r) => r.conclusion && FINISHED.includes(r.conclusion));
  const latest = done[0] ?? null;
  const state = !latest ? "unknown" : latest.conclusion === "success" ? "green" : "red";

  // Only green ends a streak; unknown carries it forward.
  const kept = prev.state === "green" ? null : (prev.red_since ?? null);
  let red_since = state === "unknown" ? kept : null;
  if (state === "red") {
    const green = done.findIndex((r) => r.conclusion === "success");
    if (green > 0) red_since = done[green - 1].created_at;
    // The streak is older than anything fetched.
    else red_since = kept ?? done[done.length - 1].created_at;
  }

  const durations = done
    .filter((r) => r.created_at >= since)
    .map((r) => (Date.parse(/** @type {string} */ (r.completed_at)) - Date.parse(r.started_at)) / 1000);
  const p50 = percentile(durations, 0.5);
  return {
    state,
    red_since,
    p50,
    p90: percentile(durations, 0.9),
    latest,
    runs: durations.length,
    slow: p50 !== null && p50 > THRESHOLD_SECONDS,
  };
}

/** @type {(s: number | null) => string} */
const duration = (s) => (s === null ? "n/a" : `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`);

/** @type {(iso: string) => string} */
const when = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/**
 * @param {Report} report
 * @param {object} opts
 * @param {PullRequest[]} opts.prs
 * @param {string} opts.branch
 * @param {string} opts.runUrl
 * @param {Date} opts.now
 * @param {ScheduledRun | null} [opts.scheduled]
 * @returns {string}
 */
export function render(report, { prs, branch, runUrl, now, scheduled = null }) {
  const { state, red_since, p50, p90, latest } = report;
  const main =
    state === "unknown" ? `No \`${CHECK}\` result yet`
    : state === "green" ? `🟢 green ([run](${latest?.html_url}))`
    : `🔴 red since ${when(/** @type {string} */ (red_since))} ([latest](${latest?.html_url}))`;
  const slow = report.slow ? ` ⚠️ over ${duration(THRESHOLD_SECONDS)}` : "";
  return [
    `<!-- ci-health ${JSON.stringify({ state, red_since, p50, p90 })} -->`,
    "",
    "| | |",
    "| --- | --- |",
    `| \`${branch}\` | ${main} |`,
    ...(scheduled
      ? [`| Scheduled run | ${scheduled.conclusion === "success" ? "🟢" : "🔴"} ${scheduled.conclusion} ([run](${scheduled.html_url})) |`]
      : []),
    `| \`${CHECK}\` p50, ${WINDOW_DAYS} days | ${duration(p50)}${slow} |`,
    `| \`${CHECK}\` p90, ${WINDOW_DAYS} days | ${duration(p90)} |`,
    `| Runs, ${WINDOW_DAYS} days | ${report.runs} |`,
    `| \`${NEEDS_HUMAN}\` | ${prs.length} |`,
    "",
    ...prs.flatMap((pr, i) => [`- [${pr.title}](${pr.html_url})`, ...(i === prs.length - 1 ? [""] : [])]),
    `Measured from a run's start to \`${CHECK}\` finishing, on pushes to \`${branch}\`. [Updated](${runUrl}) ${when(now.toISOString())}.`,
    "",
  ].join("\n");
}

/**
 * @param {string | null | undefined} body
 * @returns {Partial<Marker>}
 */
export function parseMarker(body) {
  const match = body?.match(MARKER);
  if (!match) return {};
  try {
    const marker = JSON.parse(match[1]);
    if (!marker || typeof marker !== "object") return {};
    if (typeof marker.red_since !== "string") delete marker.red_since;
    return marker;
  } catch {
    // A hand-edited marker shouldn't fail the run.
    return {};
  }
}

/**
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Repo} opts.repo
 * @param {string} opts.workflow
 * @param {string} opts.branch
 * @param {string} opts.since
 * @returns {Promise<GateRun[]>}
 */
export async function collect({ github, repo, workflow, branch, since }) {
  const route = "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs";
  const params = { ...repo, workflow_id: workflow, branch, event: "push" };
  /** @type {(runs: any[]) => Promise<GateRun[]>} */
  const join = async (runs) => {
    const out = [];
    // In turn, so a busy repo doesn't trip the secondary rate limit.
    for (const r of runs) out.push(await gate(github, repo, r));
    return out;
  };

  const recent = await join(await github.paginate(route, { ...params, created: `>=${since}`, per_page: 100 }));
  if (recent.some((r) => r.conclusion && FINISHED.includes(r.conclusion))) return recent;
  // A quiet repo has nothing in the window, but still has a latest result.
  const { data } = await github.request(route, { ...params, per_page: 50 });
  return join(data.workflow_runs);
}

/**
 * A collection's weekly full build: reported, but not a gate.
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Repo} opts.repo
 * @param {string} opts.workflow
 * @param {string} opts.branch
 * @returns {Promise<ScheduledRun | null>}
 */
export async function latestScheduled({ github, repo, workflow, branch }) {
  const { data } = await github.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
    ...repo,
    workflow_id: workflow,
    branch,
    event: "schedule",
    status: "completed",
    per_page: 10,
  });
  const run = data.workflow_runs.find((/** @type {ScheduledRun} */ r) => FINISHED.includes(r.conclusion));
  return run ? { conclusion: run.conclusion, html_url: run.html_url } : null;
}

/**
 * @param {Octokit} github
 * @param {Repo} repo
 * @param {{ id: number, created_at: string, run_started_at: string, run_attempt: number, html_url: string }} run
 * @returns {Promise<GateRun>}
 */
async function gate(github, repo, run) {
  const jobs = await github.paginate("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", { ...repo, run_id: run.id, per_page: 100 });
  const job = jobs.find((j) => j.name === CHECK);
  let started_at = run.run_started_at;
  // A partial re-run keeps the job from an earlier attempt, which started at another time.
  if (job?.run_attempt && job.run_attempt !== run.run_attempt) {
    const { data } = await github.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}", {
      ...repo,
      run_id: run.id,
      attempt_number: job.run_attempt,
    });
    started_at = data.run_started_at;
  }
  return {
    created_at: run.created_at,
    started_at,
    html_url: run.html_url,
    conclusion: job?.conclusion ?? null,
    completed_at: job?.completed_at ?? null,
  };
}

/**
 * @param {Octokit} github
 * @param {Repo} repo
 * @param {string} name
 * @param {string} color
 * @param {string} description
 */
async function ensureLabel(github, repo, name, color, description) {
  try {
    await github.request("POST /repos/{owner}/{repo}/labels", { ...repo, name, color, description });
  } catch (/** @type {any} */ e) {
    if (e.status !== 422) throw e;
  }
}

/**
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Core} opts.core
 * @param {Inputs} opts.inputs
 * @param {() => Date} [opts.now]
 */
export async function run({ github, core, inputs, now = () => new Date() }) {
  const [owner, name] = inputs.repository.split("/");
  const repo = { owner, repo: name };
  const write = inputs.write === "true";
  const at = now();
  const since = new Date(at.getTime() - WINDOW_DAYS * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");

  const { data: meta } = await github.request("GET /repos/{owner}/{repo}", repo);
  const branch = meta.default_branch;
  const runs = await collect({ github, repo, workflow: inputs.workflow, branch, since });
  const scheduled = await latestScheduled({ github, repo, workflow: inputs.workflow, branch });

  const { data: open } = await github.request("GET /repos/{owner}/{repo}/issues", {
    ...repo,
    labels: LABEL,
    state: "open",
    sort: "created",
    direction: "asc",
    per_page: 100,
  });
  const issue = open.find((/** @type {any} */ i) => !i.pull_request);
  /** @type {PullRequest[]} */
  const prs = (
    await github.paginate("GET /repos/{owner}/{repo}/issues", { ...repo, labels: NEEDS_HUMAN, state: "open", per_page: 100 })
  ).filter((/** @type {any} */ i) => i.pull_request);

  const report = summarize(runs, { prev: parseMarker(issue?.body), since });
  const body = render(report, { prs, branch, runUrl: inputs["run-url"], now: at, scheduled });
  await core.summary.addRaw(body).write();
  core.setOutput("state", report.state);
  if (!write) return;

  let number = issue?.number;
  let nodeId = issue?.node_id;
  if (issue) {
    await github.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { ...repo, issue_number: issue.number, body });
  } else {
    await ensureLabel(github, repo, LABEL, "0e8a16", "This repo's CI health report");
    const { data } = await github.request("POST /repos/{owner}/{repo}/issues", { ...repo, title: "CI health", body, labels: [LABEL] });
    number = data.number;
    nodeId = data.node_id;
  }

  try {
    const { node } = await github.graphql("query($id: ID!) { node(id: $id) { ... on Issue { isPinned } } }", { id: nodeId });
    if (!node.isPinned) await github.graphql("mutation($id: ID!) { pinIssue(input: { issueId: $id }) { issue { id } } }", { id: nodeId });
  } catch (/** @type {any} */ e) {
    core.warning(`could not pin #${number}: ${e.message}`);
  }

  const labelled = issue?.labels?.some((/** @type {{ name: string }} */ l) => l.name === RED);
  if (report.state === "red" && !labelled) {
    await ensureLabel(github, repo, RED, "d73a4a", "main's gate is failing");
    await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: number, labels: [RED] });
  } else if (report.state === "green" && labelled) {
    await github.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { ...repo, issue_number: number, name: RED });
  }
}
