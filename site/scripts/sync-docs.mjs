// Copies ../docs into the Starlight collection at build time, so the guides stay written once,
// in the repository. Each page's first `# Heading` becomes its title, links between guides become
// site routes, and links to files outside docs/ point at GitHub.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "../../docs");
const target = join(here, "../src/content/docs/docs");
const GITHUB = "https://github.com/ysugarmen/homeostat/blob/main";
const SKIP = new Set(["plans"]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return SKIP.has(name) ? [] : walk(full);
    return name.endsWith(".md") ? [full] : [];
  });
}

const route = (rel) => {
  const slug = rel.replace(/\.md$/, "").replace(/(^|\/)index$/, "");
  return `/docs/${slug ? `${slug.toLowerCase()}/` : ""}`;
};

function rewriteLinks(text, rel) {
  const from = posix.dirname(rel);
  return text.replace(/\]\((?!https?:|mailto:|#)([^)\s]+?)(#[^)\s]*)?\)/g, (match, link, hash = "") => {
    const resolved = posix.normalize(posix.join(from, link));
    if (resolved.startsWith("../")) return `](${GITHUB}/${resolved.slice(3)}${hash})`;
    if (resolved.endsWith(".md")) return `](${route(resolved)}${hash})`;
    return match;
  });
}

rmSync(target, { recursive: true, force: true });
let count = 0;
for (const file of walk(source)) {
  const rel = relative(source, file).split("\\").join("/");
  const raw = readFileSync(file, "utf8");
  const heading = /^#\s+(.+)$/m.exec(raw);
  const title = heading ? heading[1].trim() : rel;
  const body = heading ? raw.replace(heading[0], "").replace(/^\s+/, "") : raw;
  const out = `---\ntitle: ${JSON.stringify(title)}\neditUrl: ${JSON.stringify(`https://github.com/ysugarmen/homeostat/edit/main/docs/${rel}`)}\n---\n\n${rewriteLinks(body, rel)}`;
  const dest = join(target, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
  count++;
}
console.log(`synced ${count} pages from docs/`);
