// Compares the declarations reachable from each package entry point with a
// committed snapshot, so a change to the public API shows up as a reviewed diff.
// Usage: node scripts/api-snapshot.mjs [--update]   (run `npm run build` first)
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const packages = [
  { dir: "packages/core", entries: ["index.d.ts", "internal.d.ts"] },
  { dir: "packages/media", entries: ["index.d.ts", "internal.d.ts"] },
  { dir: "packages/timeline", entries: ["index.d.ts", "internal.d.ts"] },
];
const update = process.argv.includes("--update");
const failures = [];

for (const { dir, entries } of packages) {
  const dist = join(dir, "dist");
  const snapshot = join(dir, "api");
  const reachable = new Map();
  const pending = [...entries];
  while (pending.length) {
    const file = pending.pop();
    if (reachable.has(file)) continue;
    const path = join(dist, file);
    if (!existsSync(path)) {
      failures.push(`${path} is missing. Run npm run build first.`);
      continue;
    }
    const text = readFileSync(path, "utf8").replace(/^\/\/# sourceMappingURL=.*\n?/m, "");
    reachable.set(file, text);
    for (const [, name] of text.matchAll(/(?:from |import\()"\.\/([\w-]+)\.(?:ts|js)"/g))
      pending.push(name + ".d.ts");
  }
  const expected = existsSync(snapshot)
    ? readdirSync(snapshot).filter((name) => name.endsWith(".d.ts"))
    : [];
  if (update) {
    mkdirSync(snapshot, { recursive: true });
    for (const name of expected) if (!reachable.has(name)) rmSync(join(snapshot, name));
    for (const [name, text] of reachable) writeFileSync(join(snapshot, name), text);
    console.log(`${snapshot}: wrote ${reachable.size} declaration files`);
    continue;
  }
  for (const name of expected)
    if (!reachable.has(name)) failures.push(`${join(snapshot, name)} is no longer reachable`);
  for (const [name, text] of reachable) {
    const path = join(snapshot, name);
    if (!existsSync(path)) failures.push(`${path} is new`);
    else if (readFileSync(path, "utf8") !== text) failures.push(`${path} changed`);
  }
  if (!failures.length) console.log(`${snapshot}: ${reachable.size} declaration files match`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  console.error("If the API change is intended, run npm run api:update and commit the snapshot.");
  process.exit(1);
}
