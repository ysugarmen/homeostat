/**
 * A synthetic two-repo knowledge base of about 150 rules and 35 selection cases, generated
 * deterministically, for the selection eval. Signal rules are written by hand; each area also
 * gets filler rules with the same scope and vocabulary, so ranking has to tell the rule about
 * the touched file from the many that merely apply to its folder.
 */
import { type Entry, formatEntry, parseEntry } from "../src/entry.ts";
import type { Frontmatter } from "../src/schema.ts";
import type { EvalCase } from "../src/selection-eval.ts";
import { countTokens } from "../src/tokens.ts";

interface Spec {
  id: string;
  title: string;
  rule: string;
  why: string;
  score: number;
  scope?: string[];
  status?: Frontmatter["status"];
  kind?: Frontmatter["kind"];
  adopted?: boolean;
  confirmed?: string;
  also?: number;
}

interface Area {
  repo: "api" | "web" | undefined;
  area: string;
  scope: string[];
  signal: Spec[];
  /** Nouns the filler rules are about. */
  nouns: string[];
}

const AREAS: Area[] = [
  {
    repo: "api",
    area: "billing",
    scope: ["services/billing/**"],
    nouns: [
      "invoice line",
      "payment intent",
      "credit note",
      "discount code",
      "billing address",
      "payout report",
      "chargeback",
      "subscription plan",
      "proration",
      "receipt",
      "billing cycle",
      "usage record",
      "price table",
      "coupon",
    ],
    signal: [
      {
        id: "billing-money-in-cents",
        title: "Keep money as integer cents",
        rule: "Represent every amount as integer cents in a `Money` value. Never keep currency in a float or a decimal string.",
        why: "Floats lost a cent on split payments and the monthly reconciliation failed.",
        score: 5,
      },
      {
        id: "billing-invoice-total-helper",
        title: "Compute invoice totals with the shared helper",
        rule: "Call `formatInvoiceTotal()` from `services/billing/totals.ts` for every invoice total. Do not add up line items by hand.",
        why: "Hand-written sums skipped discounts and credit notes twice last quarter.",
        score: 2,
        scope: ["services/**"],
      },
      {
        id: "billing-tax-per-line",
        title: "Round tax per line item, not per invoice",
        rule: "Apply `applyTaxRounding()` from `tax.ts` to each line before summing.",
        why: "Rounding the whole invoice disagreed with the tax authority by a cent.",
        score: 3,
      },
      {
        id: "billing-refund-idempotency",
        title: "Send an idempotency key with every refund",
        rule: "Pass the order id plus the attempt number as the payment provider's idempotency key when creating a refund.",
        why: "A retried request without a key refunded a customer twice.",
        score: 4,
        scope: ["services/billing/refunds/**"],
      },
      {
        id: "billing-currency-enum",
        title: "Use the Currency enum for currency codes",
        rule: "Take currency codes from the `Currency` enum. Do not pass raw strings such as 'usd'.",
        why: "Lowercase codes were rejected by the provider in production.",
        score: 3,
      },
      {
        id: "billing-gift-card-partial",
        title: "Refund gift card payments to the card balance",
        rule: "A partial refund of a gift card payment credits the card through `creditGiftCard()`; it never goes back to a bank card.",
        why: "Support paid out gift card balances as cash by mistake.",
        score: 2,
        scope: ["services/billing/refunds/**"],
      },
    ],
  },
  {
    repo: "api",
    area: "orders",
    scope: ["services/orders/**"],
    nouns: [
      "order item",
      "shipment",
      "fulfilment step",
      "order note",
      "return label",
      "pick list",
      "order search",
      "delivery slot",
      "order total",
      "warehouse code",
      "backorder",
      "order history",
      "packing slip",
      "carrier rate",
    ],
    signal: [
      {
        id: "orders-transition-helper",
        title: "Change order status only through transitionOrder",
        rule: "Call `transitionOrder()` in `services/orders/state.ts` to change an order's status. Never write the status column directly.",
        why: "Direct writes skipped the audit event and the customer email.",
        score: 5,
      },
      {
        id: "orders-ledger-append-only",
        title: "Treat the order ledger as append-only",
        rule: "Add correcting rows to the ledger in `ledger.ts`; never update or delete a ledger row.",
        why: "An update erased the history finance needed for an audit.",
        score: 3,
      },
      {
        id: "orders-cancel-window",
        title: "Check the cancellation window before cancelling",
        rule: "Call `canCancel()` before any cancel path; the window closes 30 minutes after payment.",
        why: "Orders were cancelled after the warehouse had shipped them.",
        score: 4,
      },
      {
        id: "orders-event-names",
        title: "Name order events in the past tense",
        rule: "Event names are past-tense verbs such as `OrderShipped` or `OrderCancelled`.",
        why: "Consumers could not tell commands from facts.",
        score: 2,
      },
      {
        id: "orders-export-csv",
        title: "Stream large order exports",
        rule: "Write CSV exports with `streamRows()`; never build the whole file before sending it.",
        why: "A year-end export of two million rows ran the worker out of memory.",
        score: 1,
        scope: ["services/orders/export/**"],
      },
    ],
  },
  {
    repo: "api",
    area: "notifications",
    scope: ["services/notifications/**"],
    nouns: [
      "email subject",
      "sms body",
      "push token",
      "message queue",
      "sender address",
      "bounce report",
      "digest email",
      "notification preference",
      "delivery receipt",
      "locale file",
      "message id",
      "provider callback",
    ],
    signal: [
      {
        id: "notify-webhook-retry",
        title: "Retry webhook deliveries with exponential backoff",
        rule: "Schedule redelivery through `scheduleRetry()`; give up after eight attempts and park the event.",
        why: "Tight loops hammered partners that were already down.",
        score: 4,
      },
      {
        id: "notify-template-escaping",
        title: "Escape user content in email templates",
        rule: "Use double braces in Mustache. Triple braces skip escaping and let a customer's name inject markup.",
        why: "A display name with a script tag reached a staff inbox.",
        score: 3,
        scope: ["services/notifications/templates/**"],
      },
      {
        id: "notify-quiet-hours",
        title: "Respect quiet hours for SMS",
        rule: "Check `inQuietHours()` with the recipient's time zone before sending an SMS.",
        why: "Customers were texted at three in the morning.",
        score: 2,
      },
      {
        id: "notify-unsubscribe-link",
        title: "Include an unsubscribe link in marketing email",
        rule: "Every marketing email carries the one-click unsubscribe header and a visible link.",
        why: "Mailbox providers started marking the newsletter as spam.",
        score: 3,
      },
      {
        id: "notify-provider-timeouts",
        title: "Set a five-second timeout on provider calls",
        rule: "Pass `timeoutMs: 5000` to the mail and SMS provider clients.",
        why: "A hung provider call blocked the whole queue.",
        score: 2,
      },
    ],
  },
  {
    repo: "api",
    area: "storage",
    scope: ["db/**"],
    nouns: [
      "column name",
      "foreign key",
      "enum type",
      "query plan",
      "connection pool",
      "read replica",
      "table comment",
      "default value",
      "partition",
      "row lock",
    ],
    signal: [
      {
        id: "storage-migrations-reversible",
        title: "Write reversible migrations",
        rule: "Every migration has a down step that restores the previous schema.",
        why: "A bad deploy could not be rolled back without a manual restore.",
        score: 4,
        scope: ["db/migrations/**"],
      },
      {
        id: "storage-migrations-reversible-seeds",
        title: "Write reversible migrations for seed data",
        rule: "Seed files delete exactly the rows they insert in their down step.",
        why: "Rolling back left orphaned region rows behind.",
        score: 2,
        scope: ["db/seeds/**"],
      },
      {
        id: "storage-transactions-helper",
        title: "Wrap multi-row writes in withTransaction",
        rule: "Use `withTransaction()` from `lib/db/tx.ts` whenever a repository writes more than one row.",
        why: "Half-written invoices appeared after a crash.",
        score: 3,
        scope: ["services/**/repo/**"],
      },
      {
        id: "storage-no-select-star",
        title: "Name columns instead of selecting everything",
        rule: "List the columns a repository query needs. Do not use `SELECT *`.",
        why: "Adding a large column slowed every list endpoint.",
        score: 2,
        scope: ["services/**/repo/**"],
      },
      {
        id: "storage-index-concurrently",
        title: "Create indexes concurrently",
        rule: "Use `CREATE INDEX CONCURRENTLY` in migrations on tables with more than a million rows.",
        why: "A plain index build locked the orders table for twelve minutes.",
        score: 3,
        scope: ["db/migrations/**"],
      },
    ],
  },
  {
    repo: "web",
    area: "checkout",
    scope: ["apps/web/src/checkout/**"],
    nouns: [
      "cart line",
      "shipping option",
      "promo field",
      "order summary",
      "payment form",
      "step indicator",
      "guest checkout",
      "delivery note",
      "basket badge",
      "terms checkbox",
      "error banner",
      "confirmation page",
    ],
    signal: [
      {
        id: "checkout-price-display",
        title: "Format prices with formatPrice",
        rule: "Render every price through `formatPrice()` from `packages/ui/src/money.tsx`; it handles locale and currency.",
        why: "Hand-formatted prices showed the wrong decimal separator in Germany.",
        score: 4,
      },
      {
        id: "checkout-submit-once",
        title: "Disable the pay button while a payment is in flight",
        rule: "Set the pay button to disabled from the first click until the payment request settles.",
        why: "Double clicks created two charges.",
        score: 3,
      },
      {
        id: "checkout-address-autocomplete",
        title: "Debounce address autocomplete requests",
        rule: "Wait 300 ms after the last keystroke before calling the address lookup.",
        why: "Every keystroke cost a paid lookup.",
        score: 2,
      },
      {
        id: "checkout-webhook-retry",
        title: "Retry webhook deliveries with exponential backoff",
        rule: "Payment provider webhooks are retried by answering 503; never retry from the browser.",
        why: "Browser retries duplicated order confirmations.",
        score: 2,
        scope: ["apps/web/src/api/webhooks/**"],
      },
      {
        id: "checkout-3ds-redirect",
        title: "Handle the 3-D Secure redirect in its own route",
        rule: "Return from 3-D Secure to `/checkout/verify`, which resumes the stored cart.",
        why: "The redirect lost the cart when it landed on the summary page.",
        score: 3,
      },
    ],
  },
  {
    repo: "web",
    area: "catalog",
    scope: ["apps/web/src/catalog/**"],
    nouns: [
      "product card",
      "category page",
      "filter panel",
      "sort menu",
      "product title",
      "breadcrumb",
      "review stars",
      "size chart",
      "wishlist button",
      "recently viewed",
    ],
    signal: [
      {
        id: "catalog-image-sizes",
        title: "Request product images at the rendered size",
        rule: "Pass the rendered `width` to `productImageUrl()`; never load the original upload.",
        why: "Category pages downloaded forty megabytes on mobile.",
        score: 3,
      },
      {
        id: "catalog-search-debounce",
        title: "Debounce catalog search input",
        rule: "Wait 250 ms after typing stops before querying the search service.",
        why: "The search service was rate limiting real users.",
        score: 2,
      },
      {
        id: "catalog-pagination-cursor",
        title: "Paginate the catalog with cursors",
        rule: "Use the `after` cursor returned by `listProducts()`; never page numbers.",
        why: "Page numbers skipped products when the catalog changed between requests.",
        score: 4,
      },
      {
        id: "catalog-stock-badge",
        title: "Show stock badges from the availability field",
        rule: "Read stock state from `availability`, not from the quantity number.",
        why: "Quantities are cached and lag behind the warehouse.",
        score: 1,
      },
    ],
  },
  {
    repo: "web",
    area: "ui",
    scope: ["packages/ui/**"],
    nouns: [
      "button variant",
      "modal",
      "tooltip",
      "icon set",
      "form field",
      "spacing scale",
      "dark theme",
      "focus ring",
      "table component",
      "toast",
    ],
    signal: [
      {
        id: "ui-design-tokens",
        title: "Use design tokens for colours",
        rule: "Take colours and spacing from `tokens.ts`; no hex values in components.",
        why: "A rebrand needed changes in four hundred places.",
        score: 5,
      },
      {
        id: "ui-a11y-labels",
        title: "Give icon buttons an accessible label",
        rule: "Every icon-only button sets `aria-label`.",
        why: "Screen reader users heard only 'button'.",
        score: 4,
        scope: ["packages/ui/**/*.tsx"],
      },
      {
        id: "ui-storybook-story",
        title: "Add a story for every new component",
        rule: "Each new component ships with a story covering its states.",
        why: "Designers review components in the story book, not in the app.",
        score: 3,
      },
      {
        id: "ui-no-default-exports",
        title: "Export components by name",
        rule: "Use named exports for components; no default exports.",
        why: "Default exports were imported under three different names.",
        score: 2,
      },
      {
        id: "ui-money-component",
        title: "Keep formatPrice locale-aware",
        rule: "`formatPrice()` takes the locale from the request context; never hard-code one.",
        why: "Prices rendered in US format for every visitor.",
        score: 2,
        scope: ["packages/ui/src/money.tsx"],
      },
    ],
  },
  {
    repo: "web",
    area: "accounts",
    scope: ["apps/web/src/accounts/**"],
    nouns: [
      "profile page",
      "avatar upload",
      "login form",
      "address book",
      "order list",
      "two-factor prompt",
      "consent toggle",
      "account menu",
    ],
    signal: [
      {
        id: "accounts-session-cookie",
        title: "Read the session only from the httpOnly cookie",
        rule: "Session state comes from the httpOnly cookie; never store the session token in local storage.",
        why: "A third-party script could read tokens from local storage.",
        score: 5,
      },
      {
        id: "accounts-password-rules",
        title: "Validate passwords with the shared policy",
        rule: "Call `checkPassword()` from `packages/auth/policy.ts` on the client and the server.",
        why: "The client accepted passwords the server then rejected.",
        score: 3,
      },
      {
        id: "accounts-delete-flow",
        title: "Soft-delete accounts for thirty days",
        rule: "Mark an account deleted and purge it after thirty days.",
        why: "Customers asked to restore accounts deleted by mistake.",
        score: 2,
      },
      {
        id: "accounts-email-change",
        title: "Confirm email changes on the new address",
        rule: "Send the confirmation link to the new address before switching.",
        why: "A typo locked a customer out of their account.",
        score: 3,
      },
    ],
  },
  {
    repo: undefined,
    area: "core",
    scope: ["**"],
    nouns: [
      "pull request description",
      "error message",
      "code comment",
      "readme",
      "environment variable",
      "config key",
      "todo note",
      "changelog line",
    ],
    signal: [
      {
        id: "core-structured-logging",
        title: "Log with the structured logger",
        rule: "Log events as fields with `log.info({ ... })`; no string concatenation.",
        why: "On-call could not filter concatenated log lines.",
        score: 5,
      },
      {
        id: "core-no-secrets-in-logs",
        title: "Never log tokens or passwords",
        rule: "Redact credentials before logging any request or response.",
        why: "An access token sat in the log archive for a year.",
        score: 6,
      },
      {
        id: "core-conventional-commits",
        title: "Write commit messages in conventional style",
        rule: "Start commit subjects with a type such as feat, fix or chore.",
        why: "The release notes are generated from commit subjects.",
        score: 3,
      },
      {
        id: "core-feature-flags",
        title: "Put unfinished work behind a feature flag",
        rule: "Merge unfinished features behind a flag that is off by default.",
        why: "Half-built screens reached customers twice.",
        score: 3,
      },
      {
        id: "core-ledger-replica",
        title: "Read the ledger from the replica",
        rule: "Read queries in `services/orders/ledger.ts` go through `replicaPool`, never the primary.",
        why: "Ledger reports overloaded the primary at month end.",
        score: 1,
      },
      {
        id: "core-tx-helper-owner",
        title: "Keep withTransaction the only way to open a transaction",
        rule: "Only `lib/db/tx.ts` may call `pool.begin()`; everything else uses its helper.",
        why: "A transaction opened elsewhere was never committed.",
        score: 2,
      },
      {
        id: "core-dependency-pinning",
        title: "Pin dependency versions",
        rule: "Pin exact versions in `package.json`; no ranges.",
        why: "A minor release of a date library broke billing overnight.",
        score: 2,
      },
      {
        id: "core-api-errors",
        title: "Return errors in the problem+json shape",
        rule: "Build error responses with `problem()` from `lib/http/errors.ts`.",
        why: "Clients had to parse four error formats.",
        score: 3,
      },
      {
        id: "core-timezones",
        title: "Store times in UTC",
        rule: "Persist timestamps in UTC and convert only for display.",
        why: "Daylight saving moved scheduled jobs by an hour.",
        score: 4,
      },
      {
        id: "core-ci-cache",
        title: "Cache dependencies in CI workflows",
        rule: "Restore the package store from the cache before installing.",
        why: "Every pipeline spent four minutes downloading the same packages.",
        score: 2,
        scope: [".github/**"],
      },
      {
        id: "core-test-factories",
        title: "Build test data with factories",
        rule: "Create records with the factories in `test/factories.ts`; do not inline JSON fixtures.",
        why: "Inline fixtures went stale whenever a column was added.",
        score: 3,
        scope: ["**/*.test.ts"],
      },
      {
        id: "core-graphql-public-api",
        title: "Adopt GraphQL for the public API",
        rule: "Expose the public API through GraphQL.",
        why: "Discussed and rejected: partners asked for plain REST.",
        score: 1,
        kind: "decision",
        adopted: false,
      },
      {
        id: "core-draft-retry-everything",
        title: "Retry every failed request",
        rule: "Wrap every outbound request in a retry.",
        why: "A candidate nobody has reviewed.",
        score: 0,
        status: "candidate",
      },
    ],
  },
];

