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

export async function resolveAppLogin(api, slug, id) {
  const app = await api.get(`/apps/${slug}`);
  if (app.id !== id) throw new Error(`app ${slug} has id ${app.id}, expected ${id}`);
  return `${app.slug}[bot]`;
}

export async function waitFor({ api, repo, sha, context, login, timeoutMs, intervalMs, log, now = Date.now, sleep }) {
  const deadline = now() + timeoutMs;
  let result;
  for (;;) {
    const statuses = await api.paginate(`/repos/${repo}/commits/${sha}/statuses?per_page=100`);
    result = evaluate(statuses, { context, login });
    for (const s of result.ignored) log(`ignoring ${s.state} on ${context} from ${s.creator?.login ?? "unknown"} (${s.creator?.type ?? "?"})`);
    if (result.verdict !== "wait") return result;
    if (now() + intervalMs > deadline) return { ...result, verdict: "timeout" };
    await sleep(intervalMs);
  }
}
