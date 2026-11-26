import { test } from "node:test";
import assert from "node:assert/strict";
import { fileChanges, push } from "../.github/actions/renovate-fixup/fixup.mjs";

const raw = (...entries) => entries.map(([meta, path]) => `${meta}\0${path}\0`).join("");

test("fileChanges reads staged blobs, deletions and refusals", () => {
  assert.deepEqual(
    fileChanges(
      raw(
        [":100644 100644 o1 n1 M", "gomod2nix.toml"],
        [":000000 100755 o2 n2 A", "new file.sh"],
        [":100644 000000 o3 n3 D", "old.json"],
        [":000000 120000 o4 n4 A", "link"],
        [":000000 160000 o5 n5 A", "sub"],
        [":100644 100644 o6 n6 M", ".github/workflows/ci.yml"],
      ),
    ),
    {
      additions: [
        { path: "gomod2nix.toml", blob: "n1" },
        { path: "new file.sh", blob: "n2" },
      ],
      deletions: ["old.json"],
      refused: ["link", "sub", ".github/workflows/ci.yml"],
    },
  );
  assert.deepEqual(fileChanges(""), { additions: [], deletions: [], refused: [] });
});

const repo = { owner: "o", repo: "r" };

function fakeExec(stdout) {
  return {
    async exec() {
      throw new Error("unexpected");
    },
    async getExecOutput(cmd, args) {
      if (cmd === "git") {
        assert.deepEqual(args, ["diff", "--cached", "--raw", "-z", "--no-renames", "base"]);
        return { exitCode: 0, stdout, stderr: "" };
      }
      assert.equal(cmd, "bash");
      assert.equal(args[1], 'git cat-file blob "$1" | base64 -w0');
      return { exitCode: 0, stdout: `base64 of ${args[3]}`, stderr: "" };
    },
  };
}

test("push commits the staged blobs against the expected head", async () => {
  const calls = [];
  const github = {
    async graphql(query, variables) {
      calls.push(variables.input);
      return { createCommitOnBranch: { commit: { oid: "new" } } };
    },
  };
  const result = await push({
    github,
    exec: fakeExec(raw([":100644 100644 o1 n1 M", "a.toml"], [":100644 000000 o2 n2 D", "b.json"])),
    repo,
    branch: "renovate/x",
    expectedHeadOid: "base",
    message: "fixup",
  });
  assert.deepEqual(result, { oid: "new", refused: [] });
  assert.deepEqual(calls, [
    {
      branch: { repositoryNameWithOwner: "o/r", branchName: "renovate/x" },
      expectedHeadOid: "base",
      message: { headline: "fixup" },
      fileChanges: {
        additions: [{ path: "a.toml", contents: "base64 of n1" }],
        deletions: [{ path: "b.json" }],
      },
    },
  ]);
});

const noGraphql = {
  async graphql() {
    throw new Error("unexpected");
  },
};

test("push commits nothing without changes", async () => {
  assert.deepEqual(await push({ github: noGraphql, exec: fakeExec(""), repo, branch: "b", expectedHeadOid: "base", message: "m" }), {
    oid: null,
    refused: [],
  });
});

test("push commits nothing when a change is refused", async () => {
  const exec = fakeExec(raw([":100644 100644 o1 n1 M", "a.toml"], [":000000 120000 o2 n2 A", "leak"]));
  assert.deepEqual(await push({ github: noGraphql, exec, repo, branch: "b", expectedHeadOid: "base", message: "m" }), {
    oid: null,
    refused: ["leak"],
  });
});
