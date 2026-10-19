// Builds the tests with esbuild (so TypeScript + bundling "just work") and
// leaves jsdom external, then node:test runs dist-tests/.
import { build } from "esbuild";
import { globSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";

await rm("dist-tests", { recursive: true, force: true });
await mkdir("dist-tests", { recursive: true });

await build({
  entryPoints: globSync("tests/**/*.test.ts"),
  outdir: "dist-tests",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external", // keep jsdom (and node builtins) external
  sourcemap: false,
  logLevel: "info",
});
