import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readKbView, VERSION, validate } from "@homeostat/core";

type Loaded = ReturnType<typeof validate>;

/**
 * The KB in force, loaded for a hook: parsed once per change of the clone and kept in
 * `.homeostat/cache/`, keyed by a hash of every file read (and the Homeostat version, whose
 * parser made it). A hook is a new process each time, at every session start, message and file
 * opened; parsing 1,700 rules was about 0.35 s of each, reading the cache about 0.03 s. The cache
 * lives in the clone, never leaves it, and a stale one cannot be read: any change is a new key.
 */
export function loadKbInForce(kbRoot: string): Loaded {
  const files = readKbView(kbRoot, { inForce: true }).files;
  const hash = createHash("sha256").update(VERSION);
  for (const path of Object.keys(files).sort()) hash.update(`\0${path}\0${files[path]}`);
  const key = hash.digest("hex").slice(0, 32);
  const dir = join(kbRoot, ".homeostat", "cache");
  const file = join(dir, `kb-${key}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Loaded;
  } catch {
    // No cache for this state of the clone yet: parse, and leave it for the next hook.
  }
  const loaded = validate(files, { checks: false });
  try {
    mkdirSync(dir, { recursive: true });
    // Only the latest state is worth keeping.
    for (const old of readdirSync(dir))
      if (old.startsWith("kb-")) rmSync(join(dir, old), { force: true });
    writeFileSync(file, JSON.stringify(loaded));
  } catch {
    // A read-only clone only costs the parse again next time.
  }
  return loaded;
}
