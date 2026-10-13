import { ID_PATTERN } from "./schema.ts";

/** Lowercase-hyphen slug of `text` (at most `max` chars), or undefined if nothing is left. */
export function slugify(text: string | undefined, max = 60): string | undefined {
  const slug = (text ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return ID_PATTERN.test(slug) ? slug : undefined;
}
