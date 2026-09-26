import http from "node:http";
import { Readable } from "node:stream";

export const PROXY_PORT = 51121;
export const PROXY_BASE_URL = `http://127.0.0.1:${PROXY_PORT}/v1beta`;

let activeServer: http.Server | null =
  (globalThis as any).__superoc_proxy_server ?? null;

export function startAntigravityProxy(
  fetchHandler: (input: any, init?: any) => Promise<Response>,
): http.Server {
  if (activeServer) {
    (activeServer as any).__superoc_handler = fetchHandler;
    return activeServer;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const bodyStr =
        chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : undefined;

      const handler = (server as any).__superoc_handler || fetchHandler;
      const targetUrl = `https://generativelanguage.googleapis.com${req.url || ""}`;

      const forwardHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase();
        if (
          lower === "host" ||
          lower === "content-length" ||
          lower === "connection" ||
          lower === "transfer-encoding"
        ) {
          continue;
        }
        if (typeof v === "string") forwardHeaders[k] = v;
      }

      const upstreamRes = await handler(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: bodyStr,
      });

      const responseHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((value: string, key: string) => {
        responseHeaders[key] = value;
      });

      res.writeHead(upstreamRes.status, responseHeaders);
      if (upstreamRes.body) {
        Readable.fromWeb(upstreamRes.body as any).pipe(res);
      } else {
        res.end();
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(
        JSON.stringify({
          error: {
            code: 500,
            message: String(err?.message || err),
            status: "INTERNAL",
          },
        }),
      );
    }
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      // Server already running in another process or thread
      activeServer = server;
    } else {
      console.warn("[superoc] Local proxy server warning:", err);
    }
  });

  try {
    server.listen(PROXY_PORT, "127.0.0.1", () => {
      // listening
    });
    activeServer = server;
    (globalThis as any).__superoc_proxy_server = server;
    (server as any).__superoc_handler = fetchHandler;
  } catch {}

  return server;
}
