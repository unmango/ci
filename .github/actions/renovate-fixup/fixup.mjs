// Only package-updates still imports this, until #24.
/** @import { Exec, Octokit, Repo } from "../types.mjs" */

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
