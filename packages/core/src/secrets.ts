/**
 * Secret detection on the CPU, for everything Homeostat is about to send to a model or commit:
 * review threads before drafting, entries in `validate`, and learn/flag/handoff text. Known token
 * formats first, then a high-entropy check for anything unrecognised.
 */

export interface SecretFinding {
  kind: string;
  start: number;
  end: number;
  /** A safe hint: the first few characters, never the secret. */
  preview: string;
}

// Token formats with a fixed prefix, so a match is almost never anything else. The AI-provider,
// code-host, package-registry, payment, messaging and commerce formats follow the list in
// vectorize-io/hindsight's memory_defense.py (adapted from vectorize-io/hindsight, MIT), with
// lengths kept at or above theirs. Order matters: the first pattern to cover a span names it.
const PATTERNS: [kind: string, re: RegExp][] = [
  ["private-key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36,}\b/g],
  ["pypi-token", /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ["xai-key", /\bxai-[A-Za-z0-9]{40,}\b/g],
  ["groq-key", /\bgsk_[A-Za-z0-9]{40,}\b/g],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["replicate-token", /\br8_[A-Za-z0-9]{30,}\b/g],
  ["perplexity-key", /\bpplx-[A-Za-z0-9]{40,}\b/g],
  ["databricks-token", /\bdapi[a-f0-9]{32}(?:-\d)?\b/g],
  ["google-oauth-token", /\bya29\.[0-9A-Za-z_-]{20,}/g],
  ["digitalocean-token", /\bdo[opr]_v1_[a-f0-9]{64}\b/g],
  [
    "slack-webhook",
    /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]{8,}\/B[A-Za-z0-9_]{8,}\/[A-Za-z0-9_]{20,}/g,
  ],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-\d-[A-Za-z0-9-]{10,}/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/g],
  ["square-token", /\bsq0[a-z]{3}-[A-Za-z0-9_-]{22,}/g],
  ["braintree-token", /\baccess_token\$production\$[a-z0-9]{16}\$[a-f0-9]{32}/g],
  ["twilio-key", /\bSK[0-9a-fA-F]{32}\b/g],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g],
  ["mailgun-key", /\bkey-[A-Za-z0-9]{32}\b/g],
  [
    "discord-token",
    /\b[MNO][A-Za-z0-9]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}(?![A-Za-z0-9_-])/g,
  ],
  ["telegram-token", /(?<![\w:])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g],
  ["shopify-token", /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["atlassian-token", /\b(?:ATATT3|ATCTT3|ATBB)[A-Za-z0-9_=-]{24,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  // Database URLs (postgres, mysql, mongodb+srv, redis, …) and any other URL with a password.
  ["credentialed-url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@[^\s]+/gi],
  [
    "password-assignment",
    /\b[A-Za-z_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)[A-Za-z_]*\s*[:=]\s*["']?(?![<{$])[^\s"'<>]{8,}/gi,
  ],
];

/**
 * Payment card numbers: 13 to 19 digits, optionally grouped by spaces or dashes, that pass the
 * Luhn check and start like a real card (Visa, Mastercard, Amex, Discover, JCB, Diners). Digits
 * inside a longer run, a decimal, a UUID or a dashed id are not candidates, and the test numbers
 * payment docs quote (4242…, 4111…: three distinct digits or fewer) are left alone.
 */
const CARD = /(?<![\w.-])\d{4}(?:[ -]?\d{2,4}){2,4}(?![\w-]|\.\d)/g;
const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5)|35|3(?:0[0-5]|[68]))/;
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
function looksLikeCard(match: string): boolean {
  const digits = match.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  if (new Set(digits).size <= 3) return false;
  return CARD_PREFIX.test(digits) && luhn(digits);
}

/** Shannon entropy in bits per character. Hex tops out at 4; real keys sit well above it. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long runs that look random: mixed case and digits, entropy above hex, not a path or word. */
const CANDIDATE = /[A-Za-z0-9+/_=-]{32,}/g;
function looksRandom(s: string): boolean {
  if (/^[0-9a-f-]+$/i.test(s)) return false; // hex: SHAs, UUIDs, hashes
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/[0-9]/.test(s)) return false;
  return entropy(s) > 4.2;
}

const preview = (s: string) => `${s.slice(0, Math.min(4, Math.floor(s.length / 4)))}…`;

/** `password=config.password`: the value is a dotted name in code, which holds no secret. */
function namesAValue(match: string): boolean {
  const value = match.replace(/^[^:=]*[:=]\s*["']?/, "");
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+[,;)]*$/.test(value);
}

export function scanSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  const covered = (start: number, end: number) => found.some((f) => start < f.end && end > f.start);
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (kind === "password-assignment" && namesAValue(m[0])) continue;
      if (!covered(start, end)) found.push({ kind, start, end, preview: preview(m[0]) });
    }
  }
  for (const m of text.matchAll(CARD)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (!covered(start, end) && looksLikeCard(m[0])) {
      found.push({ kind: "card-number", start, end, preview: "card…" });
    }
  }
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (!covered(start, end) && looksRandom(m[0])) {
      found.push({ kind: "high-entropy", start, end, preview: preview(m[0]) });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Replaces every finding with `[REDACTED:kind]`. */
export function redactSecrets(text: string): { text: string; findings: SecretFinding[] } {
  const findings = scanSecrets(text);
  let out = text;
  for (const f of [...findings].reverse()) {
    out = `${out.slice(0, f.start)}[REDACTED:${f.kind}]${out.slice(f.end)}`;
  }
  return { text: out, findings };
}

/** Email addresses, for PII warnings on entries (member ids belong there, not emails). */
export function findEmails(text: string): string[] {
  return [
    ...text.matchAll(
      /(?<![\w@])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    ),
  ].map((m) => m[0]);
}
