import { fileChanges, push } from "../renovate-fixup/fixup.mjs";

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

/**
 * @typedef {object} PullRequest
 * @property {number} number
 * @property {string} node_id
 * @property {string} title
 * @property {{ name: string }[]} labels
 */

/**
 * Commits one bump on `update/<name>`, reset to `base`, and opens or retitles
 * its PR, so each package has one branch and one PR.
 *
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Exec} opts.exec
 * @param {Repo} opts.repo
 * @param {Result & { title: string }} opts.result
 * @param {string} opts.base The default branch's commit the bump ran on.
 * @param {string} opts.defaultBranch
 * @param {string} opts.patch
 * @param {string} opts.label For a bump that doesn't build.
 * @param {boolean} opts.dryRun
 * @param {(message: string) => void} opts.log
 */
export async function publish({ github, exec, repo, result, base, defaultBranch, patch, label, dryRun, log }) {
  const branch = `update/${result.name}`;
  /** @type {PullRequest[]} */
  const prs = await github.paginate("GET /repos/{owner}/{repo}/pulls", { ...repo, state: "open", head: `${repo.owner}:${branch}`, per_page: 100 });
  const pr = prs[0];
  if (pr?.title === result.title) {
    log(`${branch}: #${pr.number} already has ${result.title}`);
    return;
  }
  if (dryRun) {
    log(`${branch}: would ${pr ? `update #${pr.number}` : "open a PR"} with ${result.title}`);
    return;
  }

  await exec.exec("git", ["reset", "--quiet", "--hard", base]);
  await exec.exec("git", ["apply", "--index", patch]);
  const staged = await exec.getExecOutput("git", ["diff", "--cached", "--raw", "-z", "--no-renames", base], { silent: true });
  const { refused } = fileChanges(staged.stdout);
  if (refused.length > 0) throw new Error(`refused to push symlinks, submodules or workflows: ${refused.join(", ")}`);
  // Committed on a scratch branch first, so update/<name> never points at
  // base and its PR never shows an empty diff.
  const scratch = `${branch}-${base.slice(0, 12)}`;
  await github.request("POST /repos/{owner}/{repo}/git/refs", { ...repo, ref: `refs/heads/${scratch}`, sha: base });
  try {
    const { oid } = await push({ github, exec, repo, branch: scratch, expectedHeadOid: base, message: result.title });
    if (!oid) throw new Error("the patch changed nothing");
    try {
      await github.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { ...repo, ref: `heads/${branch}`, sha: oid, force: true });
    } catch (/** @type {any} */ e) {
      if (e.status !== 422 && e.status !== 404) throw e;
      await github.request("POST /repos/{owner}/{repo}/git/refs", { ...repo, ref: `refs/heads/${branch}`, sha: oid });
    }
  } finally {
    await github.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { ...repo, ref: `heads/${scratch}` });
  }

  let number = pr?.number;
  if (pr) {
    await github.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pr.number, title: result.title });
  } else {
    const { data } = await github.request("POST /repos/{owner}/{repo}/pulls", {
      ...repo,
      title: result.title,
      head: branch,
      base: defaultBranch,
      body: "Automated update to the latest upstream release.",
    });
    number = data.number;
    try {
      await github.graphql("mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }", {
        id: data.node_id,
      });
    } catch (/** @type {any} */ e) {
      log(`#${number}: auto-merge not enabled: ${e.message}`);
    }
  }

  const labelled = pr?.labels.some((l) => l.name === label);
  if (result.kind === "unbuildable" && !labelled) {
    await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: number, labels: [label] });
  } else if (result.kind === "bumped" && labelled) {
    await github.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { ...repo, issue_number: number, name: label });
  }
  log(`${branch}: #${number} ${pr ? "updated" : "opened"} with ${result.title}`);
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
  } else if (inputs.step === "publish") {
    /** @type {Result[]} */
    const results = JSON.parse(inputs.results);
    /** @type {Result[]} */
    const failures = results.filter((r) => r.kind === "failed");
    for (const result of results) {
      if (result.kind !== "bumped" && result.kind !== "unbuildable") continue;
      try {
        await publish({
          github,
          exec,
          repo,
          result: { ...result, title: result.title ?? `${result.name}: update` },
          base: inputs.base,
          defaultBranch: inputs["default-branch"],
          patch: `${inputs.dir}/${result.name}.patch`,
          label: inputs.label,
          dryRun,
          log: core.info,
        });
      } catch (/** @type {any} */ e) {
        core.warning(`${result.name}: ${e.message}`);
        failures.push({ name: result.name, kind: "failed", reason: `publishing failed: ${e.message}` });
      }
    }
    core.setOutput("failures", JSON.stringify(failures));
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
