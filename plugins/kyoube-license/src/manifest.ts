import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION } from "./shared.js";

export { PLUGIN_ID, PLUGIN_VERSION };

// `minimumHostVersion` is deliberately absent, for the reason recorded in the
// terminal plugin's manifest: the image pins the core every plugin is built for, so a
// minimum would add nothing (and cores up to 2026.1005.0 rejected any minimum outright).
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "KyoubeAI Licence",
  description: "Shows this instance's user limit (5 without a licence), the licence key and who is counted, and lets an instance admin apply a key.",
  author: "KyoubeAI",
  categories: ["ui"],
  // settingsPage needs instance.settings.register and globalToolbarButton needs
  // ui.action.register (the core's plugin-capability-validator).
  capabilities: ["instance.settings.register", "ui.action.register"],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  ui: {
    slots: [
      { type: "settingsPage", id: "licence", displayName: "Licence", exportName: "LicenceSettingsPage" },
      { type: "globalToolbarButton", id: "licence-chip", displayName: "Licence", exportName: "LicenceChip" },
    ],
  },
};

export default manifest;
