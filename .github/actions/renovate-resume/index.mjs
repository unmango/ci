import { input, main, setOutput } from "../../../src/action.mjs";
import { client } from "../../../src/github.mjs";
import { resume } from "../../../src/resume.mjs";

await main(async () => {
  const ticked = await resume({
    api: client({ token: input("token"), baseUrl: process.env.GITHUB_API_URL }),
    repo: input("repository"),
    before: input("before"),
    checkName: input("check-name"),
    appId: Number(input("app-id")),
    depth: Number(input("depth")),
    prefix: input("branch-prefix"),
    label: input("label"),
    log: console.log,
  });
  setOutput("ticked", JSON.stringify(ticked));
});
