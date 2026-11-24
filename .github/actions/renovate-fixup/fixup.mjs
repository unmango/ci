import { previousRequiredFailed } from "../renovate-resume/resume.mjs";

/** @import { Core, Exec, Inputs, Octokit, Repo } from "../types.mjs" */

/**
 * @typedef {object} FileChanges createCommitOnBranch's file changes, before contents are read.
 * @property {string[]} additions Paths added or modified.
 * @property {string[]} deletions Paths deleted.
 */

/**
 * @param {string} nameStatus `git diff --name-status -z --no-renames` output.
 * @returns {FileChanges}
 */
export function fileChanges(nameStatus) {
  const fields = nameStatus.split("\0").filter((f) => f !== "");
  /** @type {FileChanges} */
  const changes = { additions: [], deletions: [] };
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [status, path] = [fields[i], fields[i + 1]];
    (status === "D" ? changes.deletions : changes.additions).push(path);
  }
  return changes;
}

const CREATE_COMMIT = `
mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url } }
}`;

/**
 * Commits the applied patch through the API, so the commit is signed, and only
 * if the branch still points at `expectedHeadOid`.
 *
 * @param {object} opts
 * @param {Octokit} opts.github
 * @param {Exec} opts.exec
 * @param {Repo} opts.repo
 * @param {string} opts.branch
 * @param {string} opts.expectedHeadOid
 * @param {string} opts.message
 * @param {(path: string) => Promise<string>} [opts.read] A file's contents, base64-encoded.
 * @returns {Promise<string | null>} The new commit's oid, or null when there is nothing to commit.
 */
export async function push({ github, exec, repo, branch, expectedHeadOid, message, read }) {
  const { stdout } = await exec.getExecOutput("git", ["diff", "--cached", "--name-status", "-z", "--no-renames", expectedHeadOid], {
    silent: true,
  });
  const { additions, deletions } = fileChanges(stdout);
  if (additions.length === 0 && deletions.length === 0) return null;
  const base64 = read ?? (async (/** @type {string} */ path) => (await exec.getExecOutput("base64", ["-w0", "--", path], { silent: true })).stdout);
  const input = {
    branch: { repositoryNameWithOwner: `${repo.owner}/${repo.repo}`, branchName: branch },
    expectedHeadOid,
    message: { headline: message },
    fileChanges: {
      additions: await Promise.all(additions.map(async (path) => ({ path, contents: await base64(path) }))),
      deletions: deletions.map((path) => ({ path })),
    },
  };
  const result = await github.graphql(CREATE_COMMIT, { input });
  return result.createCommitOnBranch.commit.oid;
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
export async function label({ github, repo, branch, defaultBranch, label, checkName, appId, depth, log }) {
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
    const oid = await push({
      github,
      exec,
      repo: { owner, repo },
      branch: inputs.branch,
      expectedHeadOid: inputs.sha,
      message: inputs.message,
    });
    core.info(oid ? `pushed ${oid} to ${inputs.branch}` : "nothing to push");
    core.setOutput("oid", oid ?? "");
  } else if (inputs.step === "label") {
    const pr = await label({
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
