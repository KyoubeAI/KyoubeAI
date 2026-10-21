import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES as ASK_MESSAGES } from "../ask-level.mjs";
import { applyPatches, applyToText, countMatches, coreVersionHint, expandGlob } from "../lib.mjs";
import { CORE_VERSION, PATCHES, SKIP_HARNESS_LABEL } from "../patches.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLY = path.join(HERE, "..", "apply.mjs");
const DOCKERFILE = path.join(HERE, "..", "..", "Dockerfile");

// Excerpts of core 2026.916.1's minified UI, copied verbatim. The pi parser
// lives in a code-split chunk (AiConnectionCredentialStep-DHV6zd1f.js); the
// onboarding wizard in the main bundle (index-5zyW-AFc.js).

// The agent_end through message_end branches of the pi transcript parser, then
// the head of tool_execution_start, so the patterns are proven to anchor on
// their own branch alone.
const PI_HANDLER_2026_916_1 =
  'if(r==="agent_end"){const s=[],o=n.messages;if(o&&o.length>0){const a=o[o.length-1];if(a?.role==="assistant"){const l=a.content,{text:c,thinking:u}=gn(l);u&&s.push({kind:"thinking",ts:t,text:u}),c&&s.push({kind:"assistant",ts:t,text:c});const d=hn(a.usage);if(d){const m=d.inputTokens??d.input??0,p=d.outputTokens??d.output??0,h=d.cacheRead??d.cachedInputTokens??0,x=hn(d.cost)?.total??d.costUsd??0;(m>0||p>0)&&s.push({kind:"result",ts:t,text:"Run completed",inputTokens:m,outputTokens:p,cachedTokens:h,costUsd:x,subtype:"end",isError:!1,errors:[]})}}}return s.length===0&&s.push({kind:"system",ts:t,text:"✅ Pi agent finished"}),s}' +
  'if(r==="turn_start")return[];' +
  'if(r==="turn_end"){const s=hn(n.message),o=n.toolResults,a=[];if(s){const l=s.content,{text:c,thinking:u}=gn(l);u&&a.push({kind:"thinking",ts:t,text:u}),c&&a.push({kind:"assistant",ts:t,text:c})}if(o)for(const l of o){const c=tt(l.toolCallId,`tool-${Date.now()}`),u=l.content,d=l.isError===!0;let m;typeof u=="string"?m=u:Array.isArray(u)?m=gn(u).text||JSON.stringify(u):m=JSON.stringify(u);const p=Ur.get(c),h=tt(l.toolName,p?.toolName||"tool");a.push({kind:"tool_result",ts:t,toolUseId:c,toolName:h,content:m,isError:d}),Ur.delete(c)}return a}' +
  'if(r==="message_start")return[];if(r==="message_update"){const s=hn(n.assistantMessageEvent);if(s){const o=tt(s.type);if(o==="thinking_delta"){const a=tt(s.delta);if(a)return[{kind:"thinking",ts:t,text:a,delta:!0}]}if(o==="text_delta"){const a=tt(s.delta);if(a)return[{kind:"assistant",ts:t,text:a,delta:!0}]}if(o==="thinking_end"){const a=tt(s.content);if(a)return[{kind:"thinking",ts:t,text:a}]}if(o==="text_end"){const a=tt(s.content);if(a)return[{kind:"assistant",ts:t,text:a}]}}return[]}' +
  'if(r==="message_end"){const s=hn(n.message);if(s){const o=s.content,{text:a,thinking:l}=gn(o),c=[];return l&&c.push({kind:"thinking",ts:t,text:l}),a&&c.push({kind:"assistant",ts:t,text:a}),c}return[]}' +
  'if(r==="tool_execution_start"){return[{kind:"tool_call",ts:t,name:"x"}]}';

// The last branch of the Hermes transcript parser (the same chunk): thinking,
// errors, and every other line as agent text.
const HERMES_TAIL_2026_916_1 =
  'return sw(n)?[{kind:"thinking",ts:t,text:n.replace(/^💭\\s*/,"")}]:n.startsWith("Error:")||n.startsWith("ERROR:")||n.startsWith("Traceback")?[{kind:"stderr",ts:t,text:n}]:[{kind:"assistant",ts:t,text:n}]';

// The Hermes runner's quiet switch, packages/adapters/hermes/src/server/execute.ts
// (TypeScript source: the server runs the adapters' src through tsx).
const HERMES_QUIET_2026_916_1 =
  '  // Use -Q (quiet) to get clean output: just response + session_id line\n' +
  '  const useQuiet = cfgBoolean(config.quiet) === true; // default false\n' +
  '  const args: string[] = ["chat", "-q", prompt];\n' +
  '  if (useQuiet) args.push("-Q");\n';

// Upstream PR #12016's version of that line.
const HERMES_QUIET_UPSTREAM_FIX = '  const useQuiet = cfgBoolean(config.quiet) !== false;\n';

// The Connect step's primary action (`handleConnectStepPrimary`).
const CONNECT_PRIMARY_2026_916_1 =
  'function pn(){if(Je==="ready"&&Ft){It&&window.open(It,"_blank","noreferrer,noopener"),qe("waiting");return}Je!=="connecting"&&(zs||ma())}';

// The subscription sign-in inside the hire handler (`handleGiveHeartbeat`, `ma`).
const LOCAL_LOGIN_2026_916_1 =
  'if(Le!=="api"&&vr&&gt&&!lt()&&!bt&&!Oe.storedLogin.data){if(await qn.connect(),!es())return;ze.current={companyId:$e,binding:{provider:gt,method:"subscription",mode:"responsible_user"}}}';

// The environment-test gate further down the same handler.
const ENV_GATE_2026_916_1 =
  'if(ct){const pr=(De&&Wt.current===yr&&!sH(De)?De:null)??await wn(Sa,yr,es);if(!pr||!es())return;if(sH(pr)){P(pr.status==="fail"?"The environment test failed. Fix the reported checks before you hire this agent.":"No working authentication was found. Fix the reported checks before you hire this agent.");return}}';

// The wizard's error line followed by its footer navigation: two array
// children of the step body.
const ERROR_AND_FOOTER_2026_916_1 =
  'tn&&(0,t.jsx)("div",{className:"mt-3",children:(0,t.jsx)("p",{className:"text-xs text-destructive",children:tn})}),' +
  '(Y||_===1)&&(0,t.jsx)(Pwe,{onBack:_===4&&Je!=="idle"?Vs:Mze({currentStep:_,entryStep:S})?()=>I(Ha(_)):void 0,primaryLabel:_===1?"Continue":_===5?"Get started":_===4?Hn.label:"Next",primaryIcon:_===4?Hn.icon:void 0,loadingLabel:_===1?"Creating...":_===4?"Connecting":"Launching...",loading:_===3||_===4?!1:B,primaryDisabled:_===1?!M.trim()||B:_===3?!H.trim():_===4?Hn.disabled||B:B||en,onPrimary:()=>{_===1?kr():_===3?I(4):_===4?pn():Gn()}})';

// The same two children in core 2026.1005.0 (index-ChaaJ8xT.js), which is
// built with esbuild keepNames: the onPrimary arrow is wrapped by the bundle's
// name helper (`r`).
const ERROR_AND_FOOTER_2026_1005_0 =
  'qr&&(0,t.jsx)("div",{className:"mt-3",children:(0,t.jsx)("p",{className:"text-xs text-destructive",children:qr})}),' +
  '(vr||_===1)&&(0,t.jsx)(Yxe,{onBack:_===4&&Be!=="idle"?js:LYe({currentStep:_,entryStep:I})?()=>R(mr(_)):void 0,primaryLabel:_===1?"Continue":_===5?"Get started":_===4?ns.label:"Next",primaryIcon:_===4?ns.icon:void 0,loadingLabel:_===1?"Creating...":_===4?"Connecting":"Launching...",loading:_===3||_===4?!1:B,primaryDisabled:_===1?!Z.trim()||B:_===3?!he.trim():_===4?ns.disabled||B:B||Ht,onPrimary:r(()=>{_===1?Qe():_===3?R(4):_===4?As():ur()},"onPrimary")})';

