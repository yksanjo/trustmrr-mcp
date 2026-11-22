// Thin TrustMRR REST client with a built-in rate limiter and 429 retry.
// API docs: https://trustmrr.com/docs/api  — all money values are USD cents.

export interface Revenue {
  last30Days: number | null;
  mrr: number | null;
  total: number | null;
}

export interface Startup {
  name: string;
  slug: string;
  icon?: string | null;
  description?: string | null;
  website?: string | null;
  country?: string | null;
  foundedDate?: string | null;
  category?: string | null;
  paymentProvider?: string | null;
  targetAudience?: string | null;
  revenue?: Revenue;
  customers?: number | null;
  activeSubscriptions?: number | null;
  askingPrice?: number | null;
  profitMarginLast30Days?: number | null;
  growth30d?: number | null;
  growthMRR30d?: number | null;
  multiple?: number | null;
  rank?: number | null;
  visitorsLast30Days?: number | null;
  googleSearchImpressionsLast30Days?: number | null;
  revenuePerVisitor?: number | null;
  domainRating?: number | null;
  onSale?: boolean;
  firstListedForSaleAt?: string | null;
  xHandle?: string | null;
  xFollowerCount?: number | null;
  startupInsights?: Record<string, unknown> | null;
  techStack?: { slug: string; category?: string }[];
  marketingChannels?: { slug: string; category?: string }[];
  cofounders?: { xHandle: string; xName?: string }[];
  [key: string]: unknown;
}

export interface ListMeta {
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface ListParams {
  page?: number;
  limit?: number;
  sort?: string;
  onSale?: boolean;
  category?: string;
  xHandle?: string;
  teamSize?: string;
  fundingStatus?: string;
  minRevenue?: number;
  maxRevenue?: number;
  minMrr?: number;
  maxMrr?: number;
  minGrowth?: number;
  maxGrowth?: number;
  minPrice?: number;
  maxPrice?: number;
}

export class TrustMrrError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TrustMrrClient {
  private baseUrl: string;
  private apiKey: string;
  private minIntervalMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  /** Called with every startup the client sees, so the domain index fills up for free. */
  onStartups?: (startups: Startup[]) => void;

  constructor(opts: { apiKey: string; baseUrl?: string; requestsPerMinute?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://trustmrr.com/api/v1").replace(/\/$/, "");
    // The API allows 20/min per key; default to 18 to leave headroom.
    this.minIntervalMs = Math.ceil(60_000 / (opts.requestsPerMinute ?? 18));
  }

  /** Serialises all requests so we never exceed the per-key rate limit. */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request<T>(path: string, attempt = 0): Promise<T> {
    const res = await this.schedule(() =>
      fetch(this.baseUrl + path, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      }),
    );

    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      let waitMs = 15_000 * (attempt + 1);
      if (retryAfter > 0) waitMs = retryAfter * 1000;
      else if (reset > 0) waitMs = Math.max(1000, (reset > 1e12 ? reset : reset * 1000) - Date.now());
      await sleep(Math.min(waitMs, 65_000));
      return this.request<T>(path, attempt + 1);
    }

    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new TrustMrrError(`TrustMRR returned non-JSON (HTTP ${res.status})`, res.status);
    }
    if (!res.ok) {
      const msg = body?.error ?? `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new TrustMrrError(`TrustMRR rejected the API key: ${msg}`, res.status);
      }
      throw new TrustMrrError(msg, res.status);
    }
    return body as T;
  }

  async listStartups(params: ListParams = {}): Promise<{ data: Startup[]; meta: ListMeta }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    const q = qs.toString();
    const body = await this.request<{ data: Startup[]; meta: ListMeta }>(`/startups${q ? `?${q}` : ""}`);
    this.onStartups?.(body.data ?? []);
    return body;
  }

  /** Returns null when the slug does not exist. */
  async getStartup(slug: string): Promise<Startup | null> {
    try {
      const body = await this.request<{ data: Startup }>(`/startups/${encodeURIComponent(slug)}`);
      if (body.data) this.onStartups?.([body.data]);
      return body.data ?? null;
    } catch (e) {
      if (e instanceof TrustMrrError && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }
}
