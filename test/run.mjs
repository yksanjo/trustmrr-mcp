import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startMock, KEY } from "./mock-api.mjs";

const { srv, port, log } = await startMock();
const env = (extra) => ({ ...process.env, TRUSTMRR_BASE_URL: `http://localhost:${port}/api/v1`, TRUSTMRR_RPM: "6000",
  TRUSTMRR_INDEX_PATH: join(mkdtempSync(join(tmpdir(), "tmrr-")), "idx.json"), ...extra });
let pass = 0;
const ok = (name) => { pass++; console.log("✓", name); };

async function stdioClient(key) {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/stdio.js"], env: env({ TRUSTMRR_API_KEY: key }) }));
  return c;
}
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });

const c = await stdioClient(KEY);
const tools = (await c.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["get_startup", "index_status", "lookup_website_revenue", "search_startups"]); ok("lists 4 tools");

let r = await call(c, "lookup_website_revenue", { websites: ["https://www.post-bridge.com/pricing"] });
let x = r.structuredContent.results[0];
assert.equal(x.found, true); assert.equal(x.matchedBy, "slug-guess"); assert.equal(x.startup.mrrUsd, 34200);
ok("slug guess finds post-bridge.com (and survives a 429 retry)");

r = await call(c, "lookup_website_revenue", { websites: ["notlisted.com"], scan_budget_pages: 1 });
x = r.structuredContent.results[0];
assert.equal(x.found, false); assert.match(x.note, /Call again/); ok("partial scan says to call again");

r = await call(c, "lookup_website_revenue", { websites: ["zzz-hidden.io"] });
x = r.structuredContent.results[0];
assert.equal(x.found, true); assert.equal(x.matchedBy, "scan"); assert.equal(x.startup.slug, "acme-tool");
ok("catalogue scan finds subdomain site app.zzz-hidden.io via zzz-hidden.io");

r = await call(c, "lookup_website_revenue", { websites: ["startup7.com", "zzz-hidden.io"] });
assert.deepEqual(r.structuredContent.results.map((y) => y.matchedBy), ["index", "index"]); ok("repeat lookups hit the index");

r = await call(c, "lookup_website_revenue", { websites: ["notlisted.com"], scan_budget_pages: 10 });
assert.match(r.structuredContent.results[0].note, /full catalogue/); ok("full scan reports not listed");

r = await call(c, "lookup_website_revenue", { websites: ["not a url"] });
assert.equal(r.structuredContent.results[0].found, false); ok("invalid input handled");

log.length = 0;
r = await call(c, "search_startups", { min_mrr_usd: 2000, team_size: "1", min_growth_pct: 10 });
assert.ok(log[0].includes("minMrr=200000") && log[0].includes("teamSize=1") && log[0].includes("minGrowth=0.1"), log[0]);
assert.ok(r.structuredContent.startups.every((s) => s.mrrUsd >= 2000 && s.teamSize === "1")); ok("search converts USD/% to API units");

r = await call(c, "search_startups", { audience: "B2B", include_both: false, limit: 5 });
assert.ok(r.structuredContent.startups.length >= 5 && r.structuredContent.startups.every((s) => s.audience === "B2B"));
assert.equal(r.structuredContent.meta.nextPage, 3); assert.match(r.content[0].text, /page=3/); ok("B2B-only filter, with a next page");
r = await call(c, "search_startups", { audience: "B2B", page: 2 });
assert.ok(r.structuredContent.startups.every((s) => ["B2B", "Both"].includes(s.audience)));
assert.ok(r.structuredContent.startups.some((s) => s.audience === "Both")); ok("B2B filter includes B2B+B2C by default");
r = await call(c, "search_startups", { audience: "B2B", team_size: "1", min_mrr_usd: 1000 });
assert.ok(r.structuredContent.startups.every((s) => s.teamSize === "1" && s.mrrUsd >= 1000 && s.audience !== "B2C")); ok("B2B combines with other filters");

r = await call(c, "get_startup", { slug: "nope" });
assert.equal(r.isError, true); ok("unknown slug is a clean error");
r = await call(c, "get_startup", { slug: "startup-3" });
assert.equal(r.structuredContent.summary.askingPriceUsd, 250000); assert.match(r.content[0].text, /FOR SALE \$250,000/); ok("get_startup summary");

r = await call(c, "index_status");
assert.equal(r.structuredContent.scanComplete, true); assert.ok(r.structuredContent.indexedDomains >= 35); ok("index_status");
await c.close();

const bad = await stdioClient("tmrr_wrong");
r = await call(bad, "lookup_website_revenue", { websites: ["startup1.com"] });
assert.equal(r.isError, true); assert.match(r.content[0].text, /rejected the API key/); ok("bad key surfaces clearly");
await bad.close();

// Hosted HTTP mode with per-caller key
const httpPort = 3900 + Math.floor(Math.random() * 90);
const proc = spawn("node", ["dist/http.js"], { env: env({ PORT: String(httpPort), TRUSTMRR_API_KEY: "" }), stdio: ["ignore", "ignore", "pipe"] });
await new Promise((res) => proc.stderr.on("data", (d) => String(d).includes("listening") && res()));
const unauth = await fetch(`http://localhost:${httpPort}/mcp`, { method: "POST", body: "{}" });
assert.equal(unauth.status, 401); ok("HTTP rejects missing key");
const hc = new Client({ name: "test", version: "1" });
await hc.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${httpPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
r = await call(hc, "lookup_website_revenue", { websites: ["startup5.com"] });
assert.equal(r.structuredContent.results[0].startup.slug, "startup-5"); ok("HTTP mode lookup works");
await hc.close(); proc.kill(); srv.close();
console.log(`\n${pass} checks passed`);
