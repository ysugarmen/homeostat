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

const PATTERNS: [kind: string, re: RegExp][] = [
  ["private-key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-\d-[A-Za-z0-9-]{10,}/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["atlassian-token", /\b(?:ATATT3|ATCTT3|ATBB)[A-Za-z0-9_=-]{24,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["credentialed-url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@[^\s]+/gi],
  [
    "password-assignment",
    /\b[A-Za-z_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)[A-Za-z_]*\s*[:=]\s*["']?(?![<{$])[^\s"'<>]{8,}/gi,
  ],
];

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

export function scanSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  const covered = (start: number, end: number) => found.some((f) => start < f.end && end > f.start);
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (!covered(start, end)) found.push({ kind, start, end, preview: preview(m[0]) });
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
