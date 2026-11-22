# ci

Reusable GitHub Actions workflows for Nix repositories.
The design is the [Nix CI spec](https://github.com/UnstoppableMango/nixos/blob/main/docs/nix-ci.md).

## `nix-ci.yml`

The hosted jobs and the gate behind a repo's `required` check.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  nix:
    uses: unmango/ci/.github/workflows/nix-ci.yml@<sha> # <version>
    permissions:
      checks: read
      contents: read
      pull-requests: write
      statuses: read
    with:
      darwin: true
    secrets:
      CACHIX_AUTH_TOKEN: ${{ secrets.CACHIX_AUTH_TOKEN }}

  required:
    needs: [nix]
    if: always()
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - env:
          NEEDS: ${{ toJSON(needs) }}
        run: jq -e 'all(.[]; .result == "success" or .result == "skipped")' <<<"$NEEDS"
```

The `required` job stays in the caller: GitHub names a called workflow's checks `<caller job> / <job>`, so only a caller job can hold the `required` context the ruleset asks for.
Add any other job that should block a merge to its `needs`.
The calling job grants every permission a job in the workflow asks for, or the run fails to start.

| Input | Default | |
| --- | --- | --- |
| `darwin` | `false` | `nix flake check` on `macos-latest` |
| `aarch64-linux` | `false` | `nix flake check` on `ubuntu-24.04-arm` |
| `linux` | `false` | `nix flake check` on a hosted x86_64 runner instead of waiting for Hercules; for private repos and repos Hercules doesn't build |
| `cachix-push` | `true` | Push hosted builds to `unstoppablemango`, on pushes to `main` only |
| `hercules-timeout-minutes` | `345` | How long `gate` waits for Hercules; under 360, where the hosted job stops |

Every hosted job reads Cachix; only a push to `main` gets the token.

`gate` needs every hosted job, then:

- on a branch PR or `main`, waits for `ci/hercules/onPush/default` on the head commit and passes only on a green status created by the Hercules app (24794), ignoring the same context from anyone else;
- on a fork PR, or with `linux: true`, the hosted `linux` job builds instead and nothing waits for Hercules.

`renovate-resume` runs on a push to `main` once `gate` passes, and its failure never fails the call.
When the previous completed `required` run on `main` failed or timed out, it ticks the rebase checkbox on every open `renovate/` PR whose latest `required` run failed and that isn't labelled `renovate:needs-human`.

## `ci-health.yml`

Keeps one pinned "CI health" issue, labelled `ci-health`, in the calling repo, for the aggregator in [UnstoppableMango/nix](https://github.com/UnstoppableMango/nix) to read.
Call it from `ci.yml`, after `required`, and add a daily schedule:

```yaml
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "23 6 * * *"

concurrency:
  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  nix:
    if: github.event_name != 'schedule'
    # ...

  required:
    needs: [nix]
    if: always() && github.event_name != 'schedule'
    # ...

  ci-health:
    needs: [required]
    if: ${{ !cancelled() }}
    uses: unmango/ci/.github/workflows/ci-health.yml@<sha> # <version>
    permissions:
      actions: read
      issues: write
      pull-requests: read
```

Every other job skips the schedule, `required` included, or a scheduled run would put a green `required` on the head of `main`.
`event_name` in the concurrency group keeps a scheduled run from queueing behind a push's run on the same commit.

Each run reads the caller's workflow runs on pushes to the default branch and the `required` job in each:

- the latest `required` result, green or red;
- p50 and p90 over the last 7 days, timed from the run's start to `required` finishing, flagging a p50 over 5 minutes;
- open PRs labelled `renovate:needs-human`.

On a push or a schedule it rewrites the issue's body, creating and pinning the issue if there is none, with the caller's `GITHUB_TOKEN`.
On a PR it only writes the report to the job summary.
While `main` is red the issue carries `ci-health:red`, which comes off once it is green.
The body's first line is machine-readable, with `red_since` the creation time of the first run in the red streak:

```html
<!-- ci-health {"state":"red","red_since":"2026-11-20T09:00:00Z","p50":270,"p90":420} -->
```

`state` is `green`, `red`, or `unknown`; `p50` and `p90` are seconds, or `null` with no runs in the window.
Cancelled runs count toward neither the state nor the percentiles, and `unknown` leaves the label as it was.

## Development

Each composite action under `.github/actions/` runs the module beside it through `actions/github-script`, which supplies the Octokit client and `core`.
`nix-ci.yml` uses the actions through `$/`, so they come from the same commit.
The modules are typed with JSDoc and checked by `tsc -p jsconfig.json`.
`nix flake check` runs the type check and the tests; `node --test 'test/*.test.mjs'` runs the tests alone.
`ci.yml` calls `nix-ci.yml` both ways and holds the gate to ignoring a spoofed status, and calls `ci-health.yml` for this repo's own issue.
