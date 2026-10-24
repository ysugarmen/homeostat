import { describe, expect, test } from "vitest";
import {
  CREDIT_LABEL,
  PROMPT_GUIDE,
  parseCredits,
  sessionGuide,
  TRIGGER_MOMENTS,
} from "../src/guide.ts";
import { countTokens } from "../src/tokens.ts";

describe("sessionGuide", () => {
  const rules = new Map([
    ["billing", 36],
    ["core", 4],
  ]);
  const docs = new Map([["billing", 7]]);

  test("counts what was left out, names the tools, the moments and the credit line", () => {
    const g = sessionGuide({ rules, docs });
    expect(g).toMatch(/^# Looking things up \(homeostat\)/);
    expect(g).toContain("40 more team rules");
    expect(g).toContain("billing 36, core 4");
    expect(g).toContain("7 team documents");
    for (const tool of ["`context`", "`search`", "`docs`", "`read`", "`explain`"]) {
      expect(g).toContain(tool);
    }
    for (const moment of TRIGGER_MOMENTS) expect(g).toContain(moment);
    expect(g).toContain(`> ${CREDIT_LABEL} (`);
  });

  test("with nothing left out it still says how and when to look things up", () => {
    const g = sessionGuide({ rules: new Map(), docs: new Map() });
    expect(g).not.toContain("more team rule");
    expect(g).toContain("`search`");
  });

  test("the compact form keeps the counts and the prompt reminder, and is much shorter", () => {
    const full = sessionGuide({ rules, docs });
    const compact = sessionGuide({ rules, docs, compact: true });
    expect(compact).toContain("40 more team rules");
    expect(compact).toContain(PROMPT_GUIDE);
    expect(countTokens(compact)).toBeLessThan(countTokens(full) / 2);
  });

  test("the per-prompt reminder stays under 80 tokens and carries the credit line", () => {
    expect(countTokens(PROMPT_GUIDE)).toBeLessThan(80);
    expect(PROMPT_GUIDE).toContain(CREDIT_LABEL);
  });
});

describe("parseCredits", () => {
  test("reads the ids from each credit line, in the forms agents write it", () => {
    const reply = [
      "Fixing the retry.",
      "> From Homeostat (outbound-http-retry-helper, integrations/partner-calls#timeouts)",
      "More text.",
      "> **From Homeostat** (Redact-Before-Logging)",
      "  > From Homeostat (outbound-http-retry-helper)",
    ].join("\n");
    expect(parseCredits(reply)).toEqual({
      ids: [
        "outbound-http-retry-helper",
        "integrations/partner-calls#timeouts",
        "redact-before-logging",
      ],
      other: 0,
      lines: 3,
    });
  });

  test("counts anything that is not an id without keeping its text", () => {
    const r = parseCredits("> From Homeostat (the rule about retries, x)");
    expect(r.ids).toEqual(["x"]);
    expect(r.other).toBe(1);
  });

  test("mentions outside a credit line are not credits", () => {
    expect(parseCredits("I did not use anything From Homeostat (x) here.").lines).toBe(0);
  });
});