const VERBS = ["Validate", "Log", "Cache", "Document", "Test", "Version", "Audit", "Name"];
const ACTIONS = [
  "validate it at the boundary with the shared schema",
  "keep the handler small and move the logic into a service function",
  "add a unit test that covers the empty case",
  "log one structured event with its id",
  "keep field names in snake_case in the database",
  "document the edge cases in a short comment",
  "keep the old field readable for one release",
];
const FILLERS: Record<string, number> = {
  billing: 14,
  orders: 14,
  notifications: 12,
  storage: 10,
  checkout: 12,
  catalog: 10,
  ui: 10,
  accounts: 8,
  core: 8,
};

/** A small seeded generator, so every run builds the same KB. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const pick = <T>(xs: readonly T[], r: () => number) => xs[Math.floor(r() * xs.length)] as T;

export interface FixtureRule {
  /** KB-relative path, as the loader sees it. */
  path: string;
  entry: Entry;
  /** The file's text. */
  text: string;
}

/** A short example, so rules are the size real ones are and the budget binds. */
function example(spec: Spec): string {
  const name = /`([A-Za-z]\w*)\(/.exec(spec.rule)?.[1] ?? "sharedHelper";
  return [
    "```ts",
    "// wrong",
    `const result = await handRolled(input, { retries: 3, strict: false });`,
    "// right",
    `const result = await ${name}(input);`,
    "```",
  ].join("\n");
}

