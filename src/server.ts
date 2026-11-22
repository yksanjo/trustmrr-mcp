import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { TrustMrrClient, TrustMrrError, type Startup } from "./client.js";
import { DomainIndex } from "./domain-index.js";

const VERSION = "0.1.0";

// ---------- formatting ----------

const usd = (cents: number | null | undefined) =>
  cents == null
    ? null
    : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (v: number | null | undefined) => (v == null ? null : `${(v * 100).toFixed(1)}%`);

/** "B2B" | "B2C" | "Both" | null, from the list field or the detail insights. */
export function audienceOf(s: Startup): string | null {
  const raw = (s.targetAudience ?? (s.startupInsights as any)?.businessType ?? null) as string | null;
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === "b2b") return "B2B";
  if (v === "b2c") return "B2C";
  if (v === "both" || v.includes("b2b") && v.includes("b2c")) return "Both";
  return null; // "Unknown" or anything else
}

/** Compact, agent-friendly view of a startup with money in dollars. */
export function summarize(s: Startup) {
  return {
    name: s.name,
    slug: s.slug,
    website: s.website ?? null,
    trustmrrUrl: `https://trustmrr.com/startup/${s.slug}`,
    revenueLast30DaysUsd: s.revenue?.last30Days != null ? s.revenue.last30Days / 100 : null,
    mrrUsd: s.revenue?.mrr != null ? s.revenue.mrr / 100 : null,
    totalRevenueUsd: s.revenue?.total != null ? s.revenue.total / 100 : null,
    growth30dPct: s.growth30d != null ? +(s.growth30d * 100).toFixed(2) : null,
    profitMarginLast30DaysPct: s.profitMarginLast30Days ?? null,
    customers: s.customers ?? null,
    activeSubscriptions: s.activeSubscriptions ?? null,
    rank: s.rank ?? null,
    paymentProvider: s.paymentProvider ?? null,
    category: s.category ?? null,
    audience: audienceOf(s),
    country: s.country ?? null,
    foundedDate: s.foundedDate ?? null,
    teamSize: (s.startupInsights as any)?.teamSize ?? null,
    fundingStatus: (s.startupInsights as any)?.fundingStatus ?? null,
    visitorsLast30Days: s.visitorsLast30Days ?? null,
    onSale: s.onSale ?? false,
    askingPriceUsd: s.askingPrice != null ? s.askingPrice / 100 : null,
    revenueMultiple: s.multiple ?? null,
    founderX: s.xHandle ? `@${s.xHandle}` : null,
  };
}

function line(s: Startup): string {
  const bits = [
    `${s.name} (${s.website ?? s.slug})`,
    `30d revenue ${usd(s.revenue?.last30Days) ?? "n/a"}`,
    `MRR ${usd(s.revenue?.mrr) ?? "n/a"}`,
    `all-time ${usd(s.revenue?.total) ?? "n/a"}`,
  ];
  if (s.growth30d != null) bits.push(`30d growth ${pct(s.growth30d)}`);
  if (s.profitMarginLast30Days != null) bits.push(`margin ${s.profitMarginLast30Days}%`);
  const aud = audienceOf(s);
  if (aud) bits.push(aud === "Both" ? "B2B+B2C" : aud);
  const team = (s.startupInsights as any)?.teamSize;
  if (team) bits.push(`team ${team}`);
  if (s.onSale) bits.push(`FOR SALE ${usd(s.askingPrice) ?? ""}`.trim());
  bits.push(`verified via ${s.paymentProvider ?? "payment provider"}`);
  return bits.join(" · ") + `\n  https://trustmrr.com/startup/${s.slug}`;
}

