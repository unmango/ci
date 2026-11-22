# ci
Reusable GitHub Actions workflows for Nix repositories

## CI health

`ci-health.yml` runs daily and rewrites the pinned "CI health" issue in UnstoppableMango/nixos: each repo's latest `required` result on `main`, its open `renovate:needs-human` pull requests, and p50 and p90 of the `required` run's duration over 7 days.
Monday's run also comments a digest of everything that doesn't page.
A `main` red for more than 24 hours pages through ntfy, once per daily run until it is green.
The repositories it watches are listed in the workflow; a manual run can name others in its `repos` input.

It needs:

- `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY`: thecluster[bot], installed on both accounts with actions, checks, contents and issues read, and issues write on UnstoppableMango/nixos.
- `CI_HEALTH_NTFY_TOPIC`: the topic in pik8s3's `uptime-ntfy` var (`clan vars get pik8s3 uptime-ntfy/topic`).

Run the tests with `node --test 'ci-health/*.test.mjs'`.