function build(area: Area, spec: Spec, r: () => number): FixtureRule {
  const body = `## Rule\n${spec.rule}\n\n## Why\n${spec.why} It came up in review more than once.\n\n## Example\n${example(spec)}`;
  const month = 1 + Math.floor(r() * 9);
  const day = 1 + Math.floor(r() * 27);
  const confirmed =
    spec.confirmed ?? `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const also = spec.also ?? Math.floor(r() * 3);
  const repoSlug = area.repo ?? "shared";
  const fm: Frontmatter = {
    id: spec.id,
    title: spec.title,
    area: area.area,
    scope: spec.scope ?? area.scope,
    status: spec.status ?? "accepted",
    score: spec.score,
    owner: "ana",
    source: {
      type: "pr-feedback",
      url: `https://git.example.com/acme/${repoSlug}/pull/${100 + Math.floor(r() * 900)}#c1`,
      author: "ana",
      changedCode: true,
    },
    ...(also
      ? {
          alsoFrom: Array.from(
            { length: also },
            (_, i) =>
              `https://git.example.com/acme/${repoSlug}/pull/${1000 + Math.floor(r() * 900)}#c${i + 2}`,
          ),
        }
      : {}),
    created: "2026-01-05",
    lastConfirmed: confirmed < "2026-01-05" ? "2026-01-05" : confirmed,
    ...(spec.kind ? { kind: spec.kind } : {}),
    ...(spec.adopted !== undefined ? { adopted: spec.adopted } : {}),
    tokens: countTokens(body),
  };
  const text = formatEntry(fm, body);
  const entry = parseEntry(text).entry;
  if (!entry) throw new Error(`bad fixture rule ${spec.id}`);
  const dir = area.repo ? `knowledge/${area.repo}/${area.area}` : "knowledge/core";
  return { path: `${dir}/${spec.id}.md`, entry, text };
}

