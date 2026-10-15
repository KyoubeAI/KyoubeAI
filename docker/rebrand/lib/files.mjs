/**
 * The file set the transform touches: served UI, the server's dist output, the
 * whole `packages` workspace, the skills agents read, the CLI, shipped docs.
 * Text files only; `node_modules` and anything under a `bin` directory are
 * never entered.
 *
 * `packages/**` is admitted whole — not just `packages/*_/dist` — because the
 * image's CMD is `node --import tsx/dist/loader.mjs server/dist/index.js`: tsx
 * resolves every `@paperclipai/*` workspace import through each package's
 * `exports` map, which points at `./src/*.ts`. The TypeScript sources under
 * `packages/**\/src` are the live code (several packages ship no `dist` at
 * all), so agent prompts, adapter config labels and log prefixes all live
 * there. Code files under `packages` go through `rewriteCode`, which applies
 * the generic name rule only in display context so a lucide `import
 * { Paperclip }` or a `<Paperclip/>` element is never renamed.
 *
 * Two file kinds are admitted for reasons of their own:
 * - `packages/plugins/**` sources, because `GET /api/plugins/examples` serves
 *   the example plugins' `package.json` and `src/manifest.ts` `description`
 *   strings verbatim to Settings → Plugins.
 * - the scripts the skills ship (`.sh`, `.py`, `.js`, `.mjs`), because the
 *   usage text an agent runs them for is user-facing.
 *
 * `.sql` is deliberately absent: `packages/db/src/client.ts` resolves which
 * migrations are already applied by hashing the migration files and matching
 * those hashes against `drizzle.__drizzle_migrations` (`loadAppliedMigrations`),
 * so editing a shipped migration would make an upgraded install believe it is
 * pending. See docs/branding.md's residual record.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

const TEXT = [".js", ".mjs", ".cjs", ".css", ".html", ".webmanifest", ".json", ".svg", ".map", ".txt", ".md", ".yaml", ".yml"];
const PACKAGE_TEXT = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yaml", ".yml", ".sh", ".py", ".service"];
const SCRIPTS = [".md", ".json", ".yaml", ".yml", ".sh", ".py", ".js", ".mjs"];
const SKIP_DIRS = new Set(["node_modules", "bin", ".git"]);

/** Extensions whose `packages/**` files are rewritten with the code-context rules. */
export const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/** [relative root, extension allowlist, filter on the path relative to that root] */
const ROOTS = [
  ["ui/dist", TEXT, () => true],
  ["server/dist", [".js", ".mjs", ".cjs", ".json", ".md"], () => true],
  ["packages", PACKAGE_TEXT, () => true],
  ["skills", SCRIPTS, () => true],
  ["skills-releases", SCRIPTS, () => true],
  [".agents", SCRIPTS, () => true],
  ["cli/dist", [".js", ".mjs", ".cjs"], () => true],
  ["doc", [".md"], () => true],
  ["docs", [".md"], () => true],
];

/** A code file the server runs from source: rewrite it with `rewriteCode`, not `rewriteText`. */
export function isCodeFile(relToRoot) {
  return relToRoot.startsWith("packages/") && CODE_EXTENSIONS.includes(path.extname(relToRoot));
}

/**
 * Trees (and a few single files) the build-time sweep is allowed to find the
 * upstream name in: material shipped in the image that the running product
 * never reads. Everything else must be zero after the transform, or `--verify`
 * fails the build. Determined empirically by running the sweep against
 * `ghcr.io/paperclipai/paperclip:2026.831.1` and triaging every row (and again
 * on each core bump; entries marked 2026.916 were added for that release).
 *
 * - `ui/src`, `ui/storybook`, `ui/index.html`, `ui/public`, `ui/README.md`,
 *   `ui/package.json`: the board is served from `ui/dist`, which is NOT
 *   allowlisted — a residual there still fails the build.
 * - `server/src`: the CMD runs `server/dist/index.js`.
 * - `cli`: `/app/cli` ships no `dist` (its `bin` points at one), nothing in the
 *   image execs it, and the image exposes `kyoube`, not `paperclipai`.
 * - `doc/plans`, `docs/docs.json`, `docs/images`: upstream's own design plans
 *   and the Mintlify doc-site config/artwork; the product serves neither.
 * - `packages/paperclip-runner/runner`: the Rust crate sources behind the
 *   prebuilt runner binary — compiled upstream, never built here.
 * - `LICENSE`: upstream's copyright notice. Rewriting an attribution would be
 *   a licensing problem, not a branding fix.
 * - `.claude`, `.github`, `design`, `docker`, `evals`, `patches`, `releases`,
 *   `report`, `screenshots`, `scripts`, `tests`, `tools`: upstream's own
 *   development material.
 * - `announcements` (2026.916): the source of upstream's hosted announcement
 *   feed and its examples. The server fetches the feed from
 *   PAPERCLIP_ANNOUNCEMENTS_FEED_URL and never reads this tree, and
 *   docker-compose.yml turns announcements off.
 * - `ui/connect-flow-preview.html`, `ui/connect-model-preview.html` (2026.916):
 *   Vite entry points for upstream's onboarding previews, like `ui/index.html`;
 *   the board is served from `ui/dist`.
 * - `.env.example` (2026.916): upstream's sample environment file; the image
 *   never reads it (KyoubeAI's own is the one in this repository).
 * - `.devin` (2026.1001): upstream's DeepWiki pages about its own repository
 *   (`.devin/wiki.json`); the product never reads them.
 * - `doc/connections/tool-method-permission-reviews.json` (2026.1005): upstream's
 *   review notes on each connector tool's permissions, read only by its own
 *   tests (`tool-access-service.test.ts`, `app-definitions.test.ts`).
 * - `feature-map` (2026.1012): upstream's recipes for reproducing and verifying
 *   each feature, written for its own developers and agents; the product never
 *   reads them.
 * - `integrations/assistant-plugins` (2026.1012): the source of upstream's own
 *   Claude and OpenAI (ChatGPT/Codex) plugins for its "Assistant connections
 *   (MCP)" feature, built and published upstream. Nothing in the image reads
 *   or serves it (only upstream's `tests/runner-e2e` mentions it).
 *
 * An entry may be a multi-segment prefix or an exact file path; the longest
 * match names the row a file is counted under, otherwise it is counted under
 * its first path segment (`.` for a file at the root).
 */
