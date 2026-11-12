/**
 * Every fix KyoubeAI applies to the upstream core at image build time.
 *
 * This list is meant to be empty. An entry exists only while an upstream bug
 * is fixed here first and the same fix is on its way upstream (`upstream`
 * names the issue or pull request); it is deleted the moment a core bump
 * carries the upstream fix. `apply.mjs` enforces the exit: each pattern must
 * match exactly `expect` times across the files it names, so a core release
 * that no longer has the bug — or that changed the code's shape — fails the
 * build with the patch's id, which is the cue to remove (or redo) it.
 *
 * One kind of entry is permanent: a `standing` entry (KyoubeAI licensing, user groups, agent questions, work-object visibility and the MCP connector)
 * carries `standing: "<what it is for>"` in place of `upstream` and is never
 * deleted. When a core release moves the code it anchors on, the build fails
 * the same way, and the fix is to redo the entry for that core.
 *
 * One exception keeps the weekly build against the core's pre-releases
 * useful: a patch may declare `upstreamFix`, a pattern for the upstream fix
 * itself in the compiled code. When the patch's own pattern matches nothing
 * and `upstreamFix` matches exactly once, the core already carries the fix:
 * the patch is skipped, and the build log says "<id>: already fixed upstream".
 * Any other count still fails the build. The entry is still deleted at the
 * first stable core that carries the fix.
 *
 * Patterns are written against the compiled, minified bundle the image ships
 * (`ui/dist`), so they anchor on string literals and code shape, never on
 * minifier-chosen identifier names. The server's `server/dist` is compiled but
 * not minified; its patterns anchor on the statements themselves.
 * See CONTRIBUTING.md, "Never patch the core".
 */

/**
 * The core release these patches are written and tested against: always the
 * `ARG KYOUBE_CORE_VERSION` default in docker/Dockerfile (scripts/bump-core.sh
 * moves both, scripts/check-pins.sh fails if they differ). apply.mjs compares
 * it with the core a build actually uses, so a patch that fails on a different
 * core says that first.
 */
export const CORE_VERSION = "2026.1023.0";

/**
 * The label of the control the `onboarding-skip-harness-*` patches add under
 * a failed Connect step. Exported for the tests.
 */
export const SKIP_HARNESS_LABEL = "Skip for now and connect the harness later from the Terminal page";

import { MESSAGES as ASK_MESSAGES } from "./ask-level.mjs";
import { renderTerminalScreen } from "./setup-token-screen.mjs";

/**
 * What the `visibility-create-*` entries add after a create route's own assignment check: when the
 * core skips that check (a person names no assignee), ask the core's decision for `tasks:assign` on
 * the new task's place anyway, and refuse only a visibility denial. The decision reaches KyoubeAI
 * through `visibility-board-decide`, so this imports nothing; every other denial is ignored, so an
 * open company creates exactly as the core does. `prelude` declares the scope where the route has
 * none of its own. Exported for the tests.
 */
export function visibilityCreateCheck(companyId, scope, prelude = "") {
  return (
    ' /* kyoube-visibility (docs/groups.md) */ else if (req.actor.type === "board") { ' + prelude +
    `const kyoubeDecision = await access.decide({ actor: req.actor, action: "tasks:assign", resource: { type: "issue", companyId: ${companyId}, issueId: null, projectId: ${scope}.projectId, parentIssueId: ${scope}.parentIssueId, assigneeAgentId: null, assigneeUserId: null }, scope: ${scope} }); ` +
    'if (!kyoubeDecision.allowed && (kyoubeDecision.reason === "deny_kyoube_visibility" || kyoubeDecision.reason === "deny_kyoube_visibility_unavailable")) ' +
    "throw forbidden(kyoubeDecision.explanation, authorizationDeniedDetails(kyoubeDecision)); }"
  );
}

/**
 * Where `visibility-route-gate` mounts the gate, each a prefix of the core's routes (2026.1012.0)
 * addressed by one task or project: `/issues/:id/…` and `/projects/:id/…` in every route file, the
 * attachment upload under a company, the email thread of a task (which checks only agents), and the
 * project membership a person sets for themselves. Exported for the tests.
 */
export const ROUTE_GATE_PATHS = [
  ["issue", "/issues/:kyoubeRef"],
  ["issue", "/companies/:kyoubeCompanyId/issues/:kyoubeRef"],
  ["issue", "/companies/:kyoubeCompanyId/email/tasks/:kyoubeRef"],
  ["project", "/projects/:kyoubeRef"],
  ["project", "/companies/:kyoubeCompanyId/resource-memberships/me/projects/:kyoubeRef"],
];

/**
 * The core's public MCP tools (2026.1023.0), without the `paperclip_` prefix: every `name:
 * "paperclip_…"` in server/dist/services/public-mcp/{capabilities,expanded-capabilities,
 * file-transfers}.js except the Dot runner's `dot_*`, which stay as they are. `mcp-tool-names`
 * serves them as `kyoubeai_<name>`. Exported for the tests.
 */
export const MCP_PUBLIC_TOOL_NAMES = [
  "add_comment", "block_task", "call_api", "connection", "create_project", "create_skill", "create_task", "finish_task",
  "get_agent", "get_download_url", "get_project", "get_skill", "get_upload_url", "list_agent_instruction_revisions",
  "list_agents", "list_deliverables", "list_document_revisions", "list_project_repositories", "list_projects",
  "list_skills", "pending_approvals", "read_agent_instructions", "read_document", "read_skill_file", "read_task",
  "register_deliverable", "search_api", "search_tasks", "set_project_repositories", "update_agent",
  "update_agent_instructions", "update_deliverable", "update_project", "update_skill", "update_task", "write_document",
  "write_skill_file",
];

/**
 * The bridge wiring's shared pieces. The patched core imports the bridge (mcp-bridge.mjs, shipped
 * beside this file) at runtime; MCP_REMOVED_TOOLS is its REMOVED_TOOLS as code, which the tests
 * keep equal. Each mcp-bridge-* replacement carries MCP_MARKER, which the Dockerfile counts.
 */
const MCP_MARKER = "/* kyoube-mcp (docs/mcp.md) */";
const MCP_BRIDGE_MODULE = "/opt/kyoube/core-patches/mcp-bridge.mjs";
const MCP_REMOVED_TOOLS = '["kyoubeai_search_api", "kyoubeai_call_api"]';
// A module's top-of-file run of import and export lines, matched whole: the lookahead refuses both a
// shorter run (the next line is another import) and a run the loader already follows.
const mcpTopImports = () => /^((?:(?:import|export) [^\n]*\n)+)(?!(?:import|export) |\/\* kyoube-mcp)/g;

/** The setup page's Claude (web, Desktop, mobile) steps that `mcp-setup-claude-web` adds. */
const MCP_CLAUDE_WEB_STEP_TEXTS = [
  "Open this link to add KyoubeAI as a custom connector in Claude, then choose Connect and approve the connection in KyoubeAI. On Team and Enterprise plans an Owner adds custom connectors for the organization. The instance must be reachable over public HTTPS.",
  "In a conversation, turn on the KyoubeAI connector from the tools menu. Verify the account and organization with kyoubeai_connection before doing work.",
];

