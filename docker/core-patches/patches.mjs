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
 * One kind of entry is permanent: a `standing` entry (KyoubeAI licensing)
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
export const CORE_VERSION = "2026.1012.0";

/**
 * The label of the control the `onboarding-skip-harness-*` patches add under
 * a failed Connect step. Exported for the tests.
 */
export const SKIP_HARNESS_LABEL = "Skip for now and connect the harness later from the Terminal page";

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
  // ── Connections: a Claude subscription that lasts a year ────────────────
  // The server-host sign-in runs `claude auth login` in a folder per attempt,
  // keeps only claudeAiOauth.accessToken (an 8-hour token) and deletes the
  // folder with the refresh token, so every managed Claude run fails ~8 hours
  // after connecting. `kyoube connect claude` (docker/bootstrap) runs
  // `claude setup-token` in that same folder and writes the one-year token
  // where the Connect step reads it. Upstream's own sandbox sign-in already
  // stores setup-tokens as this credential (routes/agents.ts, setupTokenLogin).
  {
    id: "anthropic-signin-setup-token",
    title: "Connections: the Claude subscription sign-in command produces a one-year setup-token",
    upstream: "https://github.com/paperclipai/paperclip (server/src/services/local-ai-login.ts presentAttempt, local-ai-credentials.ts; issue pending)",
    files: ["server/dist/services/local-ai-login.js"],
    pattern: /mkdir -p "\$CLAUDE_CONFIG_DIR" && claude auth login\)/g,
    replacement: 'mkdir -p "$CLAUDE_CONFIG_DIR" && kyoube connect claude)',
    expect: 1,
  },
  // ── Licensing: KyoubeAI's user limit (standing: never deleted) ───────────
  // The one standing behaviour patch (CONTRIBUTING.md, "Never patch the core";
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
];
