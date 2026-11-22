export function client({ token, baseUrl = "https://api.github.com", fetch = globalThis.fetch }) {
  async function request(method, url, body) {
    const res = await fetch(url.startsWith("http") ? url : baseUrl + url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body && { "content-type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${res.statusText}: ${await res.text()}`);
    return res;
  }

  return {
    get: async (path) => (await request("GET", path)).json(),
    patch: async (path, body) => (await request("PATCH", path, body)).json(),
    async paginate(path) {
      const items = [];
      for (let url = path; url; ) {
        const res = await request("GET", url);
        items.push(...(await res.json()));
        url = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      }
      return items;
    },
  };
}