export const PATCHES = [
  {
    id: "pi-transcript-non-assistant-messages",
    title: "pi adapter: do not render tool results and the wake prompt as agent text",
    upstream: "https://github.com/paperclipai/paperclip (packages/adapters/pi-local/src/ui/parse-stdout.ts, message_end handler; PR pending)",
    // pi emits `message_end` for every message it appends to its session —
    // the user turn (the "Resume Delta" wake prompt) and each `toolResult`
    // (raw command output) as well as the assistant's own text — and the
    // parser turned all of them into `assistant` transcript entries, so the
    // task chat showed the prompt and every tool output as agent bubbles in
    // the body font (tool output twice: it is also threaded onto its tool
    // card). Only an assistant message may become agent text.
    // Since core 2026.916 the pi transcript parser is code-split into a chunk
    // whose name the bundler picks (AiConnectionCredentialStep-*.js in
    // 2026.916.1), so the patch looks in every chunk; `expect` still pins it
    // to exactly one match.
    files: ["ui/dist/assets/*.js"],
    pattern: /if\((\w+)==="message_end"\)\{const (\w+)=(\w+)\((\w+)\.message\);if\(\2\)\{/g,
    replacement: 'if($1==="message_end"){const $2=$3($4.message);if($2&&$2.role!=="assistant")return[];if($2){',
    expect: 1,
  },
  // ── pi: each message once ───────────────────────────────────────────────
  // pi streams a message as deltas and then sends the whole of it again in
  // text_end/thinking_end, message_end, turn_end and (for the last one)
  // agent_end. Only the deltas merge, so the task chat showed every reply and
  // every thinking block four or five times in a row. Same change as upstream
  // PR #14320: show the deltas, drop the repeats, and use message_end only for
  // a message that did not stream. Three entries, one fix. The streamed flag
  // lives on the parser's own pending-tool-call Map (upstream adds a module
  // variable, which a pattern cannot declare); message_start clears it.
  {
    id: "pi-transcript-once-agent-end",
    title: "pi adapter: agent_end no longer repeats the last message",
    upstream: "https://github.com/paperclipai/paperclip/pull/14320",
    files: ["ui/dist/assets/*.js"],
    pattern: /if\(([\w$]+)\?\.role==="assistant"\)\{const ([\w$]+)=\1\.content,\{text:([\w$]+),thinking:([\w$]+)\}=[\w$]+\(\2\);\4&&([\w$]+)\.push\(\{kind:"thinking",ts:([\w$]+),text:\4\}\),\3&&\5\.push\(\{kind:"assistant",ts:\6,text:\3\}\);/g,
    replacement: 'if($1?.role==="assistant"){',
    expect: 1,
  },
  {
    id: "pi-transcript-once-turn-end",
    title: "pi adapter: turn_end no longer repeats the turn's message",
    upstream: "https://github.com/paperclipai/paperclip/pull/14320",
    files: ["ui/dist/assets/*.js"],
    pattern: /(if\(([\w$]+)==="turn_end"\)\{const ([\w$]+)=[\w$]+\([\w$]+\.message\),[\w$]+=[\w$]+\.toolResults,([\w$]+)=\[\];)if\(\3\)\{const ([\w$]+)=\3\.content,\{text:([\w$]+),thinking:([\w$]+)\}=[\w$]+\(\5\);\7&&\4\.push\(\{kind:"thinking",ts:([\w$]+),text:\7\}\),\6&&\4\.push\(\{kind:"assistant",ts:\8,text:\6\}\)\}/g,
    replacement: "$1",
    expect: 1,
  },
  {
    // Takes the Map's name from the `<map>.delete(id)` that ends turn_end's
    // tool-result loop. message_end matches with or without the role guard
    // pi-transcript-non-assistant-messages adds (a --dry-run sees the core as
    // shipped), and keeps whichever it found.
    id: "pi-transcript-once-stream",
    title: "pi adapter: a streamed message is not repeated by text_end, thinking_end or message_end",
    upstream: "https://github.com/paperclipai/paperclip/pull/14320",
    files: ["ui/dist/assets/*.js"],
    pattern: new RegExp(
      String.raw`(([\w$]+)\.delete\([\w$]+\)\}return [\w$]+\})if\(([\w$]+)==="message_start"\)return\[\];` +
      String.raw`if\(\3==="message_update"\)\{const ([\w$]+)=([\w$]+)\(([\w$]+)\.assistantMessageEvent\);if\(\4\)\{const ([\w$]+)=([\w$]+)\(\4\.type\);` +
      String.raw`if\(\7==="thinking_delta"\)\{const ([\w$]+)=\8\(\4\.delta\);if\(\9\)return\[(\{kind:"thinking",ts:([\w$]+),text:\9,delta:!0\})\]\}` +
      String.raw`if\(\7==="text_delta"\)\{const ([\w$]+)=\8\(\4\.delta\);if\(\12\)return\[(\{kind:"assistant",ts:\11,text:\12,delta:!0\})\]\}` +
      String.raw`if\(\7==="thinking_end"\)\{const ([\w$]+)=\8\(\4\.content\);if\(\14\)return\[\{kind:"thinking",ts:\11,text:\14\}\]\}` +
      String.raw`if\(\7==="text_end"\)\{const ([\w$]+)=\8\(\4\.content\);if\(\15\)return\[\{kind:"assistant",ts:\11,text:\15\}\]\}\}return\[\]\}` +
      String.raw`if\(\3==="message_end"\)\{const ([\w$]+)=\5\(\6\.message\);((?:if\(\16&&\16\.role!=="assistant"\)return\[\];)?)if\(\16\)\{`,
      "g",
    ),
    replacement:
      '$1if($3==="message_start")return $2.kyoubeStreamed=!1,[];' +
      'if($3==="message_update"){const $4=$5($6.assistantMessageEvent);if($4){const $7=$8($4.type);' +
      'if($7==="thinking_delta"){const $9=$8($4.delta);if($9)return $2.kyoubeStreamed=!0,[$10]}' +
      'if($7==="text_delta"){const $12=$8($4.delta);if($12)return $2.kyoubeStreamed=!0,[$13]}}return[]}' +
      'if($3==="message_end"){const $16=$5($6.message);$17if($16&&!$2.kyoubeStreamed){',
    expect: 1,
  },
  // ── Hermes: readable task chat ──────────────────────────────────────────
  // The agent form shows "Quiet output" on by default, but the runner treated
  // an unset `quiet` as off, so every Hermes agent ran in Hermes' terminal
  // mode: it echoes the whole prompt (`Query: <AGENTS.md + wake>`), wraps at
  // 80 columns and draws boxes, all of which reached the task chat. Same
  // change as upstream PR #12016 (issue #11976): unset means quiet. The
  // replacement is written differently from upstream's `!== false`, so
  // `upstreamFix` recognises only upstream's own code.
  {
    id: "hermes-quiet-default",
    title: "Hermes adapter: an unset Quiet output runs Hermes quietly, as the form shows",
    upstream: "https://github.com/paperclipai/paperclip/pull/12016",
    files: ["packages/adapters/hermes/src/server/execute.ts"],
    pattern: /const useQuiet = cfgBoolean\(config\.quiet\) === true; \/\/ default false/g,
    replacement: "const useQuiet = cfgBoolean(config.quiet) ?? true; // KyoubeAI core patch hermes-quiet-default",
    expect: 1,
    upstreamFix: /const useQuiet = cfgBoolean\(config\.quiet\) !== false;/g,
  },
  // runChildProcess writes a run's prompt to the harness CLI's stdin with no `error` listener on
  // that stream, so a CLI that exits or closes stdin before reading it (a broken or empty
  // install, a crash at start) raises an unhandled EPIPE that kills the whole server; since
  // 2026.1023 the agent lifecycle retries a failed hello probe every minute, so it crashes again
  // each minute. The listener ignores the closed pipe, as upstream PR #14057 does, and logs any
  // other stdin failure for the run; the run's result still comes from the child's exit.
  {
    id: "child-stdin-closed-early",
    title: "Harness runs: a CLI that closes its stdin early no longer crashes the server",
    upstream: "https://github.com/paperclipai/paperclip/pull/14057",
    files: ["packages/adapter-utils/src/server-utils.ts"],
    pattern: /(\n( *)if \(opts\.stdin != null && stdin\) \{\n)( *)(void spawnPersistPromise\.finally\(\(\) => \{\n *if \(child\.killed \|\| stdin\.destroyed\) return;\n *stdin\.write\(opts\.stdin as string\);)/g,
    replacement:
      '$1$3stdin.on("error", (err) => { const code = (err as NodeJS.ErrnoException)?.code; ' +
      'if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return; ' +
      'onLogError(err, runId, "failed to write child process stdin"); }); // KyoubeAI core patch child-stdin-closed-early\n$3$4',
    expect: 1,
    upstreamFix: /stdin\.on\("error", handleStdinFailure\);/g,
  },
  // Claude subscription sign-in (Connections → Claude subscription), upstream issue #17868. The
  // server runs `claude setup-token` in a PTY and reads its screen twice: for the sign-in link,
  // then, after the person pastes the code, for the token. With the Claude Code the image ships
  // (2.1.306) both reads fail on 2026.1023.0, so the link never appears ("Preparing browser
  // sign-in…" for ever) and, once it does, the pasted code ends in "Sign-in ended before the
  // account was connected". The `setup-token-*` entries fix it, each upstream's own change:
  //
  // `setup-token-copy-hint`: Claude prints "Hold Shift while selecting to use your terminal's
  // native copy" between the link and "Paste code here if prompted", and the prompt parser
  // accepted nothing in between. Upstream PR #15550 (merged 2026-11-02, after 1023.0) skips that
  // exact line.
  {
    id: "setup-token-copy-hint",
    title: "Claude sign-in: the link appears although Claude prints a copy hint before the code prompt",
    upstream: "https://github.com/paperclipai/paperclip/pull/15550",
    files: ["packages/adapters/claude-local/src/server/setup-token-parse.ts"],
    // Not again after itself, nor after upstream's own skip.
    pattern: /(\n( *)if \(trimmed\.replace\(TRAILING_PUNCTUATION_RE, ""\) === url\) continue;\n)(?! *if \((?:COPY_HINT_LINE_RE|\/\^Hold))/g,
    replacement:
      "$1$2if (/^Hold\\s+Shift\\s+while\\s+selecting\\s+to\\s+use\\s+your\\s+terminal['’]s\\s+native\\s+copy\\.?$/i.test(trimmed)) continue; // KyoubeAI core patch setup-token-copy-hint\n",
    expect: 1,
    upstreamFix: /if \(COPY_HINT_LINE_RE\.test\(trimmed\)\) continue;/g,
  },
  // `setup-token-rendered-screen` and the four `-runner-*` entries: Claude redraws its
  // success screen by difference, so the raw stream never holds the token's anchor lines whole.
  // The runner now also keeps the whole sign-in stream (bounded like its own buffers, dropped once
  // the token binds) and, when the raw parse finds no token, parses the screen that stream draws
  // (setup-token-screen.mjs). Upstream PR #17276 (open).
  {
    id: "setup-token-rendered-screen",
    title: "Claude sign-in: the core can read the token from Claude's redrawn success screen",
    upstream: "https://github.com/paperclipai/paperclip/pull/17276",
    files: ["packages/adapters/claude-local/src/server/setup-token-parse.ts"],
    // Only in a file that has no renderTerminalScreen yet (ours or upstream's).
    pattern: /(?<!export function renderTerminalScreen\([\s\S]*)(\nexport function parseSetupTokenCredential\(text: string\): string \| null \{\n)(?![\s\S]*export function renderTerminalScreen\()/g,
    replacement: `\n// KyoubeAI core patch setup-token-rendered-screen (docker/core-patches/setup-token-screen.mjs)\nexport ${renderTerminalScreen.toString()}\n$1`,
    expect: 1,
    upstreamFix: /\nexport function renderTerminalScreen\(text: string\): string \{\n/g,
  },
  {
    id: "setup-token-rendered-runner-import",
    title: "Claude sign-in: the runner imports the screen renderer",
    upstream: "https://github.com/paperclipai/paperclip/pull/17276",
    files: ["packages/adapters/claude-local/src/server/setup-token-runner.ts"],
    pattern: /(\n( *)parseSetupTokenPrompt,\n)( *type SetupTokenPrompt,\n\} from "\.\/setup-token-parse\.js";)/g,
    replacement: "$1$2renderTerminalScreen, // KyoubeAI core patch setup-token-rendered-runner-import\n$3",
    expect: 1,
    upstreamFix: /\n *renderTerminalScreen,\n *type SetupTokenPrompt,\n\} from "\.\/setup-token-parse\.js";/g,
  },
  {
    id: "setup-token-rendered-runner-capture",
    title: "Claude sign-in: the runner parses the drawn screen when the raw stream holds no token",
    upstream: "https://github.com/paperclipai/paperclip/pull/17276",
    files: ["packages/adapters/claude-local/src/server/setup-token-runner.ts"],
    pattern:
      /(\n( *)const token = )parseSetupTokenCredential\(tokenBuffer\);(\n *if \(!token\) return;\n *tokenBytes = Buffer\.from\(token, "utf8"\);\n *tokenBuffer = "";\n)/g,
    replacement:
      "$1parseSetupTokenCredential(tokenBuffer) ?? parseSetupTokenCredential(renderTerminalScreen(kyoubeTranscript)); // KyoubeAI core patch setup-token-rendered-runner-capture$3" +
      '$2kyoubeTranscript = "";\n',
    expect: 1,
    upstreamFix: /parseSetupTokenCredential\(renderTerminalScreen\(transcript\)\)/g,
  },
  {
    id: "setup-token-rendered-runner-transcript",
    title: "Claude sign-in: the runner keeps the whole sign-in stream until the token binds",
    upstream: "https://github.com/paperclipai/paperclip/pull/17276",
    files: ["packages/adapters/claude-local/src/server/setup-token-runner.ts"],
    // Not again after itself, nor where upstream's onData already keeps its transcript.
    pattern: /(\n( *)const onData = \(chunk: string\): void => \{\n)(?! *(?:\/\/ KyoubeAI core patch setup-token-rendered-runner-transcript|if \(onCredential && !tokenBytes\) \{\n *transcript \+= chunk;))/g,
    replacement:
      "$1$2  // KyoubeAI core patch setup-token-rendered-runner-transcript: the whole stream, for the drawn screen.\n" +
      "$2  if (onCredential && !tokenBytes) {\n" +
      "$2    kyoubeTranscript += chunk;\n" +
      "$2    if (kyoubeTranscript.length > CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS) kyoubeTranscript = kyoubeTranscript.slice(kyoubeTranscript.length - CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS);\n" +
      "$2  }\n",
    expect: 1,
    upstreamFix: /\n *transcript \+= chunk;\n/g,
  },
  {
    id: "setup-token-rendered-runner-declare",
    title: "Claude sign-in: the runner declares the stream it keeps for the drawn screen",
    upstream: "https://github.com/paperclipai/paperclip/pull/17276",
    files: ["packages/adapters/claude-local/src/server/setup-token-runner.ts"],
    // Not again after itself, nor next to upstream's own `transcript`.
    pattern: /(\n( *)let tokenBuffer = "";\n)(?! *let (?:kyoubeTranscript|transcript) = "";)/g,
    replacement: '$1$2let kyoubeTranscript = ""; // KyoubeAI core patch setup-token-rendered-runner-declare\n',
    expect: 1,
    upstreamFix: /\n *let tokenBuffer = "";\n *let transcript = "";\n/g,
  },
  // `setup-token-pty-window`: the PTY bridge gave Claude a 0×0 terminal, so Ink wrapped the link
  // and the token at 80 columns and left cells of the link next to the token. A 50×1000 window,
  // set in the child before it runs the CLI, keeps both on one line. Upstream PR #17276 (open).
  {
    id: "setup-token-pty-window",
    title: "Claude and Codex sign-in: the sign-in terminal has a real window size",
    upstream: "https://github.com/paperclipai/paperclip/pull/17276",
    files: ["server/dist/services/local-ai-browser-login.js"],
    pattern: /\nimport errno, os, pty, select, signal, sys\npid, master = pty\.fork\(\)\nif pid == 0:\n( *)(os\.execvpe\(sys\.argv\[1\], sys\.argv\[1:\], os\.environ\))/g,
    replacement:
      "\nimport errno, fcntl, os, pty, select, signal, struct, sys, termios\npid, master = pty.fork()\nif pid == 0:\n" +
      '$1fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))  # KyoubeAI core patch setup-token-pty-window\n$1$2',
    expect: 1,
    upstreamFix: /\n *fcntl\.ioctl\(0, termios\.TIOCSWINSZ, struct\.pack\("HHHH", \d+, \d+, 0, 0\)\)\n/g,
  },
  // The Hermes transcript parser made every stdout line its own agent
  // message, so a reply's paragraphs, list items and table rows became
  // separate bubbles (a wrapped line starting "6." even became a numbered
  // list). A text line is now a delta, which the transcript merges with the
  // text line before it: a list item, table row or line starting in lower case
  // (a wrapped continuation) joins with a line break, anything else starts a
  // new paragraph. The transcript drops blank lines before the parser sees
  // them, so the paragraph rule stands in for them. Tool cards, thinking and
  // errors still end the message.
  {
    id: "hermes-transcript-one-message",
    title: "Hermes adapter: a reply's lines form one message in the task chat",
    upstream: "https://github.com/paperclipai/paperclip (packages/adapters/hermes/src/ui/parse-stdout.ts, parseHermesStdoutLine, regular assistant output; issue pending)",
    files: ["ui/dist/assets/*.js"],
    pattern: /([\w$]+)\.startsWith\("Traceback"\)\?\[\{kind:"stderr",ts:([\w$]+),text:\1\}\]:\[\{kind:"assistant",ts:\2,text:\1\}\]/g,
    replacement: '$1.startsWith("Traceback")?[{kind:"stderr",ts:$2,text:$1}]:[{kind:"assistant",ts:$2,text:(/^(?:[-*+] |\\d+[.)] |\\||[a-z])/.test($1)?"\\n":"\\n\\n")+$1,delta:!0}]',
    expect: 1,
  },
  // ── onboarding: "Skip for now" under a failed Connect step ──────────────
  // Step 2 of the first-run agent wizard ("Connect a model") will not hire the
  // agent until the chosen harness is signed in. On a fresh KyoubeAI install
  // nothing is: the server runs in `authenticated` mode, where the wizard's
  // Claude/OpenAI subscription sign-in ends in "Only the local operator can
  // connect this machine's CLI account" (upstream only lets the implicit local
  // operator of a `local_trusted` instance finish it), and the Terminal page
  // where `claude login` works sits behind the wizard, which has no close
  // button. An API key still works; a subscription has no way forward.
  //
  // Four patches, one feature. The footer gets a "Skip for now" button while
  // the Connect step (the wizard's internal step 4) shows an error; it calls the step's primary action with `true`,
  // which goes straight to the hire handler with `true`, which then skips the
  // two checks that need a signed-in harness (the local sign-in and the
  // environment test). Both handlers are plain function declarations, so
  // `arguments[0]` reads that flag without the pattern reaching a parameter
  // list, and every existing call passes nothing (or a click event), so only
  // the new button skips. The agent is created with the chosen harness and
  // no credential; signing in from the Terminal page afterwards is enough.
  {
    id: "onboarding-skip-harness-primary",
    title: "onboarding: the Connect step's primary action accepts a skip flag",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, handleConnectStepPrimary; feature request pending)",
    files: ["ui/dist/assets/*.js"],
    pattern: /function ([\w$]+)\(\)\{if\(([\w$]+)==="ready"&&([\w$]+)\)\{([\w$]+)&&window\.open\(\4,"_blank","noreferrer,noopener"\),([\w$]+)\("waiting"\);return\}\2!=="connecting"&&\(([\w$]+)\|\|([\w$]+)\(\)\)\}/g,
    replacement: 'function $1(){if(arguments[0]===!0){$7(!0);return}if($2==="ready"&&$3){$4&&window.open($4,"_blank","noreferrer,noopener"),$5("waiting");return}$2!=="connecting"&&($6||$7())}',
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-login",
    title: "onboarding: a skipped hire does not start the subscription sign-in",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, handleGiveHeartbeat, localLogin.connect(); feature request pending)",
    files: ["ui/dist/assets/*.js"],
    pattern: /if\(([\w$]+)!=="api"&&([\w$]+)&&([\w$]+)&&!([\w$]+)\(\)&&!([\w$]+)&&!([\w$]+)\.storedLogin\.data\)\{if\(await ([\w$]+)\.connect\(\),/g,
    replacement: 'if(arguments[0]!==!0&&$1!=="api"&&$2&&$3&&!$4()&&!$5&&!$6.storedLogin.data){if(await $7.connect(),',
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-gate",
    title: "onboarding: a skipped hire does not run the environment test",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, handleGiveHeartbeat, blocksAgentCreate gate; feature request pending)",
    files: ["ui/dist/assets/*.js"],
    pattern: /if\(([\w$]+)\)\{const ([\w$]+)=(\([^;]*?\))\?\?await ([\w$]+)\(([\w$,]*)\);if\(!\2\|\|!([\w$]+)\(\)\)return;if\(([\w$]+)\(\2\)\)\{([\w$]+)\(\2\.status==="fail"\?"The environment test failed\. Fix the reported checks before you hire this agent\.":"No working authentication was found\. Fix the reported checks before you hire this agent\."\);return\}\}/g,
    replacement: 'if($1&&arguments[0]!==!0){const $2=$3??await $4($5);if(!$2||!$6())return;if($7($2)){$8($2.status==="fail"?"The environment test failed. Fix the reported checks before you hire this agent.":"No working authentication was found. Fix the reported checks before you hire this agent.");return}}',
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-button",
    title: "onboarding: offer \"Skip for now\" under an error on the Connect step",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, error block and FooterNav; feature request pending)",
    // Anchors on the error line and on the footer's own literals ("Continue",
    // "Connecting", the step numbers), and captures the step ($5), the busy
    // flag ($7) and the Connect step's primary action ($8) from the footer's
    // props. The footer call is re-emitted verbatim ($3). Since core 2026.1005
    // the UI is built with esbuild keepNames, which wraps the onPrimary arrow
    // as `<name>(()=>{…},"onPrimary")`; the pattern accepts it with or without.
    files: ["ui/dist/assets/*.js"],
    pattern: /([\w$]+)&&\(0,([\w$]+)\.jsx\)\("div",\{className:"mt-3",children:\(0,\2\.jsx\)\("p",\{className:"text-xs text-destructive",children:\1\}\)\}\),(\(([\w$]+)\|\|([\w$]+)===1\)&&\(0,\2\.jsx\)\(([\w$]+),\{onBack:[^;]*?,primaryLabel:\5===1\?"Continue":[^;]*?,loadingLabel:\5===1\?"Creating\.\.\.":\5===4\?"Connecting":"Launching\.\.\.",loading:\5===3\|\|\5===4\?!1:([\w$]+),primaryDisabled:[^;]*?,onPrimary:(?:[\w$]+\()?\(\)=>\{\5===1\?[\w$]+\(\):\5===3\?[\w$]+\(4\):\5===4\?([\w$]+)\(\):[\w$]+\(\)\}(?:,"onPrimary"\))?\}\))/g,
    replacement:
      '$1&&(0,$2.jsx)("div",{className:"mt-3",children:(0,$2.jsx)("p",{className:"text-xs text-destructive",children:$1})}),' +
      `$5===4&&$1&&(0,$2.jsx)("div",{className:"mt-2",children:(0,$2.jsx)("button",{type:"button",className:"text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors",disabled:$7,onClick:()=>$8(!0),children:${JSON.stringify(SKIP_HARNESS_LABEL)}})}),` +
      "$3",
    expect: 1,
  },
  // ── Licensing: KyoubeAI's user limit (standing: never deleted) ───────────
  // The first standing behaviour patch (CONTRIBUTING.md, "Never patch the core";
  // docs/licensing.md). Every account is created through Better Auth's
  // createUser, so one `user.create.before` hook covers open sign-up, the
  // first-run claim and invited people. The hook only calls KyoubeAI code:
  // packages/license, built to /opt/kyoube/license/enforce.mjs, whose checkSeat
  // never throws. Its answer becomes a Better Auth APIError, which sign-up
  // passes through unchanged: 400 SEAT_LIMIT_REACHED, never a 403, which sign-up
  // swaps for a generic duplicate-account reply. A module that can't load
  // refuses the sign-up (500 LICENSE_CHECK_FAILED): fail closed.
  // scripts/smoke.sh proves the limit end to end on every PR, after every core
  // bump, and weekly against the core's :beta. When either entry stops matching,
  // redo it for the new core.
  {
    id: "license-seat-limit-import",
    title: "licensing: the auth module imports Better Auth's APIError for the user-limit hook",
    standing: "KyoubeAI licensing: the user limit",
    files: ["server/dist/auth/better-auth.js"],
    pattern: /^import \{ betterAuth \} from "better-auth";$(?!\nimport \{ APIError as KyoubeLicenseAPIError \})/gm,
    replacement: 'import { betterAuth } from "better-auth";\nimport { APIError as KyoubeLicenseAPIError } from "better-auth/api";',
    expect: 1,
  },
  {
    id: "license-seat-limit-hook",
    title: "licensing: refuse a new account when the instance is at its user limit",
    standing: "KyoubeAI licensing: the user limit",
    files: ["server/dist/auth/better-auth.js"],
    pattern: /(\n( *)emailAndPassword: \{\s*enabled: true,\s*requireEmailVerification: false,\s*disableSignUp: config\.authDisableSignUp,\s*\},)(?!\n *databaseHooks:)/g,
    replacement:
      "$1\n$2databaseHooks: { user: { create: { before: async () => { /* kyoube-license-seat-limit (docs/licensing.md) */ " +
      'const kyoubeSeat = await import("/opt/kyoube/license/enforce.mjs").then(' +
      "(module) => module.checkSeat({ countUsers: async () => Number(await db.$count(authUsers)) }), " +
      '(error) => { console.error("[kyoube] licence check unavailable", error); ' +
      'return { ok: false, status: "INTERNAL_SERVER_ERROR", code: "LICENSE_CHECK_FAILED", message: "KyoubeAI could not check its user limit, so no account was created. An instance admin can run kyoube doctor to see why." }; }); ' +
      "if (!kyoubeSeat.ok) throw new KyoubeLicenseAPIError(kyoubeSeat.status, { code: kyoubeSeat.code, message: kyoubeSeat.message }); " +
      "} } } },",
    expect: 1,
  },
  // ── User groups: chat honours assignment rules (standing: never deleted) ──
  // The core's Agent Chat route opens a conversation issue assigned to the agent
  // without the assignment check every other assigning route runs, and messages
  // in that conversation are checked only against its owner. User groups
  // (docs/groups.md) restrict who may give work to a group's agents by marking
  // them protected, so both paths ask the core's own assertCanAssignTasks — but
  // only for a protected agent, so chat with any other agent is unchanged.
  // When either anchor stops matching, redo the entry for the new core.
  {
    id: "groups-chat-open-assign-check",
    title: "user groups: opening a chat with a protected agent needs the right to assign it",
    standing: "KyoubeAI user groups: agent chat honours assignment rules",
    files: ["server/dist/routes/issues.js"],
    // `const agent = resolved.agent;` occurs once in issues.js (2026.1005.0 and 2026.1012.0), in this route.
    pattern: /(\n( *)const agent = resolved\.agent;)(?!\n *\/\* kyoube-groups-chat)/g,
    replacement:
      '$1\n$2/* kyoube-groups-chat (docs/groups.md) */ if (agent.permissions?.authorizationPolicy?.assignmentPolicy?.mode === "protected") await assertCanAssignTasks(req, companyId, { assigneeAgentId: agent.id });',
    expect: 1,
  },
  {
    id: "groups-chat-message-assign-check",
    title: "user groups: a message in a protected agent's chat needs the right to assign it",
    standing: "KyoubeAI user groups: agent chat honours assignment rules",
    files: ["server/dist/routes/issues.js"],
    pattern: /(\n( *)throw forbidden\("Only the conversation owner can send messages or start a new session"\);)(?!\n *\/\* kyoube-groups-chat)/g,
    replacement:
      '$1\n$2/* kyoube-groups-chat (docs/groups.md) */ { const kyoubeChatAgent = await agentsSvc.getById(issue.conversationAgentId); if (kyoubeChatAgent?.permissions?.authorizationPolicy?.assignmentPolicy?.mode === "protected") await assertCanAssignTasks(req, issue.companyId, { assigneeAgentId: issue.conversationAgentId }); }',
    expect: 1,
  },
  // ── Agent questions: who an agent may ask (standing: never deleted) ──
  // docs/agent-rules.md, "Agent questions". The core lets an agent address an
  // ask_user_questions card to any agent in its company, and the working rules'
  // people-only cap makes every such card unanswerable by agents. This entry
  // calls KyoubeAI code (ask-level.mjs, shipped as
  // /opt/kyoube/core-patches/ask-level.mjs) for that one case, after the core
  // applies the company cap and before it builds the card: the module refuses
  // the card (422 with a code) or makes it answerable by the addressed agent.
  // A missing patch therefore leaves every card people-only. A module that
  // can't load refuses the question (fail closed). With KYOUBE_AGENT_RULES=off
  // the module is never loaded. When the anchor stops matching, redo the entry
  // for the new core.
  {
    id: "agent-questions-ask-level",
    title: "agent questions: an agent may ask only the agents its ask level allows",
    standing: "KyoubeAI agent working rules: agent questions",
    files: ["server/dist/services/issue-thread-interactions.js"],
    // `const normalizedData = {` followed by `...data,` and `resolverPolicy: policy.requestedResolverPolicy,`
    // occurs once in issue-thread-interactions.js (2026.1012.0), in create(), right after
    // `const policy = resolveInteractionPolicy({...});`. Once patched, `});` is no longer followed by
    // `const normalizedData`, so a second apply matches nothing.
    pattern: /(\n( *)\}\);)(\n *const normalizedData = \{\n *\.\.\.data,\n *resolverPolicy: policy\.requestedResolverPolicy,)/g,
    replacement:
      "$1\n$2/* kyoube-ask-level (docs/agent-rules.md) */ " +
      'if (actor?.agentId && data.kind === "ask_user_questions" && data.addresseeAgentId && String(process.env.KYOUBE_AGENT_RULES ?? "on").trim().toLowerCase() !== "off") ' +
      'await import("/opt/kyoube/core-patches/ask-level.mjs").then(' +
      "(kyoubeAskLevel) => kyoubeAskLevel.applyAskLevel({ db, tables: { agents, issueThreadInteractions }, ops: { and, eq, isNotNull }, issue, actor, data, policy, unprocessable }), " +
      '(error) => { console.error("[kyoube] ask-level check unavailable", error); ' +
      `throw unprocessable(${JSON.stringify(ASK_MESSAGES.checkFailed)}, { code: "kyoube_ask_check_failed" }); });` +
      "$3",
    expect: 1,
  },
  // ── Work-object visibility: need-to-know companies (standing: never deleted) ──
  // docs/groups.md, "Visibility". The core shows every task and project in a
  // company to every member. Eight entries. The first four call KyoubeAI code
  // (packages/visibility, shipped as /opt/kyoube/visibility/decide.mjs) in the
  // board branch of the core's authorization decision, in its live-events
  // socket and in its company search, so in a need-to-know company a restricted
  // operator or viewer sees only the work they are involved in or whose project
  // is on their list. The three `visibility-create-*` entries make the core ask
  // that decision when a person creates a task without naming an assignee, which
  // it otherwise skips, so a restricted person cannot file work under a hidden
  // task or into a project not on their list. `visibility-route-gate` puts the
  // same decision in front of every board route addressed by a task or project
  // id or identifier, many of which check only company membership. The module's
  // functions never reject. A module that can't load refuses every covered
  // action to operators and viewers (owners and admins keep the core's own
  // rules), strips every live event, finds nothing in search and answers 404 on
  // the task and project routes to every person: fail closed. When an anchor
  // stops matching, redo the entry for the new core.
  {
    id: "visibility-board-decide",
    title: "work-object visibility: a board decision on a covered action asks KyoubeAI first",
    standing: "KyoubeAI work-object visibility: need-to-know companies",
    files: ["server/dist/services/authorization.js"],
    // `explanation: "Board user id is required.",` occurs once in authorization.js (2026.1012.0): the
    // unauthenticated deny in decideBase's board branch, after the local-board and instance-admin
    // allows, directly followed by the board `if (input.action === "tasks:assign") {` rule. Once
    // patched, the marker sits between the two, so a second apply matches nothing.
    pattern: /(\n( *)explanation: "Board user id is required\.",\n *\}\);\n( *)\}\n)(?! *\/\* kyoube-visibility)( *if \(input\.action === "tasks:assign"\) \{)/g,
    replacement:
      "$1$3/* kyoube-visibility (docs/groups.md) */ { " +
      'const kyoubeVisibility = await import("/opt/kyoube/visibility/decide.mjs").then(' +
      "(m) => m.decideBoard({ actor: input.actor, action: input.action, resource: input.resource, companyId, helpers: { getActiveMembership, db, tables: { issues }, ops: { and, eq, inArray, sql } } }), " +
      // Every decision lands here while the module is missing, so the log line is kept to once a minute.
      'async (error) => { const kyoubeNow = Date.now(); if (!(kyoubeNow - (globalThis.__kyoubeVisibilityLastLog ?? -Infinity) < 60000)) { globalThis.__kyoubeVisibilityLastLog = kyoubeNow; console.error("[kyoube] visibility module unavailable", error); } ' +
      'if (!companyId || !["issue:read", "issue:comment", "issue:mutate", "project:read", "company_scope:read", "tasks:assign"].includes(input.action)) return null; ' +
      'const kyoubeMembership = await getActiveMembership(companyId, "user", input.actor.userId); const kyoubeRole = String(kyoubeMembership?.membershipRole ?? "").toLowerCase(); ' +
      'return kyoubeRole === "owner" || kyoubeRole === "admin" ? null : { reason: "deny_kyoube_visibility_unavailable", explanation: "KyoubeAI could not check work visibility, so this is refused. An instance admin can run kyoube doctor to see why." }; }); ' +
      "if (kyoubeVisibility) return deny({ action: input.action, reason: kyoubeVisibility.reason, explanation: kyoubeVisibility.explanation }); }\n$4",
    expect: 1,
  },
  {
    id: "visibility-live-events",
    title: "work-object visibility: a restricted person's live events carry no titles or details",
    standing: "KyoubeAI work-object visibility: need-to-know companies",
    files: ["server/dist/realtime/live-events-ws.js"],
    // `const visible = await visibleEvent(event);` occurs once in live-events-ws.js (2026.1023.0),
    // inside the connection handler's listener: the core's own privacy check (visibleEvent) has
    // already dropped events for tasks, projects and runs the person may not read, and trims what
    // it sends. The core still passes plugin events whole and run events in full, so a restricted
    // person's events go on through our filter as well. The filter is set up once per socket, just
    // before the core subscribes (`const unsubscribe = subscribeCompanyLiveEvents(...)`); the match
    // stops at the first `});` so it cannot run past the listener. A filter failure lands in the
    // core's own `.catch`, which logs it and sends nothing. Once patched, `const visible =` takes
    // the filtered event, so a second apply matches nothing.
    pattern: /\n( *)(const unsubscribe = subscribeCompanyLiveEvents\(context\.companyId, \(event\) => \{\n(?:(?!\n *\}\);)[\s\S])*?\n)( *)const visible = await visibleEvent\(event\);/g,
    replacement:
      "\n$1/* kyoube-visibility (docs/groups.md) */ " +
      'const kyoubeFilter = context.actorType === "board" ? import("/opt/kyoube/visibility/decide.mjs").then(' +
      "(m) => m.liveEventFilter({ companyId: context.companyId, userId: context.actorId, lookupPerson: async () => { " +
      'const [kyoubeRoleRow, kyoubeMembership] = await Promise.all([db.select({ id: instanceUserRoles.id }).from(instanceUserRoles).where(and(eq(instanceUserRoles.userId, context.actorId), eq(instanceUserRoles.role, "instance_admin"))).then((rows) => rows[0] ?? null), ' +
      'db.select({ role: companyMemberships.membershipRole }).from(companyMemberships).where(and(eq(companyMemberships.companyId, context.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, context.actorId), eq(companyMemberships.status, "active"))).then((rows) => rows[0] ?? null)]); ' +
      "return { instanceAdmin: Boolean(kyoubeRoleRow), role: kyoubeMembership?.role ?? null }; } }), " +
      '(error) => { console.error("[kyoube] visibility module unavailable", error); return async (event) => ({ type: event.type, companyId: event.companyId, createdAt: event.createdAt, payload: {} }); }) : null;' +
      "\n$1$2$3const kyoubeVisible = await visibleEvent(event);" +
      "\n$3const visible = kyoubeVisible && kyoubeFilter ? await (await kyoubeFilter)(kyoubeVisible) : kyoubeVisible;",
    expect: 1,
  },
  {
    id: "visibility-search-scope",
    title: "work-object visibility: company search lets a visibility denial through to the filter",
    standing: "KyoubeAI work-object visibility: need-to-know companies",
    files: ["server/dist/routes/issues.js"],
    // The company-scope refusal `if (!companyScopeDecision.allowed) {` with the 403 "Company search is
    // outside this actor's authorization boundary" occurs twice in routes/issues.js (2026.1012.0): in
    // the search/extract route and in the company search route. The lookahead takes the search
    // route's alone, by the `companySearchQuerySchema` parse that follows it (extract parses with
    // `companySearchExtractQuerySchema`). The condition joins the `if` itself, so a visibility
    // denial never sends the 403 and every other denial still does. Once patched, the `if` follows
    // the marker, so a second apply matches nothing.
    pattern: /(\n( *))if \(!companyScopeDecision\.allowed\)(?= \{\n *res\.status\(403\)\.json\(\{\n *error: "Company search is outside this actor's authorization boundary",\n *\}\);\n *return;\n *\}\n *const parsedQuery = companySearchQuerySchema\.safeParse\(req\.query\);)/g,
    replacement: '$1/* kyoube-visibility (docs/groups.md) */ if (!companyScopeDecision.allowed && companyScopeDecision.reason !== "deny_kyoube_visibility")',
    expect: 1,
  },
  {
    id: "visibility-search-filter",
    title: "work-object visibility: company search answers a restricted person with what they may see",
    standing: "KyoubeAI work-object visibility: need-to-know companies",
    files: ["server/dist/routes/issues.js"],
    // `const result = await getSearchService().search(companyId, query, { issueReadCondition, projectReadCondition })`
    // followed by `res.json(result);` occurs once in routes/issues.js (2026.1023.0), at the end of
    // the company search route (search/extract calls `.extract(...)`). The core's own read
    // conditions already leave out private tasks and projects; ours goes further for need-to-know. A denied company scope reaches it only for
    // a visibility denial (visibility-search-scope), and only then is the result filtered. Once
    // patched, `res.json(` is followed by the marker, so a second apply matches nothing.
    pattern: /(\n( *)const result = await getSearchService\(\)\.search\(companyId, query, \{\n *issueReadCondition: await issueReadSqlCondition\(db, req\.actor\),\n *projectReadCondition: await projectReadSqlCondition\(db, req\.actor\),\n *\}\);\n *)res\.json\(result\);/g,
    replacement:
      "$1/* kyoube-visibility (docs/groups.md) */ res.json(" +
      'companyScopeDecision.reason === "deny_kyoube_visibility" ? await import("/opt/kyoube/visibility/decide.mjs").then(' +
      "(m) => m.filterSearchResults({ companyId, result, decide: (action, resource) => access.decide({ actor: req.actor, action, resource }) }), " +
      // Without the module nothing is found, and nothing of the core's answer is passed on but the
      // request it echoes: its counts, facets, zero-results hint and paging cover hidden matches.
      '(error) => { console.error("[kyoube] visibility module unavailable", error); return { query: result.query, normalizedQuery: result.normalizedQuery, scope: result.scope, sort: result.sort, limit: result.limit, offset: result.offset, results: [], ' +
      "countsByType: { issue: 0, comment: 0, document: 0, artifact: 0, agent: 0, project: 0 }, filterOptionCounts: { status: {}, priority: {}, assigneeAgentId: {}, assigneeUserId: {}, projectId: {}, labelId: {}, updatedWithin: {} }, zeroResults: null, hasMore: false }; }) : result);",
    expect: 1,
  },
  {
    id: "visibility-create-check",
    title: "work-object visibility: a person's unassigned task is checked against where it goes",
    standing: "KyoubeAI work-object visibility: need-to-know companies",
    files: ["server/dist/routes/issues.js"],
    // `await assertCanAssignTasks(req, companyId, createAssignmentScope);` inside the
    // `if (req.actor.type === "agent" || rawCreateBody.assigneeAgentId || rawCreateBody.assigneeUserId)`
    // block occurs once in routes/issues.js (2026.1012.0), in POST /companies/:companyId/issues.
    // `access`, `forbidden`, `authorizationDeniedDetails`, `companyId` and `createAssignmentScope`
    // are in scope there. Once patched, the block's `}` is followed by the marker, so a second apply
    // matches nothing.
    pattern: /(\n( *)if \(req\.actor\.type === "agent" \|\|\n *rawCreateBody\.assigneeAgentId \|\|\n *rawCreateBody\.assigneeUserId\) \{\n *await assertCanAssignTasks\(req, companyId, createAssignmentScope\);\n *\})(?! \/\* kyoube-visibility)/g,
    replacement: "$1" + visibilityCreateCheck("companyId", "createAssignmentScope"),
    expect: 1,
  },
  {
    id: "visibility-create-child-check",
    title: "work-object visibility: a person's unassigned subtask is checked against its parent",
    standing: "KyoubeAI work-object visibility: need-to-know companies",
    files: ["server/dist/routes/issues.js"],
    // The same block with `sanitizedBody` and `childAssignmentScope` occurs once in
    // routes/issues.js (2026.1012.0), in POST /issues/:id/children, whose parent lookup checks only
    // the company. `access`, `forbidden`, `authorizationDeniedDetails`, `parent` and
    // `childAssignmentScope` are in scope there.
    pattern: /(\n( *)if \(req\.actor\.type === "agent" \|\|\n *sanitizedBody\.assigneeAgentId \|\|\n *sanitizedBody\.assigneeUserId\) \{\n *await assertCanAssignTasks\(req, parent\.companyId, childAssignmentScope\);\n *\})(?! \/\* kyoube-visibility)/g,
    replacement: "$1" + visibilityCreateCheck("parent.companyId", "childAssignmentScope"),
    expect: 1,
  },
  {
    id: "visibility-create-plan-check",
    title: "work-object visibility: a person's unassigned plan subtasks are checked against where they go",
    standing: "KyoubeAI work-object visibility: need-to-know companies",
    files: ["server/dist/routes/issues.js"],
    // `if (childBody.assigneeAgentId || childBody.assigneeUserId) {` with its inline assignment
    // scope occurs once in routes/issues.js (2026.1012.0), in POST
    // /issues/:id/accepted-plan-decompositions, once per requested child. The route has no scope
    // variable, so the check builds the same one; `access`, `forbidden`,
    // `authorizationDeniedDetails`, `sourceIssue` and `childBody` are in scope there.
    pattern: /(\n( *)if \(childBody\.assigneeAgentId \|\| childBody\.assigneeUserId\) \{\n *await assertCanAssignTasks\(req, sourceIssue\.companyId, \{\n *projectId: childBody\.projectId \?\? sourceIssue\.projectId \?\? null,\n *parentIssueId: sourceIssue\.id,\n *assigneeAgentId: childBody\.assigneeAgentId \?\? null,\n *assigneeUserId: childBody\.assigneeUserId \?\? null,\n *\}\);\n *\})(?! \/\* kyoube-visibility)/g,
    replacement:
      "$1" +
      visibilityCreateCheck("sourceIssue.companyId", "kyoubeScope",
        "const kyoubeScope = { projectId: childBody.projectId ?? sourceIssue.projectId ?? null, parentIssueId: sourceIssue.id, assigneeAgentId: null, assigneeUserId: null }; "),
    expect: 1,
  },
  {
    id: "visibility-route-gate",
    title: "work-object visibility: a person's request addressed by a hidden task or project answers not found",
    standing: "KyoubeAI work-object visibility: need-to-know companies",
    files: ["server/dist/app.js"],
    // `api.use(boardMutationGuard());` occurs once in app.js (2026.1012.0): in createApp, after the API
    // router is made and before any of its routes is mounted, so a middleware mounted right after it
    // runs before every task and project route (by id or, for a task, by identifier such as PAP-17;
    // many of them check only company membership). `db` is createApp's parameter and `api` the
    // router; app.js imports none of the authorization service, the project service, the tables or
    // `eq`, so the replacement imports them itself, relative to app.js. Only a board actor is gated;
    // agents keep the core's own checks (SECURITY.md, Groups, "Visibility", says what that leaves). The
    // gate (packages/visibility, route-gate.ts) answers 404 only for a visibility denial and passes
    // every other case on; if the module cannot be loaded, every person gets 404 on these routes and
    // the failure is logged at most once a minute. Once patched, the marker follows the anchor, so a
    // second apply matches nothing.
    pattern: /(\n( *)api\.use\(boardMutationGuard\(\)\);\n)(?! *\/\* kyoube-visibility)/g,
    replacement:
      "$1$2/* kyoube-visibility (docs/groups.md) */ { let kyoubeGate = null; " +
      'const kyoubeLoadGate = () => (kyoubeGate ??= Promise.all([import("/opt/kyoube/visibility/decide.mjs"), import("./services/authorization.js"), import("./services/projects.js"), import("@paperclipai/db"), import("drizzle-orm")]).then(' +
      "([m, kyoubeAuthz, kyoubeProjects, kyoubeSchema, kyoubeOrm]) => m.routeGate({ decide: kyoubeAuthz.authorizationService(db).decide, ...m.coreLookups({ db, tables: { issues: kyoubeSchema.issues, projects: kyoubeSchema.projects }, ops: { eq: kyoubeOrm.eq }, resolveProjectReference: kyoubeProjects.projectService(db).resolveByReference }) })).catch(" +
      '(error) => { kyoubeGate = null; const kyoubeNow = Date.now(); if (!(kyoubeNow - (globalThis.__kyoubeVisibilityGateLastLog ?? -Infinity) < 60000)) { globalThis.__kyoubeVisibilityGateLastLog = kyoubeNow; console.error("[kyoube] visibility module unavailable", error); } return null; })); ' +
      `for (const [kyoubeKind, kyoubePath] of ${JSON.stringify(ROUTE_GATE_PATHS).replaceAll(",", ", ")}) ` +
      'api.use(kyoubePath, (req, res, next) => req.actor?.type !== "board" ? next() : kyoubeLoadGate().then((kyoubeRouteGate) => kyoubeRouteGate ? kyoubeRouteGate(kyoubeKind, req, res, next) : void res.status(404).json({ error: kyoubeKind === "project" ? "Project not found" : "Issue not found" }))); }\n',
    expect: 1,
  },
  // ── MCP connector (standing: never deleted) ──
  // docs/superpowers/specs/2026-11-12-mcp-connector-design.md, "1. Core patches". The core serves
  // its public MCP endpoint at /mcp/paperclip with `paperclip_*` tool names; KyoubeAI serves it at
  // /mcp/kyoubeai with `kyoubeai_*` names, and its setup page names the server kyoubeai and gains a
  // Claude (web, Desktop, mobile) section with an Add to Claude link. The shared constants and setup
  // copy exist in three places: packages/shared/src/*.ts, which the server loads through tsx
  // (packages/shared exports "./*": "./src/*.ts", so this is the copy behind the endpoint, the OAuth
  // resource and the server's /mcp/setup page); packages/shared/dist/*.js, patched the same so any
  // dist consumer stays consistent; and, for the setup copy, minified in the UI's agent-avatar-url
  // chunk. Those entries match every copy. The scope identifiers (`paperclip:*`),
  // the OAuth server and the Dot runner (`/mcp/runner`, `paperclip_dot_*`) stay as they are.
  // tests/mcp-endpoint.spec.mjs runs every entry on 2026.1023.0's own files. When an anchor stops
  // matching, redo the entry for the new core.
  {
    id: "mcp-path-shared",
    title: "MCP connector: the public MCP endpoint is /mcp/kyoubeai",
    standing: "KyoubeAI MCP connector",
    files: ["packages/shared/src/public-mcp.ts", "packages/shared/dist/public-mcp.js"],
    // The OAuth resource and /.well-known/oauth-protected-resource/mcp/kyoubeai follow from the constant.
    pattern: /\bPUBLIC_MCP_PATH = "\/mcp\/paperclip";/g,
    replacement: 'PUBLIC_MCP_PATH = "/mcp/kyoubeai";',
    expect: 2,
  },
  {
    id: "mcp-path-events",
    title: "MCP connector: the cloud event check calls /mcp/kyoubeai",
    standing: "KyoubeAI MCP connector",
    files: ["server/dist/services/public-mcp/events.js"],
    // The one hard-coded copy of the path outside the shared constant (2026.1023.0).
    pattern: /"\/mcp\/paperclip"/g,
    replacement: '"/mcp/kyoubeai"',
    expect: 1,
  },
  {
    id: "mcp-tool-names",
    title: "MCP connector: every public tool is named kyoubeai_<name>",
    standing: "KyoubeAI MCP connector",
    files: [
      "server/dist/services/public-mcp/*.js",
      "packages/shared/src/mcp-setup.ts",
      "packages/shared/dist/mcp-setup.js",
      "ui/dist/assets/agent-avatar-url-*.js",
    ],
    // Names, and descriptions and messages that mention another tool ("returned by
    // paperclip_search_tasks"). 2026.1023.0: capabilities.js 20, expanded-capabilities.js 28,
    // contracts.js 3, file-transfers.js 3, events.js 1, mcp-setup.ts 6, mcp-setup.js 6, agent-avatar-url 5.
    pattern: new RegExp(`\\bpaperclip_(${MCP_PUBLIC_TOOL_NAMES.join("|")})\\b`, "g"),
    replacement: "kyoubeai_$1",
    expect: 72,
  },
  {
    id: "mcp-setup-server-name",
    title: "MCP connector: the setup steps name the server kyoubeai",
    standing: "KyoubeAI MCP connector",
    files: ["packages/shared/src/mcp-setup.ts", "packages/shared/dist/mcp-setup.js", "ui/dist/assets/agent-avatar-url-*.js"],
    // Each command or sentence that names the client-side server: `codex mcp add`, `codex mcp
    // login`, `claude mcp add --transport http`, `claude mcp login`, OpenCode's config key and `opencode
    // mcp auth`, "select paperclip," and (readable copy only) "the name paperclip already points".
    // `--scopes paperclip:read,…` and `claude mcp login --help` are left alone. 2026.1023.0: mcp-setup.ts
    // 8, mcp-setup.js 8, agent-avatar-url 7.
    pattern: /(codex mcp add |codex mcp login |claude mcp add --transport http |claude mcp login |opencode mcp auth |select |the name |mcp: ?\{ ?)paperclip\b/g,
    replacement: "$1kyoubeai",
    expect: 23,
  },
  {
    id: "mcp-setup-client-names",
    title: "MCP connector: the setup page lists Claude (web, Desktop, mobile) and ChatGPT, and no Headless",
    standing: "KyoubeAI MCP connector",
    files: ["packages/shared/src/mcp-setup.ts", "packages/shared/dist/mcp-setup.js", "ui/dist/assets/agent-avatar-url-*.js"],
    // `assistantClientNames`, which orders the setup page's sections. Headless needs upstream's
    // `paperclipai` CLI, which KyoubeAI doesn't ship. The optional spaces fit the readable and the
    // minified copy alike.
    pattern: /browser:( ?)"ChatGPT \/ Claude web",( ?)headless:( ?)"Headless",( ?)/g,
    replacement: 'claude_web:$1"Claude (web, Desktop, mobile)",$2browser:$3"ChatGPT",$4',
    expect: 3,
  },
  {
    id: "mcp-setup-claude-web",
    title: "MCP connector: the Claude (web, Desktop, mobile) setup steps, with an Add to Claude link",
    standing: "KyoubeAI MCP connector",
    files: ["packages/shared/src/mcp-setup.ts", "packages/shared/dist/mcp-setup.js", "ui/dist/assets/agent-avatar-url-*.js"],
    // Inserted before `mcpSetupSteps`' browser case, whose first `code:` is the server URL variable
    // (`serverUrl` in src and dist, `e` minified). The lookbehind is the inserted case's own end, so a second
    // apply matches nothing.
    pattern: /(?<!before doing work\." \}\]; )(case ?"browser": ?return ?\[\s*\{ ?text: ?"Open your assistant's Apps \/ Connectors settings[^"]*", ?code: ?([A-Za-z_$][\w$]*) ?\})/g,
    replacement:
      `case "claude_web": return [{ text: ${JSON.stringify(MCP_CLAUDE_WEB_STEP_TEXTS[0])}, ` +
      "code: `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=KyoubeAI&connectorUrl=${encodeURIComponent($2)}` }, " +
      `{ text: ${JSON.stringify(MCP_CLAUDE_WEB_STEP_TEXTS[1])} }]; $1`,
    expect: 3,
  },
  {
    id: "mcp-setup-after-approval",
    title: "MCP connector: after approval, the assistant also summarizes data tables",
    standing: "KyoubeAI MCP connector",
    files: ["packages/shared/src/mcp-setup.ts", "packages/shared/dist/mcp-setup.js"],
    // The setup page's "After approval" section, in mcpSetupMarkdown, src and dist (the UI chunk has no
    // copy, 2026.1023.0).
    pattern: /then summarize agents and open tasks\./g,
    replacement: "then summarize agents, open tasks and data tables.",
    expect: 2,
  },
  {
    id: "mcp-setup-no-headless",
    title: "MCP connector: the Other setup steps no longer point to the removed Headless section",
    standing: "KyoubeAI MCP connector",
    files: ["packages/shared/src/mcp-setup.ts", "packages/shared/dist/mcp-setup.js", "ui/dist/assets/agent-avatar-url-*.js"],
    // The default (Other) case of `mcpSetupSteps`, in all three copies (2026.1023.0). `mcp-setup-client-names`
    // removes the Headless section this sentence sent people to.
    pattern: /If it cannot receive a browser callback, use the Headless instructions\./g,
    replacement: "If it cannot receive a browser callback, use Claude Code, Codex or OpenCode instead.",
    expect: 3,
  },
  {
    id: "mcp-ui-configure-label",
    title: "MCP connector: a configure connection reads \"Configure agents, projects, skills, tables and apps\"",
    standing: "KyoubeAI MCP connector",
    files: ["ui/dist/assets/index-*.js"],
    // The assistant connections list and the connection summary, in the main bundle.
    pattern: /Configure agents, projects and skills/g,
    replacement: "Configure agents, projects, skills, tables and apps",
    expect: 2,
  },
  // The bridge wiring: KyoubeAI's table and app tools (kyoubeai_data_*, kyoubeai_apps_*, served by the
  // kyoube.apps plugin) join the core's own on /mcp/kyoubeai and run through the core's executor, so
  // its scope checks, viewer refusal and write receipts apply to them unchanged. The patched files
  // import the bridge, /opt/kyoube/core-patches/mcp-bridge.mjs, at runtime; the Dockerfile checks
  // each file's MCP_MARKER count, that the files parse, and that the bridge loads. These entries
  // anchor on names `mcp-tool-names` has already renamed, so they follow it.
  {
    id: "mcp-bridge-register",
    title: "MCP connector: the core's internal dispatch is handed to the KyoubeAI tool bridge",
    standing: "KyoubeAI MCP connector",
    files: ["server/dist/app.js"],
    // In createApp, where the public MCP endpoint is set up (2026.1023.0). The bridge reads its tool
    // catalogue through this dispatch, as the person. A bridge that cannot be loaded is logged and the
    // core carries on with its own tools; the executor and the tool list then fail or fall back alone.
    pattern: /(\n( *)const dispatch = createMcpApiDispatch\(api\);\n)(?! *\/\* kyoube-mcp)/g,
    replacement:
      `$1$2${MCP_MARKER} import("${MCP_BRIDGE_MODULE}").then((kyoubeMcpBridge) => kyoubeMcpBridge.registerDispatch(dispatch), ` +
      '(error) => console.error("[kyoube] MCP bridge unavailable", error));\n',
    expect: 1,
  },
  {
    id: "mcp-bridge-import-capabilities",
    title: "MCP connector: the core's MCP executor can load the KyoubeAI tool bridge",
    standing: "KyoubeAI MCP connector",
    files: ["server/dist/services/public-mcp/capabilities.js"],
    // A loader after the file's imports, which `mcp-bridge-executor-find` calls.
    pattern: mcpTopImports(),
    replacement: `$1${MCP_MARKER} const kyoubeMcp = () => import("${MCP_BRIDGE_MODULE}");\n`,
    expect: 1,
  },
  {
    id: "mcp-bridge-executor-removed",
    title: "MCP connector: the executor refuses the generic search and call API tools",
    standing: "KyoubeAI MCP connector",
    files: ["server/dist/services/public-mcp/capabilities.js"],
    // The executor's call_api unwrapping, in createPublicMcpExecutor (2026.1023.0). The two generic
    // tools reach every operation by name, mixing reads and writes; the connector lists each tool on
    // its own instead, so neither is listed (`mcp-bridge-list`) and both are refused here, before the
    // unwrapping. The unwrapping stays, unreachable, so the code after it is the core's.
    pattern: /(?<!else )if \(name === "kyoubeai_call_api"\) \{/g,
    replacement:
      `${MCP_MARKER} if (${MCP_REMOVED_TOOLS}.includes(name)) throw new McpCapabilityError("Unknown KyoubeAI operation."); ` +
      'else if (name === "kyoubeai_call_api") {',
    expect: 1,
  },
  {
    id: "mcp-bridge-executor-find",
    title: "MCP connector: the executor runs KyoubeAI's table and app tools",
    standing: "KyoubeAI MCP connector",
    files: ["server/dist/services/public-mcp/capabilities.js"],
    // The executor's capability lookup (2026.1023.0). A name the core does not know is looked up in
    // the bridge, only on the /mcp/kyoubeai connection: app.js builds a second executor for the Dot
    // runner's /mcp/runner, whose OAuth resource differs. `principal` (the authenticated connection),
    // `oauth` (the executor's parameter), `z` and McpCapabilityError (the file's imports) are in
    // scope there. The bridge answers undefined for a name that is not a KyoubeAI tool, so the core's
    // "Unknown operation" stands, and throws McpCapabilityError when its catalogue cannot be read.
    pattern: /(?<!\*\/ )const capability = publicMcpCapabilities\.find\(\(c\) => c\.name === name\);/g,
    replacement:
      `${MCP_MARKER} const capability = publicMcpCapabilities.find((c) => c.name === name) ?? ` +
      '(new URL(oauth.config.resource).pathname === "/mcp/kyoubeai" ? await (await kyoubeMcp()).findTool(principal, name, { z, CapabilityError: McpCapabilityError }) : undefined);',
    expect: 1,
  },
  {
    id: "mcp-bridge-import-routes",
    title: "MCP connector: the MCP route can load the KyoubeAI tool bridge",
    standing: "KyoubeAI MCP connector",
    files: ["server/dist/routes/public-mcp.js"],
    // A loader after the file's imports, which `mcp-bridge-list` calls.
    pattern: mcpTopImports(),
    replacement: `$1${MCP_MARKER} const kyoubeMcp = () => import("${MCP_BRIDGE_MODULE}");\n`,
    expect: 1,
  },
  {
    id: "mcp-bridge-list",
    title: "MCP connector: tools/list adds KyoubeAI's table and app tools, with titles, and drops the generic API tools",
    standing: "KyoubeAI MCP connector",
    files: ["server/dist/routes/public-mcp.js"],
    // The endpoint's listTools, in publicMcpIngressRoutes (2026.1023.0). The core tools, without the
    // two generic API tools and titled by the bridge, whose idempotentHint holds only for reads; then,
    // on the person's connection (not the Dot runner's agent connection), KyoubeAI's tools from the
    // bridge; then the extension's tools as before. A bridge that cannot be loaded is logged and the
    // list is the core's, untitled, so tools/list still answers.
    pattern: /const listTools = async \(\) => \(\{\n( *)tools: \[\.\.\.\(agentConnection \? \[\] : publicMcpCapabilities\)\.map\(\(c\) => \(\{\n( *)name: c\.name, description: c\.description, inputSchema: z\.toJSONSchema\(c\.schema\),\n *annotations: \{ readOnlyHint: !c\.write && !c\.configure, destructiveHint: !!c\.destructive, idempotentHint: true, openWorldHint: !!c\.write \|\| !!c\.configure \},\n( *)\}\)\), \.\.\.await extension\?\.listTools\(principal\) \?\? \[\]\],\n( *)\}\);/g,
    replacement:
      `const listTools = async () => { ${MCP_MARKER} const bridge = await kyoubeMcp().catch((error) => { console.error("[kyoube] MCP bridge unavailable", error); return null; }); return {\n` +
      `$1tools: [...(agentConnection ? [] : publicMcpCapabilities).filter((c) => !${MCP_REMOVED_TOOLS}.includes(c.name)).map((c) => ({\n` +
      "$2name: c.name, ...(bridge ? { title: bridge.titleFor(c.name) } : {}), description: c.description, inputSchema: z.toJSONSchema(c.schema),\n" +
      "$2annotations: { readOnlyHint: !c.write && !c.configure, destructiveHint: !!c.destructive, idempotentHint: !c.write && !c.configure, openWorldHint: !!c.write || !!c.configure },\n" +
      "$3})), ...(!agentConnection && bridge ? await bridge.listTools(principal) : []), ...await extension?.listTools(principal) ?? []],\n" +
      "$4}; };",
    expect: 1,
  },
];
