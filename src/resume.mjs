const failed = (run) => run.conclusion === "failure" || run.conclusion === "timed_out";

const UNTICKED = /- \[ \] <!-- rebase-check -->/;

export function tickRebase(body) {
  if (!body || !UNTICKED.test(body)) return null;
  return body.replace(UNTICKED, "- [x] <!-- rebase-check -->");
}

export function isCandidate(pr, { repo, prefix, label }) {
  return (
    pr.head.ref.startsWith(prefix) &&
    pr.head.repo?.full_name === repo &&
    !pr.labels.some((l) => l.name === label)
  );
}

export function latestRun(runs, { completed = false } = {}) {
  return runs
    .filter((r) => !completed || r.status === "completed")
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id)[0];
}

async function runsFor({ api, repo, sha, checkName, appId }) {
  const q = new URLSearchParams({ check_name: checkName, app_id: String(appId), filter: "all", per_page: "100" });
  return (await api.get(`/repos/${repo}/commits/${sha}/check-runs?${q}`)).check_runs;
}

export async function previousRequiredFailed({ api, repo, before, checkName, appId, depth }) {
  if (!before || /^0+$/.test(before)) return false;
  const commits = await api.get(`/repos/${repo}/commits?sha=${before}&per_page=${depth}`);
  for (const { sha } of commits) {
    const latest = latestRun(await runsFor({ api, repo, sha, checkName, appId }), { completed: true });
    if (latest) return failed(latest);
  }
  return false;
}

export async function resume({ api, repo, before, checkName, appId, depth, prefix, label, log }) {
  if (!(await previousRequiredFailed({ api, repo, before, checkName, appId, depth }))) {
    log("previous main run did not fail; nothing to resume");
    return [];
  }
  const ticked = [];
  const prs = await api.paginate(`/repos/${repo}/pulls?state=open&per_page=100`);
  for (const pr of prs.filter((p) => isCandidate(p, { repo, prefix, label }))) {
    const latest = latestRun(await runsFor({ api, repo, sha: pr.head.sha, checkName, appId }));
    if (latest?.status !== "completed" || !failed(latest)) continue;
    const body = tickRebase(pr.body);
    if (!body) {
      log(`#${pr.number}: no unticked rebase checkbox`);
      continue;
    }
    await api.patch(`/repos/${repo}/pulls/${pr.number}`, { body });
    log(`#${pr.number}: ticked the rebase checkbox`);
    ticked.push(pr.number);
  }
  return ticked;
}
