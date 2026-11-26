type labelPlan =
  | MainRed
  | NoPullRequest
  | Moved(int)
  | Label(int)

// While main is red, renovate-resume reruns the PR once main is green instead.
let labelPlan = async (~defaultBranch, ~sha, sources: RenovateResume.sources) => {
  let red = await RenovateResume.previousFailed(~before=defaultBranch, sources)
  if red {
    MainRed
  } else {
    let prs = await sources.pulls()
    switch prs[0] {
    | None => NoPullRequest
    | Some(pr) if pr.head.sha != sha => Moved(pr.number)
    | Some(pr) => Label(pr.number)
    }
  }
}

let run = async _args => {
  let input = name => Github.Core.input(name, {required: false})
  let octokit = Github.make(input("token"))
  let repository = Cli.parseRepo(input("repository"))
  let {owner, repo} = repository
  let branch = input("branch")
  let sha = input("sha")
  switch input("step") {
  | "push" =>
    let pushed = await octokit->Github.push(
      ~repo=repository,
      ~branch,
      ~expectedHeadOid=sha,
      ~message="chore(deps): renovate fixup",
    )
    switch pushed {
    | Commit(oid) =>
      Github.Core.setOutput("oid", oid)
      Github.Core.info(`pushed ${oid} to ${branch}`)
    | Unchanged =>
      Github.Core.setOutput("oid", "")
      Github.Core.info("nothing to push")
    | Refused(paths) =>
      Github.Core.setOutput("oid", "")
      Github.Core.setOutput("refused", "true")
      Github.Core.setFailed(
        `refused to push symlinks, submodules or workflows: ${paths->Array.join(", ")}`,
      )
    }
  | "label" =>
    let defaultBranch = input("default-branch")
    let label = input("label")
    let checkName = input("check-name")
    let appId = input("app-id")->Int.fromString->Option.getOrThrow
    let sources: RenovateResume.sources = {
      commits: sha => octokit->Github.commitShas(repository, ~sha, ~depth=20),
      runsFor: ref => octokit->Github.checkRuns(repository, ~ref, ~checkName, ~appId),
      pulls: () =>
        octokit->Github.paginate(
          octokit.rest.pulls.list,
          {owner, repo, state: "open", head: `${owner}:${branch}`, perPage: 100},
        ),
    }
    let pr = switch await labelPlan(~defaultBranch, ~sha, sources) {
    | MainRed =>
      Github.Core.info(`${defaultBranch} is red; leaving ${label} off`)
      ""
    | NoPullRequest =>
      Github.Core.info(`no open PR for ${branch}`)
      ""
    | Moved(number) =>
      Github.Core.info(
        `#${number->Int.toString}: ${branch} moved past ${sha}; leaving ${label} off`,
      )
      ""
    | Label(number) =>
      let _ = await octokit.rest.issues.addLabels({
        owner,
        repo,
        issueNumber: number,
        labels: [label],
      })
      Github.Core.info(`#${number->Int.toString}: labelled ${label}`)
      number->Int.toString
    }
    Github.Core.setOutput("pr", pr)
  | step => Github.Core.setFailed(`unknown step ${step}`)
  }
}

let subcommand: Cli.subcommand = {
  name: "renovate-fixup",
  summary: "Push a Renovate branch's fixup, or label its PR when the fixup failed",
  run,
}
