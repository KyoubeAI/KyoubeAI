/**
 * The plugin's identity, shared by the manifest, the worker and the browser
 * bundle. Kept free of imports so the Files tab never pulls in worker code.
 */
export const PLUGIN_ID = "kyoube.files";
export const PLUGIN_VERSION = "0.5.0";
/** The `detailTab` slot id; the project sidebar link opens `?tab=plugin:<PLUGIN_ID>:<TAB_SLOT_ID>`. */
export const TAB_SLOT_ID = "project-files";