export const SWEEP_ALLOWLIST = [
  ".claude",
  ".devin",
  ".env.example",
  ".github",
  "LICENSE",
  "announcements",
  "cli",
  "design",
  "doc/connections/tool-method-permission-reviews.json",
  "doc/plans",
  "docker",
  "docs/docs.json",
  "docs/images",
  "evals",
  "feature-map",
  "integrations/assistant-plugins",
  "packages/paperclip-runner/runner",
  "patches",
  "releases",
  "report",
  "screenshots",
  "scripts",
  "server/src",
  "tests",
  "tools",
  "ui/README.md",
  "ui/connect-flow-preview.html",
  "ui/connect-model-preview.html",
  "ui/index.html",
  "ui/package.json",
  "ui/public",
  "ui/src",
  "ui/storybook",
];

const SWEEP_PREFIXES = [...SWEEP_ALLOWLIST].sort((a, b) => b.length - a.length);

/**
 * Files the sweep counts and prints but does not fail on, with the reason each
 * cannot be rewritten. Narrow patterns, so a residual anywhere else still fails.
 */
export const SWEEP_KNOWN_RESIDUALS = [
  {
    pattern: /^packages\/db\/src\/migrations\/[^/]+\.sql$/,
    reason:
      "a shipped migration: packages/db/src/client.ts resolves which migrations are already applied by hashing these files and matching the hashes against drizzle.__drizzle_migrations (loadAppliedMigrations), so editing one would make an upgraded install replay it. 0105_instance_scoped_environments.sql is the one that seeds display text (the default environment's description); the rest are SQL comments",
  },
];

/** The reason this path is a known residual, or undefined if it is not one. */
export function knownResidualReason(relToRoot) {
  return SWEEP_KNOWN_RESIDUALS.find((entry) => entry.pattern.test(relToRoot))?.reason;
}

const SWEEP_SKIP_DIRS = new Set(["node_modules", ".git", "__tests__"]);
const SWEEP_SKIP_FILE = /(\.map|\.d\.ts)$|\.(test|spec)\.[A-Za-z0-9]+$/;

/** The sweep row one path is counted under. */
export function sweepArea(relToRoot) {
  for (const prefix of SWEEP_PREFIXES) {
    if (relToRoot === prefix || relToRoot.startsWith(`${prefix}/`)) return prefix;
  }
  const slash = relToRoot.indexOf("/");
  return slash === -1 ? "." : relToRoot.slice(0, slash);
}

async function walk(dir, out, symlinks) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      symlinks?.push(abs);
    } else if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(abs, out, symlinks);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

export async function collectFiles(root) {
  const files = [];
  const symlinks = [];
  for (const [rel, extensions, filter] of ROOTS) {
    const base = path.join(root, rel);
    const found = [];
    await walk(base, found, symlinks);
    for (const abs of found) {
      const relToRoot = path.relative(base, abs).replace(/\\/g, "/");
      if (extensions.includes(path.extname(abs)) && filter(relToRoot)) files.push(abs);
    }
  }
  // Top-level markdown (README.md, SECURITY.md, …).
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(path.join(root, entry.name));
  }
  const skippedSymlinks = [...new Set(symlinks.map((abs) => path.relative(root, abs).replace(/\\/g, "/")))].sort();
  return { files, skippedSymlinks };
}

/** Every text-ish file under `root`, for the whole-image residual sweep. */
export async function collectSweepFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM") continue;
      throw error;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SWEEP_SKIP_DIRS.has(entry.name)) stack.push(abs);
      } else if (entry.isFile() && !SWEEP_SKIP_FILE.test(entry.name)) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

export function isBinary(buffer) {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true;
  return false;
}
