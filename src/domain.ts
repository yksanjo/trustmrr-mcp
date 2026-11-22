// Domain normalisation and slug guessing.

// Common multi-part public suffixes; enough for a naive "base domain" without a full PSL.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp",
  "co.kr", "co.in", "com.br", "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "co.za",
  "com.cn", "com.tw", "co.id", "com.my", "com.ph", "com.vn", "com.ua", "com.pl", "co.il",
]);

/** "https://www.Foo.com/pricing?x=1" -> "foo.com". Returns null if it can't be parsed. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  try {
    let host = new URL(s).hostname.replace(/\.$/, "");
    host = host.replace(/^www\d*\./, "");
    if (!host.includes(".")) return null;
    return host;
  } catch {
    return null;
  }
}

/** "app.foo.co.uk" -> "foo.co.uk" */
export function baseDomain(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
  return lastTwo;
}

/** True when both refer to the same site (exact host or same base domain). */
export function sameSite(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || baseDomain(a) === baseDomain(b);
}

/** Cheap guesses at a TrustMRR slug from a domain: "post-bridge.com" -> ["post-bridge", "postbridge"]. */
export function slugGuesses(host: string): string[] {
  const base = baseDomain(host);
  const suffixLen = base.split(".").length - 1;
  const label = base.split(".").slice(0, -suffixLen).join("-");
  const out = new Set<string>();
  const clean = label.replace(/[^a-z0-9-]/g, "");
  if (clean) out.add(clean);
  const stripped = clean.replace(/(^get-?|^try-?|^use-?|-?app$|-?hq$)/g, "");
  if (stripped && stripped !== clean) out.add(stripped);
  if (clean.includes("-")) out.add(clean.replace(/-/g, ""));
  return [...out].slice(0, 3);
}
