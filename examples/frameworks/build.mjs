// Builds the framework consumers with Vite in production mode, each with its
// own framework plugin, into examples/frameworks/dist/<name>. A consumer with a
// server entry also gets dist/<name>-server. Each client build lists the
// modules its bundle holds in modules.json, for the suite's isolation check.
// The packages resolve through their public exports to dist, as an installed
// copy would. Usage (build the packages first):
//   node examples/frameworks/build.mjs [vanilla,react,...]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

/** Each consumer: its framework plugins, a server entry, and extra modes. */
export const consumers = {
  vanilla: { plugins: async () => [] },
  react: { plugins: async () => [], server: "server.jsx", development: true },
};

// Records the modules of the client bundle, relative to the repository.
function listModules(outDir) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const modules = new Set();
  return {
    name: "list-modules",
    apply: "build",
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle))
        if (output.type === "chunk")
          for (const id of output.moduleIds) modules.add(id.replace(root, "").replace(/\?.*$/, ""));
    },
    // Vite empties the directory before writing, so list the modules after.
    writeBundle() {
      const list = [...modules].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      writeFileSync(outDir + "/modules.json", JSON.stringify(list, null, 2) + "\n");
    },
  };
}

export async function buildConsumers(names = Object.keys(consumers)) {
  for (const name of names) {
    const consumer = consumers[name];
    if (!consumer) throw new Error("No consumer named " + name);
    const root = here + name;
    const modes = [
      ["production", name],
      ...(consumer.development ? [["development", name + "-dev"]] : []),
    ];
    for (const [mode, out] of modes) {
      const outDir = here + "dist/" + out;
      await build({
        root,
        base: "./",
        mode,
        configFile: false,
        logLevel: "warn",
        plugins: [...(await consumer.plugins({ ssr: false })), listModules(outDir)],
        define: { "process.env.NODE_ENV": JSON.stringify(mode) },
        build: { outDir, emptyOutDir: true, minify: mode === "production" },
        worker: { format: "es" },
      });
    }
    if (consumer.server)
      await build({
        root,
        configFile: false,
        logLevel: "warn",
        plugins: await consumer.plugins({ ssr: true }),
        build: {
          ssr: consumer.server,
          outDir: here + "dist/" + name + "-server",
          emptyOutDir: true,
        },
      });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const names = process.argv[2]?.split(",");
  await buildConsumers(names);
  console.log("Built " + (names ?? Object.keys(consumers)).join(", "));
}
