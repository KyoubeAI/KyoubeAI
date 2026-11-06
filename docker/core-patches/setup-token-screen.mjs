/**
 * The terminal screen the `setup-token-rendered-*` patches give the core's Claude sign-in
 * (packages/adapters/claude-local/src/server/setup-token-parse.ts), ported from upstream PR #17276.
 *
 * Claude Code 2.1.3xx redraws its success screen by difference: it writes only the cells that
 * changed since the last frame and moves over the rest with cursor sequences. The raw stream then
 * never holds the line "Your OAuth token (valid for 1 year):" in one piece, so the core's token
 * parser finds no token and the sign-in ends with "Sign-in ended before the account was
 * connected" after the person pasted a valid code (upstream issue #17868, finding 4).
 * `renderTerminalScreen` replays the stream onto a bounded grid and returns the screen as text,
 * which the core's own parser then reads unchanged.
 *
 * It applies CR, LF, BS, TAB, the CSI cursor moves A B C D E F G H f, the erases K and J, save and
 * restore (CSI s/u, ESC 7/8), and skips OSC strings, private-mode CSI and charset designations.
 * A bare LF starts a new line, since Ink puts the terminal in raw mode.
 *
 * The function is self-contained (its constants live inside it) because the patch inserts its
 * source text into the core file: `renderTerminalScreen.toString()`. Plain JavaScript is valid
 * TypeScript for tsx, which runs the adapter's source.
 */
export function renderTerminalScreen(text) {
  const CSI_AT_RE = /^\x1b\[([0-?]*)([ -/]*)([@-~])/;
  const CHARSET_AT_RE = /^\x1b[()*+][\x20-\x7e]/;
  const MAX_RENDER_ROWS = 2048;
  const MAX_RENDER_COLS = 1024;
  const rows = [[]];
  let row = 0;
  let col = 0;
  let saved = { row: 0, col: 0 };
  const ensureRow = (r) => {
    while (rows.length <= r && rows.length < MAX_RENDER_ROWS) rows.push([]);
  };
  const moveTo = (r, c) => {
    row = Math.max(0, Math.min(r, MAX_RENDER_ROWS - 1));
    col = Math.max(0, Math.min(c, MAX_RENDER_COLS - 1));
    ensureRow(row);
  };
  if (typeof text !== "string") return "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\x1b") {
      const rest = text.slice(i, i + 256);
      const csi = CSI_AT_RE.exec(rest);
      if (csi) {
        i += csi[0].length;
        const rawParams = csi[1];
        const intermediates = csi[2];
        const final = csi[3];
        if (intermediates || /^[<=>?]/.test(rawParams)) continue;
        const params = rawParams.split(";").map((value) => Number.parseInt(value, 10));
        const n = Number.isFinite(params[0]) && params[0] > 0 ? params[0] : 1;
        switch (final) {
          case "A": moveTo(row - n, col); break;
          case "B": moveTo(row + n, col); break;
          case "C": moveTo(row, col + n); break;
          case "D": moveTo(row, col - n); break;
          case "E": moveTo(row + n, 0); break;
          case "F": moveTo(row - n, 0); break;
          case "G": moveTo(row, n - 1); break;
          case "H":
          case "f": {
            const c = Number.isFinite(params[1]) && params[1] > 0 ? params[1] : 1;
            moveTo(n - 1, c - 1);
            break;
          }
          case "K": {
            const mode = Number.isFinite(params[0]) ? params[0] : 0;
            const line = rows[row];
            if (mode === 0) line.length = Math.min(line.length, col);
            else if (mode === 1) for (let c = 0; c <= col && c < line.length; c += 1) line[c] = " ";
            else line.length = 0;
            break;
          }
          case "J": {
            const mode = Number.isFinite(params[0]) ? params[0] : 0;
            if (mode === 0) {
              rows[row].length = Math.min(rows[row].length, col);
              rows.length = row + 1;
            } else if (mode === 2 || mode === 3) {
              for (const line of rows) line.length = 0;
            }
            break;
          }
          case "s": saved = { row, col }; break;
          case "u": moveTo(saved.row, saved.col); break;
          default: break;
        }
        continue;
      }
      if (text[i + 1] === "]") {
        const bell = text.indexOf("\x07", i + 2);
        const st = text.indexOf("\x1b\\", i + 2);
        const ends = [bell === -1 ? -1 : bell + 1, st === -1 ? -1 : st + 2].filter((end) => end !== -1);
        i = ends.length > 0 ? Math.min(...ends) : text.length;
        continue;
      }
      const charset = CHARSET_AT_RE.exec(rest);
      if (charset) { i += charset[0].length; continue; }
      const next = text[i + 1];
      if (next === "7") saved = { row, col };
      else if (next === "8") moveTo(saved.row, saved.col);
      i += next === undefined ? 1 : 2;
      continue;
    }
    i += 1;
    if (ch === "\r") { col = 0; continue; }
    if (ch === "\n") { moveTo(row + 1, 0); continue; }
    if (ch === "\b") { moveTo(row, col - 1); continue; }
    if (ch === "\t") { moveTo(row, (Math.floor(col / 8) + 1) * 8); continue; }
    if (ch < " " || ch === "\x7f") continue;
    if (col < MAX_RENDER_COLS) {
      const line = rows[row];
      while (line.length < col) line.push(" ");
      line[col] = ch;
      col += 1;
    }
  }
  return rows.map((line) => line.join("").trimEnd()).join("\n");
}
