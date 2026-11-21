// Checks that every relative link in the tracked Markdown files points at an
// existing file and, for a Markdown target, at an existing heading anchor.
// Usage: node scripts/docs-links.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const files = execFileSync("git", ["ls-files", "-z", "*.md"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

// Fenced code is not Markdown, so neither its links nor its "#" lines count.
function prose(text) {
  let fence = null;
  return text.split("\n").map((line) => {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      return "";
    }
    if (open) {
      fence = open[1];
      return "";
    }
    return line;
  });
}

// GitHub heading IDs: lowercase, drop punctuation, spaces to hyphens, and
// number repeated headings.
const anchorCache = new Map();
function anchors(file) {
  let found = anchorCache.get(file);
  if (found) return found;
  found = new Set();
  const seen = new Map();
  for (const line of prose(readFileSync(file, "utf8"))) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = heading[1]
      .replace(/`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.add(count ? `${base}-${count}` : base);
  }
  anchorCache.set(file, found);
  return found;
}

const failures = [];
for (const file of files) {
  prose(readFileSync(file, "utf8")).forEach((line, index) => {
    const text = line.replace(/`[^`]*`/g, "");
    for (const [, target] of text.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
      if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const [path, hash] = target.split("#", 2);
      const destination = path ? resolve(dirname(file), decodeURI(path)) : resolve(file);
      const where = `${file}:${index + 1}`;
      if (!existsSync(destination)) {
        failures.push(`${where}: ${target} does not exist`);
      } else if (hash && destination.endsWith(".md") && !anchors(destination).has(hash)) {
        failures.push(`${where}: ${relative(".", destination)} has no heading #${hash}`);
      }
    }
  });
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Checked links in ${files.length} Markdown files.`);
