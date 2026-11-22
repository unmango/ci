/** @import { Core, Inputs, Octokit, Repo } from "../types.mjs" */

/**
 * @typedef {object} CheckRun
 * @property {number} id
 * @property {"queued" | "in_progress" | "completed" | string} status
 * @property {string | null} conclusion
 * @property {string} started_at
 */

/**
 * @typedef {object} PullRequest
 * @property {number} number
 * @property {string | null} body
 * @property {{ name: string }[]} labels
 * @property {{ ref: string, sha: string, repo: { full_name: string } | null }} head
 */

/**
 * @typedef {object} RequiredRuns Where to read the required check runs.
 * @property {Octokit} github
 * @property {Repo} repo
 * @property {string} checkName
 * @property {number} appId
 */

/** @type {(run: CheckRun) => boolean} */
const failed = (run) => run.conclusion === "failure" || run.conclusion === "timed_out";

const UNTICKED = /- \[ \] <!-- rebase-check -->/;

/**
 * @param {string | null | undefined} body
 * @returns {string | null} The body with the box ticked, or null if there is no unticked box.
 */
export function tickRebase(body) {
  if (!body || !UNTICKED.test(body)) return null;
  return body.replace(UNTICKED, "- [x] <!-- rebase-check -->");
}

/**
 * @param {PullRequest} pr
 * @param {{ repo: Repo, prefix: string, label: string }} opts
 */
export function isCandidate(pr, { repo, prefix, label }) {
  return (
    pr.head.ref.startsWith(prefix) &&
    pr.head.repo?.full_name === `${repo.owner}/${repo.repo}` &&
    !pr.labels.some((l) => l.name === label)
  );
}

/**
 * @param {CheckRun[]} runs
 * @param {{ completed?: boolean }} [opts]
 * @returns {CheckRun | undefined}
 */
export function latestRun(runs, { completed = false } = {}) {
  return runs
    .filter((r) => !completed || r.status === "completed")
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id)[0];
}

/**
 * @param {RequiredRuns & { sha: string }} opts
 * @returns {Promise<CheckRun[]>}
 */
async function runsFor({ github, repo, sha, checkName, appId }) {
  const { data } = await github.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
    ...repo,
    ref: sha,
    check_name: checkName,
    app_id: appId,
    filter: "all",
    per_page: 100,
  });
  return data.check_runs;
}

/**
 * @param {RequiredRuns & { before: string, depth: number }} opts
 * @returns {Promise<boolean>}
 */
export async function previousRequiredFailed({ github, repo, before, checkName, appId, depth }) {
  if (!before || /^0+$/.test(before)) return false;
  const { data: commits } = await github.request("GET /repos/{owner}/{repo}/commits", { ...repo, sha: before, per_page: depth });
  for (const { sha } of /** @type {{ sha: string }[]} */ (commits)) {
    // A scheduled run's required is skipped, and a cancelled one never finished.
    const runs = await runsFor({ github, repo, sha, checkName, appId });
    const finished = runs.filter((r) => r.conclusion === "success" || failed(r));
    const latest = latestRun(finished, { completed: true });
    if (latest) return failed(latest);
  }
  return false;
}

/**
 * @param {RequiredRuns & { before: string, depth: number, prefix: string, label: string, log: (message: string) => void }} opts
 * @returns {Promise<number[]>} The PRs ticked.
 */
export async function resume({ github, repo, before, checkName, appId, depth, prefix, label, log }) {
  if (!(await previousRequiredFailed({ github, repo, before, checkName, appId, depth }))) {
    log("previous main run did not fail; nothing to resume");
    return [];
  }
  /** @type {number[]} */
  const ticked = [];
  /** @type {PullRequest[]} */
  const prs = await github.paginate("GET /repos/{owner}/{repo}/pulls", { ...repo, state: "open", per_page: 100 });
  for (const pr of prs.filter((p) => isCandidate(p, { repo, prefix, label }))) {
    const latest = latestRun(await runsFor({ github, repo, sha: pr.head.sha, checkName, appId }));
    if (latest?.status !== "completed" || !failed(latest)) continue;
    const body = tickRebase(pr.body);
    if (!body) {
      log(`#${pr.number}: no unticked rebase checkbox`);
      continue;
    }
    await github.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pr.number, body });
    log(`#${pr.number}: ticked the rebase checkbox`);
    ticked.push(pr.number);
  }
  return ticked;
}

/**
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Core} opts.core
 * @param {Inputs} opts.inputs
 */
export async function run({ github, core, inputs }) {
  const [owner, repo] = inputs.repository.split("/");
  const ticked = await resume({
    github,
    repo: { owner, repo },
    before: inputs.before,
    checkName: inputs["check-name"],
    appId: Number(inputs["app-id"]),
    depth: Number(inputs.depth),
    prefix: inputs["branch-prefix"],
    label: inputs.label,
    log: core.info,
  });
  core.setOutput("ticked", JSON.stringify(ticked));
}
