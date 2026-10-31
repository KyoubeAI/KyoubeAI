import { DEFAULT_GRACE_SEC, DEFAULT_TIMEOUT_SEC, VALID_EFFORTS, VALID_MODES } from "./constants.js";
import type { AdapterConfigSchema } from "./types.js";

function effortLabel(effort: string): string {
  switch (effort) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    default:
      return effort;
  }
}

function modeLabel(mode: string): string {
  switch (mode) {
    case "auto":
      return "Auto";
    case "accept-edits":
      return "Accept edits";
    case "plan":
      return "Plan only";
    default:
      return mode;
  }
}

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "effort",
        label: "Reasoning effort",
        type: "select",
        default: "",
        options: [
          { value: "", label: "Default (from model)" },
          ...VALID_EFFORTS.map((effort) => ({
            value: effort,
            label: effortLabel(effort),
          })),
        ],
        hint: "Optional Antigravity CLI --effort level override.",
      },
      {
        key: "dangerouslySkipPermissions",
        label: "Skip permission prompts",
        type: "toggle",
        default: true,
        hint: "Pass --dangerously-skip-permissions so unattended agent runs do not block on interactive prompts.",
      },
      {
        key: "disableSlashCommands",
        label: "Disable slash commands",
        type: "toggle",
        default: false,
        hint: "Pass --disable-slash-commands in print mode.",
      },
      {
        key: "mode",
        label: "Permission mode",
        type: "select",
        default: "auto",
        options: VALID_MODES.map((mode) => ({
          value: mode,
          label: modeLabel(mode),
        })),
        hint: "Antigravity CLI --mode setting.",
      },
      {
        key: "persistSession",
        label: "Persist session",
        type: "toggle",
        default: true,
        hint: "Resume Antigravity conversations across heartbeats via --conversation.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
      },
      {
        key: "graceSec",
        label: "Grace seconds",
        type: "number",
        default: DEFAULT_GRACE_SEC,
        hint: "Seconds to wait after SIGTERM before killing the agy process.",
      },
    ],
  };
}
