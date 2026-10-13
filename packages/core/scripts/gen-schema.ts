import { writeFileSync } from "node:fs";
import { entryJsonSchema } from "../src/json-schema.ts";

const out = new URL("../schema/entry.schema.json", import.meta.url);
writeFileSync(out, `${JSON.stringify(entryJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
