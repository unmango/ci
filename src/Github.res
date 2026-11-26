type repo = {owner: string, repo: string}

let parseRepo = full =>
  switch full->String.split("/") {
  | [owner, repo] => {owner, repo}
  | _ => JsError.throwWithMessage(`not owner/repo: ${full}`)
  }

module Core = {
  type inputOptions = {required: bool}
  @module("@actions/core") external input: (string, inputOptions) => string = "getInput"
  @module("@actions/core") external info: string => unit = "info"
  @module("@actions/core") external setOutput: (string, string) => unit = "setOutput"
}

type response<'a> = {data: 'a}

type commit = {sha: string}

type checkRun = {
  id: int,
  status: string,
  conclusion: Nullable.t<string>,
  @as("started_at") startedAt: string,
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

type listPulls = {owner: string, repo: string, state: string, @as("per_page") perPage: int}

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
type rest = {repos: repos, checks: checks, pulls: pulls}

type t = {rest: rest}
type options = {auth: string}
@module("@octokit/rest") @new external make: options => t = "Octokit"
@send
external paginate: (t, 'params => promise<response<array<'a>>>, 'params) => promise<array<'a>> =
  "paginate"
