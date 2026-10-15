import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectFiles, isBinary } from "../lib/files.mjs";
import { RebrandError, runRebrand } from "../rebrand.mjs";

const BRAND_JSON = {
  name: "KyoubeAI", shortName: "KyoubeAI", description: "AI OS", themeColor: "#18181b",
  urls: { home: "https://example.test/home", docs: "https://example.test/docs", feedback: "https://example.test/feedback", tos: "https://example.test/tos", repo: "https://example.test/repo" },
  phrases: { "[paperclip]": "[kyoubeai]" },
};
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4v16M18 4l-11 8 11 8"/></svg>';
const LOCKUP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 124 28" fill="currentColor"><path d="M6 4v16M18 4l-11 8 11 8" fill="none" stroke="currentColor" stroke-width="2"/><text x="30" y="21" font-family="Inter" font-weight="600" font-size="19">KyoubeAI</text></svg>';
const LOCKUP_JS = 'function DXn({decorative:e=!1,title:t="Paperclip",className:n,...r}){return(0,s.jsxs)("svg",{...r,className:n,viewBox:"22.5 22.5 121 27",fill:"currentColor",role:e?void 0:"img","aria-hidden":e?!0:void 0,"aria-label":e?void 0:t,focusable:"false",children:[(0,s.jsx)("path",{d:"M131.15 48.4902Z"})]})}';
const THINKING_JS = '(0,s.jsx)("path",{className:"paperclip-thinking-icon-path",d:"M16 6 l-8.414 8.586",fill:"none",stroke:"currentColor"})';
const INDEX_HTML = `<!DOCTYPE html><html><head><meta name="apple-mobile-web-app-title" content="Paperclip" /><title>Paperclip</title>
<!-- PAPERCLIP_RUNTIME_BRANDING_START -->
<!-- PAPERCLIP_RUNTIME_BRANDING_END -->
<script type="module" crossorigin src="/assets/index-BHbrFFmp.js"></script>
<link rel="modulepreload" crossorigin href="/assets/mention-chips-CbXq5njg.js">
<link rel="stylesheet" crossorigin href="/assets/index-BU41-p9M.css"></head><body><div id="root"></div></body></html>`;

