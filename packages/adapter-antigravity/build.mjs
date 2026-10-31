import esbuild from "esbuild";
import { execSync } from "node:child_process";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

// Server adapter bundle: self-contained ESM for Node 24+ so the core server
// can load it directly from /opt/kyoube/adapters/antigravity/dist/index.js.
await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node24"],
  logLevel: "info",
});

// UI stdout parser bundle: self-contained ESM with zero runtime imports for
// execution inside the browser Web Worker sandbox (/api/adapters/:type/ui-parser.js).
await esbuild.build({
  entryPoints: ["src/ui-parser.ts"],
  outfile: "dist/ui-parser.js",
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: ["es2023"],
  logLevel: "info",
});

execSync("pnpm exec tsc -p tsconfig.build.json", { stdio: "inherit" });
