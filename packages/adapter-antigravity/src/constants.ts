import type { AdapterModel } from "./types.js";

export const ADAPTER_TYPE = "antigravity_local";
export const ADAPTER_LABEL = "Antigravity";
export const AGY_CLI = "agy";

export const DEFAULT_MODEL = "gemini-4-argon-high";
export const DEFAULT_TIMEOUT_SEC = 900;
export const DEFAULT_GRACE_SEC = 15;

export const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const VALID_MODES = ["auto", "accept-edits", "plan"] as const;

/**
 * Curated list of models available in Antigravity CLI (`agy models`).
 */
export const ANTIGRAVITY_MODELS: AdapterModel[] = [
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
  { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
  { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
  { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
  { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
  { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
  { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
  { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];
