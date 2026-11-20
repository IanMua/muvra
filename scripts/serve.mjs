import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
const root = resolve(import.meta.dirname, "..");
const port = Number(process.env.MUVRA_PORT ?? 4187);

// 仅监听本机并限制静态目录，浏览器实验不会接入业务服务器或暴露项目文件。
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const filename = resolve(root, `.${pathname === "/" ? "/demo/index.html" : pathname}`);
  if (!filename.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const bytes = await readFile(filename);
    response.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".map": "application/json",
        }[extname(filename)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Muvra: http://127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
