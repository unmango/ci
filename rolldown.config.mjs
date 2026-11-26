import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/Main.res.mjs",
  platform: "node",
  output: {
    file: "dist/unmango-ci.mjs",
    format: "esm",
    minify: true,
    sourcemap: true,
  },
  transform: { target: "node24" },
});
