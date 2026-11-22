#!/usr/bin/env node
// Local mode: Claude Desktop / Claude Code / Cursor launch this as a subprocess.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createContext, createServer } from "./server.js";

const ctx = createContext(configFromEnv());
const server = createServer(ctx);
await server.connect(new StdioServerTransport());

const shutdown = () => {
  ctx.index.save();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
