import { describe, expect, it } from "vitest";
import { RETIRED_MESSAGE, runConnect } from "../src/commands/connect.js";

describe("kyoube connect claude", () => {
  it("is retired: it points to the browser sign-in and changes nothing", async () => {
    const lines: string[] = [];
    expect(await runConnect(["claude"], { dir: "/x" }, {}, (line) => lines.push(line))).toBe(1);
    expect(lines).toEqual([RETIRED_MESSAGE]);
    expect(RETIRED_MESSAGE).toContain("paste the code Claude gives you back into the browser");
  });
});