// Excerpts of core 2026.916.1's compiled server (server/dist), copied verbatim.
const SIGNIN_COMMAND_2026_916_1 =
  '        command: provider === "openai"\n' +
  '            ? `(export CODEX_HOME=${shellQuote(directory)} && mkdir -p "$CODEX_HOME" && codex -c \'cli_auth_credentials_store="file"\' login --device-auth)`\n' +
  '            : provider === "anthropic"\n' +
  '                ? `(export CLAUDE_CONFIG_DIR=${shellQuote(directory)} && mkdir -p "$CLAUDE_CONFIG_DIR" && claude auth login)`\n' +
  '                : `(export GROK_HOME=${shellQuote(directory)} && mkdir -p "$GROK_HOME" && grok login --device-auth)`,\n';

// The auth module's imports and the start of authConfig in core 2026.916.1's
// server/dist/auth/better-auth.js, copied verbatim.
const BETTER_AUTH_2026_916_1 =
  'import { betterAuth } from "better-auth";\n' +
  'import { drizzleAdapter } from "better-auth/adapters/drizzle";\n' +
  'import { toNodeHandler } from "better-auth/node";\n' +
  'import { authAccounts, authSessions, authUsers, authVerifications, } from "@paperclipai/db";\n' +
  "export function createBetterAuthInstance(db, config, trustedOrigins) {\n" +
  "    const authConfig = {\n" +
  "        baseURL: baseUrl,\n" +
  "        secret,\n" +
  "        trustedOrigins,\n" +
  "        emailAndPassword: {\n" +
  "            enabled: true,\n" +
  "            requireEmailVerification: false,\n" +
  "            disableSignUp: config.authDisableSignUp,\n" +
  "        },\n" +
  "        rateLimit: buildBetterAuthRateLimitOptions({\n";

const CLAUDE_VERIFY_2026_916_1 =
  '            if (!token)\n' +
  '                throw new Error("Missing login");\n' +
  '            await fetchClaudeQuota(token);\n';

const patch = (id) => PATCHES.find((entry) => entry.id === id);
const piPatch = patch("pi-transcript-non-assistant-messages");
const primaryPatch = patch("onboarding-skip-harness-primary");
const loginPatch = patch("onboarding-skip-harness-login");
const gatePatch = patch("onboarding-skip-harness-gate");
const buttonPatch = patch("onboarding-skip-harness-button");
const piAgentEndPatch = patch("pi-transcript-once-agent-end");
const piTurnEndPatch = patch("pi-transcript-once-turn-end");
const piStreamPatch = patch("pi-transcript-once-stream");
const hermesQuietPatch = patch("hermes-quiet-default");
const hermesLinesPatch = patch("hermes-transcript-one-message");

/** A bundle fragment carrying every region the declared patches target, once each. */
const FULL_BUNDLE_2026_916_1 =
  `const x=1;function vw(r,n,t){${PI_HANDLER_2026_916_1}}function hw(n,t){${HERMES_TAIL_2026_916_1}}${CONNECT_PRIMARY_2026_916_1}` +
  `async function ma(){try{${LOCAL_LOGIN_2026_916_1}${ENV_GATE_2026_916_1}}catch{}}const y=[${ERROR_AND_FOOTER_2026_916_1}];`;

function declaredSafely(entry) {
  expect(entry).toBeDefined();
  expect(entry.upstream).toContain("github.com/paperclipai/paperclip");
  expect(entry.expect).toBe(1);
  expect(entry.pattern.flags).toContain("g");
}

/** Runs the (patched or unpatched) pi handler as the parser would, with the minified helpers stubbed. */
function runPiHandler(code, message) {
  const hn = (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : null);
  const tt = (value, fallback = "") => (typeof value === "string" ? value : fallback);
  const gn = (content) => ({ text: content.filter((c) => c.type === "text").map((c) => c.text).join(""), thinking: "" });
  const fn = new Function("r", "n", "t", "hn", "tt", "gn", `${code};return "fell-through"`);
  return fn("message_end", { message }, "2026-09-24T00:00:00Z", hn, tt, gn);
}

describe("pi-transcript-non-assistant-messages", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(piPatch));

  it("looks in every chunk, since the parser moved out of the main bundle", () => {
    expect(piPatch.files).toEqual(["ui/dist/assets/*.js"]);
  });

  it("matches the 2026.916.1 handler exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(PI_HANDLER_2026_916_1, piPatch);
    expect(count).toBe(1);
    expect(text).toContain('if(r==="message_end"){const s=hn(n.message);if(s&&s.role!=="assistant")return[];if(s){');
    const renamed = PI_HANDLER_2026_916_1.replaceAll("hn(", "Qx(").replaceAll("const s=", "const Z=").replaceAll("if(s){", "if(Z){").replaceAll("s.content", "Z.content");
    expect(applyToText(renamed, piPatch).count).toBe(1);
  });

  it("does not match again once applied, so a core that already carries the fix fails the build", () => {
    const once = applyToText(PI_HANDLER_2026_916_1, piPatch).text;
    expect(applyToText(once, piPatch).count).toBe(0);
  });

  it("keeps the assistant's text and drops the wake prompt and tool results — proven by running the patched code", () => {
    const text = (s) => [{ type: "text", text: s }];
    const before = PI_HANDLER_2026_916_1;
    const after = applyToText(before, piPatch).text;
    expect(runPiHandler(before, { role: "user", content: text("## KyoubeAI Resume Delta") })).toEqual([{ kind: "assistant", ts: "2026-09-24T00:00:00Z", text: "## KyoubeAI Resume Delta" }]);
    expect(runPiHandler(before, { role: "toolResult", content: text("=== doc revisions ===") })).toHaveLength(1);
    expect(runPiHandler(after, { role: "user", content: text("## KyoubeAI Resume Delta") })).toEqual([]);
    expect(runPiHandler(after, { role: "toolResult", content: text("=== doc revisions ===") })).toEqual([]);
    expect(runPiHandler(after, { role: "assistant", content: text("Done — the pack is sent.") })).toEqual([{ kind: "assistant", ts: "2026-09-24T00:00:00Z", text: "Done — the pack is sent." }]);
    expect(runPiHandler(after, null)).toEqual([]);
  });
});

/** The pi patches in the order patches.mjs applies them, starting from the one already shipped. */
const PI_PATCHES = () => [piPatch, piAgentEndPatch, piTurnEndPatch, piStreamPatch];

function applyAll(text, patches) {
  return patches.reduce((current, entry) => {
    const { text: next, count } = applyToText(current, entry);
    expect(count, entry.id).toBe(1);
    return next;
  }, text);
}

/**
 * Feeds a pi event stream through the (patched or unpatched) handler, merging
 * deltas the way the UI's transcript builder does (appendTranscriptEntry), and
 * returns the entries the task chat would get.
 */
function runPiStream(code, events) {
  const hn = (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : null);
  const tt = (value, fallback = "") => (typeof value === "string" ? value : fallback);
  const gn = (content) => ({
    text: content.filter((c) => c.type === "text").map((c) => c.text).join(""),
    thinking: content.filter((c) => c.type === "thinking").map((c) => c.thinking).join(""),
  });
  const handler = new Function("hn", "tt", "gn", "Ur", `return (r,n,t)=>{${code};return[{kind:"stdout",ts:t,text:"?"}]}`)(hn, tt, gn, new Map());
  const entries = [];
  for (const event of events) {
    for (const entry of handler(event.type, event, "2026-10-07T00:00:00Z")) {
      const last = entries[entries.length - 1];
      if ((entry.kind === "assistant" || entry.kind === "thinking") && entry.delta && last?.kind === entry.kind && last.delta) {
        last.text += entry.text;
      } else {
        entries.push({ ...entry });
      }
    }
  }
  return entries;
}

/** One assistant message as pi 0.87 streams it: thinking, then text, each as deltas then whole again. */
function piMessage({ thinking, text, toolCall }) {
  const content = [
    ...(thinking ? [{ type: "thinking", thinking }] : []),
    ...(text ? [{ type: "text", text }] : []),
  ];
  const half = (s) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))];
  const message = { role: "assistant", content };
  return [
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    ...(thinking ? [
      ...half(thinking).map((delta) => ({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } })),
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", content: thinking } },
    ] : []),
    ...(text ? [
      ...half(text).map((delta) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } })),
      { type: "message_update", assistantMessageEvent: { type: "text_end", content: text } },
    ] : []),
    { type: "message_end", message },
    ...(toolCall ? [
      { type: "tool_execution_start", toolCallId: toolCall, toolName: "bash", args: {} },
      { type: "message_start", message: { role: "toolResult", content: [{ type: "text", text: "exit 0" }] } },
      { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "exit 0" }] } },
    ] : []),
    { type: "turn_end", message, toolResults: toolCall ? [{ toolCallId: toolCall, toolName: "bash", content: "exit 0" }] : [] },
  ];
}

