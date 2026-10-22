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
await esbuild.build({
  entryPoints: { "ui/index": "src/ui/index.tsx" },
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  external: ["react", "react-dom", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui"],
  sourcemap: true,
  logLevel: "info",
});
