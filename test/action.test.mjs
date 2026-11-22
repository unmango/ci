import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { input, main, setOutput } from "../src/action.mjs";

test("input reads INPUT_ variables the way the runner names them", () => {
  const env = { "INPUT_TIMEOUT-MINUTES": " 5 " };
  assert.equal(input("timeout-minutes", { env }), "5");
});

test("input falls back to a default and refuses a missing required one", () => {
  assert.equal(input("x", { env: {}, fallback: "d" }), "d");
  assert.throws(() => input("x", { env: {} }), /input x is required/);
});

test("setOutput appends to GITHUB_OUTPUT", () => {
  const file = join(mkdtempSync(join(tmpdir(), "out-")), "out");
  setOutput("verdict", "pass", { env: { GITHUB_OUTPUT: file } });
  setOutput("ignored", "2", { env: { GITHUB_OUTPUT: file } });
  assert.equal(readFileSync(file, "utf8"), "verdict=pass\nignored=2\n");
});

test("main reports a multi-line error as one annotation", async (t) => {
  const lines = [];
  t.mock.method(console, "log", (l) => lines.push(l));
  await main(async () => {
    throw new Error("a\nb");
  });
  assert.deepEqual(lines, ["::error::a%0Ab"]);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});
