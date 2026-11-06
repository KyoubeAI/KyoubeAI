// The `setup-token-*` core patches: Claude subscription sign-in on core 2026.1023.0 with the
// Claude Code the image ships (upstream issue #17868). Every test runs the core's own code,
// copied verbatim into fixtures/, before and after the patches, against what Claude Code 2.1.306
// printed through the core's PTY bridge in the KyoubeAI image (fixtures/claude-2.1.306-*.json,
// with every per-attempt URL value replaced by a fake).
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyToText, countMatches } from "../lib.mjs";
import { PATCHES } from "../patches.mjs";
import { renderTerminalScreen } from "../setup-token-screen.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const fixture = (name) => readFile(path.join(FIXTURES, name), "utf8");
const capture = async (name) => JSON.parse(await fixture(name)).output;

const patch = (id) => PATCHES.find((entry) => entry.id === id);
const IDS = [
  "setup-token-copy-hint",
  "setup-token-rendered-screen",
  "setup-token-rendered-runner-import",
  "setup-token-rendered-runner-capture",
  "setup-token-rendered-runner-transcript",
  "setup-token-rendered-runner-declare",
  "setup-token-pty-window",
];
const PARSE_IDS = ["setup-token-copy-hint", "setup-token-rendered-screen"];
const RUNNER_IDS = IDS.filter((id) => id.startsWith("setup-token-rendered-runner-"));

function applyAll(text, ids) {
  let out = text;
  for (const id of ids) {
    const result = applyToText(out, patch(id));
    expect(result.count, id).toBe(1);
    out = result.text;
  }
  return out;
}

// A fake token in the shape the core's parser binds.
const FAKE_TOKEN = `sk-ant-oat01-${"Ab3_-x".repeat(16)}Q`;

