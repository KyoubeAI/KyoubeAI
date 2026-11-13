import esbuild from "esbuild";
import { readFile, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

// Worker-side bundles: the runtime dependencies (package.json `dependencies`) stay external
// (shipped via pnpm deploy); @kyoube/visibility is a workspace devDependency, bundled in so
// `pnpm deploy --prod` needs no copy of it.
const { dependencies } = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const runtimeDependencies = Object.keys(dependencies ?? {});

await esbuild.build({
  entryPoints: { manifest: "src/manifest.ts", worker: "src/worker.ts" },
  outdir: "dist",
  bundle: true,
  external: [...new Set([...runtimeDependencies, "@paperclipai/plugin-sdk", "@paperclipai/plugin-sdk/*"])],
  platform: "node",
  format: "esm",
  target: ["node24"],
  sourcemap: true,
  logLevel: "info",
});

// Browser bundle: everything bundled except what the Paperclip host provides.
const ui = await esbuild.build({
  entryPoints: { "ui/index": "src/ui/index.tsx" },
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  external: ["react", "react-dom", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui"],
  sourcemap: true,
  metafile: true,
  logLevel: "info",
});

// The Files tab must never ship the worker-side MCP code or zod: one stray
// import from `mcp/` once grew the browser bundle from ~39 KB to ~772 KB.
const forbidden = Object.keys(ui.metafile.inputs).filter((input) => /(^|\/)src\/mcp\//.test(input) || /\/node_modules\/zod\//.test(input))
  // Our own modules first: they name the import to remove.
  .sort((a, b) => Number(b.includes("src/mcp/")) - Number(a.includes("src/mcp/")));
if (forbidden.length > 0) {
  console.error(`dist/ui/index.js must not bundle the MCP tools or zod; it pulled in:\n  ${forbidden.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}
