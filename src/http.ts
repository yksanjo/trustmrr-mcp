#!/usr/bin/env node
// Hosted mode: Streamable HTTP at POST /mcp. Each caller sends their own TrustMRR key as
// "Authorization: Bearer tmrr_..." (falls back to TRUSTMRR_API_KEY if set). One domain index
// is shared by everyone, since the revenue data is the same for all keys.
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { configFromEnv, createContext, createIndex, createServer, type Context } from "./server.js";

const base = configFromEnv({ requireKey: false });
const index = createIndex(base.indexPath);
const contexts = new Map<string, Context>();
const PORT = Number(process.env.PORT ?? 3000);

function contextFor(key: string): Context {
  let ctx = contexts.get(key);
  if (!ctx) {
    ctx = createContext({ ...base, apiKey: key }, index);
    contexts.set(key, ctx);
  }
  return ctx;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

const http = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, ...index.status() }));
    return;
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== "POST") {
    // Stateless server: no SSE stream or session to resume.
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }

  const auth = req.headers.authorization ?? "";
  const key = auth.match(/^Bearer\s+(\S+)$/i)?.[1] ?? base.apiKey;
  if (!key) {
    res
      .writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
      .end(JSON.stringify({ error: "Send your TrustMRR API key as 'Authorization: Bearer tmrr_...'" }));
    return;
  }

  try {
    const body = await readJson(req);
    const server = createServer(contextFor(key));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: (e as Error).message }, id: null }),
      );
    }
  }
});

http.listen(PORT, () => console.error(`trustmrr-mcp listening on http://localhost:${PORT}/mcp`));
const shutdown = () => {
  index.save();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
