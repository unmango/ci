/** @import { Core, Exec, Inputs, Octokit, Repo } from "../types.mjs" */

/**
 * @typedef {object} Result What one package's bump came to.
 * @property {string} name
 * @property {"current" | "bumped" | "unbuildable" | "failed"} kind
 * @property {string} [title] The commit and PR title, for a bump.
 * @property {string} [reason] Why it failed.
 */

/** The bump command's exit code for an update that changed files but doesn't build. */
export const UNBUILDABLE = 3;

/**
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseList(stdout) {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** @type {(text: string) => string | undefined} */
const lastLine = (text) => parseList(text).at(-1);

/**
 * @param {object} opts
 * @param {string} opts.name
 * @param {number} opts.code The bump command's exit code.
 * @param {string} opts.stdout Its last line is the title of a bump.
 * @param {string} opts.stderr
 * @param {boolean} opts.changed Whether the work tree changed.
 * @returns {Result}
 */
export function classify({ name, code, stdout, stderr, changed }) {
  if (code !== 0 && code !== UNBUILDABLE) {
    return { name, kind: "failed", reason: lastLine(stderr) ?? lastLine(stdout) ?? `exit ${code}` };
  }
  if (!changed) {
    return code === 0 ? { name, kind: "current" } : { name, kind: "failed", reason: "reported unbuildable without changing anything" };
  }
  return { name, kind: code === 0 ? "bumped" : "unbuildable", title: lastLine(stdout) ?? `${name}: update` };
}

/**
 * @param {Result[]} failures
 * @param {{ runUrl: string, now: Date }} opts
 */
export function renderFailures(failures, { runUrl, now }) {
  const when = now.toISOString().replace(/\.\d+Z$/, "Z");
  // Code spans, so an @mention in build output notifies nobody.
  const lines = failures.map((f) => `- \`${f.name}\`: \`${(f.reason ?? "").replaceAll("`", "'")}\``);
  return [
    `Rewritten by each [package updates run](${runUrl}); last ${when}.`,
    "",
    failures.length === 0 ? "No package failed to update." : lines.join("\n"),
    "",
  ].join("\n");
}

/** `timeout`'s exit code when the command ran out of time. */
const TIMED_OUT = 124;

/**
 * The step's environment without what github-script and the runner hand an
 * action: its inputs and the runtime tokens, which would let a bump write the
 * Actions cache.
 *
 * @returns {Record<string, string>}
 */
function commandEnv() {
  /** @type {Record<string, string>} */
  const env = /** @type {any} */ (globalThis).process.env;
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(INPUT_|INPUTS$|ACTIONS_)/.test(k)));
}

/**
 * Runs the bump command for each listed package from a clean tree, holding
 * no token that can write. Each bump's staged diff goes to `<dir>/<name>.patch`.
 *
 * @param {object} opts
 * @param {Exec} opts.exec
 * @param {string[]} opts.names
 * @param {string} opts.bump Shell command, run with the package name appended.
 * @param {string} opts.dir
 * @param {string} opts.timeout Per package, as `timeout` reads it, such as `60m`.
 * @param {(message: string) => void} opts.log
 * @returns {Promise<Result[]>}
 */
export async function bumpAll({ exec, names, bump, dir, timeout, log }) {
  const base = (await exec.getExecOutput("git", ["rev-parse", "HEAD"], { silent: true })).stdout.trim();
  const env = commandEnv();
  /** @type {Result[]} */
  const results = [];
  for (const name of names) {
    await exec.exec("git", ["reset", "--quiet", "--hard", base]);
    await exec.exec("git", ["clean", "--quiet", "--force", "-d"]);
    const { exitCode, stdout, stderr } = await exec.getExecOutput("timeout", [timeout, "bash", "-c", `${bump} "$1"`, "bump", name], {
      ignoreReturnCode: true,
      env,
    });
    await exec.exec("git", ["add", "--all"]);
    const staged = await exec.getExecOutput("git", ["diff", "--cached", "--quiet"], { ignoreReturnCode: true, silent: true });
    const result =
      exitCode === TIMED_OUT
        ? { name, kind: /** @type {const} */ ("failed"), reason: `timed out after ${timeout}` }
        : classify({ name, code: exitCode, stdout, stderr, changed: staged.exitCode !== 0 });
    if (result.kind === "bumped" || result.kind === "unbuildable") {
      await exec.exec("git", ["diff", "--cached", "--binary", `--output=${dir}/${name}.patch`]);
    }
    log(`${name}: ${result.kind}${result.title ? ` (${result.title})` : ""}${result.reason ? `: ${result.reason}` : ""}`);
    results.push(result);
  }
  await exec.exec("git", ["reset", "--quiet", "--hard", base]);
  return results;
}

const ISSUE_TITLE = "Package update failures";

/**
 * Rewrites the one pinned failures issue, creating it on the first failure.
 *
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Repo} opts.repo
 * @param {string} opts.body
 * @param {boolean} opts.any Whether anything failed.
 * @param {(message: string) => void} opts.warn
 */
export async function report({ github, repo, body, any, warn }) {
  /** @type {{ number: number, node_id: string, title: string, pull_request?: unknown }[]} */
  const open = await github.paginate("GET /repos/{owner}/{repo}/issues", { ...repo, state: "open", per_page: 100 });
  const issue = open.find((i) => !i.pull_request && i.title === ISSUE_TITLE);
  if (issue) {
    await github.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { ...repo, issue_number: issue.number, body });
    return;
  }
  if (!any) return;
  const { data } = await github.request("POST /repos/{owner}/{repo}/issues", { ...repo, title: ISSUE_TITLE, body });
  try {
    await github.graphql("mutation($id: ID!) { pinIssue(input: { issueId: $id }) { issue { id } } }", { id: data.node_id });
  } catch (/** @type {any} */ e) {
    warn(`could not pin #${data.number}: ${e.message}`);
  }
}

/**
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Exec} opts.exec
 * @param {Core} opts.core
 * @param {Inputs} opts.inputs
 * @param {() => Date} [opts.now]
 */
export async function run({ github, exec, core, inputs, now = () => new Date() }) {
  const [owner, name] = inputs.repository.split("/");
  const repo = { owner, repo: name };
  const dryRun = inputs["dry-run"] === "true";

  if (inputs.step === "bump") {
    const { exitCode, stdout, stderr } = await exec.getExecOutput("bash", ["-c", inputs.list], { ignoreReturnCode: true, env: commandEnv() });
    if (exitCode !== 0) {
      core.setFailed(`list failed: ${lastLine(stderr) ?? `exit ${exitCode}`}`);
      return;
    }
    const results = await bumpAll({ exec, names: parseList(stdout), bump: inputs.bump, dir: inputs.dir, timeout: inputs.timeout, log: core.info });
    core.setOutput("results", JSON.stringify(results));
    core.setOutput("failures", JSON.stringify(results.filter((r) => r.kind === "failed")));
  } else if (inputs.step === "report") {
    /** @type {Result[]} */
    const failures = JSON.parse(inputs.failures);
    const body = renderFailures(failures, { runUrl: inputs["run-url"], now: now() });
    await core.summary.addRaw(body).write();
    if (!dryRun) await report({ github, repo, body, any: failures.length > 0, warn: core.warning });
  } else {
    core.setFailed(`unknown step ${inputs.step}`);
  }
}
