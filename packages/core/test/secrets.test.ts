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
  // Bitbucket repository, project and workspace access tokens.
  ["atlassian-token", j("ATCTT3", "xFfGN0", "Q".repeat(40))],
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
  // Ported from vectorize-io/hindsight's list (MIT); every sample is assembled at runtime.
  ["openai-key", j("sk-", "admin-", "Qw8".repeat(14))],
  ["github-token", j("ghs_", "Q".repeat(18), "r".repeat(18))],
  ["github-token", j("gho_", "Q".repeat(18), "r".repeat(18))],
  ["gitlab-token", j("glpat-", "Ab1".repeat(8))],
  ["npm-token", j("npm_", "Ab1".repeat(12))],
  ["pypi-token", j("pypi-", "AgEIcHlwaS5vcmc", "Ab1".repeat(10))],
  ["xai-key", j("xai-", "Ab1".repeat(15))],
  ["groq-key", j("gsk_", "Ab1".repeat(15))],
  ["huggingface-token", j("hf_", "Ab1".repeat(12))],
  ["replicate-token", j("r8_", "Ab1".repeat(12))],
  ["perplexity-key", j("pplx-", "Ab1".repeat(15))],
  ["databricks-token", j("dapi", "0a".repeat(16))],
  ["google-oauth-token", j("ya29", ".", "Ab1".repeat(10))],
  ["digitalocean-token", j("dop_", "v1_", "a0".repeat(32))],
  ["stripe-key", j("rk_", "live_", "Ab1".repeat(8))],
  ["square-token", j("sq0", "atp-", "Ab1".repeat(8))],
  ["braintree-token", j("access_token$", "production$", "ab12".repeat(4), "$", "0f".repeat(16))],
  [
    "slack-webhook",
    j("https://hooks.", "slack.com/services/", "T0123ABCD", "/B0123ABCD/", "Ab1".repeat(8)),
  ],
  ["twilio-key", j("SK", "0a".repeat(16))],
  ["sendgrid-key", j("SG", ".", "Ab1x".repeat(5), "Ab", ".", "Ab1x".repeat(10), "Abc")],
  ["mailgun-key", j("key-", "Ab1x".repeat(8))],
  ["discord-token", j("M", "Ab1".repeat(7), "Ab", ".", "Ab1Ab1", ".", "Ab1".repeat(9))],
  ["telegram-token", j("123456789", ":", "Ab1".repeat(11), "Ab")],
  ["shopify-token", j("shpat_", "0a".repeat(16))],
  ["credentialed-url", j("mongodb+srv://", "app:", "hunter22x", "@cluster0.example.net/db")],
  ["credentialed-url", j("mysql://", "root:", "pa55word", "@localhost:3306/app")],
  // A Luhn-valid Visa number made of many digits (not a well-known test number).
  ["card-number", j("4539", " 1488", " 0343", " 6467")],
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
    // From a real document: code that passes a credential along names it, it does not hold it.
    ["a value read from config", "username=config.username, password=config.password,"],
    ["a settings attribute", "api_key: settings.PARTNER_API_KEY"],
    // Rule and review text quotes code; none of this is a credential.
    ["a key-value phrase", "Use the key-value cache, not the session store."],
    ["a snake_case name", "Call npm_config_registry_override_for_ci() first."],
    ["an epoch in milliseconds", "Timestamps look like 1729771200000 in the API."],
    ["a UUID with digit groups", "id 12345678-1234-1234-1234-123456789012"],
    ["a payment test card", "Use 4242 4242 4242 4242 in the sandbox."],
    ["a Luhn-failing number", "order 4539 1488 0343 6468"],
    ["a version or decimal", "Pin 1234.5678.9012.3456 or 0.1234567890123"],
    ["a placeholder token", "set GITLAB_TOKEN to glpat-<token>"],
    ["a port list", "ports 8080 8081 8082 8083"],
    // An international phone number can pass Luhn and start like a card; the + says it is a phone.
    [
      "an international phone number",
      `For example, ${j("+4539", "1488", "0343", "6467")} reads as mobile.`,
    ],
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