const PI_RUN = [
  { type: "agent_start" },
  { type: "message_start", message: { role: "user", content: [{ type: "text", text: "## KyoubeAI Resume Delta" }] } },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "## KyoubeAI Resume Delta" }] } },
  ...piMessage({ thinking: "Check the revision first.", text: "The board accepted the pack. Now I post it.", toolCall: "call-1" }),
  ...piMessage({ thinking: "Sent. Close the issue.", text: "## BAP-56 — posted and done\n\n- sent 16:06Z" }),
  { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "## BAP-56 — posted and done\n\n- sent 16:06Z" }], usage: { input: 10, output: 5 } }] },
];

const texts = (entries, kind) => entries.filter((entry) => entry.kind === kind).map((entry) => entry.text);

describe("pi-transcript-once-*", () => {
  it("are declared with the safety fields every patch needs, against upstream PR #14320", () => {
    for (const entry of [piAgentEndPatch, piTurnEndPatch, piStreamPatch]) {
      declaredSafely(entry);
      expect(entry.upstream).toBe("https://github.com/paperclipai/paperclip/pull/14320");
      expect(entry.files).toEqual(["ui/dist/assets/*.js"]);
    }
  });

  it("are listed after pi-transcript-non-assistant-messages, and the stream patch keeps its role guard either way", () => {
    const ids = PATCHES.map((entry) => entry.id);
    expect(ids.indexOf(piStreamPatch.id)).toBeGreaterThan(ids.indexOf(piPatch.id));
    // a --dry-run applies every patch to the core as shipped
    expect(applyToText(PI_HANDLER_2026_916_1, piStreamPatch).count).toBe(1);
    expect(applyToText(PI_HANDLER_2026_916_1, piStreamPatch).text).not.toContain('role!=="assistant"');
    expect(applyAll(PI_HANDLER_2026_916_1, PI_PATCHES())).toContain('if(s&&s.role!=="assistant")return[];if(s&&!Ur.kyoubeStreamed){');
  });

  it("each match the 2026.916.1 parser exactly once, whatever the minifier called the identifiers", () => {
    applyAll(PI_HANDLER_2026_916_1, PI_PATCHES());
    const renamed = PI_HANDLER_2026_916_1.replaceAll("hn(", "Qx(").replaceAll("tt(", "$k(").replaceAll("gn(", "Zz(").replaceAll("Ur.", "$m.");
    applyAll(renamed, PI_PATCHES());
  });

  it("do not match again once applied", () => {
    const once = applyAll(PI_HANDLER_2026_916_1, PI_PATCHES());
    for (const entry of PI_PATCHES()) expect(applyToText(once, entry).count, entry.id).toBe(0);
  });

  it("show every message and thinking block once, the tool call and its result once each — proven by running the patched code", () => {
    const before = runPiStream(applyAll(PI_HANDLER_2026_916_1, [piPatch]), PI_RUN);
    // what the task chat showed: the reply four times, the last one five
    expect(texts(before, "assistant").filter((text) => text.startsWith("The board"))).toHaveLength(4);
    expect(texts(before, "assistant").filter((text) => text.startsWith("## BAP-56"))).toHaveLength(5);

    const after = runPiStream(applyAll(PI_HANDLER_2026_916_1, PI_PATCHES()), PI_RUN);
    expect(texts(after, "assistant")).toEqual(["The board accepted the pack. Now I post it.", "## BAP-56 — posted and done\n\n- sent 16:06Z"]);
    expect(texts(after, "thinking")).toEqual(["Check the revision first.", "Sent. Close the issue."]);
    expect(after.filter((entry) => entry.kind === "tool_call")).toHaveLength(1);
    expect(after.find((entry) => entry.kind === "tool_result")).toMatchObject({ toolUseId: "call-1", content: "exit 0" });
    // agent_end still reports the run's usage
    expect(after.find((entry) => entry.kind === "result")).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("still shows a message that did not stream, from message_end", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "No deltas for this one." }] };
    const events = [{ type: "message_start", message }, { type: "message_end", message }, { type: "turn_end", message, toolResults: [] }];
    expect(texts(runPiStream(applyAll(PI_HANDLER_2026_916_1, PI_PATCHES()), events), "assistant")).toEqual(["No deltas for this one."]);
  });
});

describe("hermes-quiet-default", () => {
  it("is declared with the safety fields every patch needs, against upstream PR #12016", () => {
    declaredSafely(hermesQuietPatch);
    expect(hermesQuietPatch.upstream).toBe("https://github.com/paperclipai/paperclip/pull/12016");
    expect(hermesQuietPatch.files).toEqual(["packages/adapters/hermes/src/server/execute.ts"]);
  });

  it("makes an unset Quiet output quiet and keeps an explicit choice — proven by running the patched line", () => {
    const patched = applyToText(HERMES_QUIET_2026_916_1, hermesQuietPatch);
    expect(patched.count).toBe(1);
    const expression = /const useQuiet = (.*?);/.exec(patched.text)[1];
    const useQuiet = (quiet) => new Function("config", "cfgBoolean", `return ${expression};`)(
      { quiet }, (v) => (typeof v === "boolean" ? v : undefined));
    expect(useQuiet(undefined)).toBe(true);
    expect(useQuiet(true)).toBe(true);
    expect(useQuiet(false)).toBe(false);
    expect(useQuiet("no")).toBe(true);
  });

  it("does not match again once applied, and recognises upstream's own fix only", () => {
    const once = applyToText(HERMES_QUIET_2026_916_1, hermesQuietPatch).text;
    expect(applyToText(once, hermesQuietPatch).count).toBe(0);
    expect(countMatches(once, hermesQuietPatch.upstreamFix)).toBe(0);
    expect(countMatches(HERMES_QUIET_2026_916_1, hermesQuietPatch.upstreamFix)).toBe(0);
    expect(countMatches(HERMES_QUIET_UPSTREAM_FIX, hermesQuietPatch.upstreamFix)).toBe(1);
  });
});

/** Feeds Hermes stdout lines through the (patched or unpatched) parser tail, merging deltas as the UI does. */
function runHermesLines(code, lines) {
  const sw = (line) => line.includes("💭");
  const parse = new Function("sw", `return (n,t)=>{${code}}`)(sw);
  const entries = [];
  for (const line of lines) {
    for (const entry of parse(line, "2026-10-07T00:00:00Z")) {
      const last = entries[entries.length - 1];
      if (entry.kind === "assistant" && entry.delta && last?.kind === "assistant" && last.delta) last.text += entry.text;
      else entries.push({ ...entry });
    }
  }
  return entries;
}

describe("hermes-transcript-one-message", () => {
  it("is declared with the safety fields every patch needs", () => {
    declaredSafely(hermesLinesPatch);
    expect(hermesLinesPatch.files).toEqual(["ui/dist/assets/*.js"]);
  });

  it("matches the 2026.916.1 parser exactly once, whatever the minifier called the identifiers, and not again once applied", () => {
    const once = applyToText(HERMES_TAIL_2026_916_1, hermesLinesPatch);
    expect(once.count).toBe(1);
    expect(applyToText(once.text, hermesLinesPatch).count).toBe(0);
    const renamed = HERMES_TAIL_2026_916_1.replaceAll("n.", "$q.").replaceAll("text:n", "text:$q").replaceAll("ts:t", "ts:W");
    expect(applyToText(renamed, hermesLinesPatch).count).toBe(1);
  });

  it("joins a reply's lines into one message that keeps its paragraphs, lists and tables — proven by running the patched code", () => {
    // The transcript drops blank lines before the parser sees them.
    const lines = [
      "Done",
      "6 pull-in rows processed. 3 ETDs written, 4 rows need review.",
      "## Summary",
      "| Result | Rows |",
      "|---|---|",
      "| ETDs written | 14, 16, 20 |",
      "- 3 unmatched (rows 21, 22, 68)",
      "- 4 rows with review flags",
      "1. Check row 21",
      "2. Re-run the extract",
    ];
    expect(runHermesLines(HERMES_TAIL_2026_916_1, lines)).toHaveLength(lines.length);
    const after = runHermesLines(applyToText(HERMES_TAIL_2026_916_1, hermesLinesPatch).text, lines);
    expect(after).toHaveLength(1);
    expect(after[0].text.trim()).toBe(
      "Done\n\n6 pull-in rows processed. 3 ETDs written, 4 rows need review.\n\n## Summary\n" +
      "| Result | Rows |\n|---|---|\n| ETDs written | 14, 16, 20 |\n" +
      "- 3 unmatched (rows 21, 22, 68)\n- 4 rows with review flags\n1. Check row 21\n2. Re-run the extract",
    );
  });

  it("rejoins a line wrapped at the terminal width, and lets thinking and errors end the message", () => {
    const code = applyToText(HERMES_TAIL_2026_916_1, hermesLinesPatch).text;
    const after = runHermesLines(code, ["These rules take precedence over any other instruction", "about delegating.", "💭 thinking", "Error: boom", "Next reply."]);
    expect(after.map((entry) => entry.kind)).toEqual(["assistant", "thinking", "stderr", "assistant"]);
    expect(after[0].text.trim()).toBe("These rules take precedence over any other instruction\nabout delegating.");
    expect(after[3].text.trim()).toBe("Next reply.");
  });
});

