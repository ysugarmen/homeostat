import { z } from "zod";
import { frontmatterSchema } from "./schema.ts";

/** JSON Schema for entry frontmatter, for editors and non-TypeScript tooling. */
export function entryJsonSchema() {
  return {
    ...z.toJSONSchema(frontmatterSchema, { target: "draft-2020-12", io: "input" }),
    title: "kbx knowledge entry frontmatter",
    description:
      "Shape only. Cross-field rules (pr-feedback needs source.url, conflictsWith forces disputed) and config rules are enforced by `kbx validate`.",
  };
}
