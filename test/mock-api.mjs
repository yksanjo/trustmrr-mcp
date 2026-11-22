// Minimal fake of https://trustmrr.com/api/v1 for offline tests.
import { createServer } from "node:http";

export const KEY = "tmrr_test";
const startups = [];
for (let i = 1; i <= 35; i++) {
  startups.push({
    name: `Startup ${i}`, slug: `startup-${i}`, website: `https://startup${i}.com`,
    revenue: { last30Days: (40 - i) * 100000, mrr: (40 - i) * 90000, total: (40 - i) * 5000000 },
    growth30d: 0.05, profitMarginLast30Days: 80, paymentProvider: "stripe", rank: i,
    targetAudience: ["B2C", "B2B", "Both"][i % 3],
    startupInsights: { teamSize: i % 2 ? "1" : "2-5" }, onSale: i === 3, askingPrice: i === 3 ? 25000000 : null,
  });
}
startups[1] = { ...startups[1], name: "Post Bridge", slug: "post-bridge", website: "https://www.post-bridge.com" };
startups[24] = { ...startups[24], name: "Hidden Gem", slug: "acme-tool", website: "https://app.zzz-hidden.io/" };

export function startMock(port = 0) {
  const log = [];
  let first = true;
  const srv = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    log.push(url.pathname + url.search);
    const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "Invalid API key" });
    if (first) { first = false; return send(429, { error: "Too many requests" }, { "retry-after": "1" }); }
    const m = url.pathname.match(/^\/api\/v1\/startups(?:\/([^/]+))?$/);
    if (!m) return send(404, { error: "Not found" });
    if (m[1]) {
      const s = startups.find((x) => x.slug === decodeURIComponent(m[1]));
      return s ? send(200, { data: s }) : send(404, { error: "Startup not found" });
    }
    const page = Number(url.searchParams.get("page") ?? 1), limit = Number(url.searchParams.get("limit") ?? 10);
    let list = startups;
    const minMrr = url.searchParams.get("minMrr");
    if (minMrr) list = list.filter((s) => s.revenue.mrr >= Number(minMrr));
    const team = url.searchParams.get("teamSize");
    if (team) list = list.filter((s) => s.startupInsights.teamSize === team);
    const data = list.slice((page - 1) * limit, page * limit);
    send(200, { data, meta: { total: list.length, page, limit, hasMore: page * limit < list.length } });
  });
  return new Promise((r) => srv.listen(port, () => r({ srv, port: srv.address().port, log })));
}
