type repo = {owner: string, repo: string}

module Core = {
  type inputOptions = {required: bool}
  @module("@actions/core") external input: (string, inputOptions) => string = "getInput"
  @module("@actions/core") external info: string => unit = "info"
  @module("@actions/core") external setOutput: (string, string) => unit = "setOutput"
  @module("@actions/core") external setFailed: string => unit = "setFailed"
}

type response<'a> = {data: 'a}

type commit = {sha: string}

type checkRun = {
  // Check run ids are past 2^31.
  id: float,
  status: string,
  conclusion: Nullable.t<string>,
  @as("started_at") startedAt: Nullable.t<string>,
}

type label = {name: string}
type headRepo = {@as("full_name") fullName: string}
type head = {ref: string, sha: string, repo: Nullable.t<headRepo>}
type pullRequest = {
  number: int,
  body: Nullable.t<string>,
  labels: array<label>,
  head: head,
}

type listCommits = {owner: string, repo: string, sha: string, @as("per_page") perPage: int}

type listCheckRuns = {
  owner: string,
  repo: string,
  ref: string,
  @as("check_name") checkName: string,
  @as("app_id") appId: int,
  filter: string,
  @as("per_page") perPage: int,
}
type checkRuns = {@as("check_runs") checkRuns: array<checkRun>}

type listPulls = {
  owner: string,
  repo: string,
  state: string,
  head?: string,
  @as("per_page") perPage: int,
}

type addLabels = {
  owner: string,
  repo: string,
  @as("issue_number") issueNumber: int,
  labels: array<string>,
}

type updatePull = {
  owner: string,
  repo: string,
  @as("pull_number") pullNumber: int,
  body: string,
}

type repos = {listCommits: listCommits => promise<response<array<commit>>>}
type checks = {listForRef: listCheckRuns => promise<response<checkRuns>>}
type pulls = {
  list: listPulls => promise<response<array<pullRequest>>>,
  update: updatePull => promise<response<unknown>>,
}
type issues = {addLabels: addLabels => promise<response<unknown>>}
type rest = {repos: repos, checks: checks, pulls: pulls, issues: issues}

type t = {rest: rest}
type options = {auth: string, baseUrl?: string}
@module("@octokit/rest") @new external octokit: options => t = "Octokit"
@scope(("process", "env")) @val external apiUrl: option<string> = "GITHUB_API_URL"
let make = token => octokit({auth: token, baseUrl: ?apiUrl})
@send
external paginate: (t, 'params => promise<response<array<'a>>>, 'params) => promise<array<'a>> =
  "paginate"

let commitShas = async (t, {owner, repo}: repo, ~sha, ~depth) => {
  let {data} = await t.rest.repos.listCommits({owner, repo, sha, perPage: depth})
  data->Array.map(c => c.sha)
}

let checkRuns = async (t, {owner, repo}: repo, ~ref, ~checkName, ~appId) => {
  let {data} = await t.rest.checks.listForRef({
    owner,
    repo,
    ref,
    checkName,
    appId,
    filter: "all",
    perPage: 100,
  })
  data.checkRuns
}

type addition = {path: string, blob: string}
type fileChanges = {additions: array<addition>, deletions: array<string>, refused: array<string>}

let regular = ["100644", "100755"]

// Reads `git diff --cached --raw -z --no-renames` output.
let fileChanges = raw => {
  let fields = raw->String.split("\u0000")->Array.filter(f => f != "")
  let changes = {additions: [], deletions: [], refused: []}
  for i in 0 to fields->Array.length / 2 - 1 {
    let path = fields->Array.getUnsafe(2 * i + 1)
    switch fields->Array.getUnsafe(2 * i)->String.split(" ") {
    | _ if path->String.startsWith(".github/workflows/") => changes.refused->Array.push(path)
    | [_, _, _, _, "D"] => changes.deletions->Array.push(path)
    // A symlink would make the read follow it off the tree.
    | [_, mode, _, blob, _] if regular->Array.includes(mode) =>
      changes.additions->Array.push({path, blob})
    | _ => changes.refused->Array.push(path)
    }
  }
  changes
}

type branchRef = {repositoryNameWithOwner: string, branchName: string}
type headline = {headline: string}
type fileAddition = {path: string, contents: string}
type fileDeletion = {path: string}
type fileChangesInput = {additions: array<fileAddition>, deletions: array<fileDeletion>}
type createCommitInput = {
  branch: branchRef,
  expectedHeadOid: string,
  message: headline,
  fileChanges: fileChangesInput,
}

type staged<'a> =
  | Refused(array<string>)
  | Unchanged
  | Commit('a)

let stage = (~repo: repo, ~branch, ~expectedHeadOid, ~message, ~contents, changes: fileChanges) =>
  switch changes {
  | {refused} if refused->Array.length > 0 => Refused(refused)
  | {additions: [], deletions: []} => Unchanged
  | {additions, deletions} =>
    Commit({
      branch: {repositoryNameWithOwner: `${repo.owner}/${repo.repo}`, branchName: branch},
      expectedHeadOid,
      message: {headline: message},
      fileChanges: {
        additions: additions->Array.map(({path, blob}): fileAddition => {
          path,
          contents: contents(blob),
        }),
        deletions: deletions->Array.map((path): fileDeletion => {path: path}),
      },
    })
  }

type createCommitVariables = {input: createCommitInput}
type committed = {oid: string}
type createdCommit = {commit: committed}
type createCommitResult = {createCommitOnBranch: createdCommit}
@send
external graphql: (t, string, createCommitVariables) => promise<createCommitResult> = "graphql"

let createCommit = `
mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`

// Signed by GitHub, and only if the branch still points at expectedHeadOid.
// Reads the index's blobs, never the work tree.
let push = async (t, ~repo, ~branch, ~expectedHeadOid, ~message) =>
  switch Git.staged(expectedHeadOid)
  ->fileChanges
  ->stage(~repo, ~branch, ~expectedHeadOid, ~message, ~contents=Git.blobBase64, _) {
  | Refused(paths) => Refused(paths)
  | Unchanged => Unchanged
  | Commit(input) =>
    let {createCommitOnBranch: {commit: {oid}}} = await t->graphql(createCommit, {input: input})
    Commit(oid)
  }
