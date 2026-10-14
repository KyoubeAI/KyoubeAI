import type { DownloadFile } from "./download-rules.js";

/** How long a save the viewer has to confirm waits before it is answered `declined`: inside the SDK's own 30 s call timeout, so the host always answers first. */
export const DOWNLOAD_PROMPT_MS = 25_000;

/** The host page's own document and URL API, passed in so the save is testable without a DOM. */
export interface SaveEnv {
  document: { createElement(tag: "a"): HTMLAnchorElement; body: { appendChild(node: Node): unknown } };
  url: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
  /** Runs the revoke on a later task: revoking straight after `click()` cancels the download in some browsers. */
  defer: (fn: () => void) => void;
}

/**
 * Saves a routed file from the host page. The anchor belongs to the host document, not the app's
 * frame, so the frame's sandbox plays no part in whether the browser allows it.
 */
export function saveFile(file: DownloadFile, env: SaveEnv): void {
  // A structured clone never yields a SharedArrayBuffer here (the host is not cross-origin isolated),
  // so the bytes are an ordinary ArrayBuffer view, which is what `BlobPart` asks for.
  const url = env.url.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime }));
  const anchor = env.document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  env.document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    env.defer(() => { env.url.revokeObjectURL(url); });
  }
}

/** The save waiting for the viewer, as the Save bar shows it. */
export interface PendingSave { filename: string; size: number; save(): void; dismiss(): void }

export interface DownloadController {
  /** Saves now when the viewer just clicked; otherwise asks through `onPrompt`. Rejects as `Error("<code>: …")` with `declined`, `limit` or `disabled`. */
  request(file: DownloadFile): Promise<void>;
  /** Rejects a waiting save as `disabled` and clears the bar. Not terminal: React may run an effect's cleanup and then the effect again. */
  dispose(): void;
}

/**
 * Decides, per download, whether the browser will allow a save right now. With User Activation v2 a
 * click inside the frame also activates the host page, so `isActive()` means "the viewer just
 * clicked something" (for about 5 s). When it is false (the app took too long to build the file, the
 * browser has no `userActivation`, or nobody clicked at all), the viewer is asked. The Save button is
 * a real click on the host page, so the browser allows the save it starts.
 */
export function createDownloadController(opts: {
  isActive: () => boolean;
  save: (file: DownloadFile) => void;
  onPrompt: (pending: PendingSave | null) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}): DownloadController {
  type Waiting = { resolve: () => void; reject: (error: Error) => void; timer: unknown };
  let waiting: Waiting | null = null;

  /** Ends `entry` once: a later Save, Dismiss, timeout or dispose for it finds it gone and does nothing. */
  const settle = (entry: Waiting, outcome: Error | null): void => {
    if (waiting !== entry) return;
    waiting = null;
    opts.clearTimeout(entry.timer);
    opts.onPrompt(null);
    if (outcome) entry.reject(outcome);
    else entry.resolve();
  };

  return {
    request(file) {
      if (waiting) return Promise.reject(new Error("limit: a save is already waiting for the viewer"));
      if (opts.isActive()) {
        try {
          opts.save(file);
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const entry: Waiting = { resolve, reject, timer: null };
        waiting = entry;
        entry.timer = opts.setTimeout(() => { settle(entry, new Error("declined: the viewer did not save the file")); }, DOWNLOAD_PROMPT_MS);
        opts.onPrompt({
          filename: file.filename,
          size: file.bytes.byteLength,
          save: () => {
            if (waiting !== entry) return;
            try {
              opts.save(file);
              settle(entry, null);
            } catch (error) {
              settle(entry, error instanceof Error ? error : new Error(String(error)));
            }
          },
          dismiss: () => { settle(entry, new Error("declined: the viewer dismissed the save")); },
        });
      });
    },
    dispose() {
      if (waiting) settle(waiting, new Error("disabled: this app has stopped"));
    },
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