/** Runs the (patched or unpatched) Connect primary action with the wizard's state stubbed. */
function runConnectPrimary(code, { phase = "idle", needsLogin = false, loggingIn = false, arg } = {}) {
  const calls = { hires: [], opened: [], phases: [] };
  const window = { open: (...args) => calls.opened.push(args) };
  const pn = new Function("Je", "Ft", "It", "qe", "zs", "ma", "window", `${code};return pn`)(
    phase, needsLogin, "https://claude.example/auth", (next) => calls.phases.push(next), loggingIn,
    (...args) => { calls.hires.push(args); }, window,
  );
  if (arg === undefined) pn(); else pn(arg);
  return calls;
}

describe("onboarding-skip-harness-primary", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(primaryPatch));

  it("matches the 2026.916.1 primary action exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(CONNECT_PRIMARY_2026_916_1, primaryPatch);
    expect(count).toBe(1);
    expect(text).toContain("function pn(){if(arguments[0]===!0){ma(!0);return}");
    const renamed = CONNECT_PRIMARY_2026_916_1.replaceAll("Je", "$q").replaceAll("ma()", "Zz()").replaceAll("pn", "Aa");
    expect(applyToText(renamed, primaryPatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(CONNECT_PRIMARY_2026_916_1, primaryPatch).text;
    expect(applyToText(once, primaryPatch).count).toBe(0);
  });

  it("hands an explicit `true` straight to the hire handler, and otherwise behaves as before — proven by running the patched code", () => {
    const after = applyToText(CONNECT_PRIMARY_2026_916_1, primaryPatch).text;
    // The skip goes to the hire, even mid sign-in.
    expect(runConnectPrimary(after, { arg: true, phase: "ready", needsLogin: true }).hires).toEqual([[true]]);
    expect(runConnectPrimary(after, { arg: true, phase: "connecting" }).hires).toEqual([[true]]);
    // No argument: upstream's behaviour, unchanged.
    expect(runConnectPrimary(after, {}).hires).toEqual([[]]);
    const signIn = runConnectPrimary(after, { phase: "ready", needsLogin: true });
    expect(signIn.hires).toEqual([]);
    expect(signIn.opened).toHaveLength(1);
    expect(signIn.phases).toEqual(["waiting"]);
    expect(runConnectPrimary(after, { phase: "connecting" }).hires).toEqual([]);
    expect(runConnectPrimary(after, { loggingIn: true }).hires).toEqual([]);
    // A click event is not a skip.
    expect(runConnectPrimary(after, { arg: { type: "click" } }).hires).toEqual([[]]);
  });
});

/** Runs the (patched or unpatched) sign-in block inside a plain async function, as the hire handler holds it. */
async function runLocalLogin(code, { mode = "subscription", arg } = {}) {
  const calls = { connects: 0 };
  const fn = new Function(
    "Le", "vr", "gt", "lt", "bt", "Oe", "qn", "es", "ze", "$e",
    `return async function ma(){${code}return "hired"}`,
  )(
    mode, true, "anthropic", () => null, null, { storedLogin: { data: null } },
    { connect: async () => { calls.connects += 1; throw new Error("Only the local operator can connect this machine's CLI account."); } },
    () => true, { current: null }, "company-1",
  );
  let outcome;
  try { outcome = arg === undefined ? await fn() : await fn(arg); } catch (error) { outcome = `threw: ${error.message}`; }
  return { ...calls, outcome };
}

describe("onboarding-skip-harness-login", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(loginPatch));

  it("matches the 2026.916.1 sign-in block exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(LOCAL_LOGIN_2026_916_1, loginPatch);
    expect(count).toBe(1);
    expect(text).toContain('if(arguments[0]!==!0&&Le!=="api"&&vr&&gt&&!lt()&&!bt&&!Oe.storedLogin.data){if(await qn.connect(),');
    const renamed = LOCAL_LOGIN_2026_916_1.replaceAll("Le", "$k").replaceAll("qn.", "Ww.").replaceAll("Oe.", "Uu.");
    expect(applyToText(renamed, loginPatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(LOCAL_LOGIN_2026_916_1, loginPatch).text;
    expect(applyToText(once, loginPatch).count).toBe(0);
  });

  it("skips the sign-in only on an explicit `true` — proven by running the patched code", async () => {
    const after = applyToText(LOCAL_LOGIN_2026_916_1, loginPatch).text;
    const blocked = await runLocalLogin(LOCAL_LOGIN_2026_916_1);
    expect(blocked).toEqual({ connects: 1, outcome: "threw: Only the local operator can connect this machine's CLI account." });
    expect(await runLocalLogin(after)).toEqual(blocked);
    expect(await runLocalLogin(after, { arg: { type: "click" } })).toEqual(blocked);
    expect(await runLocalLogin(after, { arg: true })).toEqual({ connects: 0, outcome: "hired" });
    // An API key never signs in, skip or not.
    expect(await runLocalLogin(after, { mode: "api" })).toEqual({ connects: 0, outcome: "hired" });
  });
});

/** Runs the (patched or unpatched) environment gate inside a plain async function, as the hire handler holds it. */
async function runEnvGate(code, { envResult, arg } = {}) {
  const calls = { probes: 0, errors: [] };
  const blocks = (result) => result.status === "fail" || result.authMissing === true;
  const fn = new Function(
    "ct", "De", "Wt", "yr", "sH", "wn", "Sa", "es", "P",
    `return async function ma(){${code}return "hired"}`,
  )(
    true, null, { current: false }, false, blocks,
    async () => { calls.probes += 1; return envResult; }, {}, () => true, (message) => calls.errors.push(message),
  );
  const outcome = arg === undefined ? await fn() : await fn(arg);
  return { ...calls, outcome };
}

describe("onboarding-skip-harness-gate", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(gatePatch));

  it("matches the 2026.916.1 gate exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(ENV_GATE_2026_916_1, gatePatch);
    expect(count).toBe(1);
    expect(text).toContain("if(ct&&arguments[0]!==!0){const pr=(De&&Wt.current===yr&&!sH(De)?De:null)??await wn(Sa,yr,es);");
    // Upstream's own messages are kept.
    expect(text).toContain('"The environment test failed. Fix the reported checks before you hire this agent."');
    const renamed = ENV_GATE_2026_916_1.replaceAll("ct", "$c").replaceAll("pr", "Rr").replaceAll("sH(", "Ss(").replaceAll("P(", "Pp(");
    expect(applyToText(renamed, gatePatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(ENV_GATE_2026_916_1, gatePatch).text;
    expect(applyToText(once, gatePatch).count).toBe(0);
  });

  it("still blocks a failed probe, and skips the probe only on an explicit `true` — proven by running the patched code", async () => {
    const after = applyToText(ENV_GATE_2026_916_1, gatePatch).text;
    const fail = { status: "fail" };
    const before = await runEnvGate(ENV_GATE_2026_916_1, { envResult: fail });
    expect(before).toEqual({ probes: 1, errors: ["The environment test failed. Fix the reported checks before you hire this agent."], outcome: undefined });
    expect(await runEnvGate(after, { envResult: fail })).toEqual(before);
    expect(await runEnvGate(after, { envResult: fail, arg: { type: "click" } })).toEqual(before);
    expect(await runEnvGate(after, { envResult: { status: "warn", authMissing: true } })).toEqual({ probes: 1, errors: ["No working authentication was found. Fix the reported checks before you hire this agent."], outcome: undefined });
    expect(await runEnvGate(after, { envResult: fail, arg: true })).toEqual({ probes: 0, errors: [], outcome: "hired" });
    expect(await runEnvGate(after, { envResult: { status: "pass" } })).toEqual({ probes: 1, errors: [], outcome: "hired" });
  });
});

