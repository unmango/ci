open Test
open! Github

let equals = (a, b) => assertion(~operator="equals", (a, b) => a == b, a, b)

let raw = entries =>
  entries->Array.map(((meta, path)) => `${meta}\u0000${path}\u0000`)->Array.join("")

test("fileChanges reads staged blobs, deletions and refusals", () => {
  equals(
    fileChanges(
      raw([
        (":100644 100644 o1 n1 M", "gomod2nix.toml"),
        (":000000 100755 o2 n2 A", "new file.sh"),
        (":100644 000000 o3 n3 D", "old.json"),
        (":000000 120000 o4 n4 A", "link"),
        (":000000 160000 o5 n5 A", "sub"),
        (":100644 100644 o6 n6 M", ".github/workflows/ci.yml"),
      ]),
    ),
    {
      additions: [{path: "gomod2nix.toml", blob: "n1"}, {path: "new file.sh", blob: "n2"}],
      deletions: ["old.json"],
      refused: ["link", "sub", ".github/workflows/ci.yml"],
    },
  )
  equals(fileChanges(""), {additions: [], deletions: [], refused: []})
})

let changes = fileChanges(
  raw([(":100644 100644 o1 n1 M", "a.toml"), (":100644 000000 o2 n2 D", "b.json")]),
)
let stage = (~contents=_ => JsError.throwWithMessage("read a blob"), changes) =>
  stage(
    ~repo={owner: "o", repo: "r"},
    ~branch="renovate/x",
    ~expectedHeadOid="base",
    ~message="fixup",
    ~contents,
    changes,
  )

test("stage commits the staged blobs against the expected head", () =>
  equals(
    stage(~contents=blob => `base64 of ${blob}`, changes),
    Commit({
      branch: {repositoryNameWithOwner: "o/r", branchName: "renovate/x"},
      expectedHeadOid: "base",
      message: {headline: "fixup"},
      fileChanges: {
        additions: [{path: "a.toml", contents: "base64 of n1"}],
        deletions: [{path: "b.json"}],
      },
    }),
  )
)

test("stage commits nothing without changes", () => equals(stage(fileChanges("")), Unchanged))

test("stage commits nothing when a change is refused", () =>
  equals(
    stage(
      fileChanges(raw([(":100644 100644 o1 n1 M", "a.toml"), (":000000 120000 o2 n2 A", "leak")])),
    ),
    Refused(["leak"]),
  )
)
