import { describe, expect, it } from "vitest";
import manifest, { APPS_SKILL_KEY } from "../../src/manifest.js";

describe("kyoube-apps skill for downloads", () => {
  const apps = manifest.skills!.find((skill) => skill.skillKey === APPS_SKILL_KEY)!.markdown;

  it("teaches the call, where to make it, the limits and the refusals", () => {
    for (const phrase of [
      "## Saving files", "kyoube.ui.download(", "from the click handler", "25 MB", "declined", "don't retry",
      "csv, tsv, txt, json, md, xlsx, docx, pptx, pdf, png, jpg/jpeg, zip", "3 downloads per 10 seconds",
      "Don't build `<a download>` links",
    ]) {
      expect(apps).toContain(phrase);
    }
  });
});