/** Evaluates the (patched or unpatched) error+footer children with the wizard's render scope stubbed. */
function renderErrorAndFooter(code, { step, error, loading = false }) {
  const t = { jsx: (type, props) => ({ type, props }) };
  const primaryCalls = [];
  const fn = new Function(
    "t", "tn", "Y", "Pwe", "Je", "Vs", "Mze", "I", "Ha", "_", "S", "Hn", "B", "M", "H", "en", "kr", "pn", "Gn",
    `return [${code}]`,
  );
  const children = fn(
    t, error, true, "FooterNav", "idle", () => {}, () => true, () => {}, (n) => n - 1, step, 3,
    { label: "Connect", icon: "arrow", disabled: false }, loading, { trim: () => "Co" }, { trim: () => "Ada" }, false,
    () => {}, (...args) => { primaryCalls.push(args); }, () => {},
  );
  return { children, primaryCalls };
}

describe("onboarding-skip-harness-button", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(buttonPatch));

  it("matches the 2026.916.1 error line and footer exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(ERROR_AND_FOOTER_2026_916_1, buttonPatch);
    expect(count).toBe(1);
    expect(text).toContain('_===4&&tn&&(0,t.jsx)("div",{className:"mt-2"');
    expect(text).toContain("onClick:()=>pn(!0)");
    // The footer call is re-emitted untouched.
    expect(text).toContain(ERROR_AND_FOOTER_2026_916_1.slice(ERROR_AND_FOOTER_2026_916_1.indexOf("(Y||")));
    const renamed = ERROR_AND_FOOTER_2026_916_1.replaceAll("tn", "$e").replaceAll("(0,t.jsx)", "(0,Kt.jsx)").replaceAll("pn()", "Qq()").replaceAll("_===", "St===").replaceAll("currentStep:_", "currentStep:St").replaceAll("Ha(_)", "Ha(St)");
    expect(applyToText(renamed, buttonPatch).count).toBe(1);
  });

  it("matches the 2026.1005.0 footer, whose onPrimary is wrapped by keepNames, and the skip control calls the Connect action with `true`", () => {
    const { count, text } = applyToText(ERROR_AND_FOOTER_2026_1005_0, buttonPatch);
    expect(count).toBe(1);
    expect(text).toContain(ERROR_AND_FOOTER_2026_1005_0.slice(ERROR_AND_FOOTER_2026_1005_0.indexOf("(vr||")));
    expect(applyToText(text, buttonPatch).count).toBe(0);
    const t = { jsx: (type, props) => ({ type, props }) };
    const connect = [];
    const render = (code, step, error) => new Function(
      "t", "qr", "vr", "Yxe", "Be", "js", "LYe", "I", "R", "mr", "_", "ns", "B", "Z", "he", "Ht", "Qe", "As", "ur", "r",
      `return [${code}]`,
    )(t, error, true, "FooterNav", "idle", () => {}, () => true, 3, () => {}, (n) => n - 1, step,
      { label: "Connect", icon: "arrow", disabled: false }, false, { trim: () => "Co" }, { trim: () => "Ada" }, false,
      () => {}, (...args) => { connect.push(args); }, () => {}, (fn) => fn);
    const [, skip, footer] = render(text, 4, "Only the local operator can connect this machine's CLI account.");
    expect(skip.props.children.props.children).toBe(SKIP_HARNESS_LABEL);
    skip.props.children.props.onClick();
    expect(connect).toEqual([[true]]);
    footer.props.onPrimary();
    expect(connect).toEqual([[true], []]);
    expect(render(text, 3, "x")[1]).toBeFalsy();
  });

  it("does not match again once applied", () => {
    const once = applyToText(ERROR_AND_FOOTER_2026_916_1, buttonPatch).text;
    expect(applyToText(once, buttonPatch).count).toBe(0);
  });

  it("renders the skip control only on step 4 under an error, and it calls the primary action with `true` — proven by running the patched code", () => {
    const after = applyToText(ERROR_AND_FOOTER_2026_916_1, buttonPatch).text;
    const message = "Could not verify the local subscription. Run the sign-in command shown for this connection, finish signing in, then try Connect again.";
    const before = renderErrorAndFooter(ERROR_AND_FOOTER_2026_916_1, { step: 4, error: message });
    expect(before.children).toHaveLength(2);
    expect(before.children[1].type).toBe("FooterNav");

    const shown = renderErrorAndFooter(after, { step: 4, error: message });
    expect(shown.children).toHaveLength(3);
    expect(shown.children[0].props.children.props.children).toBe(message);
    const button = shown.children[1].props.children;
    expect(button.type).toBe("button");
    expect(button.props.type).toBe("button");
    expect(button.props.children).toBe(SKIP_HARNESS_LABEL);
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    expect(shown.primaryCalls).toEqual([[true]]);
    expect(shown.children[2].type).toBe("FooterNav");
    expect(shown.children[2].props.primaryLabel).toBe("Connect");

    // Any other step, or no error: the slot is falsy, so React renders nothing there.
    expect(renderErrorAndFooter(after, { step: 3, error: message }).children[1]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 5, error: message }).children[1]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 4, error: null }).children[0]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 4, error: null }).children[1]).toBeFalsy();
    // While a hire is in flight the control is disabled.
    expect(renderErrorAndFooter(after, { step: 4, error: message, loading: true }).children[1].props.children.props.disabled).toBe(true);
  });
});

/** Writes every file the declared patches target, each holding its 2026.916.1 excerpt once. */
async function writeFullCore(root) {
  await mkdir(path.join(root, "ui", "dist", "assets"), { recursive: true });
  await mkdir(path.join(root, "server", "dist", "services"), { recursive: true });
  await writeFile(path.join(root, "ui/dist/assets/index-5zyW-AFc.js"), FULL_BUNDLE_2026_916_1);
  await writeFile(path.join(root, "server/dist/services/local-ai-login.js"), SIGNIN_COMMAND_2026_916_1);
  await writeFile(path.join(root, "server/dist/services/local-ai-credentials.js"), CLAUDE_VERIFY_2026_916_1);
  await writeFile(path.join(root, "server/dist/services/issue-thread-interactions.js"), INTERACTION_CREATE_2026_1012_0);
  await mkdir(path.join(root, "server", "dist", "auth"), { recursive: true });
  await writeFile(path.join(root, "server/dist/auth/better-auth.js"), BETTER_AUTH_2026_916_1);
  await mkdir(path.join(root, "server", "dist", "routes"), { recursive: true });
  await writeFile(path.join(root, "server/dist/routes/issues.js"), CHAT_OPEN_2026_1005_0 + CHAT_MESSAGE_2026_1005_0);
  await mkdir(path.join(root, "packages", "adapters", "hermes", "src", "server"), { recursive: true });
  await writeFile(path.join(root, "packages/adapters/hermes/src/server/execute.ts"), HERMES_QUIET_2026_916_1);
}

const signinPatch = patch("anthropic-signin-setup-token");

const licenseImportPatch = patch("license-seat-limit-import");
const licenseHookPatch = patch("license-seat-limit-hook");
const ENFORCE_BUILT = path.join(HERE, "..", "..", "..", "packages", "license", "dist", "enforce.mjs");

/** A standing patch: no upstream to wait for, so no upstream link and no upstreamFix. */
function declaredStanding(entry) {
  expect(entry).toBeDefined();
  expect(entry.standing).toMatch(/licensing/i);
  expect(entry.upstream).toBeUndefined();
  expect(entry.upstreamFix).toBeUndefined();
  expect(entry.expect).toBe(1);
  expect(entry.pattern.flags).toContain("g");
}

/**
 * Runs the patched hook as the core would, with the core's db, its user table
 * and Better Auth's APIError stood in for, and the module path pointed at the
 * real built enforce.mjs (or at `modulePath`).
 */
