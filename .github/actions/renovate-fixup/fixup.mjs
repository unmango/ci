import { previousRequiredFailed } from "../renovate-resume/resume.mjs";

/** @import { Core, Exec, Inputs, Octokit, Repo } from "../types.mjs" */

/**
 * @typedef {object} FileChanges createCommitOnBranch's file changes, before contents are read.
 * @property {{ path: string, blob: string }[]} additions Paths added or modified, with their staged blob.
 * @property {string[]} deletions Paths deleted.
 * @property {string[]} refused Paths that aren't regular files, or that the App can't write.
 */

const REGULAR = new Set(["100644", "100755"]);

/**
 * @param {string} raw `git diff --cached --raw -z --no-renames` output.
 * @returns {FileChanges}
 */
export function fileChanges(raw) {
  const fields = raw.split("\0").filter((f) => f !== "");
  /** @type {FileChanges} */
  const changes = { additions: [], deletions: [], refused: [] };
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, newMode, , blob, status] = fields[i].split(" ");
    const path = fields[i + 1];
    if (path.startsWith(".github/workflows/")) changes.refused.push(path);
    else if (status === "D") changes.deletions.push(path);
    // A symlink would make the read follow it off the tree.
    else if (!REGULAR.has(newMode)) changes.refused.push(path);
    else changes.additions.push({ path, blob });
  }
  return changes;
}

const CREATE_COMMIT = `
mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url } }
}`;

/**
 * Commits the staged changes through the API, so the commit is signed, and only
 * if the branch still points at `expectedHeadOid`. Contents come from the
 * index's blobs, never the work tree, which the patch wrote.
 *
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Exec} opts.exec
 * @param {Repo} opts.repo
 * @param {string} opts.branch
 * @param {string} opts.expectedHeadOid
 * @param {string} opts.message
 * @returns {Promise<{ oid: string | null, refused: string[] }>} The new commit, or null when nothing was committed.
 */
export async function push({ github, exec, repo, branch, expectedHeadOid, message }) {
  const { stdout } = await exec.getExecOutput("git", ["diff", "--cached", "--raw", "-z", "--no-renames", expectedHeadOid], { silent: true });
  const { additions, deletions, refused } = fileChanges(stdout);
  if (refused.length > 0) return { oid: null, refused };
  if (additions.length === 0 && deletions.length === 0) return { oid: null, refused };
  /** @type {(blob: string) => Promise<string>} */
  const base64 = async (blob) => (await exec.getExecOutput("bash", ["-c", 'git cat-file blob "$1" | base64 -w0', "read", blob], { silent: true })).stdout;
  const input = {
    branch: { repositoryNameWithOwner: `${repo.owner}/${repo.repo}`, branchName: branch },
    expectedHeadOid,
    message: { headline: message },
    fileChanges: {
      additions: await Promise.all(additions.map(async ({ path, blob }) => ({ path, contents: await base64(blob) }))),
      deletions: deletions.map((path) => ({ path })),
    },
  };
  const result = await github.graphql(CREATE_COMMIT, { input });
  return { oid: result.createCommitOnBranch.commit.oid, refused };
}

/**
 * Labels the branch's PR, unless main's last finished required run failed:
 * then renovate-resume reruns the PR once main is green.
 *
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Repo} opts.repo
 * @param {string} opts.branch
 * @param {string} opts.defaultBranch
 * @param {string} opts.label
 * @param {string} opts.checkName
 * @param {number} opts.appId
 * @param {number} opts.depth
 * @param {(message: string) => void} opts.log
 * @returns {Promise<number | null>} The PR labelled.
 */
export async function labelFailed({ github, repo, branch, defaultBranch, label, checkName, appId, depth, log }) {
  if (await previousRequiredFailed({ github, repo, before: defaultBranch, checkName, appId, depth })) {
    log(`${defaultBranch} is red; leaving ${label} off`);
    return null;
  }
  /** @type {{ number: number }[]} */
  const prs = await github.paginate("GET /repos/{owner}/{repo}/pulls", { ...repo, state: "open", head: `${repo.owner}:${branch}`, per_page: 100 });
  if (prs.length === 0) {
    log(`no open PR for ${branch}`);
    return null;
  }
  const [{ number }] = prs;
  await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: number, labels: [label] });
  log(`#${number}: labelled ${label}`);
  return number;
}

/**
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Exec} opts.exec
 * @param {Core} opts.core
 * @param {Inputs} opts.inputs
 */
export async function run({ github, exec, core, inputs }) {
  const [owner, repo] = inputs.repository.split("/");
  if (inputs.step === "push") {
    const { oid, refused } = await push({
      github,
      exec,
      repo: { owner, repo },
      branch: inputs.branch,
      expectedHeadOid: inputs.sha,
      message: inputs.message,
    });
    core.setOutput("oid", oid ?? "");
    if (refused.length > 0) {
      core.setOutput("refused", "true");
      core.setFailed(`refused to push symlinks, submodules or workflows: ${refused.join(", ")}`);
      return;
    }
    core.info(oid ? `pushed ${oid} to ${inputs.branch}` : "nothing to push");
  } else if (inputs.step === "label") {
    const pr = await labelFailed({
      github,
      repo: { owner, repo },
      branch: inputs.branch,
      defaultBranch: inputs["default-branch"],
      label: inputs.label,
      checkName: inputs["check-name"],
      appId: Number(inputs["app-id"]),
      depth: Number(inputs.depth),
      log: core.info,
    });
    core.setOutput("pr", pr ?? "");
  } else {
    core.setFailed(`unknown step ${inputs.step}`);
  }
}
