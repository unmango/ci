import { test } from "node:test";
import assert from "node:assert/strict";
import { fileChanges, push, label } from "../.github/actions/renovate-fixup/fixup.mjs";

test("fileChanges splits additions from deletions", () => {
  assert.deepEqual(fileChanges("M\0gomod2nix.toml\0A\0new file.json\0D\0old.json\0"), {
    additions: ["gomod2nix.toml", "new file.json"],
    deletions: ["old.json"],
  });
  assert.deepEqual(fileChanges(""), { additions: [], deletions: [] });
});

const repo = { owner: "o", repo: "r" };

function fakeExec(stdout) {
  return {
    async exec() {
      throw new Error("unexpected");
    },
    async getExecOutput(cmd, args) {
      assert.equal(cmd, "git");
      assert.deepEqual(args, ["diff", "--cached", "--name-status", "-z", "--no-renames", "base"]);
      return { exitCode: 0, stdout, stderr: "" };
    },
  };
}

test("push commits the staged changes against the expected head", async () => {
  const calls = [];
  const github = {
    async graphql(query, variables) {
      calls.push(variables.input);
      return { createCommitOnBranch: { commit: { oid: "new" } } };
    },
  };
  const oid = await push({
    github,
    exec: fakeExec("M\0a.toml\0D\0b.json\0"),
    repo,
    branch: "renovate/x",
    expectedHeadOid: "base",
    message: "fixup",
    read: async (p) => `base64 of ${p}`,
  });
  assert.equal(oid, "new");
  assert.deepEqual(calls, [
    {
      branch: { repositoryNameWithOwner: "o/r", branchName: "renovate/x" },
      expectedHeadOid: "base",
      message: { headline: "fixup" },
      fileChanges: {
        additions: [{ path: "a.toml", contents: "base64 of a.toml" }],
        deletions: [{ path: "b.json" }],
      },
    },
  ]);
});

test("push commits nothing without changes", async () => {
  const github = {
    async graphql() {
      throw new Error("unexpected");
    },
  };
  assert.equal(await push({ github, exec: fakeExec(""), repo, branch: "b", expectedHeadOid: "base", message: "m" }), null);
});

const checkRun = (conclusion) => ({ id: 1, status: "completed", conclusion, started_at: "2026-01-01T00:00:00Z" });

function fakeApi({ main, prs }) {
  const labelled = [];
  return {
    labelled,
    async request(route, params) {
      if (route === "GET /repos/{owner}/{repo}/commits") {
        assert.equal(params.sha, "main");
        return { data: [{ sha: "m1" }] };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        return { data: { check_runs: main ? [checkRun(main)] : [] } };
      }
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels") {
        labelled.push([params.issue_number, params.labels]);
        return { data: [] };
      }
      throw new Error(`unexpected ${route}`);
    },
    async paginate(route, params) {
      assert.equal(route, "GET /repos/{owner}/{repo}/pulls");
      assert.equal(params.head, "o:renovate/x");
      return prs;
    },
  };
}

const opts = { repo, branch: "renovate/x", defaultBranch: "main", label: "renovate:needs-human", checkName: "required", appId: 15368, depth: 5, log() {} };

test("label labels the PR while main is green", async () => {
  const github = fakeApi({ main: "success", prs: [{ number: 7 }] });
  assert.equal(await label({ github, ...opts }), 7);
  assert.deepEqual(github.labelled, [[7, ["renovate:needs-human"]]]);
});

test("label labels when main has no finished required run", async () => {
  const github = fakeApi({ main: null, prs: [{ number: 7 }] });
  assert.equal(await label({ github, ...opts }), 7);
});

test("label leaves the label off while main is red", async () => {
  const github = fakeApi({ main: "failure", prs: [{ number: 7 }] });
  assert.equal(await label({ github, ...opts }), null);
  assert.deepEqual(github.labelled, []);
});

test("label does nothing without a PR", async () => {
  const github = fakeApi({ main: "success", prs: [] });
  assert.equal(await label({ github, ...opts }), null);
  assert.deepEqual(github.labelled, []);
});