async function makeTree(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "kyoube-rebrand-root-"));
  const brandDir = await mkdtemp(path.join(tmpdir(), "kyoube-rebrand-brand-"));
  await writeFile(path.join(brandDir, "brand.json"), JSON.stringify(BRAND_JSON));
  await writeFile(path.join(brandDir, "mark.svg"), MARK);
  await writeFile(path.join(brandDir, "lockup.svg"), LOCKUP);
  await mkdir(path.join(brandDir, "icons"), { recursive: true });
  for (const name of ["favicon.ico", "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png", "android-chrome-192x192.png", "android-chrome-512x512.png"]) {
    await writeFile(path.join(brandDir, "icons", name), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  }
  const files = {
    "ui/dist/index.html": INDEX_HTML,
    "ui/dist/site.webmanifest": JSON.stringify({ name: "Paperclip", short_name: "Paperclip", description: "x", theme_color: "#000", background_color: "#000", icons: [] }),
    "ui/dist/favicon.svg": "<svg>old</svg>",
    "ui/dist/favicon.ico": "old",
    "ui/dist/favicon-16x16.png": "old",
    "ui/dist/favicon-32x32.png": "old",
    "ui/dist/apple-touch-icon.png": "old",
    "ui/dist/android-chrome-192x192.png": "old",
    "ui/dist/android-chrome-512x512.png": "old",
    "ui/dist/paperclip-thinking.svg": "<svg>old thinking</svg>",
    "ui/dist/assets/index-BHbrFFmp.js": `${LOCKUP_JS};${THINKING_JS};var a="Welcome to Paperclip",b=e?.metadata?.managedByPaperclip,c="X-Paperclip-Run-Id",d=import("./CompanyExport-Z_xz3qVA.js"),f="/paperclip-thinking.svg",g="https://paperclip.ing/feedback",h=n.startsWith("[paperclip]");\n//# sourceMappingURL=index-BHbrFFmp.js.map`,
    "ui/dist/assets/index-BHbrFFmp.js.map": '{"version":3,"file":"index-BHbrFFmp.js","sources":["Paperclip.tsx"]}',
    "ui/dist/assets/CompanyExport-Z_xz3qVA.js": 'export const x="Exported from [Paperclip](https://paperclip.ing)"',
    "ui/dist/assets/mention-chips-CbXq5njg.js": 'e.set("X-Paperclip-Route",1)',
    "ui/dist/assets/index-BU41-p9M.css": ".paperclip-markdown{color:red}",
    "server/dist/services/heartbeat.js": 'const s="Paperclip task context:";export function buildPaperclipWakePayload(){}',
    "server/dist/vendor/paperclip-runner/bin/paperclip-runnerd": String.fromCharCode(0) + "ELF Paperclip binary",
    "packages/shared/dist/labels.js": 'export const L={type:"paperclip_runner",label:"Paperclip Runner"}',
    // `packages/**/src` is the live code: tsx resolves the workspace exports map there.
    "packages/shared/src/labels.ts": 'export const L = "Paperclip Runner";\n/** The Paperclip label. */\n',
    "packages/adapters/hermes/src/server/execute.ts": "  const prompt = 'You work in a Paperclip-managed company.';\n",
    "packages/adapter-utils/src/runtime-progress.ts": 'const PREFIX = "[paperclip]"; // the [paperclip] classifier\n',
    "packages/ui-kit/src/Icon.tsx": 'import { Paperclip } from "lucide-react";\nexport const Icon = () => <Paperclip className="h-4" />;\n',
    "packages/db/src/migrations/0105_instance_scoped_environments.sql": "INSERT INTO e VALUES ('Default execution environment for Paperclip runs on this machine.');",
    "packages/skills-catalog/skills/x/SKILL.md": "# Paperclip catalog skill",
    "packages/plugins/plugin-example/package.json": '{"name":"@paperclipai/plugin-example","description":"A Paperclip plugin that does things"}',
    "packages/plugins/plugin-example/src/manifest.ts": 'export default { description: "Paperclip example" };',
    "skills/paperclip/SKILL.md": "---\nname: paperclip\n---\n# Paperclip Skill\nTriggered by Paperclip.",
    "skills/paperclip/scripts/paperclip-upload-artifact.sh": 'echo "Upload an artifact to the current Paperclip"',
    "skills-releases/paperclip/1.0.0/SKILL.md": "Paperclip release",
    "cli/dist/index.js": 'console.log("Paperclip CLI")',
    // Source-only trees: shipped in the image, never executed by it.
    "ui/src/Sidebar.tsx": 'export const label = "Paperclip";',
    "cli/src/index.ts": 'console.log("Paperclip CLI");',
    "doc/plans/x.md": "Paperclip plan",
    "README.md": "# Paperclip",
    "node_modules/@paperclipai/shared/dist/x.js": '"Paperclip inside node_modules"',
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue; // an override of `null` omits the file entirely.
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return { root, brandDir };
}

const read = (root, rel) => readFile(path.join(root, rel), "utf8");

describe("collectFiles / isBinary", () => {
  it("walks the spec's file set and nothing else", async () => {
    const { root } = await makeTree();
    const rels = (await collectFiles(root)).files.map((f) => path.relative(root, f).replace(/\\/g, "/")).sort();
    expect(rels).toContain("ui/dist/index.html");
    expect(rels).toContain("ui/dist/assets/index-BHbrFFmp.js");
    expect(rels).toContain("ui/dist/assets/index-BHbrFFmp.js.map");
    expect(rels).toContain("server/dist/services/heartbeat.js");
    expect(rels).toContain("packages/shared/dist/labels.js");
    expect(rels).toContain("packages/skills-catalog/skills/x/SKILL.md");
    expect(rels).toContain("packages/plugins/plugin-example/package.json");
    expect(rels).toContain("packages/plugins/plugin-example/src/manifest.ts");
    expect(rels).toContain("skills/paperclip/SKILL.md");
    expect(rels).toContain("skills/paperclip/scripts/paperclip-upload-artifact.sh");
    expect(rels).toContain("skills-releases/paperclip/1.0.0/SKILL.md");
    expect(rels).toContain("cli/dist/index.js");
    expect(rels).toContain("doc/plans/x.md");
    expect(rels).toContain("README.md");
    // packages/** is live code: tsx runs it from src.
    expect(rels).toContain("packages/shared/src/labels.ts");
    expect(rels).toContain("packages/adapters/hermes/src/server/execute.ts");
    expect(rels).toContain("packages/adapter-utils/src/runtime-progress.ts");
    // .sql is deliberately out: client.ts matches migrations by content hash.
    expect(rels).not.toContain("packages/db/src/migrations/0105_instance_scoped_environments.sql");
    expect(rels).not.toContain("ui/src/Sidebar.tsx");
    expect(rels).not.toContain("cli/src/index.ts");
    expect(rels).not.toContain("server/dist/vendor/paperclip-runner/bin/paperclip-runnerd");
    expect(rels).not.toContain("node_modules/@paperclipai/shared/dist/x.js");
    expect(rels).not.toContain("ui/dist/favicon.ico");
  });

  it("reports a symlink it declined to follow", async () => {
    const { root } = await makeTree();
    try {
      await symlink(path.join(root, "packages/shared/dist/labels.js"), path.join(root, "packages/shared/dist/alias.js"));
    } catch (error) {
      if (error.code === "EPERM" || error.code === "ENOSYS") return; // Windows without developer mode.
      throw error;
    }
    const { files, skippedSymlinks } = await collectFiles(root);
    expect(skippedSymlinks).toContain("packages/shared/dist/alias.js");
    expect(files.map((f) => path.relative(root, f).replace(/\\/g, "/"))).not.toContain("packages/shared/dist/alias.js");
  });

  it("sniffs a NUL byte as binary", () => {
    expect(isBinary(Buffer.from("plain text"))).toBe(false);
    expect(isBinary(Buffer.from(String.fromCharCode(0) + "ELF"))).toBe(true);
  });
});

describe("runRebrand", () => {
  it("rebrands text, artwork, the bundle SVGs and the asset names, and verifies clean", async () => {
    const { root, brandDir } = await makeTree();
    const result = await runRebrand({ root, brandDir, verify: true, report: false, log: () => {} });

    // Text rules across the file set.
    const assets = await readdir(path.join(root, "ui/dist/assets"));
    const main = assets.find((n) => /^index-BHbrFFmp-[0-9a-f]{8}\.js$/.test(n));
    expect(main).toBeDefined();
    const js = await read(root, `ui/dist/assets/${main}`);
    expect(js).toContain('"Welcome to KyoubeAI"');
    expect(js).toContain("managedByPaperclip");
    expect(js).toContain('"X-Paperclip-Run-Id"');
    expect(js).toContain('"https://example.test/feedback"');
    expect(js).toContain('"[kyoubeai]"');
    expect(js).toContain('"/kyoubeai-thinking.svg"');
    expect(js).toContain('viewBox:"0 0 124 28"');
    expect(js).toContain('children:"KyoubeAI"');
    expect(js).toContain('pathLength:"85.717"');
    expect(await read(root, "server/dist/services/heartbeat.js")).toBe('const s="KyoubeAI task context:";export function buildPaperclipWakePayload(){}');
    expect(await read(root, "packages/shared/dist/labels.js")).toContain('label:"KyoubeAI Runner"');
    expect(await read(root, "packages/shared/dist/labels.js")).toContain('type:"paperclip_runner"');
    expect(await read(root, "skills/paperclip/SKILL.md")).toBe("---\nname: paperclip\n---\n# KyoubeAI Skill\nTriggered by KyoubeAI.");
    // The example plugins' sources back Settings → Plugins (GET /api/plugins/examples).
    const pluginPkg = await read(root, "packages/plugins/plugin-example/package.json");
    expect(pluginPkg).toContain('"A KyoubeAI plugin that does things"');
    expect(pluginPkg).toContain('"@paperclipai/plugin-example"');
    expect(await read(root, "packages/plugins/plugin-example/src/manifest.ts")).toContain('"KyoubeAI example"');
    // Scripts the skills ship print usage text.
    expect(await read(root, "skills/paperclip/scripts/paperclip-upload-artifact.sh")).toContain("the current KyoubeAI");
    // The live package sources: display text in strings, comments and prose is
    // rewritten; a lucide import and a JSX element are left alone and reported.
    expect(await read(root, "packages/shared/src/labels.ts")).toBe('export const L = "KyoubeAI Runner";\n/** The KyoubeAI label. */\n');
    expect(await read(root, "packages/adapters/hermes/src/server/execute.ts")).toContain("a KyoubeAI-managed company");
    expect(await read(root, "packages/adapter-utils/src/runtime-progress.ts")).toBe('const PREFIX = "[kyoubeai]"; // the [kyoubeai] classifier\n');
    expect(await read(root, "packages/ui-kit/src/Icon.tsx")).toBe('import { Paperclip } from "lucide-react";\nexport const Icon = () => <Paperclip className="h-4" />;\n');
    expect(result.codeShaped.filter((c) => c.startsWith("packages/ui-kit/src/Icon.tsx"))).toHaveLength(2);
    // Source-only trees and the hashed migration are left alone.
    expect(await read(root, "ui/src/Sidebar.tsx")).toContain('"Paperclip"');
    expect(await read(root, "cli/src/index.ts")).toContain('"Paperclip CLI"');
    expect(await read(root, "packages/db/src/migrations/0105_instance_scoped_environments.sql")).toContain("Paperclip runs");
    expect(await read(root, "node_modules/@paperclipai/shared/dist/x.js")).toContain("Paperclip inside");
    expect(await read(root, "server/dist/vendor/paperclip-runner/bin/paperclip-runnerd")).toContain("Paperclip binary");

    // Artwork.
    expect(await read(root, "ui/dist/favicon.svg")).toContain('d="M6 4v16M18 4l-11 8 11 8"');
    expect(await read(root, "ui/dist/kyoubeai-thinking.svg")).toContain("@keyframes draw");
    await expect(readFile(path.join(root, "ui/dist/paperclip-thinking.svg"))).rejects.toThrow();
    expect((await readFile(path.join(root, "ui/dist/favicon.ico")))[0]).toBe(0x89);
    expect(JSON.parse(await read(root, "ui/dist/site.webmanifest"))).toMatchObject({ name: "KyoubeAI", short_name: "KyoubeAI" });

    // index.html: title, app title, references.
    const html = await read(root, "ui/dist/index.html");
    expect(html).toContain("<title>KyoubeAI</title>");
    expect(html).toContain('content="KyoubeAI"');
    expect(html).toContain(`src="/assets/${main}"`);
    expect(html).not.toContain("index-BHbrFFmp.js\"");
    // Chunks and maps follow.
    const mapName = `${main}.map`;
    expect(assets).toContain(mapName);
    expect(js).toContain(`//# sourceMappingURL=${mapName}`);
    const exportChunk = assets.find((n) => /^CompanyExport-Z_xz3qVA-[0-9a-f]{8}\.js$/.test(n));
    expect(js).toContain(`import("./${exportChunk}")`);
    expect(assets.some((n) => /^index-BU41-p9M-[0-9a-f]{8}\.css$/.test(n))).toBe(true);
    expect(assets).not.toContain("index-BHbrFFmp.js");

    expect(result.anchors).toEqual({ lockup: 1, thinking: 1 });
    expect(result.residual).toEqual([]);
    expect(result.counts.name).toBeGreaterThan(5);
    // The sweep sees the whole tree: only source-only rows may be non-zero.
    expect(result.sweepFailures).toEqual([]);
    expect(result.sweep["ui/src"]).toBe(1);
    expect(result.sweep.cli).toBe(1);
    expect(result.sweep.packages).toBeUndefined();
    expect(result.knownResiduals.join("\n")).toContain("0105_instance_scoped_environments.sql");
    expect(result.notUtf8).toEqual([]);
  });

  describe("the whole-image sweep", () => {
    it("fails the build on a display string in a tree the file set never entered", async () => {
      // `.txt` is not in the packages extension list, so only the sweep sees it.
      const { root, brandDir } = await makeTree({ "packages/foo/src/fixtures/prompt.txt": "You work for Paperclip." });
      await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/sweep: packages still carries 1 display match/);
    });

    it("does not fail on a bare identifier, which it reports as code-shaped instead", async () => {
      const { root, brandDir } = await makeTree({ "packages/foo/src/y.ts": "import { Paperclip } from 'lucide-react';\n" });
      const result = await runRebrand({ root, brandDir, verify: true, report: false, log: () => {} });
      expect(result.sweepFailures).toEqual([]);
      expect(result.codeShaped.join("\n")).toContain("packages/foo/src/y.ts");
    });

    it("allows the upstream development material core 2026.916 added", async () => {
      const { root, brandDir } = await makeTree({
        "announcements/examples/staging/current.json": '{ "alt": "Paperclip. Ideas become work." }\n',
        "ui/connect-flow-preview.html": "<title>Connect flow — Paperclip onboarding</title>\n",
        "ui/connect-model-preview.html": "<title>Connect a model — Paperclip onboarding</title>\n",
        ".env.example": "# Optional Paperclip ID Gmail OAuth broker.\n",
      });
      const result = await runRebrand({ root, brandDir, verify: true, report: false, log: () => {} });
      expect(result.sweepFailures).toEqual([]);
      expect(result.sweep.announcements).toBe(1);
      expect(result.sweep["ui/connect-flow-preview.html"]).toBe(1);
      expect(result.sweep["ui/connect-model-preview.html"]).toBe(1);
      expect(result.sweep[".env.example"]).toBe(1);
    });

    it("allows the upstream development material cores 2026.1001 and 2026.1005 added, and nothing else under doc/connections", async () => {
      const { root, brandDir } = await makeTree({
        ".devin/wiki.json": '{ "repo_notes": [{ "content": "Paperclip is the control plane." }] }\n',
        "doc/connections/tool-method-permission-reviews.json": '{ "keyPermissions": "Grant Paperclip read access." }\n',
      });
      const result = await runRebrand({ root, brandDir, verify: true, report: false, log: () => {} });
      expect(result.sweepFailures).toEqual([]);
      expect(result.sweep[".devin"]).toBe(1);
      expect(result.sweep["doc/connections/tool-method-permission-reviews.json"]).toBe(1);
      const other = await makeTree({ "doc/connections/other.json": '{ "note": "Paperclip connects it." }\n' });
      await expect(runRebrand({ ...other, verify: true, report: false, log: () => {} })).rejects.toThrow(/sweep: doc still carries 1 display match/);
    });

    it("allows the upstream development material core 2026.1012 added, and nothing else under integrations", async () => {
      const { root, brandDir } = await makeTree({
        "feature-map/README.md": "# Paperclip feature map\n",
        "integrations/assistant-plugins/README.md": "# Paperclip assistant plugins\n",
      });
      const result = await runRebrand({ root, brandDir, verify: true, report: false, log: () => {} });
      expect(result.sweepFailures).toEqual([]);
      expect(result.sweep["feature-map"]).toBe(1);
      expect(result.sweep["integrations/assistant-plugins"]).toBe(1);
      const other = await makeTree({ "integrations/other/README.md": "# Paperclip integration\n" });
      await expect(runRebrand({ ...other, verify: true, report: false, log: () => {} })).rejects.toThrow(/sweep: integrations still carries 1 display match/);
    });

    it("still fails on a preview page or root file nobody has triaged", async () => {
      const preview = await makeTree({ "ui/other-preview.html": "<title>Paperclip preview</title>\n" });
      await expect(runRebrand({ ...preview, verify: true, report: false, log: () => {} })).rejects.toThrow(/sweep: ui still carries 1 display match/);
      const rootFile = await makeTree({ "NOTICE.txt": "Paperclip is great.\n" });
      await expect(runRebrand({ ...rootFile, verify: true, report: false, log: () => {} })).rejects.toThrow(/sweep: \. still carries 1 display match/);
    });

    it("prints the table, the code-shaped list and the skipped counts under --report", async () => {
      const { root, brandDir } = await makeTree();
      const lines = [];
      await runRebrand({ root, brandDir, verify: true, report: true, log: (line) => lines.push(line) });
      const out = lines.join("\n");
      expect(out).toMatch(/code-shaped matches left alone: \d+/);
      expect(out).toContain("whole-image sweep");
      expect(out).toMatch(/\* ui\/src\s+1/);
      expect(out).toContain("symlinks skipped");
      expect(out).toContain("known residual packages/db/src/migrations/0105_instance_scoped_environments.sql");
    });
  });

  it("is deterministic: the same inputs give the same asset names", async () => {
    const a = await makeTree();
    const b = await makeTree();
    await runRebrand({ root: a.root, brandDir: a.brandDir, verify: true, report: false, log: () => {} });
    await runRebrand({ root: b.root, brandDir: b.brandDir, verify: true, report: false, log: () => {} });
    expect((await readdir(path.join(a.root, "ui/dist/assets"))).sort()).toEqual((await readdir(path.join(b.root, "ui/dist/assets"))).sort());
  });

  it("fails verification when the lockup anchor is missing", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/assets/index-BHbrFFmp.js": `${THINKING_JS};var a="Paperclip";\n//# sourceMappingURL=index-BHbrFFmp.js.map` });
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(RebrandError);
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/lockup anchor matched 0 times/);
  });

  it("fails verification when the loading-icon anchor appears twice", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/assets/index-BHbrFFmp.js": `${LOCKUP_JS};${THINKING_JS};${THINKING_JS};\n//# sourceMappingURL=index-BHbrFFmp.js.map` });
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/loading-icon anchor matched 2 times/);
  });

  it("fails verification when a reference points at a missing asset", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/index.html": INDEX_HTML.replace("index-BU41-p9M.css", "gone-XXXXXXXX.css") });
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/gone-XXXXXXXX\.css/);
  });

  it("fails verification when index.html lost its marker block or title", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/index.html": INDEX_HTML.replace("<title>Paperclip</title>", "") });
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/<title>KyoubeAI<\/title>/);
    const removed = await makeTree({ "ui/dist/index.html": INDEX_HTML.replace("<!-- PAPERCLIP_RUNTIME_BRANDING_START -->", "") });
    await expect(runRebrand({ root: removed.root, brandDir: removed.brandDir, verify: true, report: false, log: () => {} }))
      .rejects.toThrow(/lost the upstream runtime-branding marker block/);
  });

  it("verifies the rendered site.webmanifest carries the brand name", async () => {
    const { root, brandDir } = await makeTree({
      "ui/dist/site.webmanifest": JSON.stringify({ short_name: "Paperclip", description: "x", theme_color: "#000", background_color: "#000", icons: [] }),
    });
    const result = await runRebrand({ root, brandDir, verify: true, report: false, log: () => {} });
    expect(result.problems).toEqual([]);
    expect(JSON.parse(await read(root, "ui/dist/site.webmanifest")).name).toBe("KyoubeAI");
  });

  it("without --verify still rewrites and returns the residual list instead of throwing", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/assets/index-BHbrFFmp.js": `${THINKING_JS};\n//# sourceMappingURL=index-BHbrFFmp.js.map` });
    const result = await runRebrand({ root, brandDir, verify: false, report: false, log: () => {} });
    expect(result.anchors.lockup).toBe(0);
  });

  it("does not mistake a map's embedded sourcesContent '../' reference for a same-directory asset", async () => {
    const { root, brandDir } = await makeTree({
      "ui/dist/assets/index-BHbrFFmp.js.map": '{"version":3,"file":"index-BHbrFFmp.js","sources":["Paperclip.tsx"],"sourcesContent":["import x from \'../foo.js\'"]}',
    });
    const result = await runRebrand({ root, brandDir, verify: true, report: false, log: () => {} });
    expect(result.problems).toEqual([]);
  });

  it("fails verification when a CSS url() references a missing font asset", async () => {
    const { root, brandDir } = await makeTree({
      "ui/dist/assets/index-BU41-p9M.css": ".paperclip-markdown{color:red}@font-face{src:url(/assets/inter-AAAAAAAA.woff2)}",
    });
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/inter-AAAAAAAA\.woff2/);
  });

  it("fails verification when sourceMappingURL names a map file that was never shipped", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/assets/index-BHbrFFmp.js.map": null });
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/index-BHbrFFmp\.js\.map/);
  });
});
