import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "../src/github.mjs";

function fakeFetch(routes) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    const r = routes[url];
    if (!r) return new Response("missing", { status: 404, statusText: "Not Found" });
    return new Response(JSON.stringify(r.body), { status: 200, headers: r.headers ?? {} });
  };
  return { fetch, seen };
}

test("get sends the token and API headers", async () => {
  const { fetch, seen } = fakeFetch({ "https://api.test/x": { body: { ok: 1 } } });
  const api = client({ token: "t", baseUrl: "https://api.test", fetch });
  assert.deepEqual(await api.get("/x"), { ok: 1 });
  assert.equal(seen[0].init.headers.authorization, "Bearer t");
  assert.equal(seen[0].init.headers.accept, "application/vnd.github+json");
});

test("paginate follows Link rel=next", async () => {
  const { fetch } = fakeFetch({
    "https://api.test/l?per_page=1": { body: [1], headers: { link: '<https://api.test/l?per_page=1&page=2>; rel="next", <https://api.test/l?per_page=1&page=2>; rel="last"' } },
    "https://api.test/l?per_page=1&page=2": { body: [2] },
  });
  const api = client({ token: "t", baseUrl: "https://api.test", fetch });
  assert.deepEqual(await api.paginate("/l?per_page=1"), [1, 2]);
});

test("patch sends a JSON body", async () => {
  const { fetch, seen } = fakeFetch({ "https://api.test/p": { body: {} } });
  await client({ token: "t", baseUrl: "https://api.test", fetch }).patch("/p", { body: "b" });
  assert.equal(seen[0].init.method, "PATCH");
  assert.equal(seen[0].init.body, '{"body":"b"}');
});

test("a non-2xx response throws with the status and path", async () => {
  const { fetch } = fakeFetch({});
  await assert.rejects(client({ token: "t", baseUrl: "https://api.test", fetch }).get("/nope"), /GET \/nope: 404/);
});