async function runPatchedHook(count, modulePath = ENFORCE_BUILT) {
  const patched = applyToText(applyToText(BETTER_AUTH_2026_916_1, licenseImportPatch).text, licenseHookPatch).text;
  const objectText = /databaseHooks: (\{.*\}),$/m.exec(patched)?.[1];
  if (!objectText) throw new Error("no databaseHooks line in the patched module");
  const source = objectText.replace("/opt/kyoube/license/enforce.mjs", pathToFileURL(modulePath).href);
  const authUsers = { table: "user" };
  class FakeAPIError extends Error {
    constructor(status, body) { super(body.message); this.status = status; this.body = body; }
  }
  const db = { $count: async (table) => { if (table !== authUsers) throw new Error("counted the wrong table"); return count; } };
  // vitest's runner rejects a dynamic import() inside `new Function`
  // (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING), so the hook object goes through a real module.
  const file = path.join(HERE, `.hook-under-test-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, `export default (db, authUsers, KyoubeLicenseAPIError) => (${source});\n`);
  try {
    const { default: build } = await import(pathToFileURL(file).href);
    return await build(db, authUsers, FakeAPIError).user.create.before();
  } finally {
    await rm(file, { force: true });
  }
}

describe("license-seat-limit-import", () => {
  it("is declared as a standing licensing patch", () => declaredStanding(licenseImportPatch));
  it("adds Better Auth's APIError once, right after the betterAuth import, and not again", () => {
    const { count, text } = applyToText(BETTER_AUTH_2026_916_1, licenseImportPatch);
    expect(count).toBe(1);
    expect(text).toContain('import { betterAuth } from "better-auth";\nimport { APIError as KyoubeLicenseAPIError } from "better-auth/api";\n');
    expect(applyToText(text, licenseImportPatch).count).toBe(0);
  });
});

describe("license-seat-limit-hook", () => {
  it("is declared as a standing licensing patch", () => declaredStanding(licenseHookPatch));
  it("adds the user.create.before hook once, after emailAndPassword, with the marker", () => {
    const { count, text } = applyToText(BETTER_AUTH_2026_916_1, licenseHookPatch);
    expect(count).toBe(1);
    expect(text).toContain("disableSignUp: config.authDisableSignUp,\n        },\n        databaseHooks: { user: { create: { before: async () => {");
    expect(text).toContain("kyoube-license-seat-limit");
    expect(text).toContain('import("/opt/kyoube/license/enforce.mjs")');
    expect(applyToText(text, licenseHookPatch).count).toBe(0);
  });
  // These run the real dist/enforce.mjs (`pnpm test` builds it first). Its folder,
  // /kyoubeai/kyoube, doesn't exist outside the container, so this is the free tier.
  it("lets an account in below the limit", async () => {
    await expect(runPatchedHook(4)).resolves.toBeUndefined();
  });
  it("refuses at the limit with 400 SEAT_LIMIT_REACHED and the spec's message", async () => {
    await expect(runPatchedHook(5)).rejects.toMatchObject({ status: "BAD_REQUEST", body: { code: "SEAT_LIMIT_REACHED", message: expect.stringContaining("(5 of 5)") } });
  });
  it("fails closed with 500 LICENSE_CHECK_FAILED when enforce.mjs can't be loaded", async () => {
    await expect(runPatchedHook(0, path.join(HERE, "no-such-enforce.mjs"))).rejects.toMatchObject({ status: "INTERNAL_SERVER_ERROR", body: { code: "LICENSE_CHECK_FAILED" } });
  });
});

describe("a standing patch that stops matching", () => {
  let root;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "core-patches-standing-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("tells the build to redo it for this core, never to delete it", async () => {
    await mkdir(path.join(root, "server", "dist", "auth"), { recursive: true });
    await writeFile(path.join(root, "server/dist/auth/better-auth.js"), "export const moved = true;\n");
    const error = await applyPatches(root, [licenseHookPatch]).catch((caught) => caught);
    expect(error.message).toMatch(/"license-seat-limit-hook" matched 0 time\(s\)/);
    expect(error.message).toMatch(/standing KyoubeAI patch \(KyoubeAI licensing: the user limit\): redo it for this core; never delete it/);
    expect(error.message).not.toMatch(/delete the patch/);
  });
});

describe("anthropic-signin-setup-token", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(signinPatch));

  it("changes only the Claude sign-in command, once", () => {
    const { count, text } = applyToText(SIGNIN_COMMAND_2026_916_1, signinPatch);
    expect(count).toBe(1);
    expect(text).toContain('mkdir -p "$CLAUDE_CONFIG_DIR" && kyoube connect claude)`');
    expect(text).not.toContain("claude auth login");
    expect(text).toContain("codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth)");
    expect(text).toContain("grok login --device-auth)");
    expect(applyToText(text, signinPatch).count).toBe(0);
  });
});

describe("an upstream-fix marker", () => {
  // A patch with a marker for the upstream fix, and one file per test case.
  const marked = {
    id: "marked",
    upstream: "https://github.com/paperclipai/paperclip/commit/0000000",
    files: ["server/dist/x.js"],
    pattern: /buggy\(\)/g,
    replacement: "fixed()",
    expect: 1,
    upstreamFix: /upstreamFixed\(\)/g,
  };
  let root;
  const write = async (text) => {
    await mkdir(path.join(root, "server", "dist"), { recursive: true });
    await writeFile(path.join(root, "server/dist/x.js"), text);
  };
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "core-patches-marker-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("skips the patch when the pattern matches nothing and the marker matches exactly once", async () => {
    await write("a(); upstreamFixed(); b();");
    const report = await applyPatches(root, [marked]);
    expect(report).toEqual([{ id: "marked", matched: 0, expect: 1, files: [], skipped: "already fixed upstream" }]);
    expect(await readFile(path.join(root, "server/dist/x.js"), "utf8")).toBe("a(); upstreamFixed(); b();");
  });

  it("fails when neither the pattern nor the marker matches", async () => {
    await write("a(); b();");
    await expect(applyPatches(root, [marked])).rejects.toThrow(/"marked" matched 0 time\(s\).*its upstream fix matched 0 time\(s\)/);
  });

  it("fails when the marker matches more than once", async () => {
    await write("upstreamFixed(); upstreamFixed();");
    await expect(applyPatches(root, [marked])).rejects.toThrow(/"marked" matched 0 time\(s\).*its upstream fix matched 2 time\(s\)/);
  });

  it("still applies the patch where the pattern matches, whatever the marker says", async () => {
    await write("buggy(); upstreamFixed();");
    const report = await applyPatches(root, [marked]);
    expect(report).toEqual([{ id: "marked", matched: 1, expect: 1, files: ["server/dist/x.js"] }]);
    expect(await readFile(path.join(root, "server/dist/x.js"), "utf8")).toBe("fixed(); upstreamFixed();");
  });

  it("a core that carries upstream PR #12016 builds: hermes-quiet-default is skipped and logged, the rest still apply", async () => {
    await writeFullCore(root);
    const fixed = HERMES_QUIET_2026_916_1.replace(/  const useQuiet = .*\n/, HERMES_QUIET_UPSTREAM_FIX);
    await writeFile(path.join(root, "packages/adapters/hermes/src/server/execute.ts"), fixed);
    const { stdout } = await promisify(execFile)(process.execPath, [APPLY, "--root", root, "--report", "--dry-run"]);
    expect(stdout).toContain("core-patches: hermes-quiet-default: already fixed upstream");
    const report = await applyPatches(root, PATCHES);
    expect(report.find((entry) => entry.id === hermesQuietPatch.id)).toMatchObject({ skipped: "already fixed upstream" });
    expect(report.filter((entry) => !entry.skipped).map((entry) => entry.matched)).toEqual(PATCHES.filter((entry) => entry !== hermesQuietPatch).map(() => 1));
    expect(await readFile(path.join(root, "packages/adapters/hermes/src/server/execute.ts"), "utf8")).toBe(fixed);
  });
});

