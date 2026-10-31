import { spawn } from "node:child_process";
import path from "node:path";

/** One agent harness CLI a built-in or bundled local adapter runs. */
export interface HarnessSpec {
  /** The command the adapter runs by default, looked up on PATH. */
  name: string;
  label: string;
  /** Core adapter types whose runs execute this CLI. */
  adapterTypes: string[];
  /** The official installer, run as `node` by `kyoube harness install`; null when KyoubeAI offers none. */
  install: string | null;
}

/**
 * Every harness CLI a built-in or bundled (antigravity_local) local adapter runs, in the order `kyoube harness list` prints them.
 * KyoubeAI's image ships none of its own. The core image carries claude, codex, gemini, kimi and
 * opencode in /usr/local/bin; whatever a person installs lands in ~/.local/bin, which is first on PATH.
 */
export const HARNESSES: readonly HarnessSpec[] = [
  { name: "claude", label: "Claude Code", adapterTypes: ["claude_local"], install: "curl -fsSL https://claude.ai/install.sh | bash" },
  { name: "codex", label: "Codex", adapterTypes: ["codex_local"], install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
  { name: "gemini", label: "Gemini CLI", adapterTypes: ["gemini_local"], install: "npm install -g @google/gemini-cli" },
  { name: "opencode", label: "OpenCode", adapterTypes: ["opencode_local"], install: "npm install -g opencode-ai" },
  { name: "kimi", label: "Kimi Code", adapterTypes: ["kimi_local"], install: "npm install -g @moonshot-ai/kimi-code" },
  { name: "pi", label: "pi", adapterTypes: ["pi_local"], install: "npm install -g @earendil-works/pi-coding-agent" },
  {
    name: "hermes",
    label: "Hermes Agent",
    adapterTypes: ["hermes_local"],
    install: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --non-interactive",
  },
  { name: "grok", label: "Grok CLI", adapterTypes: ["grok_local"], install: null },
  { name: "agy", label: "Antigravity CLI", adapterTypes: ["antigravity_local"], install: "curl -fsSL https://antigravity.google/cli/install.sh | bash" },
];

export type HarnessOrigin = "yours" | "core image" | "other";

export interface HarnessStatus {
  spec: HarnessSpec;
  /** Where the name resolves on PATH, or null when it is not installed. */
  path: string | null;
  origin: HarnessOrigin | null;
  /** First line of `--version`, or null when the CLI did not run. */
  version: string | null;
}

export interface ProbeDeps {
  which(name: string): Promise<string | null>;
  version(binPath: string): Promise<string | null>;
}

export function findHarness(name: string): HarnessSpec | undefined {
  return HARNESSES.find((spec) => spec.name === name);
}

export function harnessOrigin(binPath: string, home: string): HarnessOrigin {
  if (binPath.startsWith(`${path.posix.join(home, ".local", "bin")}/`)) return "yours";
  if (binPath.startsWith("/usr/local/bin/")) return "core image";
  return "other";
}

export function harnessesForAdapterTypes(adapterTypes: Iterable<string>): HarnessSpec[] {
  const wanted = new Set(adapterTypes);
  return HARNESSES.filter((spec) => spec.adapterTypes.some((type) => wanted.has(type)));
}

export async function probeHarness(spec: HarnessSpec, home: string, deps: ProbeDeps): Promise<HarnessStatus> {
  const binPath = await deps.which(spec.name);
  if (!binPath) return { spec, path: null, origin: null, version: null };
  return { spec, path: binPath, origin: harnessOrigin(binPath, home), version: await deps.version(binPath) };
}

export async function probeHarnesses(home: string, deps: ProbeDeps, specs: readonly HarnessSpec[] = HARNESSES): Promise<HarnessStatus[]> {
  const statuses: HarnessStatus[] = [];
  for (const spec of specs) statuses.push(await probeHarness(spec, home, deps));
  return statuses;
}

export function describeHarness(status: HarnessStatus): string {
  if (!status.path) return "not installed";
  const where = `${status.origin} (${status.path})`;
  if (status.version) return `${status.version} — ${where}`;
  const fix = status.spec.install ? ` — reinstall: kyoube harness install ${status.spec.name}` : "";
  return `does not run${fix} — ${where}`;
}

export function missingHarnesses(statuses: HarnessStatus[], adapterTypes: Iterable<string>): HarnessSpec[] {
  const needed = new Set(harnessesForAdapterTypes(adapterTypes).map((spec) => spec.name));
  return statuses.filter((status) => needed.has(status.spec.name) && !status.path).map((status) => status.spec);
}

function capture(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout, stderr }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find((line) => line.length > 0);

/** Looks harnesses up the way an agent run does: `command -v` on the given environment's PATH. */
export function systemProbe(env: NodeJS.ProcessEnv): ProbeDeps {
  return {
    async which(name) {
      const { code, stdout } = await capture("sh", ["-c", 'command -v "$1"', "sh", name], env, 5_000);
      const found = firstLine(stdout) ?? "";
      return code === 0 && found.startsWith("/") ? found : null;
    },
    async version(binPath) {
      const { code, stdout, stderr } = await capture(binPath, ["--version"], env, 10_000);
      if (code !== 0) return null;
      return firstLine(stdout) ?? firstLine(stderr) ?? null;
    },
  };
}
