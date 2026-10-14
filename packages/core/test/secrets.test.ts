import { describe, expect, test } from "vitest";
import { findEmails, redactSecrets, scanSecrets } from "../src/secrets.ts";

// Assembled at runtime so this file never contains a literal that a scanner would flag.
const j = (...parts: string[]) => parts.join("");

const SAMPLES: [string, string][] = [
  ["aws-access-key", j("AKIA", "IOSFODNN7", "EXAMPLE")],
  ["github-token", j("ghp_", "a".repeat(18), "B".repeat(18))],
  ["github-token", j("github_pat_", "11ABCDEFG0", "x".repeat(72))],
  ["anthropic-key", j("sk-ant-", "api03-", "Ab3".repeat(12))],
  ["openai-key", j("sk-", "proj-", "Zx9".repeat(12))],
  ["slack-token", j("xoxb-", "123456789012-", "1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx")],
  ["slack-token", j("xapp-", "1-A0123456789-", "1234567890123-", "abcdef0123456789")],
  ["stripe-key", j("sk_live_", "4eC39HqLyjWDarjtT1zdp7dc")],
  ["google-api-key", j("AIza", "SyD", "-", "a".repeat(31))],
  ["atlassian-token", j("ATATT3", "xFfGF0", "Q".repeat(40))],
  ["private-key", j("-----BEGIN ", "RSA PRIVATE KEY-----")],
  [
    "jwt",
    j(
      "eyJhbGciOiJIUzI1NiJ9",
      ".",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      ".",
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ),
  ],
  ["credentialed-url", j("postgres://", "admin:", "s3cretPassw0rd", "@db.internal:5432/app")],
  ["password-assignment", j("DB_PASSWORD", "=", "Tr0ub4dor&3xyz")],
];

describe("scanSecrets", () => {
  test.each(SAMPLES)("finds a %s", (kind, secret) => {
    const findings = scanSecrets(`config: ${secret} please rotate`);
    expect(findings.map((f) => f.kind)).toContain(kind);
  });

  test("finds unrecognised high-entropy strings", () => {
    const token = j(
      "Zq7",
      "Lm2",
      "Xv9",
      "Rt4",
      "Pw8",
      "Ny1",
      "Kc6",
      "Hd3",
      "Bs5",
      "Gf0",
      "Uj2",
      "Oe7",
    );
    expect(scanSecrets(`token ${token}`).map((f) => f.kind)).toEqual(["high-entropy"]);
  });

  test.each([
    ["a git SHA", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
    ["a UUID", "550e8400-e29b-41d4-a716-446655440000"],
    ["a long word", "internationalisation-considerations"],
    ["a path", "services/integrations/partner-availability-client.ts"],
    ["prose about secrets", "Never log the password or the API token in plain text."],
    ["a placeholder", "set ANTHROPIC_API_KEY=<your key>"],
  ])("does not flag %s", (_, text) => {
    expect(scanSecrets(text)).toEqual([]);
  });

  test("reports where each finding is, without echoing the secret", () => {
    const secret = j("ghp_", "c".repeat(36));
    const [f] = scanSecrets(`x ${secret} y`);
    expect(f?.start).toBe(2);
    expect(f?.end).toBe(2 + secret.length);
    expect(f?.preview).toBe("ghp_…");
  });
});

describe("redactSecrets", () => {
  test("replaces each secret with its kind and keeps the rest", () => {
    const secret = j("xoxb-", "123456789012-", "1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx");
    const { text, findings } = redactSecrets(`Use the bot token ${secret} for alerts.`);
    expect(text).toBe("Use the bot token [REDACTED:slack-token] for alerts.");
    expect(findings).toHaveLength(1);
  });

  test("leaves clean text alone", () => {
    expect(redactSecrets("Wrap calls in withRetry().")).toEqual({
      text: "Wrap calls in withRetry().",
      findings: [],
    });
  });
});

describe("findEmails", () => {
  test("finds email addresses but not decorators or handles", () => {
    expect(findEmails("ask dana@example.com, not @dana or @Injectable()")).toEqual([
      "dana@example.com",
    ]);
  });
});
