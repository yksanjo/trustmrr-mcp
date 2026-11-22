# TrustMRR Revenue MCP

An MCP server that lets any agent ask **"how much does this website make?"** and get back verified revenue from [TrustMRR](https://trustmrr.com). TrustMRR pulls these numbers straight from the payment provider (Stripe and others), so they aren't self-reported.

TrustMRR's own API and MCP only find startups **by slug or by filter**. They have no way to look up a website. This server adds that, plus agent-friendly output in plain dollars.

## Tools

| Tool | What it does |
|---|---|
| `lookup_website_revenue` | 1–10 URLs or domains → 30-day revenue, MRR, all-time revenue, growth, margin, customers, team size, sale status |
| `search_startups` | Filter by **B2B / B2C**, MRR, revenue, growth %, team size, funding, category, price, on-sale. You pass USD and %, and the server converts them to the API's cents and decimals |
| `get_startup` | Full record by TrustMRR slug (tech stack, channels, insights, cofounders) |
| `index_status` | How much of the catalogue the domain index has covered so far |

Example agent prompts:
- *"Compare the verified revenue of postbridge.com and shipfa.st."*
- *"Find bootstrapped solo-founder B2B startups growing more than 20% a month."*

### B2B / B2C filter

The TrustMRR API has no audience filter, so the server applies it. It reads up to 6 API pages per call (10 startups each) and keeps the startups whose customer type matches. By default `audience: "B2B"` also includes startups that sell to both businesses and consumers; set `include_both: false` to get B2B-only. If more results are left, the response gives a `nextPage` to call with. Every result also shows its audience (`B2B`, `B2C` or `Both`), lookups included.

## How website lookup works

1. **Index hit.** Every startup the server sees gets saved in a domain → slug map at `~/.cache/trustmrr-mcp/domain-index.json`.
2. **Slug guess.** `post-bridge.com` → tries the slugs `post-bridge` and `postbridge`. That's 1–3 requests, and it catches most sites.
3. **Catalogue scan.** Pages through all startups, largest revenue first, and stops as soon as the domain turns up. Progress is saved, so the next call picks up where this one stopped.

`www.`, paths and subdomains are normalized, so `https://app.foo.com/pricing` matches `foo.com`. A result is only returned if the startup's listed website matches the domain you asked about.

The API allows 20 requests per minute per key. The server queues requests at 18/min and retries on 429. To make every lookup instant, index the whole catalogue once (it takes about 3.3 seconds per 10 startups):

```bash
TRUSTMRR_API_KEY=tmrr_... npm run warm-index
```

## Setup

1. Get an API key at https://trustmrr.com/dashboard-dev
2. Run it with `npx -y trustmrr-revenue-mcp` (no install needed), or build it from source:

```bash
npm install && npm run build
```

### Claude Code

```bash
claude mcp add trustmrr-revenue -e TRUSTMRR_API_KEY=tmrr_... -- npx -y trustmrr-revenue-mcp
```

Or from a local build: `-- node /path/to/trustmrr-mcp/dist/stdio.js`

### Claude Desktop / Cursor (`mcpServers` config)

```json
{
  "mcpServers": {
    "trustmrr-revenue": {
      "command": "npx",
      "args": ["-y", "trustmrr-revenue-mcp"],
      "env": { "TRUSTMRR_API_KEY": "tmrr_..." }
    }
  }
}
```

### Hosted (Streamable HTTP, for remote agents)

```bash
PORT=3000 npm run start:http      # POST /mcp, GET /health
```

Each caller sends their own key as `Authorization: Bearer tmrr_...`, and every key gets its own rate limiter. All callers share one domain index, since the data is public. If you set `TRUSTMRR_API_KEY` on the server, callers who send no key will use yours, so only do that on a private deployment.

```bash
claude mcp add --transport http trustmrr-revenue https://your-host/mcp --header "Authorization: Bearer tmrr_..."
```

## Environment variables

| Var | Default |
|---|---|
| `TRUSTMRR_API_KEY` | required for stdio and warm-index |
| `TRUSTMRR_INDEX_PATH` | `~/.cache/trustmrr-mcp/domain-index.json` |
| `TRUSTMRR_RPM` | `18` |
| `TRUSTMRR_BASE_URL` | `https://trustmrr.com/api/v1` |
| `PORT` | `3000` (HTTP mode) |

## Tests

`npm test` builds the server and runs 17 end-to-end checks over stdio and HTTP against a local fake of the TrustMRR API. No key is needed.

## Notes

- TrustMRR only covers startups that have connected their payment provider. "Not found" means TrustMRR has no verified number for that site, not that the site makes no money.
- Follow TrustMRR's [terms](https://trustmrr.com/terms) and rate limits. This server only uses the official API, with no scraping.