// The core's parser and runner, unpatched and patched, written as real modules vitest imports.
// The runner's one package import (@paperclipai/adapter-utils) points at its verbatim copy.
let dir;
const modules = {};
beforeAll(async () => {
  dir = await mkdtemp(path.join(HERE, ".setup-token-under-test-"));
  const parse = await fixture("setup-token-parse-2026.1023.0.ts");
  const runner = (await fixture("setup-token-runner-2026.1023.0.ts")).replace(
    'from "@paperclipai/adapter-utils";',
    'from "./login-runner-lifecycle.ts";',
  );
  await writeFile(path.join(dir, "login-runner-lifecycle.ts"), await fixture("login-runner-lifecycle-2026.1023.0.ts"));
  for (const [variant, parseText, runnerText] of [
    ["unpatched", parse, runner],
    ["patched", applyAll(parse, PARSE_IDS), applyAll(runner, RUNNER_IDS)],
  ]) {
    const base = path.join(dir, variant);
    await writeFile(`${base}-setup-token-parse.ts`, parseText);
    await writeFile(`${base}-setup-token-runner.ts`, runnerText.replace('from "./setup-token-parse.js";', `from "./${variant}-setup-token-parse.ts";`));
    modules[variant] = {
      parse: await import(pathToFileURL(`${base}-setup-token-parse.ts`).href),
      runner: await import(pathToFileURL(`${base}-setup-token-runner.ts`).href),
    };
  }
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("setup-token-* declarations", () => {
  it("are each declared once with an upstream link and a marker for upstream's own fix", () => {
    for (const id of IDS) {
      const entry = patch(id);
      expect(entry, id).toBeDefined();
      expect(entry.upstream, id).toMatch(/^https:\/\/github\.com\/paperclipai\/paperclip\/pull\/(15550|17276)$/);
      expect(entry.expect, id).toBe(1);
      expect(entry.pattern.flags, id).toContain("g");
      expect(entry.upstreamFix, id).toBeInstanceOf(RegExp);
    }
    expect(patch("setup-token-copy-hint").upstream).toContain("/pull/15550");
  });

  it("match the 2026.1023.0 files exactly once each, and not again once applied", async () => {
    const files = {
      "packages/adapters/claude-local/src/server/setup-token-parse.ts": await fixture("setup-token-parse-2026.1023.0.ts"),
      "packages/adapters/claude-local/src/server/setup-token-runner.ts": await fixture("setup-token-runner-2026.1023.0.ts"),
      "server/dist/services/local-ai-browser-login.js": await fixture("local-ai-browser-login-2026.1023.0.js"),
    };
    for (const id of IDS) {
      const entry = patch(id);
      expect(entry.files, id).toHaveLength(1);
      const text = files[entry.files[0]];
      expect(text, id).toBeDefined();
      const once = applyToText(text, entry);
      expect(once.count, id).toBe(1);
      expect(applyToText(once.text, entry).count, id).toBe(0);
      expect(countMatches(text, entry.upstreamFix), id).toBe(0);
      expect(countMatches(once.text, entry.upstreamFix), id).toBe(0);
    }
  });

  // The 1023 files with upstream's diffs applied (`patch -p1`): PR #15550 alone, as the next core
  // will likely carry it, and with PR #17276 too. What apply.mjs then needs from each entry: its
  // pattern matches nothing and its marker exactly once ("already fixed upstream").
  it("on a core with upstream's fixes, each entry finds nothing to do and recognises the fix once", async () => {
    const upstream = {
      "packages/adapters/claude-local/src/server/setup-token-parse.ts": await fixture("setup-token-parse-upstream-15550-17276.ts"),
      "packages/adapters/claude-local/src/server/setup-token-runner.ts": await fixture("setup-token-runner-upstream-17276.ts"),
      "server/dist/services/local-ai-browser-login.js": await fixture("local-ai-browser-login-upstream-17276.js"),
    };
    for (const id of IDS) {
      const entry = patch(id);
      const text = upstream[entry.files[0]];
      expect(countMatches(text, entry.pattern), id).toBe(0);
      expect(countMatches(text, entry.upstreamFix), id).toBe(1);
    }
  });

  it("on a core with only upstream PR #15550, the copy hint is skipped and the screen renderer still applies", async () => {
    const text = await fixture("setup-token-parse-upstream-15550.ts");
    expect(countMatches(text, patch("setup-token-copy-hint").pattern)).toBe(0);
    expect(countMatches(text, patch("setup-token-copy-hint").upstreamFix)).toBe(1);
    expect(applyToText(text, patch("setup-token-rendered-screen")).count).toBe(1);
  });
});

describe("setup-token-copy-hint", () => {
  it("unpatched, the core finds no sign-in link in what Claude 2.1.306 prints, with or without a window size", async () => {
    for (const name of ["claude-2.1.306-setup-token-prompt-no-window.json", "claude-2.1.306-setup-token-prompt-1000-cols.json"]) {
      expect(modules.unpatched.parse.parseSetupTokenPrompt(await capture(name)), name).toBeNull();
    }
  });

  it("patched, it finds the link and the code prompt in both captures", async () => {
    for (const name of ["claude-2.1.306-setup-token-prompt-no-window.json", "claude-2.1.306-setup-token-prompt-1000-cols.json"]) {
      const prompt = modules.patched.parse.parseSetupTokenPrompt(await capture(name));
      expect(prompt, name).not.toBeNull();
      expect(prompt.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=00000000-/);
      expect(prompt.url).toContain("state=" + "S".repeat(43));
      expect(prompt.prompt).toBe("Paste code here if prompted");
    }
  });

  it("skips only that hint: any other line between the link and the prompt still fails closed", async () => {
    const text = (await capture("claude-2.1.306-setup-token-prompt-1000-cols.json")).replace("Hold\x1b[7GShift", "Type\x1b[7GHere");
    expect(text).not.toContain("Hold");
    expect(modules.patched.parse.parseSetupTokenPrompt(text)).toBeNull();
  });

  it("recognises upstream's own fix", () => {
    const entry = patch("setup-token-copy-hint");
    expect(countMatches("    if (COPY_HINT_LINE_RE.test(trimmed)) continue;\n", entry.upstreamFix)).toBe(1);
  });
});

/** Claude 2.1.3xx's redraw from `before` to `after`: only changed cells, CHA over the rest (as upstream PR #17276's test). */
function diffRedraw(before, after) {
  let out = `\x1b[${before.length}A`;
  for (let row = 0; row < after.length; row += 1) {
    const was = before[row] ?? "";
    const now = after[row];
    out += "\r";
    let skipped = false;
    for (let col = 0; col < now.length; col += 1) {
      if (was[col] === now[col]) { skipped = true; continue; }
      if (skipped) { out += `\x1b[${col + 1}G`; skipped = false; }
      out += now[col];
    }
    if (was.length > now.length) out += "\x1b[K";
    out += "\x1b[1B";
  }
  return out;
}

const PROMPT_FRAME = [
  " Browser didn't open? Use the url below to sign in (c to copy)",
  " https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-4000-8000-000000000000&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=" + "A".repeat(43) + "&code_challenge_method=S256&state=" + "S".repeat(43),
  " Hold Shift while selecting to use your terminal's native copy",
  " Paste code here if prompted >",
];
const SUCCESS_FRAME = [
  " ✓ Long-lived authentication token created successfully!",
  " Your OAuth token (valid for 1 year):",
  ` ${FAKE_TOKEN}`,
  " Store this token securely. You won't be able to see it again.",
];

/** Runs the core's runner against a stand-in PTY that prints `chunks` and exits 0. */
async function runLogin(runner, chunks) {
  const writes = [];
  const driver = {
    async start(_command, onData) {
      onData(chunks[0]);
      // The runner writes the code, then the Return; Claude answers with the success screen.
      while (!writes.includes("\r")) await new Promise((resolve) => setTimeout(resolve, 1));
      for (const chunk of chunks.slice(1)) onData(chunk);
      return { exitCode: 0 };
    },
    write: (input) => writes.push(input),
    stop() {},
    async dispose() {},
  };
  const delivered = [];
  const prompts = [];
  const result = await runner.runSetupTokenLogin(driver, {
    onPrompt: (prompt) => prompts.push(prompt.url),
    provideCode: async () => "browser-code#state",
    onCredential: async (bytes) => { delivered.push(bytes.toString("utf8")); },
    timeoutMs: 5000,
    codeSubmitSettleMs: 0,
  });
  return { outcome: result.outcome, delivered, prompts, writes };
}

describe("setup-token-rendered-*", () => {
  const redraw = diffRedraw(PROMPT_FRAME, SUCCESS_FRAME);

  it("the redraw really leaves the anchor line broken in the raw stream", () => {
    expect(redraw).not.toContain("Your OAuth token (valid for 1 year):");
    expect(modules.unpatched.parse.parseSetupTokenCredential(PROMPT_FRAME.join("\r\n") + "\r\n" + redraw)).toBeNull();
  });

  it("unpatched, the pasted code ends in a failed sign-in and the token is lost (issue #17868, finding 4)", async () => {
    // The unpatched prompt parser needs the hint gone to get this far, as with #15550 alone.
    const frame = PROMPT_FRAME.filter((line) => !line.includes("Hold Shift"));
    const run = await runLogin(modules.unpatched.runner, [`${frame.join("\r\n")}\r\n`, diffRedraw(frame, SUCCESS_FRAME)]);
    expect(run.prompts).toHaveLength(1);
    expect(run.writes).toEqual(["browser-code#state", "\r"]);
    expect(run.outcome).not.toBe("success");
    expect(run.delivered).toEqual([]);
  });

  it("patched, the runner reads the token from the drawn screen and delivers it once", async () => {
    const run = await runLogin(modules.patched.runner, [`${PROMPT_FRAME.join("\r\n")}\r\n`, redraw]);
    expect(run.prompts).toHaveLength(1);
    expect(run.outcome).toBe("success");
    expect(run.delivered).toEqual([FAKE_TOKEN]);
  });

  it("patched, a success screen that arrives whole still binds through the core's own raw parse", async () => {
    const run = await runLogin(modules.patched.runner, [`${PROMPT_FRAME.join("\r\n")}\r\n`, `\r\n${SUCCESS_FRAME.join("\r\n")}\r\n`]);
    expect(run.outcome).toBe("success");
    expect(run.delivered).toEqual([FAKE_TOKEN]);
  });

  it("patched, a screen with no token still fails closed", async () => {
    const failure = [" Error: the code was not accepted.", " Try again.", "", ""];
    const run = await runLogin(modules.patched.runner, [`${PROMPT_FRAME.join("\r\n")}\r\n`, diffRedraw(PROMPT_FRAME, failure)]);
    expect(run.outcome).not.toBe("success");
    expect(run.delivered).toEqual([]);
  });

  it("the parse module exports the renderer patched in, which is setup-token-screen.mjs itself", () => {
    expect(modules.patched.parse.renderTerminalScreen(redraw)).toBe(renderTerminalScreen(redraw));
    expect(modules.unpatched.parse.renderTerminalScreen).toBeUndefined();
  });

  it("recognise upstream's own fix", () => {
    expect(countMatches("\nexport function renderTerminalScreen(text: string): string {\n", patch("setup-token-rendered-screen").upstreamFix)).toBe(1);
    expect(countMatches("\n  renderTerminalScreen,\n  type SetupTokenPrompt,\n} from \"./setup-token-parse.js\";", patch("setup-token-rendered-runner-import").upstreamFix)).toBe(1);
    expect(countMatches("?? parseSetupTokenCredential(renderTerminalScreen(transcript));", patch("setup-token-rendered-runner-capture").upstreamFix)).toBe(1);
    expect(countMatches("\n      transcript += chunk;\n", patch("setup-token-rendered-runner-transcript").upstreamFix)).toBe(1);
    expect(countMatches('\n  let tokenBuffer = "";\n  let transcript = "";\n', patch("setup-token-rendered-runner-declare").upstreamFix)).toBe(1);
  });
});

describe("renderTerminalScreen", () => {
  it("draws text, CR, LF and column moves", () => {
    expect(renderTerminalScreen("ab\r\ncd\x1b[5Gef")).toBe("ab\ncd  ef");
  });

  it("moves up and overwrites, erases to the end of a line, and saves and restores the cursor", () => {
    expect(renderTerminalScreen("one\ntwo\x1b[1A\rONE")).toBe("ONE\ntwo");
    expect(renderTerminalScreen("abcdef\r\x1b[3C\x1b[K")).toBe("abc");
    expect(renderTerminalScreen("ab\x1b7cd\x1b8X")).toBe("abXd");
    expect(renderTerminalScreen("x\x1b[3;4Hy")).toBe("x\n\n   y");
  });

  it("keeps an OSC 8 link's text and drops the link, and ignores private modes and colours", () => {
    expect(renderTerminalScreen("\x1b]8;id=1;https://e.x\x07see\x1b]8;;\x07 \x1b[?25l\x1b[1;32mok\x1b[0m")).toBe("see ok");
  });

  it("stays bounded on hostile input", () => {
    const out = renderTerminalScreen("\x1b[99999B" + "x".repeat(5000) + "\x1b[99999C!");
    expect(out.split("\n")).toHaveLength(2048);
    expect(out.split("\n").at(-1)).toHaveLength(1024);
    expect(renderTerminalScreen(undefined)).toBe("");
  });
});

describe("setup-token-pty-window", () => {
  const run = promisify(execFile);
  const bridgeOf = (text) => /const PYTHON_PTY_BRIDGE = String\.raw `([\s\S]*?)`;/.exec(text)[1];

  /** Runs the core's bridge with `stty size` as the child: the window the sign-in CLI sees. */
  async function windowOf(bridge) {
    const { stdout } = await run("python3", ["-u", "-c", bridge, "stty", "size"], { timeout: 10_000 });
    return stdout.trim();
  }

  it("unpatched, the sign-in CLI gets a 0×0 terminal", async () => {
    expect(await windowOf(bridgeOf(await fixture("local-ai-browser-login-2026.1023.0.js")))).toBe("0 0");
  });

  it("patched, it gets 50 rows by 1000 columns, and the bridge still forwards the output", async () => {
    const patched = applyToText(await fixture("local-ai-browser-login-2026.1023.0.js"), patch("setup-token-pty-window"));
    expect(patched.count).toBe(1);
    expect(await windowOf(bridgeOf(patched.text))).toBe("50 1000");
  });

  it("recognises upstream's own fix", () => {
    expect(countMatches('if pid == 0:\n    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))\n', patch("setup-token-pty-window").upstreamFix)).toBe(1);
  });
});
