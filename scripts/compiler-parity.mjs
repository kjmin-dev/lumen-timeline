// tsrs ports the TypeScript 7.1 compiler. For every project, both compilers
// must report the same diagnostics and exit code, and emitting projects must
// produce byte-identical output. Any difference is a tsrs bug to report and pin around.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const projects = [
  { path: "packages/core", emit: true },
  { path: "packages/core/test", emit: false },
];
const compilers = ["tsrs", "tsc"];
const windows = process.platform === "win32";
const bin = (name) => join("node_modules", ".bin", windows ? name + ".cmd" : name);

function files(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith(".tsbuildinfo")) found.push(relative(dir, full));
    }
  };
  walk(dir);
  return found.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

const scratch = mkdtempSync(join(tmpdir(), "lumen-parity-"));
const failures = [];
try {
  for (const project of projects) {
    const runs = compilers.map((compiler) => {
      const out = join(scratch, compiler, project.path);
      const args = ["-p", project.path, "--pretty", "false"];
      args.push(
        ...(project.emit
          ? ["--outDir", out, "--tsBuildInfoFile", join(out, "build.tsbuildinfo")]
          : ["--noEmit"]),
      );
      const result = spawnSync(bin(compiler), args, { encoding: "utf8", shell: windows });
      if (result.error) throw result.error;
      return {
        compiler,
        out,
        status: result.status,
        output: (result.stdout + result.stderr).trim(),
      };
    });
    const [a, b] = runs;
    if (a.status !== b.status)
      failures.push(`${project.path}: exit ${a.status} (tsrs) vs ${b.status} (tsc)`);
    if (a.output !== b.output)
      failures.push(
        `${project.path}: diagnostics differ\n--- tsrs\n${a.output}\n--- tsc\n${b.output}`,
      );
    let compared = 0;
    if (project.emit) {
      const left = files(a.out);
      const right = files(b.out);
      if (left.join("\n") !== right.join("\n"))
        failures.push(`${project.path}: emitted file lists differ`);
      for (const file of left.filter((name) => right.includes(name))) {
        compared++;
        if (!readFileSync(join(a.out, file)).equals(readFileSync(join(b.out, file))))
          failures.push(`${project.path}: ${file} differs`);
      }
    }
    const diagnostics = a.output ? a.output.split("\n").length : 0;
    console.log(
      `${project.path}: exit ${a.status}, ${diagnostics} diagnostic lines, ${compared} emitted files compared`,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("tsrs and tsc agree.");