function errorResult(e: unknown) {
  const msg =
    e instanceof TrustMrrError
      ? `TrustMRR API error (HTTP ${e.status}): ${e.message}`
      : `Error: ${(e as Error)?.message ?? String(e)}`;
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

// ---------- server ----------

export interface Context {
  client: TrustMrrClient;
  index: DomainIndex;
}

export interface Config {
  apiKey: string;
  baseUrl?: string;
  indexPath?: string;
  requestsPerMinute?: number;
}

export function createIndex(indexPath?: string): DomainIndex {
  return new DomainIndex(indexPath ?? join(homedir(), ".cache", "trustmrr-mcp", "domain-index.json"));
}

/** One client per API key (the rate limit is per key); the domain index can be shared. */
export function createContext(opts: Config, sharedIndex?: DomainIndex): Context {
  const client = new TrustMrrClient({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    requestsPerMinute: opts.requestsPerMinute,
  });
  const index = sharedIndex ?? createIndex(opts.indexPath);
  index.attach(client);
  return { client, index };
}

export function createServer(ctx: Context) {
  const { client, index } = ctx;
  const server = new McpServer({ name: "trustmrr-revenue", version: VERSION });

  server.registerTool(
    "lookup_website_revenue",
    {
      title: "Look up a website's verified revenue",
      description:
        "Given one or more websites (URL or domain, e.g. 'postbridge.com' or 'https://www.shipfa.st/pricing'), " +
        "return the revenue TrustMRR has verified from the site's payment provider (Stripe etc.): last-30-day revenue, " +
        "MRR, all-time revenue, growth, profit margin, customers, team size and sale status. Money is in USD. " +
        "A site that isn't on TrustMRR has no verified revenue there; the result says whether the full catalogue was searched.",
      inputSchema: {
        websites: z.array(z.string().min(3)).min(1).max(10).describe("Websites or domains to look up (max 10)."),
        scan_budget_pages: z
          .number()
          .int()
          .min(0)
          .max(30)
          .optional()
          .describe(
            "How many catalogue pages (10 startups each, ~3.3s per page because of the API rate limit) to scan per unknown site. Default 6.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ websites, scan_budget_pages }) => {
      try {
        const results = [];
        for (const w of websites) {
          results.push(await index.lookup(client, w, { scanBudgetPages: scan_budget_pages ?? 6 }));
        }
        const text = results
          .map((r) =>
            r.found && r.startup ? line(r.startup) : `${r.domain ?? r.query}: not found. ${r.note ?? ""}`.trim(),
          )
          .join("\n\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            results: results.map((r) => ({
              query: r.query,
              domain: r.domain,
              found: r.found,
              matchedBy: r.matchedBy ?? null,
              note: r.note ?? null,
              startup: r.startup ? summarize(r.startup) : null,
            })),
          },
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "search_startups",
    {
      title: "Search startups by revenue and other filters",
      description:
        "Browse TrustMRR startups with verified revenue. Filters use plain USD and percentages (converted for you). " +
        "Use this to find e.g. solo-founder B2B SaaS above $5k MRR, fastest growers, or businesses for sale under a price.",
      inputSchema: {
        sort: z
          .enum([
            "revenue-desc", "revenue-asc", "growth-desc", "growth-asc", "price-desc", "price-asc",
            "multiple-asc", "multiple-desc", "listed-desc", "listed-asc", "best-deal",
          ])
          .optional(),
        category: z.string().optional().describe("e.g. saas, ai, ecommerce, fintech"),
        audience: z
          .enum(["B2B", "B2C"])
          .optional()
          .describe("Who the customers are. Filtered by this server, since the API has no such filter."),
        include_both: z
          .boolean()
          .optional()
          .describe("With audience set, also include startups that sell to both businesses and consumers. Default true."),
        team_size: z.enum(["1", "2-5", "6-10", "11-25", "26-50", "51+"]).optional(),
        funding_status: z.enum(["bootstrapped", "vc-funded"]).optional(),
        on_sale: z.boolean().optional(),
        founder_x_handle: z.string().optional().describe("Founder's X handle, without @"),
        min_mrr_usd: z.number().min(0).optional(),
        max_mrr_usd: z.number().min(0).optional(),
        min_revenue_30d_usd: z.number().min(0).optional(),
        max_revenue_30d_usd: z.number().min(0).optional(),
        min_growth_pct: z.number().optional().describe("30-day revenue growth, e.g. 10 for +10%"),
        max_growth_pct: z.number().optional(),
        min_price_usd: z.number().min(0).optional(),
        max_price_usd: z.number().min(0).optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(10).optional().describe("Results per page (API max 10). With audience set, it's a minimum target: every match on the pages read is returned."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        const cents = (v?: number) => (v == null ? undefined : Math.round(v * 100));
        const dec = (v?: number) => (v == null ? undefined : v / 100);
        const params = {
          sort: a.sort,
          category: a.category,
          teamSize: a.team_size,
          fundingStatus: a.funding_status,
          onSale: a.on_sale,
          xHandle: a.founder_x_handle?.replace(/^@/, ""),
          minMrr: cents(a.min_mrr_usd),
          maxMrr: cents(a.max_mrr_usd),
          minRevenue: cents(a.min_revenue_30d_usd),
          maxRevenue: cents(a.max_revenue_30d_usd),
          minGrowth: dec(a.min_growth_pct),
          maxGrowth: dec(a.max_growth_pct),
          minPrice: cents(a.min_price_usd),
          maxPrice: cents(a.max_price_usd),
        };
        const limit = a.limit ?? 10;

        if (!a.audience) {
          const { data, meta } = await client.listStartups({ ...params, page: a.page, limit });
          index.save();
          const header = `${meta?.total ?? data.length} startups match · page ${meta?.page ?? 1}${meta?.hasMore ? " (more available)" : ""}`;
          return {
            content: [{ type: "text", text: [header, ...data.map(line)].join("\n\n") }],
            structuredContent: { meta, startups: data.map(summarize) },
          };
        }

        // Audience filter: walk API pages (10 each) and keep matches, up to a page budget.
        const wanted = new Set([a.audience, ...(a.include_both === false ? [] : ["Both"])]);
        const MAX_PAGES = 6;
        const startPage = a.page ?? 1;
        const matches: Startup[] = [];
        let page = startPage;
        let scanned = 0;
        let total: number | null = null;
        let hasMore = true;
        while (matches.length < limit && hasMore && page < startPage + MAX_PAGES) {
          const { data, meta } = await client.listStartups({ ...params, page, limit: 10 });
          total = meta?.total ?? total;
          hasMore = !!meta?.hasMore && data.length > 0;
          scanned += data.length;
          for (const st of data) {
            const aud = audienceOf(st);
            if (aud && wanted.has(aud)) matches.push(st);
          }
          page++;
        }
        index.save();
        // Return every match from the pages read, so resuming at nextPage never skips any.
        const shown = matches;
        const nextPage = hasMore ? page : null;
        const header =
          `${shown.length} ${a.audience}${wanted.has("Both") ? " (incl. B2B+B2C)" : ""} startups ` +
          `from ${scanned} checked (API pages ${startPage}–${page - 1} of ${total ?? "?"} matching your other filters)` +
          (nextPage ? ` · for more, call again with page=${nextPage}` : " · no more results");
        return {
          content: [{ type: "text", text: [header, ...shown.map(line)].join("\n\n") }],
          structuredContent: {
            meta: { audience: a.audience, includeBoth: wanted.has("Both"), scanned, totalBeforeAudienceFilter: total, nextPage },
            startups: shown.map(summarize),
          },
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_startup",
    {
      title: "Get one startup by TrustMRR slug",
      description:
        "Full TrustMRR record for one startup by its slug (the last part of trustmrr.com/startup/<slug>), " +
        "including tech stack, marketing channels, insights and cofounders. Money values in the raw record are USD cents; " +
        "the summary is in USD.",
      inputSchema: { slug: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ slug }) => {
      try {
        const s = await client.getStartup(slug);
        index.save();
        if (!s) return { isError: true, content: [{ type: "text", text: `No TrustMRR startup with slug "${slug}".` }] };
        return {
          content: [{ type: "text", text: line(s) }],
          structuredContent: { summary: summarize(s), raw: s },
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "index_status",
    {
      title: "Domain index status",
      description: "How much of the TrustMRR catalogue has been indexed for website lookups.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const st = index.status();
      return { content: [{ type: "text", text: JSON.stringify(st, null, 2) }], structuredContent: st };
    },
  );

  return server;
}

export function configFromEnv(opts: { requireKey: boolean } = { requireKey: true }): Config {
  const apiKey = process.env.TRUSTMRR_API_KEY ?? "";
  if (!apiKey && opts.requireKey) {
    console.error(
      "TRUSTMRR_API_KEY is not set. Create a key at https://trustmrr.com/dashboard-dev and pass it as an env var.",
    );
    process.exit(1);
  }
  return {
    apiKey,
    baseUrl: process.env.TRUSTMRR_BASE_URL,
    indexPath: process.env.TRUSTMRR_INDEX_PATH,
    requestsPerMinute: process.env.TRUSTMRR_RPM ? Number(process.env.TRUSTMRR_RPM) : undefined,
  };
}
