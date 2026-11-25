// Serves the built site to the browser tests, as a static host would.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".wasm", "application/wasm"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".pf_fragment", "application/octet-stream"],
  [".pf_index", "application/octet-stream"],
  [".pf_meta", "application/octet-stream"],
  [".pagefind", "application/octet-stream"],
]);

export function startStaticServer(rootDir) {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let path = decodeURIComponent(url.pathname);
        if (path.endsWith("/")) path += "index.html";
        let full = resolve(rootDir, `.${path}`);
        if (!full.startsWith(rootDir)) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (!existsSync(full) && existsSync(`${full}/index.html`)) {
          full = `${full}/index.html`;
        }
        const body = await readFile(full);
        res.writeHead(200, {
          "Content-Type": MIME.get(extname(full)) ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    server.on("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("Unexpected server address"));
        return;
      }
      resolveServer({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done(undefined))),
      });
    });
  });
}
