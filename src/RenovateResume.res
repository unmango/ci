type options = {repo: Github.repo, prefix: string, label: string}

type decision =
  | Tick(string)
  | NoCheckbox
  | Ignore

let unticked = /- \[ \] <!-- rebase-check -->/

let tickRebase = body =>
  switch body->Nullable.toOption {
  | Some(b) if unticked->RegExp.test(b) =>
    Some(b->String.replaceRegExp(unticked, "- [x] <!-- rebase-check -->"))
  | _ => None
  }

let isCandidate = (pr: Github.pullRequest, {repo, prefix, label}) =>
  pr.head.ref->String.startsWith(prefix) &&
  pr.head.repo->Nullable.mapOr(false, r => r.fullName == `${repo.owner}/${repo.repo}`) &&
  !(pr.labels->Array.some(l => l.name == label))

let failed = (run: Github.checkRun) =>
  switch run.conclusion->Nullable.toOption {
  | Some("failure" | "timed_out") => true
  | _ => false
  }

let latestRun = (~completed=false, runs: array<Github.checkRun>) =>
  runs
  ->Array.filter(r => !completed || r.status == "completed")
  ->Array.toSorted((a, b) =>
    switch Date.fromString(b.startedAt)->Date.getTime -.
      Date.fromString(a.startedAt)->Date.getTime {
    | 0. => Int.toFloat(b.id - a.id)
    | d => d
    }
  )
  ->Array.get(0)

// Drops a scheduled run's skipped required and a cancelled run.
let commitVerdict = runs =>
  runs
  ->Array.filter(r => r.Github.conclusion == Value("success") || failed(r))
  ->latestRun(~completed=true)
  ->Option.map(failed)

let hasHistory = before => before != "" && !(/^0+$/->RegExp.test(before))

let decide = (pr: Github.pullRequest, runs) =>
  switch latestRun(runs) {
  | Some(r) if r.status == "completed" && failed(r) =>
    switch tickRebase(pr.body) {
    | Some(body) => Tick(body)
    | None => NoCheckbox
    }
  | _ => Ignore
  }

let run = async _args => {
  let input = name => Github.Core.input(name, {required: true})
  let int = name => input(name)->Int.fromString->Option.getOrThrow
  let octokit = Github.make({auth: input("token")})
  let {owner, repo} as full = Github.parseRepo(input("repository"))
  let before = Github.Core.input("before", {required: false})
  let checkName = input("check-name")
  let appId = int("app-id")
  let depth = int("depth")
  let opts = {repo: full, prefix: input("branch-prefix"), label: input("label")}
  let runsFor = async ref => {
    let {data} = await octokit.rest.checks.listForRef({
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

  let previousFailed = async () => {
    let {data: commits} = await octokit.rest.repos.listCommits({
      owner,
      repo,
      sha: before,
      perPage: depth,
    })
    let rec walk = async i =>
      switch commits[i] {
      | None => false
      | Some(c) =>
        let runs = await runsFor(c.sha)
        switch commitVerdict(runs) {
        | Some(verdict) => verdict
        | None => await walk(i + 1)
        }
      }
    await walk(0)
  }

  let resume = hasHistory(before) ? await previousFailed() : false
  let ticked = []
  if !resume {
    Github.Core.info("previous main run did not fail; nothing to resume")
  } else {
    let prs = await octokit->Github.paginate(
      octokit.rest.pulls.list,
      {owner, repo, state: "open", perPage: 100},
    )
    for i in 0 to prs->Array.length - 1 {
      let pr = prs->Array.getUnsafe(i)
      if isCandidate(pr, opts) {
        let runs = await runsFor(pr.head.sha)
        switch decide(pr, runs) {
        | Tick(body) =>
          let _ = await octokit.rest.pulls.update({owner, repo, pullNumber: pr.number, body})
          Github.Core.info(`#${pr.number->Int.toString}: ticked the rebase checkbox`)
          ticked->Array.push(pr.number)
        | NoCheckbox => Github.Core.info(`#${pr.number->Int.toString}: no unticked rebase checkbox`)
        | Ignore => ()
        }
      }
    }
  }
  Github.Core.setOutput("ticked", ticked->JSON.stringifyAny->Option.getOr("[]"))
}

let subcommand: Cli.subcommand = {
  name: "renovate-resume",
  summary: "Tick the rebase box on Renovate PRs that failed while main was red",
  run,
}
