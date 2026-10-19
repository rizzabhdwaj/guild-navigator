// One tiny build script. esbuild bundles three separate scripts into dist/:
//   sidebar (React)  -> dist/sidebar.js + dist/index.html
//   content script   -> dist/content.js
//   background       -> dist/background.js
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  sourcemap: true,
  target: "firefox109",
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
};

const builds = [
  // The sidebar can be a normal ES module (it's a real page).
  { ...shared, entryPoints: ["src/sidebar/main.tsx"], outfile: "dist/sidebar.js", format: "esm", jsx: "automatic" },
  // Content + background scripts are injected as plain scripts, so IIFE.
  { ...shared, entryPoints: ["src/content.ts"], outfile: "dist/content.js", format: "iife" },
  { ...shared, entryPoints: ["src/background.ts"], outfile: "dist/background.js", format: "iife" },
];

// public/ (manifest.json, index.html, icons) is copied as-is.
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });

if (watch) {
  for (const options of builds) (await context(options)).watch();
  console.log("watching for changes...");
} else {
  await Promise.all(builds.map((options) => build(options)));
}
