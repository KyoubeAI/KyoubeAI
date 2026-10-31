import { describe, expect, it } from "vitest";
import { runHarness, defaultHarnessDeps, type HarnessCommandDeps } from "../src/commands/harness.js";

function setup(paths: Record<string, string>, opts: { installExit?: number; afterInstall?: Record<string, string> } = {}) {
  const lines: string[] = [];
  const installs: string[] = [];
  let current = { ...paths };
  const deps: HarnessCommandDeps = {
    probe: {
      async which(name) { return current[name] ?? null; },
      async version(binPath) { return `${binPath.split("/").pop()} 1.0`; },
    },
    async runInstaller(command) {
      installs.push(command);
      current = { ...current, ...(opts.afterInstall ?? {}) };
      return opts.installExit ?? 0;
    },
    log: (line) => { lines.push(line); },
  };
  return { deps, lines, installs };
}
const env = { PAPERCLIP_HOME: "/kyoubeai" };

describe("kyoube harness", () => {
  it("list prints one line per harness with its origin", async () => {
    const { deps, lines } = setup({ claude: "/usr/local/bin/claude", pi: "/kyoubeai/.local/bin/pi" });
    expect(await runHarness(["list"], env, deps)).toBe(0);
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe("claude    claude 1.0 — core image (/usr/local/bin/claude)");
    expect(lines.find((line) => line.startsWith("pi "))).toBe("pi        pi 1.0 — yours (/kyoubeai/.local/bin/pi)");
    expect(lines.find((line) => line.startsWith("hermes "))).toBe("hermes    not installed");
  });

  it("which prints the path, exits 1 when missing and 2 for an unknown name", async () => {
    const { deps, lines } = setup({ codex: "/kyoubeai/.local/bin/codex" });
    expect(await runHarness(["which", "codex"], env, deps)).toBe(0);
    expect(lines).toEqual(["/kyoubeai/.local/bin/codex"]);
    expect(await runHarness(["which", "pi"], env, deps)).toBe(1);
    expect(await runHarness(["which", "nope"], env, deps)).toBe(2);
  });

  it("missing prints only the harnesses those adapter types need that are not installed", async () => {
    const { deps, lines } = setup({ claude: "/usr/local/bin/claude" });
    expect(await runHarness(["missing", "claude_local", "pi_local", "hermes_local", "process"], env, deps)).toBe(0);
    expect(lines).toEqual(["pi", "hermes"]);
  });

  it("install runs the official installer and reports the new copy", async () => {
    const { deps, lines, installs } = setup({}, { afterInstall: { pi: "/kyoubeai/.local/bin/pi" } });
    expect(await runHarness(["install", "pi"], env, deps)).toBe(0);
    expect(installs).toEqual(["npm install -g @earendil-works/pi-coding-agent"]);
    expect(lines.at(-1)).toBe("pi: pi 1.0 — yours (/kyoubeai/.local/bin/pi)");
  });

  it("install says so when another copy still comes first on PATH", async () => {
    const { deps, lines } = setup({ claude: "/usr/local/bin/claude" });
    expect(await runHarness(["install", "claude"], env, deps)).toBe(0);
    expect(lines).toContain("note: /usr/local/bin/claude comes first on PATH, not your install in /kyoubeai/.local/bin");
  });

  it("install fails with the installer's exit code, or when nothing landed on PATH", async () => {
    const failed = setup({}, { installExit: 3 });
    expect(await runHarness(["install", "hermes"], env, failed.deps)).toBe(3);
    const nothing = setup({});
    expect(await runHarness(["install", "codex"], env, nothing.deps)).toBe(1);
  });

  it("install refuses an unknown harness and one without an installer", async () => {
    const { deps, installs } = setup({});
    expect(await runHarness(["install", "nope"], env, deps)).toBe(2);
    expect(await runHarness(["install", "grok"], env, deps)).toBe(2);
    expect(installs).toEqual([]);
  });

  it("prints usage for an unknown subcommand", async () => {
    const { deps, lines } = setup({});
    expect(await runHarness(["frobnicate"], env, deps)).toBe(2);
    expect(lines[0]).toContain("usage: kyoube harness");
  });
});

describe("defaultHarnessDeps", () => {
  it("uses pipefail so failed pipes report non-zero exit", async () => {
    const deps = defaultHarnessDeps(process.env);
    expect(await deps.runInstaller("false | true")).not.toBe(0);
  });
});
