import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Expands one `dir/prefix-*.ext` style glob (a single `*`, in the basename only) under `root`. */
export async function expandGlob(root, glob) {
  const dir = path.dirname(glob);
  const base = path.basename(glob);
  const star = base.indexOf("*");
  if (star === -1) return [path.join(root, glob)];
  const prefix = base.slice(0, star);
  const suffix = base.slice(star + 1);
  let names;
  try {
    names = await readdir(path.join(root, dir));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && name.length >= prefix.length + suffix.length)
    .sort()
    .map((name) => path.join(root, dir, name));
}

/**
 * Applies one patch to one text and reports how many times it matched. The
 * decision about that count belongs to the caller: `applyPatches` compares
 * the total across files with `patch.expect`.
 */
export function applyToText(text, patch) {
  let count = 0;
  const out = text.replace(patch.pattern, (...args) => {
    count += 1;
    // Rebuild `$n` references by hand so a replacement string works the same
    // through this counting wrapper as it would passed to `replace` directly.
    const groups = args.slice(1, -2);
    return patch.replacement.replace(/\$(\d+)/g, (_, n) => groups[Number(n) - 1] ?? "");
  });
  return { text: out, count };
}

/** How many times `pattern` matches `text` (counted globally, whatever the pattern's own flags). */
export function countMatches(text, pattern) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return [...text.matchAll(global)].length;
}

/**
 * Applies every patch under `root`. Returns a report; throws when a patch did
 * not match exactly `expect` times — the build must stop, not ship a core
 * with a fix silently missing (0) or applied somewhere it was not meant for (>expect).
 * The one exception: a patch whose pattern matches nothing while its
 * `upstreamFix` pattern matches exactly once is skipped (`skipped:
 * "already fixed upstream"` in the report), because the core carries the fix.
 */
export async function applyPatches(root, patches, { dryRun = false } = {}) {
  const report = [];
  // A dry run keeps what each patch would have written, so the patches after it
  // match the same text they would in a real run (some build on another's output).
  const unwritten = new Map();
  for (const patch of patches) {
    const files = (await Promise.all(patch.files.map((glob) => expandGlob(root, glob)))).flat();
    let total = 0;
    let fixed = 0;
    const touched = [];
    const pending = [];
    for (const file of files) {
      const before = unwritten.get(file) ?? (await readFile(file, "utf8"));
      const { text, count } = applyToText(before, patch);
      if (patch.upstreamFix) fixed += countMatches(before, patch.upstreamFix);
      if (count === 0) continue;
      total += count;
      touched.push(path.relative(root, file));
      pending.push({ file, text });
    }
    if (total === 0 && patch.upstreamFix && fixed === 1) {
      report.push({ id: patch.id, matched: 0, expect: patch.expect, files: [], skipped: "already fixed upstream" });
      continue;
    }
    report.push({ id: patch.id, matched: total, expect: patch.expect, files: touched });
    if (total !== patch.expect) {
      throw new Error(
        `core patch "${patch.id}" matched ${total} time(s) in ${files.length} candidate file(s), expected ${patch.expect}` +
          (patch.upstreamFix ? ` (its upstream fix matched ${fixed} time(s), and only exactly 1 skips it)` : "") +
          (patch.standing
            ? `. This is a standing KyoubeAI patch (${patch.standing}): redo it for this core; never delete it.`
            : `. Either the core release changed this code (redo the patch) or it now carries the upstream fix (delete the patch): ${patch.upstream}`),
      );
    }
    for (const { file, text } of pending) {
      if (dryRun) unwritten.set(file, text);
      else await writeFile(file, text);
    }
  }
  return report;
}

/**
 * Explains a build on a different core than the patches are written for. The
 * usual cause is a `.env` left over from an earlier release: it pins
 * KYOUBE_CORE_VERSION, and `git pull` never updates `.env`, so the new
 * release's patches meet the old core and match nothing. Returns null when the
 * cores agree or the build did not say which core it uses.
 */
export function coreVersionHint(buildCore, patchedCore) {
  if (!buildCore || buildCore === patchedCore) return null;
  return (
    `this build uses core ${buildCore}, but this KyoubeAI release is made for core ${patchedCore}. ` +
    `If you did not mean to change the core, KYOUBE_CORE_VERSION (or the older PAPERCLIP_VERSION) in your .env ` +
    `is left over from an earlier release, and git pull does not update .env: set it to ${patchedCore}, ` +
    `or delete the line to follow the release's pin, then build again.`
  );
}
