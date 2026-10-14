/**
 * Phone layouts for the app runner, the Data page and the Groups and Data access settings pages
 * (wide tables scroll in their own box, long ids break, controls are 44px tall), injected once like the
 * Studio styles: the host's compiled Tailwind has no classes for these, and a
 * class it lacks is dropped without a word (see apps/frame-height.ts).
 */
const CSS = String.raw`
.kyoube-phone-only { display: none !important; }
[data-kyoube-scroll] { max-width: 100%; overflow-x: auto; }
[data-kyoube-break] { overflow-wrap: anywhere; word-break: break-all; }
[data-kyoube-page="groups"], [data-kyoube-page="data-access"] { min-width: 0; }
[data-kyoube-page="groups"] fieldset { min-width: 0; }
@media (max-width: 639px) {
  [data-kyoube-page="groups"], [data-kyoube-page="data-access"] { padding-bottom: 96px !important; }
  [data-kyoube-page="groups"] button, [data-kyoube-page="groups"] select, [data-kyoube-page="groups"] input:not([type="checkbox"]),
  [data-kyoube-page="data-access"] button, [data-kyoube-page="data-access"] select, [data-kyoube-page="data-access"] input:not([type="checkbox"]) { min-height: 44px; }
  [data-kyoube-page="groups"] fieldset label, [data-kyoube-page="data-access"] label { min-height: 44px; }
  [data-kyoube-page="groups"] fieldset { flex-basis: 100%; }
  [data-kyoube-confirm] { min-height: 44px; align-items: center; }
  .kyoube-wide-only { display: none !important; }
  .kyoube-phone-only { display: inline-flex !important; }
  [data-kyoube-runner] { padding: 0 !important; gap: 0 !important; }
  [data-kyoube-runner-bar] { padding: 8px 4px; min-height: 44px; }
  [data-kyoube-runner-bar] a, [data-kyoube-runner-bar] button { min-height: 40px; min-width: 40px; align-items: center; justify-content: center; }
  [data-kyoube-save-bar] button { min-height: 44px; }
  .kyoube-phone-menu { display: flex; flex-direction: column; gap: 6px; padding: 8px 4px; }
  [data-kyoube-page="data"] { flex-direction: column; padding: 0 !important; gap: 12px !important; }
  [data-kyoube-page="data"] > aside { width: auto !important; }
  [data-kyoube-data-view="table"] > aside { display: none; }
  [data-kyoube-data-view="list"] > main { display: none; }
  [data-kyoube-page="data"] li > button { min-height: 44px; }
}
`;

const STYLE_ID = "kyoube-apps-phone-styles";

export function ensurePhoneStyles(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/** The app's display name from the runner's runtime context (`{ app: { name } }`), or the fallback. */
export function appNameOf(context: unknown, fallback: string): string {
  const name = (context as { app?: { name?: unknown } } | null)?.app?.name;
  return typeof name === "string" && name.length > 0 ? name : fallback;
}
