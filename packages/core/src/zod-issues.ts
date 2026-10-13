import type { z } from "zod";
import { error, type Issue } from "./issues.ts";

/** Converts zod issues to homeostat issues with readable, dotted-path messages. */
export function fromZod(
  zodError: z.ZodError,
  { code, file, renamed = {} }: { code: string; file?: string; renamed?: Record<string, string> },
): Issue[] {
  const extra = file ? { file } : {};
  return zodError.issues.flatMap((i): Issue[] => {
    if (i.code === "unrecognized_keys") {
      return i.keys.map((key) => {
        const path = [...i.path, key].join(".");
        const hint = renamed[key] ? `; did you mean "${renamed[key]}"?` : "";
        return error(code, `${path}: unknown key${hint}`, { path, ...extra });
      });
    }
    const path = i.path.join(".");
    const missing = i.code === "invalid_type" && /received undefined/.test(i.message);
    return [error(code, `${path}: ${missing ? "is required" : i.message}`, { path, ...extra })];
  });
}
