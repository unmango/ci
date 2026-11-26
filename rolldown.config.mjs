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
  // Drops the HTTP client @actions/core imports for OIDC alone.
  treeshake: { moduleSideEffects: (id) => !id.includes("/node_modules/@actions/") },
});
