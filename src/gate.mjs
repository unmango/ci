/** @import { Core, Inputs, Octokit, Repo } from "./types.mjs" */

/**
 * @typedef {object} Status
 * @property {number} id
 * @property {string} context
 * @property {"pending" | "success" | "failure" | "error"} state
 * @property {string} created_at
 * @property {string | null} [target_url]
 * @property {{ login: string, type: string } | null} [creator]
 */

/**
 * @typedef {object} Evaluation
 * @property {"wait" | "pass" | "fail" | "timeout"} verdict
 * @property {Status} [status] The latest status from the app.
 * @property {Status[]} ignored Statuses on the context from anyone else.
 */

/** @type {(a: Status, b: Status) => number} */
const byNewest = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id;

/**
 * @param {Status[]} statuses
 * @param {{ context: string, login: string }} opts
 * @returns {Evaluation}
 */
export function evaluate(statuses, { context, login }) {
  const forContext = statuses.filter((s) => s.context === context).sort(byNewest);
  // Only the creator ties a status to an app.
  const trusted = (/** @type {Status} */ s) => s.creator?.login === login && s.creator?.type === "Bot";
  const ignored = forContext.filter((s) => !trusted(s));
  const latest = forContext.find(trusted);
  if (!latest || latest.state === "pending") return { verdict: "wait", status: latest, ignored };
  return { verdict: latest.state === "success" ? "pass" : "fail", status: latest, ignored };
}

/**
 * @param {Octokit} github
 * @param {string} slug
 * @param {number} id
 * @returns {Promise<string>} The app's bot login.
 */
export async function resolveAppLogin(github, slug, id) {
  const { data: app } = await github.request("GET /apps/{app_slug}", { app_slug: slug });
  if (app.id !== id) throw new Error(`app ${slug} has id ${app.id}, expected ${id}`);
  return `${app.slug}[bot]`;
}

/**
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Repo} opts.repo
 * @param {string} opts.sha
 * @param {string} opts.context
 * @param {string} opts.login
 * @param {number} opts.timeoutMs
 * @param {number} opts.intervalMs
 * @param {(message: string) => void} opts.log
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<unknown>} opts.sleep
 * @returns {Promise<Evaluation>}
 */
export async function waitFor({ github, repo, sha, context, login, timeoutMs, intervalMs, log, now = Date.now, sleep }) {
  const deadline = now() + timeoutMs;
  let result;
  for (;;) {
    /** @type {Status[]} */
    const statuses = await github.paginate("GET /repos/{owner}/{repo}/commits/{ref}/statuses", { ...repo, ref: sha, per_page: 100 });
    result = evaluate(statuses, { context, login });
    for (const s of result.ignored) log(`ignoring ${s.state} on ${context} from ${s.creator?.login ?? "unknown"} (${s.creator?.type ?? "?"})`);
    if (result.verdict !== "wait") return result;
    if (now() + intervalMs > deadline) return { ...result, verdict: "timeout" };
    await sleep(intervalMs);
  }
}

/**
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Core} opts.core
 * @param {Inputs} opts.inputs
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<unknown>} [opts.sleep]
 */
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
  else if (result.verdict === "fail") core.setFailed(`${context} is ${result.status?.state}${link}`);
  else core.setFailed(`no final ${context} from ${login} within ${inputs["timeout-minutes"]} minutes`);
}
