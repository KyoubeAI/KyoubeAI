import { runAgentRules } from "./commands/agent-rules.js";
import { runConnect } from "./commands/connect.js";
import { runDoctor } from "./commands/doctor.js";
import { runEnsurePlugins } from "./commands/ensure-plugins.js";
import { runHarness } from "./commands/harness.js";
import { runLicense } from "./commands/license.js";
import { runUsers } from "./commands/users.js";
import { runSetup } from "./commands/setup.js";
import { runWriteConfig } from "./commands/write-config.js";
import { AS_NODE_ENV, findGosu, planNodeUser, reexec } from "./run-as-node.js";

export interface ParsedArgs {
  command: string | null;
  flags: Record<string, string | true>;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: null, flags: {}, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        result.flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && ["api-key", "api-base", "dir"].includes(body)) {
        result.flags[body] = next;
        i += 1;
      } else {
        result.flags[body] = true;
      }
      continue;
    }
    if (result.command === null) result.command = arg;
    else result.positionals.push(arg);
  }
  return result;
}

const USAGE = `kyoube — KyoubeAI bootstrap and diagnostics

Usage: kyoube <command> [flags]

Commands:
  setup                 One-time: log in as instance admin (browser approval), store a board key, install plugins
  ensure-plugins        Install/upgrade Kyoube plugins into the core host (flags: --watch, --api-key <key>, --api-base <url>)
  agent-rules           Keep the agent working rules in force (--once, --watch) or remove them (off)
  license [show]        Show the licence: Free (5 users) or licensed, users counted, expiry, instance ID
  license set <key>     Apply a KyoubeAI licence key (checked first; an invalid key is never saved)
  license clear         Remove the licence key; the free limit of 5 users applies
  license refresh       Re-read the users for the Licence page now (the container does it every minute)
  users list            List every user the licence counts
  users remove <email>  Delete a user's account to free a seat (--yes skips the question)
  doctor                Check config, databases, plugins, harnesses and kept system packages
  harness list          Show the agent harness CLIs on PATH, their versions and where they come from
  harness install <name>  Install a harness with its official installer (claude, codex, hermes, pi, gemini, opencode, kimi)
  harness which <name>  Print where a harness CLI is (exit 1 when it is not installed)
  harness missing <adapterType...>  Print the harnesses those adapter types need that are not installed
  write-config          (internal) Render /kyoubeai/kyoube/config.json from the environment
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags.help === true || parsed.command === null) {
    console.log(USAGE);
    return parsed.command === null && parsed.flags.help !== true ? 1 : 0;
  }
  // `docker compose exec app kyoube ...` runs as root; what an install or a sign-in writes must belong to node.
  const plan = planNodeUser({
    command: parsed.command,
    positionals: parsed.positionals,
    uid: process.getuid?.(),
    gosu: findGosu(),
    execPath: process.execPath,
    script: process.argv[1],
    argv,
    reexeced: Boolean(env[AS_NODE_ENV]),
  });
  if (plan.kind === "refuse") {
    console.log(plan.message);
    return 1;
  }
  if (plan.kind === "reexec") return reexec(plan.file, plan.args, env);
  switch (parsed.command) {
    case "setup":
      return runSetup(parsed.flags, env);
    case "ensure-plugins":
      return runEnsurePlugins(parsed.flags, env);
    case "agent-rules":
      return runAgentRules(parsed.positionals, parsed.flags, env);
    case "license":
      return runLicense(parsed.positionals, parsed.flags, env);
    case "users":
      return runUsers(parsed.positionals, parsed.flags, env);
    case "doctor":
      return runDoctor(env);
    case "harness":
      return runHarness(parsed.positionals, env);
    case "connect":
      return runConnect(parsed.positionals, parsed.flags, env);
    case "write-config":
      return runWriteConfig(env);
    default:
      console.log(`Unknown command: ${parsed.command}\n\n${USAGE}`);
      return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined && /kyoube(\.mjs|\.js)?$/.test(process.argv[1]) && !process.env.VITEST;
if (isEntrypoint) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`kyoube: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
