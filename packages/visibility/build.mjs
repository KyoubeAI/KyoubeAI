import esbuild from "esbuild";
import { execSync } from "node:child_process";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

// The library the visibility plugins and the kyoube CLI import.
await esbuild.build({ entryPoints: ["src/index.ts"], outfile: "dist/index.js", bundle: true, platform: "node", format: "esm", target: ["node24"], logLevel: "info" });

// The decision the core's authorization patch imports from /opt/kyoube/visibility/decide.mjs:
// one self-contained file with no dependencies, so it loads from a path outside any
// node_modules tree.
await esbuild.build({ entryPoints: ["src/core-entry.ts"], outfile: "dist/decide.mjs", bundle: true, platform: "node", format: "esm", target: ["node24"], logLevel: "info" });

// Declarations for the workspace packages' typecheck. TypeScript 7's tsc rejects file
// arguments next to a tsconfig.json (TS5112), so they come from a project file.
execSync("pnpm exec tsc -p tsconfig.build.json", { stdio: "inherit" });
