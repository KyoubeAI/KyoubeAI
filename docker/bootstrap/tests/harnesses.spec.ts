import { describe, expect, it } from "vitest";
import {
  HARNESSES, describeHarness, findHarness, harnessOrigin, harnessesForAdapterTypes,
  missingHarnesses, probeHarnesses, systemProbe, type ProbeDeps,
} from "../src/harnesses.js";

const fakeProbe = (paths: Record<string, string>, versions: Record<string, string>): ProbeDeps => ({
  async which(name) { return paths[name] ?? null; },
  async version(binPath) { return versions[binPath] ?? null; },
});

describe("the harness catalogue", () => {
  it("installs each harness with its official installer", () => {
    expect(findHarness("claude")?.install).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(findHarness("codex")?.install).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
    expect(findHarness("hermes")?.install).toBe("curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --non-interactive");
    expect(findHarness("pi")?.install).toBe("npm install -g @earendil-works/pi-coding-agent");
    expect(findHarness("gemini")?.install).toBe("npm install -g @google/gemini-cli");
    expect(findHarness("opencode")?.install).toBe("npm install -g opencode-ai");
    expect(findHarness("kimi")?.install).toBe("npm install -g @moonshot-ai/kimi-code");
    expect(findHarness("grok")?.install).toBeNull();
    expect(findHarness("agy")?.install).toBe("curl -fsSL https://antigravity.google/cli/install.sh | bash");
  });

  it("covers every local CLI adapter type, once", () => {
    expect(HARNESSES.flatMap((spec) => spec.adapterTypes).sort()).toEqual([
      "antigravity_local", "claude_local", "codex_local", "gemini_local", "grok_local", "hermes_local", "kimi_local", "opencode_local", "pi_local",
    ]);
    expect(new Set(HARNESSES.map((spec) => spec.name)).size).toBe(HARNESSES.length);
  });
});

describe("harnessOrigin", () => {
  it("tells a user install from the core image's copy", () => {
    expect(harnessOrigin("/kyoubeai/.local/bin/claude", "/kyoubeai")).toBe("yours");
    expect(harnessOrigin("/usr/local/bin/claude", "/kyoubeai")).toBe("core image");
    expect(harnessOrigin("/kyoubeai/.local/binx/claude", "/kyoubeai")).toBe("other");
    expect(harnessOrigin("/opt/tools/claude", "/kyoubeai")).toBe("other");
  });
});

describe("harnessesForAdapterTypes", () => {
  it("returns each needed harness once, in catalogue order, ignoring unknown types", () => {
    expect(harnessesForAdapterTypes(["pi_local", "hermes_local", "pi_local", "process"]).map((spec) => spec.name)).toEqual(["pi", "hermes"]);
  });
});

describe("probeHarnesses and describeHarness", () => {
  it("reports path, origin and version, and a harness that no longer runs", async () => {
    const statuses = await probeHarnesses("/kyoubeai", fakeProbe(
      { claude: "/kyoubeai/.local/bin/claude", codex: "/usr/local/bin/codex", hermes: "/kyoubeai/.local/bin/hermes" },
      { "/kyoubeai/.local/bin/claude": "2.1.290 (Claude Code)", "/usr/local/bin/codex": "codex-cli 0.155.1" },
    ));
    const byName = new Map(statuses.map((status) => [status.spec.name, status]));
    expect(statuses.map((status) => status.spec.name)).toEqual(HARNESSES.map((spec) => spec.name));
    expect(byName.get("claude")).toMatchObject({ path: "/kyoubeai/.local/bin/claude", origin: "yours", version: "2.1.290 (Claude Code)" });
    expect(describeHarness(byName.get("claude")!)).toBe("2.1.290 (Claude Code) — yours (/kyoubeai/.local/bin/claude)");
    expect(describeHarness(byName.get("codex")!)).toBe("codex-cli 0.155.1 — core image (/usr/local/bin/codex)");
    expect(describeHarness(byName.get("hermes")!)).toBe("does not run — reinstall: kyoube harness install hermes — yours (/kyoubeai/.local/bin/hermes)");
    expect(describeHarness(byName.get("pi")!)).toBe("not installed");
  });
});

describe("missingHarnesses", () => {
  it("names the harnesses agents need that are not on PATH", async () => {
    const statuses = await probeHarnesses("/kyoubeai", fakeProbe({ claude: "/usr/local/bin/claude" }, {}));
    expect(missingHarnesses(statuses, ["claude_local", "pi_local", "hermes_local"]).map((spec) => spec.name)).toEqual(["pi", "hermes"]);
  });
});

describe("systemProbe", () => {
  it("finds a real command and reads its version; a missing one is null", async () => {
    const probe = systemProbe(process.env);
    const node = await probe.which("node");
    expect(node).toMatch(/^\/.*node$/);
    expect(await probe.version(node!)).toMatch(/^v\d+\./);
    expect(await probe.which("kyoube-no-such-cli-7f3a")).toBeNull();
    expect(await probe.version("/nonexistent/kyoube-cli")).toBeNull();
  });
});