function fillers(area: Area, r: () => number): Spec[] {
  const out: Spec[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < (FILLERS[area.area] ?? 0); i++) {
    const noun = area.nouns[i % area.nouns.length] as string;
    const verb = pick(VERBS, r);
    const id = `${area.area}-${slug(verb)}-${slug(noun)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: `${verb} the ${noun} consistently`,
      rule: `When code here changes the ${noun}, ${pick(ACTIONS, r)}.`,
      why: `A reviewer asked for this on an earlier change to the ${noun}, and it came up again.`,
      score: 1 + Math.floor(r() * 6),
    });
  }
  return out;
}

/** The rules, in a stable order. */
export function fixtureRules(): FixtureRule[] {
  const r = prng(20261024);
  return AREAS.flatMap((area) =>
    [...area.signal, ...fillers(area, r)].map((spec) => build(area, spec, r)),
  );
}

export const FIXTURE_REPOS = ["api", "web"] as const;

/** The rules a session in `repo` sees: the shared ones plus that repo's. */
export function fixturePool(rules: readonly FixtureRule[], repo: string | undefined): Entry[] {
  return rules
    .filter((r) => r.path.startsWith("knowledge/core/") || r.path.startsWith(`knowledge/${repo}/`))
    .map((r) => r.entry);
}

/** The KB's config, for writing the fixture to disk. */
export const FIXTURE_CONFIG = `version: 1
team:
  members:
    - id: ana
      handle: "@ana"
      role: senior
repos:
  api:
    source: acme/api
    areas:
      billing: ["services/billing/**"]
      orders: ["services/orders/**"]
      notifications: ["services/notifications/**"]
      storage: ["db/**", "services/**/repo/**"]
  web:
    source: acme/web
    areas:
      checkout: ["apps/web/src/checkout/**", "apps/web/src/api/**"]
      catalog: ["apps/web/src/catalog/**"]
      ui: ["packages/ui/**"]
      accounts: ["apps/web/src/accounts/**"]
distribution:
  tokenBudget: 2000
sources:
  host: github
  kbRepo: acme/team-kb
`;

/** Forty cases, the hard ones marked. */
export const FIXTURE_CASES: EvalCase[] = [
  // Sessions: the rule about the touched file among many that apply to its folder.
  {
    name: "tax file",
    repo: "api",
    paths: ["services/billing/tax.ts"],
    expect: ["billing-tax-per-line"],
  },
  // Hard: broad scope, but the text names the exact helper file.
  {
    name: "totals helper",
    repo: "api",
    paths: ["services/billing/totals.ts"],
    expect: ["billing-invoice-total-helper"],
  },
  {
    name: "billing file no rule names",
    repo: "api",
    paths: ["services/billing/invoice_pdf.ts"],
    expect: ["billing-money-in-cents"],
  },
  {
    name: "refund endpoint",
    repo: "api",
    paths: ["services/billing/refunds/create.ts"],
    expect: ["billing-refund-idempotency", "billing-gift-card-partial"],
  },
  // Hard: a global rule that names the touched file.
  {
    name: "ledger file",
    repo: "api",
    paths: ["services/orders/ledger.ts"],
    expect: ["orders-ledger-append-only", "core-ledger-replica"],
  },
  {
    name: "order state and its test",
    repo: "api",
    paths: ["services/orders/state.ts", "services/orders/state.test.ts"],
    expect: ["orders-transition-helper", "core-test-factories"],
  },
  {
    name: "order export",
    repo: "api",
    paths: ["services/orders/export/csv.ts"],
    expect: ["orders-export-csv"],
  },
  {
    name: "email template",
    repo: "api",
    paths: ["services/notifications/templates/receipt.mustache"],
    expect: ["notify-template-escaping"],
  },
  {
    name: "webhook delivery (api)",
    repo: "api",
    paths: ["services/notifications/webhooks/deliver.ts"],
    expect: ["notify-webhook-retry"],
  },
  {
    name: "sms sender",
    repo: "api",
    paths: ["services/notifications/sms.ts"],
    expect: ["notify-quiet-hours", "notify-provider-timeouts"],
  },
  {
    name: "migration",
    repo: "api",
    paths: ["db/migrations/0042_add_order_index.sql"],
    expect: ["storage-index-concurrently", "storage-migrations-reversible"],
  },
  {
    name: "seed data",
    repo: "api",
    paths: ["db/seeds/0003_regions.sql"],
    expect: ["storage-migrations-reversible-seeds"],
  },
  {
    name: "repository",
    repo: "api",
    paths: ["services/billing/repo/invoices.ts"],
    expect: ["storage-transactions-helper"],
  },
  // Hard: global rule naming the touched file, no scoped rule applies.
  {
    name: "transaction helper",
    repo: "api",
    paths: ["lib/db/tx.ts"],
    expect: ["core-tx-helper-owner"],
  },
  {
    name: "package manifest",
    repo: "api",
    paths: ["package.json"],
    expect: ["core-dependency-pinning"],
  },
  {
    name: "ci workflow",
    repo: "web",
    paths: [".github/workflows/ci.yml"],
    expect: ["core-ci-cache"],
  },
  {
    name: "checkout summary",
    repo: "web",
    paths: ["apps/web/src/checkout/Summary.tsx"],
    expect: ["checkout-price-display"],
  },
  {
    name: "webhook delivery (web)",
    repo: "web",
    paths: ["apps/web/src/api/webhooks/payment.ts"],
    expect: ["checkout-webhook-retry"],
  },
  {
    name: "money component",
    repo: "web",
    paths: ["packages/ui/src/money.tsx"],
    expect: ["ui-money-component", "ui-design-tokens"],
  },
  {
    name: "icon button",
    repo: "web",
    paths: ["packages/ui/src/IconButton.tsx"],
    expect: ["ui-a11y-labels", "ui-design-tokens"],
  },
  {
    name: "password form",
    repo: "web",
    paths: ["apps/web/src/accounts/ChangePassword.tsx"],
    expect: ["accounts-password-rules"],
  },
  {
    name: "product list",
    repo: "web",
    paths: ["apps/web/src/catalog/ProductList.tsx", "apps/web/src/catalog/api.ts"],
    expect: ["catalog-pagination-cursor"],
  },
  {
    name: "no files yet",
    repo: "api",
    paths: [],
    expect: ["core-no-secrets-in-logs", "core-structured-logging"],
  },
  {
    name: "three areas",
    repo: "api",
    paths: ["services/billing/tax.ts", "services/orders/state.ts", "services/notifications/sms.ts"],
    expect: ["billing-tax-per-line", "orders-transition-helper", "notify-quiet-hours"],
  },
  // Hard: one specific file among thirty generic ones.
  {
    name: "wide billing change",
    repo: "api",
    paths: [
      "services/billing/tax.ts",
      ...Array.from({ length: 30 }, (_, i) => `services/billing/handlers/handler_${i}.ts`),
    ],
    expect: ["billing-tax-per-line"],
  },
  // Search: what an agent asks for.
  {
    name: "search: tax rounding",
    repo: "api",
    task: "round tax on each line item",
    expect: ["billing-tax-per-line"],
  },
  // Hard: the query's words appear only in the rule body.
  {
    name: "search: body words",
    repo: "api",
    task: "mustache triple braces",
    expect: ["notify-template-escaping"],
  },
  // Hard: a long question full of common words.
  {
    name: "search: long question",
    repo: "api",
    task: "I'm adding an endpoint so support staff can issue a partial refund for an order that was paid with a gift card. What should I watch out for?",
    expect: ["billing-gift-card-partial", "billing-refund-idempotency"],
  },
  // Hard: near-duplicate titles, told apart by repo.
  {
    name: "search: webhook retry (web)",
    repo: "web",
    task: "retry webhook deliveries",
    expect: ["checkout-webhook-retry"],
  },
  {
    name: "search: webhook retry (api)",
    repo: "api",
    task: "retry webhook deliveries",
    expect: ["notify-webhook-retry"],
  },
  // Hard: near-duplicate titles in one repo.
  {
    name: "search: seed rollback",
    repo: "api",
    task: "reversible migration for seed data",
    expect: ["storage-migrations-reversible-seeds"],
  },
  {
    name: "search: why-only words",
    repo: "api",
    task: "export ran out of memory with two million rows",
    expect: ["orders-export-csv"],
  },
  {
    name: "search: index lock",
    repo: "api",
    task: "adding an index locked the table",
    expect: ["storage-index-concurrently"],
  },
  {
    name: "search: colours",
    repo: "web",
    task: "where do colours come from",
    expect: ["ui-design-tokens"],
  },
  // Hard: the query's best words compete with another rule's title.
  {
    name: "search: float money",
    repo: "api",
    task: "money float rounding errors",
    expect: ["billing-money-in-cents"],
  },
  {
    name: "search: page numbers",
    repo: "web",
    task: "should I use page numbers for product lists",
    expect: ["catalog-pagination-cursor"],
  },
  // Hard: "deleting" and "delete" stem differently.
  {
    name: "search: deleting accounts",
    repo: "web",
    task: "deleting a customer account",
    expect: ["accounts-delete-flow"],
  },
  // Hard: long questions whose common words match filler rules.
  {
    name: "search: long price question",
    repo: "web",
    task: "We keep getting complaints that customers in other countries see prices with the wrong decimal separator on the checkout summary page, where is that handled?",
    expect: ["checkout-price-display", "ui-money-component"],
  },
  {
    name: "search: long sms question",
    repo: "api",
    task: "A customer complained they got a text message from us in the middle of the night. How do we stop sending sms then?",
    expect: ["notify-quiet-hours"],
  },
  {
    name: "search: double charge",
    repo: "web",
    task: "customer was charged twice after clicking pay",
    expect: ["checkout-submit-once"],
  },
];

/** The session budget the hook gives rules at the default 2,000 tokens with documents present. */
export const FIXTURE_BUDGET = 1600;