describe("applyPatches", () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "core-patches-"));
    await mkdir(path.join(root, "ui", "dist", "assets"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("expands a single-star glob in the basename", async () => {
    await writeFile(path.join(root, "ui/dist/assets/index-AAAA.js"), "");
    await writeFile(path.join(root, "ui/dist/assets/index-AAAA.js.map"), "");
    await writeFile(path.join(root, "ui/dist/assets/other-BBBB.js"), "");
    expect((await expandGlob(root, "ui/dist/assets/index-*.js")).map((f) => path.basename(f))).toEqual(["index-AAAA.js"]);
    expect((await expandGlob(root, "ui/dist/assets/*.js")).map((f) => path.basename(f))).toEqual(["index-AAAA.js", "other-BBBB.js"]);
    expect(await expandGlob(root, "nope/*.js")).toEqual([]);
  });

  it("rewrites the bundle in place and reports it", async () => {
    const file = path.join(root, "ui/dist/assets/index-5zyW-AFc.js");
    await writeFullCore(root);
    const report = await applyPatches(root, PATCHES);
    expect(report.map((entry) => entry.matched)).toEqual(PATCHES.map(() => 1));
    expect(report.find((entry) => entry.id === buttonPatch.id).files).toEqual(["ui/dist/assets/index-5zyW-AFc.js"]);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain('.role!=="assistant")return[]');
    expect(patched).toContain("arguments[0]!==!0");
    expect(patched).toContain(SKIP_HARNESS_LABEL);
    expect(await readFile(path.join(root, "server/dist/services/local-ai-login.js"), "utf8")).toContain("kyoube connect claude");
    expect(await readFile(path.join(root, "packages/adapters/hermes/src/server/execute.ts"), "utf8")).toContain("cfgBoolean(config.quiet) ?? true");
    const auth = await readFile(path.join(root, "server/dist/auth/better-auth.js"), "utf8");
    expect(auth).toContain("KyoubeLicenseAPIError");
    expect(auth).toContain("kyoube-license-seat-limit");
  });

  it("finds the pi parser in a code-split chunk", async () => {
    await writeFullCore(root);
    await writeFile(path.join(root, "ui/dist/assets/index-5zyW-AFc.js"), FULL_BUNDLE_2026_916_1.replace(PI_HANDLER_2026_916_1, ""));
    await writeFile(path.join(root, "ui/dist/assets/AiConnectionCredentialStep-DHV6zd1f.js"), PI_HANDLER_2026_916_1);
    const report = await applyPatches(root, PATCHES);
    expect(report.find((entry) => entry.id === piPatch.id).files).toEqual(["ui/dist/assets/AiConnectionCredentialStep-DHV6zd1f.js"]);
  });

  it("fails — without writing — when a patch matches zero times or more than declared", async () => {
    const file = path.join(root, "ui/dist/assets/index-5zyW-AFc.js");
    await writeFullCore(root);
    await writeFile(file, "nothing here");
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/matched 0 time\(s\).*expected 1/);
    await writeFile(file, FULL_BUNDLE_2026_916_1 + FULL_BUNDLE_2026_916_1);
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/matched 2 time\(s\).*expected 1/);
    // A bundle that carries only the transcript parsers still fails the build
    // on the others, so a core that moved one of them cannot ship half a fix.
    await writeFile(file, `function vw(r,n,t){${PI_HANDLER_2026_916_1}}function hw(n,t){${HERMES_TAIL_2026_916_1}}`);
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/onboarding-skip-harness-primary.*matched 0 time\(s\)/);
  });

  it("dry-run reports without touching the file", async () => {
    const file = path.join(root, "ui/dist/assets/index-5zyW-AFc.js");
    await writeFullCore(root);
    const report = await applyPatches(root, PATCHES, { dryRun: true });
    expect(report.map((entry) => entry.matched)).toEqual(PATCHES.map(() => 1));
    expect(await readFile(file, "utf8")).toBe(FULL_BUNDLE_2026_916_1);
  });
});

describe("the core the patches are written for", () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "core-patches-"));
    await mkdir(path.join(root, "ui", "dist", "assets"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Runs apply.mjs as the Dockerfile does and returns its exit code and output. */
  async function runApply(args) {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [APPLY, "--root", root, ...args]);
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }

  it("is the core the Dockerfile pins", async () => {
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    expect(dockerfile).toMatch(new RegExp(`^ARG KYOUBE_CORE_VERSION=${CORE_VERSION.replaceAll(".", "\\.")}$`, "m"));
  });

  it("says nothing extra when the build uses that core, or does not say which core it uses", () => {
    expect(coreVersionHint(CORE_VERSION, CORE_VERSION)).toBeNull();
    expect(coreVersionHint(null, CORE_VERSION)).toBeNull();
    expect(coreVersionHint("", CORE_VERSION)).toBeNull();
  });

  it("names both cores and the .env line to change when they differ", () => {
    const hint = coreVersionHint("2026.831.1", "2026.916.1");
    expect(hint).toContain("core 2026.831.1");
    expect(hint).toContain("core 2026.916.1");
    expect(hint).toContain("KYOUBE_CORE_VERSION");
    expect(hint).toContain(".env");
  });

  it("leads a failed build with the core mismatch, before the patch error", async () => {
    await writeFile(path.join(root, "ui/dist/assets/index-OLD.js"), "an older core's bundle");
    const { code, stderr } = await runApply(["--report", "--core-version", "2026.831.1"]);
    expect(code).toBe(1);
    const lines = stderr.trim().split("\n");
    expect(lines[0]).toContain(`core 2026.831.1, but this KyoubeAI release is made for core ${CORE_VERSION}`);
    expect(lines[1]).toMatch(/core patch ".*" matched 0 time\(s\)/);
  });

  it("fails exactly as before on the pinned core", async () => {
    await writeFile(path.join(root, "ui/dist/assets/index-OLD.js"), "a bundle upstream changed");
    const { code, stderr } = await runApply(["--report", "--core-version", CORE_VERSION]);
    expect(code).toBe(1);
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).not.toContain(".env");
  });

  it("still builds on another core whose code the patches match, with a note", async () => {
    await writeFullCore(root);
    const { code, stdout, stderr } = await runApply(["--report", "--core-version", "beta"]);
    expect(code).toBe(0);
    expect(stdout).toContain("applied 1/1");
    expect(stderr).toContain(`built on core beta; these patches are written for core ${CORE_VERSION}`);
  });
});

const chatOpenPatch = patch("groups-chat-open-assign-check");
const chatMessagePatch = patch("groups-chat-message-assign-check");

function declaredStandingGroups(entry) {
  expect(entry).toBeDefined();
  expect(entry.standing).toMatch(/user groups/i);
  expect(entry.upstream).toBeUndefined();
  expect(entry.upstreamFix).toBeUndefined();
  expect(entry.expect).toBe(1);
  expect(entry.pattern.flags).toContain("g");
  expect(entry.files).toEqual(["server/dist/routes/issues.js"]);
}

describe("groups-chat-open-assign-check", () => {
  it("is declared as a standing user-groups patch", () => declaredStandingGroups(chatOpenPatch));
  it("checks assignment before a chat with a protected agent is created, once", () => {
    const { count, text } = applyToText(CHAT_OPEN_2026_1005_0, chatOpenPatch);
    expect(count).toBe(1);
    expect(text).toContain("kyoube-groups-chat");
    expect(text.indexOf("const agent = resolved.agent;")).toBeLessThan(text.indexOf("assertCanAssignTasks(req, companyId, { assigneeAgentId: agent.id })"));
    expect(text.indexOf("assertCanAssignTasks(req, companyId, { assigneeAgentId: agent.id })")).toBeLessThan(text.indexOf("svc.create(companyId, {"));
    expect(text).toContain('agent.permissions?.authorizationPolicy?.assignmentPolicy?.mode === "protected"');
    expect(applyToText(text, chatOpenPatch).count).toBe(0);
  });
});

describe("groups-chat-message-assign-check", () => {
  it("is declared as a standing user-groups patch", () => declaredStandingGroups(chatMessagePatch));
  it("checks assignment before a message to a protected agent's chat, once", () => {
    const { count, text } = applyToText(CHAT_MESSAGE_2026_1005_0, chatMessagePatch);
    expect(count).toBe(1);
    expect(text).toContain("kyoube-groups-chat");
    expect(text).toContain("assertCanAssignTasks(req, issue.companyId, { assigneeAgentId: issue.conversationAgentId })");
    expect(applyToText(text, chatMessagePatch).count).toBe(0);
  });
});

// Excerpts of core 2026.1005.0's server/dist/routes/issues.js, copied verbatim:
// the Agent Chat open route and the start of the issue-comment route.
const CHAT_OPEN_2026_1005_0 =
  "                throw notFound(\"Agent not found\");\n" +
  "            const agent = resolved.agent;\n" +
  "            const existing = await svc.getConversation(companyId, agent.id, req.actor.userId);\n" +
  "            if (existing && !(await assertIssueReadAllowed(req, res, existing)))\n" +
  "                return;\n" +
  "            if (existing || method === \"get\") {\n" +
  "                res.json(existing);\n" +
  "                return;\n" +
  "            }\n" +
  "            const issue = await svc.create(companyId, {\n" +
  "                title: `Chat with ${agent.name}`, assigneeAgentId: agent.id,\n" +
  "                conversationAgentId: agent.id, conversationUserId: req.actor.userId,\n" +
  "                conversationState: \"waiting\", status: \"in_review\", createdByUserId: req.actor.userId,\n" +
  "            });\n";

