import { describe, expect, it } from "vitest";
import { cleanDownloadName, DOWNLOAD_TYPES, MAX_DOWNLOAD_NAME } from "../../src/ui/apps/download-rules.js";

const ok = (raw: unknown) => {
  const result = cleanDownloadName(raw);
  if (!result.ok) throw new Error(`refused: ${result.message}`);
  return result;
};

describe("cleanDownloadName", () => {
  it("maps every allowed extension to its type, case-insensitively", () => {
    expect([...DOWNLOAD_TYPES.keys()].sort()).toEqual(["csv", "docx", "jpeg", "jpg", "json", "md", "pdf", "png", "pptx", "tsv", "txt", "xlsx", "xml", "zip"]);
    expect(ok("Report.XLSX")).toEqual({ ok: true, filename: "Report.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(ok("a.csv").mime).toBe("text/csv");
    expect(ok("a.jpg").mime).toBe("image/jpeg");
    expect(ok("a.jpeg").mime).toBe("image/jpeg");
    expect(ok("a.zip").mime).toBe("application/zip");
  });

  it("refuses types outside the allowlist, and names without one", () => {
    for (const raw of ["x.html", "x.htm", "x.svg", "x.xhtml", "x.exe", "x.bat", "x.sh", "x.js", "x.xlsm", "x.docm", "x.pptm", "report", "report.", "x.pdf.exe"]) {
      const result = cleanDownloadName(raw);
      expect(result.ok, raw).toBe(false);
    }
    const refused = cleanDownloadName("x.exe");
    expect(refused.ok === false && refused.message).toContain("csv, tsv, txt");
  });

  it("refuses a name that is not a string, is empty, or is over 255 units", () => {
    for (const raw of [undefined, null, 5, {}, "", "a".repeat(252) + ".csv"]) expect(cleanDownloadName(raw).ok).toBe(false);
    expect(cleanDownloadName("a".repeat(251) + ".csv").ok).toBe(true);
  });

  it("strips separators, reserved characters, control and format characters", () => {
    expect(ok("../../etc/passwd.txt").filename).toBe("etcpasswd.txt");
    expect(ok("C:\\Users\\x\\a.csv").filename).toBe("CUsersxa.csv");
    expect(ok('a*b?c"d<e>f|g:h.csv').filename).toBe("abcdefgh.csv");
    expect(ok("line\nbreak\t.csv").filename).toBe("linebreak.csv");
    // U+202E RIGHT-TO-LEFT OVERRIDE would make "invoice\u202Efdp.exe" read as "invoiceexe.pdf".
    expect(cleanDownloadName("invoice\u202Efdp.exe").ok).toBe(false);
    expect(ok("in\u202Evoice\u200B.pdf").filename).toBe("invoice.pdf");
  });

  it("collapses whitespace and trims spaces and dots at both ends", () => {
    expect(ok("  my    report  .csv").filename).toBe("my report.csv");
    expect(ok("...hidden.csv").filename).toBe("hidden.csv");
    expect(ok("report.xlsx...").filename).toBe("report.xlsx");
    expect(ok("report . .xlsx").filename).toBe("report.xlsx");
    expect(cleanDownloadName(".xlsx").ok).toBe(false);
    expect(cleanDownloadName(" . .csv").ok).toBe(false);
  });

  it("prefixes Windows device names", () => {
    expect(ok("CON.txt").filename).toBe("_CON.txt");
    expect(ok("nul.csv").filename).toBe("_nul.csv");
    expect(ok("com1.xlsx").filename).toBe("_com1.xlsx");
    expect(ok("lpt9.tar.zip").filename).toBe("_lpt9.tar.zip");
    expect(ok("console.txt").filename).toBe("console.txt");
  });

  it("cuts the stem so the whole name is at most 120 characters, keeping the extension", () => {
    const name = ok("b".repeat(200) + ".xlsx").filename;
    expect(name).toHaveLength(MAX_DOWNLOAD_NAME);
    expect(name.endsWith(".xlsx")).toBe(true);
    expect(ok("a".repeat(115) + ".xlsx").filename).toHaveLength(120);
  });

  it("keeps non-Latin names and never splits a surrogate pair", () => {
    expect(ok("図面 19-462810.xlsx").filename).toBe("図面 19-462810.xlsx");
    // NFC: "e" + combining acute becomes one "é".
    expect(ok("re\u0301sume\u0301.pdf").filename).toBe("résumé.pdf");
    // 115 + 4 + 4 units: the cut at 116 lands between the first emoji's two halves.
    const emoji = ok("a".repeat(115) + "😀😀.csv").filename;
    expect(emoji).toBe("a".repeat(115) + ".csv");
    expect(emoji.length).toBeLessThanOrEqual(MAX_DOWNLOAD_NAME);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji)).toBe(false);
  });
});
