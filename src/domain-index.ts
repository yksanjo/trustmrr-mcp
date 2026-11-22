// Persistent domain -> slug index. The TrustMRR API has no "find by website" filter,
// so we learn the mapping from every startup we see and, when needed, page through
// the catalogue (largest revenue first) to find unknown domains.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Startup, TrustMrrClient } from "./client.js";
import { baseDomain, normalizeDomain, sameSite, slugGuesses } from "./domain.js";

interface IndexFile {
  version: 1;
  domains: Record<string, string>; // host or base domain -> slug
  scanNextPage: number;
  scanComplete: boolean;
  scanStartedAt: string | null;
  scanCompletedAt: string | null;
  catalogueTotal: number | null;
}

const PAGE_SIZE = 10; // API maximum
const RESCAN_AFTER_MS = 7 * 24 * 3600 * 1000;

export interface LookupResult {
  query: string;
  domain: string | null;
  found: boolean;
  startup?: Startup;
  matchedBy?: "index" | "slug-guess" | "scan";
  note?: string;
}

export class DomainIndex {
  private data: IndexFile;
  private dirty = false;
  private scanLock: Promise<void> = Promise.resolve();

  constructor(private path: string) {
    this.data = this.load();
    // If the last full scan is stale, start a fresh pass (existing entries are kept).
    if (
      this.data.scanComplete &&
      this.data.scanCompletedAt &&
      Date.now() - Date.parse(this.data.scanCompletedAt) > RESCAN_AFTER_MS
    ) {
      this.data.scanComplete = false;
      this.data.scanNextPage = 1;
      this.data.scanStartedAt = null;
    }
  }

  /** Feed every startup a client sees into this index. */
  attach(client: TrustMrrClient): void {
    client.onStartups = (s) => this.learn(s);
  }

  private load(): IndexFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed?.version === 1) return parsed;
    } catch {
      /* first run */
    }
    return {
      version: 1,
      domains: {},
      scanNextPage: 1,
      scanComplete: false,
      scanStartedAt: null,
      scanCompletedAt: null,
      catalogueTotal: null,
    };
  }

  save(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch (e) {
      console.error(`[trustmrr-mcp] could not save index: ${(e as Error).message}`);
    }
  }

  learn(startups: Startup[]): void {
    for (const s of startups) {
      const host = normalizeDomain(s.website);
      if (!host || !s.slug) continue;
      if (this.data.domains[host] !== s.slug) {
        this.data.domains[host] = s.slug;
        this.dirty = true;
      }
      // Also map the base domain, unless another startup already owns it.
      const base = baseDomain(host);
      if (base !== host && !this.data.domains[base]) {
        this.data.domains[base] = s.slug;
        this.dirty = true;
      }
    }
  }

  status() {
    const scanned = Math.min(
      (this.data.scanNextPage - 1) * PAGE_SIZE,
      this.data.catalogueTotal ?? Infinity,
    );
    return {
      indexedDomains: Object.keys(this.data.domains).length,
      catalogueTotal: this.data.catalogueTotal,
      scannedStartups: this.data.scanComplete ? this.data.catalogueTotal : scanned,
      scanComplete: this.data.scanComplete,
      scanCompletedAt: this.data.scanCompletedAt,
      indexPath: this.path,
    };
  }

  private slugFor(host: string): string | undefined {
    return this.data.domains[host] ?? this.data.domains[baseDomain(host)];
  }

  /**
   * Scan up to `maxPages` more catalogue pages. Stops early if `stopWhen` returns true.
   * Serialised so concurrent lookups don't double-scan.
   */
  scan(client: TrustMrrClient, maxPages: number, stopWhen?: () => boolean): Promise<void> {
    const run = this.scanLock.then(async () => {
      for (let i = 0; i < maxPages && !this.data.scanComplete; i++) {
        if (stopWhen?.()) break;
        if (!this.data.scanStartedAt) this.data.scanStartedAt = new Date().toISOString();
        const page = this.data.scanNextPage;
        const { meta, data } = await client.listStartups({
          page,
          limit: PAGE_SIZE,
          sort: "revenue-desc",
        });
        // learn() already ran via onStartups
        this.data.catalogueTotal = meta?.total ?? this.data.catalogueTotal;
        this.data.scanNextPage = page + 1;
        if (!meta?.hasMore || data.length === 0) {
          this.data.scanComplete = true;
          this.data.scanCompletedAt = new Date().toISOString();
        }
        this.dirty = true;
        if (i % 5 === 4) this.save();
      }
      this.save();
    });
    this.scanLock = run.catch(() => undefined);
    return run;
  }

  async lookup(
    client: TrustMrrClient,
    query: string,
    opts: { scanBudgetPages: number },
  ): Promise<LookupResult> {
    const domain = normalizeDomain(query);
    if (!domain) return { query, domain: null, found: false, note: "Not a valid website or domain." };

    // 1. Known mapping.
    const known = this.slugFor(domain);
    if (known) {
      const s = await client.getStartup(known);
      if (s && sameSite(normalizeDomain(s.website), domain)) {
        return { query, domain, found: true, startup: s, matchedBy: "index" };
      }
      // Stale entry: the startup was removed or changed domain.
      delete this.data.domains[domain];
      delete this.data.domains[baseDomain(domain)];
      this.dirty = true;
    }

    // 2. Guess the slug from the domain name.
    for (const guess of slugGuesses(domain)) {
      if (guess === known) continue;
      const s = await client.getStartup(guess);
      if (s && sameSite(normalizeDomain(s.website), domain)) {
        this.save();
        return { query, domain, found: true, startup: s, matchedBy: "slug-guess" };
      }
    }

    // 3. Keep paging through the catalogue until we see the domain or run out of budget.
    if (!this.data.scanComplete && opts.scanBudgetPages > 0) {
      await this.scan(client, opts.scanBudgetPages, () => !!this.slugFor(domain));
      const slug = this.slugFor(domain);
      if (slug) {
        const s = await client.getStartup(slug);
        if (s) return { query, domain, found: true, startup: s, matchedBy: "scan" };
      }
    }

    this.save();
    const st = this.status();
    return {
      query,
      domain,
      found: false,
      note: st.scanComplete
        ? "This website is not listed on TrustMRR (searched the full catalogue). It has no verified revenue there."
        : `Not found yet. Searched ${st.scannedStartups ?? 0} of ${st.catalogueTotal ?? "?"} startups ` +
          `(largest revenue first, so smaller sites are reached later). Call again to keep searching, ` +
          `or run \`npm run warm-index\` once to index everything.`,
    };
  }
}
