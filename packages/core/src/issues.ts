export type Severity = "error" | "warning";

/** A value `validate --fix` can write back into the entry's frontmatter. */
export interface Fix {
  field: string;
  value: unknown;
}

export interface Issue {
  /** Stable machine-readable code, e.g. `body.rule.tooLong`. */
  code: string;
  severity: Severity;
  message: string;
  /** Dotted frontmatter path the issue is about, when there is one. */
  path?: string;
  /** KB-relative file the issue was found in, when known. */
  file?: string;
  fix?: Fix;
}

export const error = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({
  code,
  severity: "error",
  message,
  ...extra,
});

export const hasErrors = (issues: readonly Issue[]) => issues.some((i) => i.severity === "error");
