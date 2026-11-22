const byNewest = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id;

export function evaluate(statuses, { context, login }) {
  const forContext = statuses.filter((s) => s.context === context).sort(byNewest);
  // Only the creator ties a status to an app.
  const trusted = (s) => s.creator?.login === login && s.creator?.type === "Bot";
  const ignored = forContext.filter((s) => !trusted(s));
  const latest = forContext.find(trusted);
  if (!latest || latest.state === "pending") return { verdict: "wait", status: latest, ignored };
  return { verdict: latest.state === "success" ? "pass" : "fail", status: latest, ignored };
}

export async function resolveAppLogin(github, slug, id) {
  const { data: app } = await github.request("GET /apps/{app_slug}", { app_slug: slug });
  if (app.id !== id) throw new Error(`app ${slug} has id ${app.id}, expected ${id}`);
  return `${app.slug}[bot]`;
}

export async function waitFor({ github, repo, sha, context, login, timeoutMs, intervalMs, log, now = Date.now, sleep }) {
  const deadline = now() + timeoutMs;
  let result;
  for (;;) {
    const statuses = await github.paginate("GET /repos/{owner}/{repo}/commits/{ref}/statuses", { ...repo, ref: sha, per_page: 100 });
    result = evaluate(statuses, { context, login });
    for (const s of result.ignored) log(`ignoring ${s.state} on ${context} from ${s.creator?.login ?? "unknown"} (${s.creator?.type ?? "?"})`);
    if (result.verdict !== "wait") return result;
    if (now() + intervalMs > deadline) return { ...result, verdict: "timeout" };
    await sleep(intervalMs);
  }
}

export async function run({ github, core, inputs, now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const [owner, repo] = inputs.repository.split("/");
  const { context, sha } = inputs;
  const login = await resolveAppLogin(github, inputs["app-slug"], Number(inputs["app-id"]));
  core.info(`waiting for ${context} from ${login} on ${sha}`);

  const result = await waitFor({
    github,
    repo: { owner, repo },
    sha,
    context,
    login,
    timeoutMs: Number(inputs["timeout-minutes"]) * 60_000,
    intervalMs: Number(inputs["interval-seconds"]) * 1000,
    log: core.warning,
    now,
    sleep,
  });

  core.setOutput("verdict", result.verdict);
  core.setOutput("ignored", result.ignored.length);
  const link = result.status?.target_url ? ` (${result.status.target_url})` : "";
  if (result.verdict === "pass") core.info(`${context} passed${link}`);
  else if (result.verdict === "fail") core.setFailed(`${context} is ${result.status.state}${link}`);
  else core.setFailed(`no final ${context} from ${login} within ${inputs["timeout-minutes"]} minutes`);
}
