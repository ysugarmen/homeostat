/**
 * Flags text that would steer agents somewhere dangerous. Every merged rule reaches every session,
 * so a rule is a prompt: this is the check that a poisoned or careless one cannot slip through
 * (security plan T3). Findings block validation until a member signs the entry off, and a
 * flagged entry never auto-merges.
 */

export interface RiskFinding {
  kind:
    | "pipe-to-shell"
    | "unlisted-url"
    | "unlisted-host"
    | "credential-handling"
    | "disable-security"
    | "injection"
    | "destructive"
    | "hidden-characters"
    | "hidden-comment";
  /** What matched, trimmed, for the reviewer. */
  excerpt: string;
}

export const RISK_ADVICE: Record<RiskFinding["kind"], string> = {
  "pipe-to-shell": "runs downloaded code",
  "unlisted-url": "points agents at a domain not in security.allowedDomains",
  "unlisted-host":
    "names a host not in security.allowedDomains; internal hostnames should not reach agents",
  "credential-handling": "tells agents to move or reveal credentials",
  "disable-security": "tells agents to turn a security check off (fine if it says never to)",
  injection: "reads like a prompt injection",
  destructive: "runs a destructive command",
  "hidden-characters": "contains invisible or direction-changing characters",
  "hidden-comment": "hides text in an HTML comment",
};

const RULES: [RiskFinding["kind"], RegExp][] = [
  [
    "pipe-to-shell",
    /\b(?:curl|wget|iwr|irm|invoke-webrequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i,
  ],
  ["pipe-to-shell", /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/i],
  ["pipe-to-shell", /\biex\b[^\n]*\b(?:iwr|irm|invoke-webrequest|downloadstring)\b/i],
  [
    "credential-handling",
    /\b(?:send|post|upload|exfiltrat\w*|forward|share|paste|print|echo|output|log|include|email)\b[^.\n]{0,60}\b(?:env(?:ironment)?\s*var(?:iable)?s?|environment variables|\.env\b|secrets?|tokens?|credentials?|api[ _-]?keys?|ssh keys?|passwords?|cookies?)\b/i,
  ],
  [
    "disable-security",
    /\b(?:disable|turn off|switch off|skip|bypass|ignore)\b[^.\n]{0,40}\b(?:tls|ssl|certificates?|cert(?:ificate)? (?:checks?|verification)|authentication|authorization|auth|csrf|signatures?|signature (?:checks?|verification)|verification|sandbox(?:ing)?|security (?:checks?|scans?)|2fa|mfa)\b/i,
  ],
  [
    "disable-security",
    /\bverify\s*=\s*False\b|\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|\bInsecureSkipVerify\s*:\s*true\b|--no-verify-ssl\b/,
  ],
  [
    "injection",
    /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,20}\b(?:all|any|previous|prior|above|earlier|other)\b[^.\n]{0,20}\b(?:instructions|rules|guidance|prompts?|directions)\b/i,
  ],
  [
    "injection",
    /\b(?:do not|don't|never)\s+(?:tell|inform|show|mention (?:it )?to|alert)\s+(?:the\s+)?(?:user|developer|reviewer)\b/i,
  ],
  ["injection", /\b(?:system prompt|developer message|you are now|new instructions:)\b/i],
  ["destructive", /\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$HOME)(?:\s|$)/i],
  ["destructive", /\bchmod\s+(?:-R\s+)?777\b/],
  ["destructive", /\bgit\s+push\s+(?:--force|-f)\b[^\n]*\b(?:main|master)\b/],
  // Zero-width, bidi-override and BOM characters. Escaped so the source stays readable.
  [
    "hidden-characters",
    new RegExp("[\\u200B-\\u200F\\u2060\\uFEFF\\u202A-\\u202E\\u2066-\\u2069]"),
  ],
  ["hidden-comment", /<!--[\s\S]*?-->/],
];

const URL = /https?:\/\/([^\s/)>\]`'"]+)[^\s)>\]`'"]*/gi;

/** Hosts that point nowhere real: reserved for documentation and tests, loopback, or one label (an in-cluster or compose service name). */
const HARMLESS_HOST =
  /^(?:localhost|[^.]+|(?:[^.]+\.)*(?:example|test|invalid|localhost)|(?:[^.]+\.)*example\.(?:com|org|net)|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/;

const hostOf = (host: string) => host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

const allowed = (host: string, domains: readonly string[]) => {
  const h = hostOf(host);
  if (!/[a-z0-9]/.test(h) || HARMLESS_HOST.test(h)) return true;
  return domains.some((d) => h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`));
};

/**
 * Hostnames written without a scheme (`api.prod.acme.io`, `*.dev.acme.io`), on the TLDs internal
 * hosts usually use. Only drafted text is scanned for them: written text names hosts on purpose.
 */
const BARE_HOST =
  /(?<![\w@/.-])(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|io|ai|net|org|dev|app|cloud|co|internal|corp|lan|local)\b(?![\w-]|\.[a-z])/gi;

export function scanRisk(
  text: string,
  opts: { allowedDomains: readonly string[]; bareHosts?: boolean },
): RiskFinding[] {
  const found: RiskFinding[] = [];
  for (const [kind, re] of RULES) {
    const m = re.exec(text);
    if (m && !found.some((f) => f.kind === kind)) {
      found.push({ kind, excerpt: m[0].trim().slice(0, 80) });
    }
  }
  // One finding per host: a document listing ten URLs on one site needs one sign-off line.
  const seen = new Set<string>();
  for (const m of text.matchAll(URL)) {
    const host = hostOf(m[1] ?? "");
    if (seen.has(host) || allowed(host, opts.allowedDomains)) continue;
    seen.add(host);
    found.push({ kind: "unlisted-url", excerpt: m[0].replace(/[.,;:!?]+$/, "").slice(0, 80) });
  }
  if (opts.bareHosts) {
    // Template placeholders (`<slot>.dev.acme.io`, `{env}.acme.io`) stand in for a label.
    const plain = text.replace(URL, " ").replace(/<[^<>\s]{1,30}>|\{[^{}\s]{1,30}\}/g, "x");
    for (const m of plain.matchAll(BARE_HOST)) {
      const host = hostOf(m[0].replace(/^\*\./, ""));
      if (seen.has(host) || allowed(host, opts.allowedDomains)) continue;
      seen.add(host);
      found.push({ kind: "unlisted-host", excerpt: m[0] });
    }
  }
  return found;
}
