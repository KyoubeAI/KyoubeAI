import { PLUGIN_ID, TAB_SLOT_ID } from "./manifest.js";

/** The project-page URL that opens this plugin's Files tab. */
export function filesTabPath(projectRef: string): string {
  return `/projects/${encodeURIComponent(projectRef)}?tab=${encodeURIComponent(`plugin:${PLUGIN_ID}:${TAB_SLOT_ID}`)}`;
}

/** `filesTabPath` under the company's URL prefix (`/<PREFIX>/projects/<id>?tab=…`); bare when there is no prefix. */
export function filesTabLink(prefix: string | null, projectId: string): string {
  return prefix ? `/${prefix}${filesTabPath(projectId)}` : filesTabPath(projectId);
}