const CHAT_MESSAGE_2026_1005_0 =
  "    router.post(\"/issues/:id/comments\", validate(addIssueCommentSchema), async (req, res) => {\n" +
  "        const id = req.params.id;\n" +
  "        const issue = await getAccessibleResource(req, res, svc.getById(id), \"Issue not found\");\n" +
  "        if (!issue)\n" +
  "            return;\n" +
  "        if (issue.conversationAgentId && req.actor.type === \"board\") {\n" +
  "            if (!(await instanceSettings.getExperimental()).enableAgentChat)\n" +
  "                throw notFound(\"Agent Chat is disabled\");\n" +
  "            if (!req.actor.userId)\n" +
  "                throw forbidden(\"Board user access required\");\n" +
  "            if (req.actor.userId !== issue.conversationUserId)\n" +
  "                throw forbidden(\"Only the conversation owner can send messages or start a new session\");\n" +
  "            if (!req.body.clientRequestId)\n";

// Excerpt of core 2026.1012.0's server/dist/services/issue-thread-interactions.js,
// copied verbatim: create() applies the company cap, then builds the card.
const INTERACTION_CREATE_2026_1012_0 =
  "            const policy = resolveInteractionPolicy({\n" +
  "                kind: data.kind,\n" +
  "                requested: data.resolverPolicy,\n" +
  "                governance,\n" +
  "                hasToolAction: data.kind === \"request_confirmation\" &&\n" +
  "                    data.payload.toolAction !== undefined,\n" +
  "                hasSecretProposal: data.kind === \"request_confirmation\" &&\n" +
  "                    data.payload.secretProposal !== undefined,\n" +
  "            });\n" +
  "            const normalizedData = {\n" +
  "                ...data,\n" +
  "                resolverPolicy: policy.requestedResolverPolicy,\n" +
  "            };\n";

const askLevelPatch = patch("agent-questions-ask-level");
const ASK_LEVEL_MODULE = path.join(HERE, "..", "ask-level.mjs");

/**
 * Runs the patched excerpt as the core would: the core's db, tables, drizzle
 * operators and unprocessable stood in for, the cap already applied
 * (human_only), and the module path pointed at the real ask-level.mjs (or at
 * `modulePath`). Returns the policy and normalizedData the core would store.
 */
async function runPatchedCreate({ actor = { agentId: "r" }, data = { kind: "ask_user_questions", addresseeAgentId: "m", payload: {} }, env, modulePath = ASK_LEVEL_MODULE } = {}) {
  const patched = applyToText(INTERACTION_CREATE_2026_1012_0, askLevelPatch).text.replace("/opt/kyoube/core-patches/ask-level.mjs", pathToFileURL(modulePath).href);
  const agents = { name: "agents" };
  const issueThreadInteractions = { name: "cards" };
  const rows = { agents: [
    { id: "m", name: "Manager", reportsTo: null, status: "idle", metadata: null },
    { id: "r", name: "Report", reportsTo: "m", status: "idle", metadata: null },
    { id: "p", name: "Peer", reportsTo: null, status: "idle", metadata: null },
  ], cards: [] };
  const db = { select: () => ({ from: (table) => ({ where: async () => rows[table.name] }) }) };
  const unprocessable = (message, details) => Object.assign(new Error(message), { status: 422, details });
  const resolveInteractionPolicy = () => ({ requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "inherited", effectiveResolverPolicySource: "company_cap" });
  const previous = process.env.KYOUBE_AGENT_RULES;
  if (env === undefined) delete process.env.KYOUBE_AGENT_RULES;
  else process.env.KYOUBE_AGENT_RULES = env;
  try {
    // As runPatchedHook does: vitest's runner rejects a dynamic import() inside
    // `new Function`/AsyncFunction (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING), so
    // the patched excerpt goes through a real module.
    const file = path.join(HERE, `.hook-under-test-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(file, `export default async (db, agents, issueThreadInteractions, and, eq, isNotNull, unprocessable, resolveInteractionPolicy, governance, issue, actor, data) => {\n${patched}\nreturn { policy, normalizedData };\n};\n`);
    try {
      const { default: run } = await import(pathToFileURL(file).href);
      return await run(db, agents, issueThreadInteractions, () => ({}), () => ({}), () => ({}), unprocessable, resolveInteractionPolicy, {}, { id: "i1", companyId: "c1" }, actor, data);
    } finally {
      await rm(file, { force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.KYOUBE_AGENT_RULES;
    else process.env.KYOUBE_AGENT_RULES = previous;
  }
}

describe("agent-questions-ask-level", () => {
  it("is declared as a standing agent-rules patch on the interactions service", () => {
    expect(askLevelPatch).toBeDefined();
    expect(askLevelPatch.standing).toMatch(/agent working rules/i);
    expect(askLevelPatch.upstream).toBeUndefined();
    expect(askLevelPatch.upstreamFix).toBeUndefined();
    expect(askLevelPatch.expect).toBe(1);
    expect(askLevelPatch.pattern.flags).toContain("g");
    expect(askLevelPatch.files).toEqual(["server/dist/services/issue-thread-interactions.js"]);
  });

  it("inserts the check once, after the cap is applied and before the card is built", () => {
    const { count, text } = applyToText(INTERACTION_CREATE_2026_1012_0, askLevelPatch);
    expect(count).toBe(1);
    expect(text.indexOf("const policy = resolveInteractionPolicy({")).toBeLessThan(text.indexOf("kyoube-ask-level"));
    expect(text.indexOf("kyoube-ask-level")).toBeLessThan(text.indexOf("const normalizedData = {"));
    expect(text).toContain('import("/opt/kyoube/core-patches/ask-level.mjs")');
    expect(applyToText(text, askLevelPatch).count).toBe(0);
  });

  it("carries the module's own check-failed message in its fallback", () => {
    expect(askLevelPatch.replacement).toContain(JSON.stringify(ASK_MESSAGES.checkFailed));
  });

  it("lets a question to an agent in the asker's line through, answerable by that agent", async () => {
    const { policy, normalizedData } = await runPatchedCreate();
    expect(policy.effectiveResolverPolicy).toBe("not_creator");
    expect(normalizedData.resolverPolicy).toBe("not_creator");
  });

  it("refuses a question to an agent outside the asker's line with the module's code", async () => {
    await expect(runPatchedCreate({ data: { kind: "ask_user_questions", addresseeAgentId: "p", payload: {} } })).rejects.toMatchObject({ status: 422, details: { code: "kyoube_ask_outside_line" } });
  });

  it("never loads the module for anything else, so those cards stay people-only", async () => {
    const missing = path.join(HERE, "no-such-module.mjs");
    for (const input of [
      { actor: { agentId: null, userId: "u1" } },
      { data: { kind: "ask_user_questions", addresseeAgentId: null, payload: {} } },
      { data: { kind: "ask_user_questions", addresseeUserId: "u1", payload: {} } },
      { data: { kind: "request_confirmation", addresseeAgentId: "m", payload: {} } },
    ]) {
      const { policy } = await runPatchedCreate({ ...input, modulePath: missing });
      expect(policy.effectiveResolverPolicy).toBe("human_only");
    }
  });

  it("skips the module when KYOUBE_AGENT_RULES is OFF, in any case or spacing", async () => {
    const missing = path.join(HERE, "no-such-module.mjs");
    for (const env of ["off", "OFF", " Off ", "off\n"]) {
      const { policy } = await runPatchedCreate({ env, modulePath: missing });
      expect(policy.effectiveResolverPolicy).toBe("human_only");
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runPatchedCreate({ env: "on", modulePath: missing })).rejects.toMatchObject({ details: { code: "kyoube_ask_check_failed" } });
    error.mockRestore();
  });

  it("refuses an agent-to-agent question when the module cannot be loaded (fail closed)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runPatchedCreate({ modulePath: path.join(HERE, "no-such-module.mjs") })).rejects.toMatchObject({ message: ASK_MESSAGES.checkFailed, status: 422, details: { code: "kyoube_ask_check_failed" } });
    error.mockRestore();
  });

  it("is shipped and checked by the Dockerfile", async () => {
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    expect(dockerfile).toMatch(/^COPY docker\/core-patches\/apply\.mjs docker\/core-patches\/lib\.mjs docker\/core-patches\/patches\.mjs docker\/core-patches\/ask-level\.mjs \/opt\/kyoube\/core-patches\/$/m);
    expect(dockerfile).toContain("grep -q 'kyoube-ask-level' /app/server/dist/services/issue-thread-interactions.js");
    expect(dockerfile).toContain('import("/opt/kyoube/core-patches/ask-level.mjs")');
  });
});
