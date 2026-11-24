import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extname } from "node:path";

export async function serve(port = 0) {
  const base = new URL("../../", import.meta.url);
  const types = {
    ".html": "text/html",
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".map": "application/json",
    ".css": "text/css",
    ".webm": "video/webm",
    ".ogg": "audio/ogg",
  };
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/") {
      res.writeHead(302, { Location: "/examples/vanilla/index.html" }).end();
      return;
    }
    if (
      !(
        /^\/(examples\/(vanilla|sync|bench)|packages\/(core|timeline|media|sync)|experiments\/sync)\/[a-zA-Z0-9_./-]+$/.test(
          path,
        ) || path === "/node_modules/signalsmith-stretch/SignalsmithStretch.mjs"
      ) ||
      !types[extname(path)]
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(fileURLToPath(new URL("." + path, base)));
      res.setHeader("Content-Type", types[extname(path)]);
      // Support seeking in the bundled reference without downloading it again.
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      if (range) {
        const start = Number(range[1]),
          end = Math.min(data.length - 1, range[2] ? Number(range[2]) : data.length - 1);
        if (start > end) {
          res.writeHead(416, { "Content-Range": "bytes */" + data.length }).end();
          return;
        }
        res.writeHead(206, {
          "Content-Range": "bytes " + start + "-" + end + "/" + data.length,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
        });
        res.end(data.subarray(start, end + 1));
      } else
        res.writeHead(200, { "Accept-Ranges": "bytes", "Content-Length": data.length }).end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log((await serve(Number(process.env.PORT ?? 4173))).url);
}
