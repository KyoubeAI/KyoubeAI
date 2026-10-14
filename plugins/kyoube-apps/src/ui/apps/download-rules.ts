/**
 * What `kyoube.ui.download` may save (docs/apps.md, "Saving files"): the host side of the trust
 * boundary decides the name, the type and the size, and the app's own claims about any of them are
 * never read. Data and document types only. Deliberately absent: anything a local browser would run
 * (html, htm, xhtml, svg, and xml, whose XHTML root runs script), executables and scripts, and
 * macro-enabled Office files (xlsm, docm, pptm). The type comes from the extension alone. This
 * governs only the checked route: the frame's own `<a download>` skips it, and its bytes go only to
 * the viewer's disk with nothing sent while the app runs. But if the viewer opens an html or svg
 * file saved that way, it can send what it holds to a server (docs/apps.md, Security model).
 */
export const DOWNLOAD_TYPES: ReadonlyMap<string, string> = new Map([
  ["csv", "text/csv"],
  ["tsv", "text/tab-separated-values"],
  ["txt", "text/plain"],
  ["json", "application/json"],
  ["md", "text/markdown"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["zip", "application/zip"],
]);

export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_DOWNLOAD_NAME = 120;
/** The longest name the host reads at all, before cleaning. */
const MAX_RAW_NAME = 255;
/** Windows device names, which no file may be called whatever its extension. */
const RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ALLOWED_LIST = [...DOWNLOAD_TYPES.keys()].join(", ");

/** One file the runner saves: the name and type the host chose, and the app's bytes. */
export interface DownloadFile { filename: string; mime: string; bytes: Uint8Array }

/** Strips spaces and dots from both ends. */
const trimEnds = (value: string): string => value.replace(/^[\s.]+|[\s.]+$/gu, "");

/**
 * The name the file is saved under, or why it may not be saved. `\p{Cc}` takes out control
 * characters and `\p{Cf}` format characters, among them the right-to-left override that makes
 * `fdp.exe` display as `exe.pdf`; the path separators and the characters Windows refuses go too.
 */
export function cleanDownloadName(raw: unknown): { ok: true; filename: string; mime: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_NAME) {
    return { ok: false, message: `download needs a file name of 1 to ${MAX_RAW_NAME} characters` };
  }
  const name = trimEnds(raw.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/[/\\:*?"<>|]/g, "").replace(/\s+/gu, " "));
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  const mime = DOWNLOAD_TYPES.get(extension);
  // `${title}.xlsx` with an empty title cleans to the bare extension, which is a missing name, not a wrong type.
  if (dot === -1 && DOWNLOAD_TYPES.has(name.toLowerCase())) return { ok: false, message: "download needs a file name before the extension" };
  if (!mime) return { ok: false, message: `download can only save ${ALLOWED_LIST} files` };
  let stem = trimEnds(name.slice(0, dot));
  if (RESERVED_STEM.test(stem.split(".")[0]!.trim())) stem = `_${stem}`;
  const room = MAX_DOWNLOAD_NAME - extension.length - 1;
  if (stem.length > room) {
    // Cut by UTF-16 units, then drop a high surrogate left without its pair.
    stem = trimEnds(stem.slice(0, room).replace(/[\uD800-\uDBFF]$/, ""));
  }
  return { ok: true, filename: `${stem}.${extension}`, mime };
}
