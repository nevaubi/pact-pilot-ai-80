// Server-only: read-only access to a fixed allowlist of official public-law services for the Office
// assistant. No arbitrary URLs: https on port 443 only, no credentials, every redirect hop re-checked
// against the allowlist, one deadline covering headers AND body, and a byte cap on the body.
import { decodeEntities, htmlToText } from "./library.server";

export const PUBLIC_HOSTS: Record<string, string[]> = {
  "www.ecfr.gov": ["/current/", "/api/search/v1/", "/api/versioner/v1/"],
  "www.federalregister.gov": ["/d/", "/documents/", "/api/v1/documents"],
  "www.courtlistener.com": ["/opinion/", "/api/rest/v4/search/"],
  "www.govinfo.gov": ["/content/pkg/", "/app/details/"],
  "uscode.house.gov": ["/view.xhtml"],
  "www.ilga.gov": ["/legislation/ilcs/"],
  "www.law.cornell.edu": ["/uscode/text/", "/cfr/text/"],
};

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Is this URL on the public-law allowlist (host + path prefix), https, default port, no credentials? */
export function checkPublicUrl(raw: string, base?: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "Only https URLs are allowed." };
  if (u.username || u.password)
    return { ok: false, reason: "URLs with credentials are not allowed." };
  if (u.port && u.port !== "443")
    return { ok: false, reason: "Only the default https port is allowed." };
  const host = u.hostname.toLowerCase();
  const prefixes = PUBLIC_HOSTS[host];
  if (!prefixes)
    return {
      ok: false,
      reason: `Host ${host} is not on the public-law allowlist (${Object.keys(PUBLIC_HOSTS).join(", ")}).`,
    };
  if (!prefixes.some((p) => u.pathname.startsWith(p)))
    return { ok: false, reason: `That path on ${host} is not an allowed public-law page.` };
  return { ok: true, url: u };
}

export type SafeFetchResult =
  | {
      ok: true;
      status: number;
      finalUrl: string;
      contentType: string;
      body: string;
      truncated: boolean;
    }
  | {
      ok: false;
      status: number | null;
      reason: string;
      kind: "blocked" | "timeout" | "http" | "network";
    };

/** Fetch an allowlisted URL with manual, re-validated redirects and a single deadline incl. body. */
export async function safePublicFetch(
  raw: string,
  o: {
    signal?: AbortSignal;
    ms?: number;
    maxBytes?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<SafeFetchResult> {
  const ms = o.ms ?? 12_000;
  const maxBytes = o.maxBytes ?? 1_500_000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("deadline")), ms);
  const onAbort = () => ctl.abort(o.signal?.reason);
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let check = checkPublicUrl(raw);
    for (let hop = 0; hop <= 3; hop++) {
      if (!check.ok) return { ok: false, status: null, reason: check.reason, kind: "blocked" };
      const res = await fetch(check.url, {
        redirect: "manual",
        signal: ctl.signal,
        credentials: "omit",
        headers: {
          "User-Agent": "MirzaLawLibrary/1.0 (+public-law reader)",
          Accept: "text/html,application/json,application/xml;q=0.9,*/*;q=0.5",
          ...(o.headers ?? {}),
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc)
          return {
            ok: false,
            status: res.status,
            reason: "Redirect without a location.",
            kind: "http",
          };
        check = checkPublicUrl(loc, check.url.toString());
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, status: res.status, reason: `HTTP ${res.status}`, kind: "http" };
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      if (reader)
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (size + value.byteLength > maxBytes) {
            chunks.push(value.subarray(0, maxBytes - size));
            size = maxBytes;
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
          size += value.byteLength;
        }
      const buf = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.byteLength;
      }
      return {
        ok: true,
        status: res.status,
        finalUrl: check.url.toString(),
        contentType: res.headers.get("content-type") ?? "",
        body: new TextDecoder().decode(buf),
        truncated,
      };
    }
    return { ok: false, status: null, reason: "Too many redirects.", kind: "blocked" };
  } catch (e) {
    const timedOut = ctl.signal.aborted && !o.signal?.aborted;
    return {
      ok: false,
      status: null,
      reason: timedOut
        ? `No answer within ${ms / 1000}s.`
        : o.signal?.aborted
          ? "Stopped."
          : e instanceof Error
            ? e.message
            : "Network error.",
      kind: timedOut ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

export type ProviderStatus =
  "ok" | "no_results" | "rate_limited" | "unavailable" | "not_configured";
export type PublicHit = {
  provider: string;
  citation: string;
  title: string;
  url: string;
  snippet: string;
  date: string | null;
};
export type ProviderResult = {
  provider: string;
  status: ProviderStatus;
  detail?: string;
  results: PublicHit[];
};

const strip = (s: string | null | undefined) => decodeEntities((s ?? "").replace(/<[^>]+>/g, ""));

function failed(
  provider: string,
  r: Extract<SafeFetchResult, { ok: false }>,
  tokenless = false,
): ProviderResult {
  if (r.status === 429)
    return {
      provider,
      status: "rate_limited",
      detail: "Rate limited — try again later.",
      results: [],
    };
  if (tokenless && (r.status === 401 || r.status === 403))
    return {
      provider,
      status: "not_configured",
      detail:
        "CourtListener refused an anonymous request; a COURTLISTENER_API_TOKEN secret would be needed.",
      results: [],
    };
  return { provider, status: "unavailable", detail: r.reason, results: [] };
}

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

export async function ecfrSearch(q: string, signal?: AbortSignal): Promise<ProviderResult> {
  const p = "eCFR";
  const r = await safePublicFetch(
    `https://www.ecfr.gov/api/search/v1/results?${new URLSearchParams({ query: q, per_page: "8", order: "relevance" })}`,
    { ...(signal ? { signal } : {}) },
  );
  if (!r.ok) return failed(p, r);
  const j = parseJson<{
    results?: {
      starts_on?: string;
      hierarchy?: { title?: string; part?: string; section?: string | null };
      headings?: { section?: string | null; part?: string | null };
      full_text_excerpt?: string | null;
    }[];
  }>(r.body);
  if (!j)
    return { provider: p, status: "unavailable", detail: "Unexpected response.", results: [] };
  const results = (j.results ?? [])
    .filter((x) => x.hierarchy?.title && x.hierarchy?.part)
    .map((x) => {
      const t = x.hierarchy!.title!;
      const part = x.hierarchy!.part!;
      const sec = x.hierarchy!.section ?? null;
      const cite = sec ? `${t} CFR ${sec}` : `${t} CFR Part ${part}`;
      return {
        provider: p,
        citation: cite,
        title: strip(sec ? x.headings?.section : x.headings?.part) || cite,
        url: sec
          ? `https://www.ecfr.gov/current/title-${t}/section-${sec}`
          : `https://www.ecfr.gov/current/title-${t}/part-${part}`,
        snippet: strip(x.full_text_excerpt).slice(0, 300),
        date: x.starts_on ?? null,
      };
    });
  return { provider: p, status: results.length ? "ok" : "no_results", results };
}

export async function federalRegisterSearch(
  q: string,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  const p = "Federal Register";
  const qs = new URLSearchParams({ per_page: "8", order: "relevance" });
  qs.set("conditions[term]", q);
  for (const f of ["title", "type", "publication_date", "html_url", "document_number", "abstract"])
    qs.append("fields[]", f);
  const r = await safePublicFetch(`https://www.federalregister.gov/api/v1/documents.json?${qs}`, {
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) return failed(p, r);
  const j = parseJson<{
    results?: {
      title: string;
      type?: string;
      publication_date?: string;
      html_url?: string;
      document_number: string;
      abstract?: string | null;
    }[];
  }>(r.body);
  if (!j)
    return { provider: p, status: "unavailable", detail: "Unexpected response.", results: [] };
  const results = (j.results ?? []).map((d) => ({
    provider: p,
    citation: `${d.publication_date?.slice(0, 4) ?? ""} FR Doc. ${d.document_number}`.trim(),
    title: d.title,
    url: d.html_url ?? `https://www.federalregister.gov/d/${d.document_number}`,
    snippet: `${d.type ?? "Document"}${d.abstract ? ` — ${d.abstract.slice(0, 240)}` : ""}`,
    date: d.publication_date ?? null,
  }));
  return { provider: p, status: results.length ? "ok" : "no_results", results };
}

export async function courtListenerSearch(
  q: string,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  const p = "CourtListener";
  const token = process.env["COURTLISTENER_API_TOKEN"];
  const qs = new URLSearchParams({
    q,
    type: "o",
    order_by: "score desc",
    court: "ill illappct ca7 ilnd ilcd ilsd scotus",
  });
  const r = await safePublicFetch(`https://www.courtlistener.com/api/rest/v4/search/?${qs}`, {
    ...(signal ? { signal } : {}),
    ...(token ? { headers: { Authorization: `Token ${token}` } } : {}),
  });
  if (!r.ok) return failed(p, r, !token);
  const j = parseJson<{
    results?: {
      caseName: string;
      citation?: string[];
      court: string;
      dateFiled?: string;
      absolute_url: string;
      opinions?: { snippet?: string }[];
    }[];
  }>(r.body);
  if (!j)
    return { provider: p, status: "unavailable", detail: "Unexpected response.", results: [] };
  const results = (j.results ?? []).slice(0, 8).map((o) => ({
    provider: p,
    citation: o.citation?.[0] ?? o.caseName,
    title: `${o.caseName} (${o.court}${o.dateFiled ? `, ${o.dateFiled.slice(0, 4)}` : ""})`,
    url: `https://www.courtlistener.com${o.absolute_url}`,
    snippet: strip(o.opinions?.[0]?.snippet).slice(0, 300),
    date: o.dateFiled ?? null,
  }));
  return {
    provider: p,
    status: results.length ? "ok" : "no_results",
    ...(token ? {} : { detail: "Anonymous access (no API token configured); limits are lower." }),
    results,
  };
}

/** Each provider's outcome is reported separately; a failure is never presented as zero hits. */
export async function searchPublicLaw(q: string, signal?: AbortSignal): Promise<ProviderResult[]> {
  return Promise.all([
    ecfrSearch(q, signal),
    federalRegisterSearch(q, signal),
    courtListenerSearch(q, signal),
  ]);
}

/** Read one allowlisted public-law page as plain text (HTML/XML/JSON only; PDFs are not parsed here). */
export async function fetchPublicSource(url: string, signal?: AbortSignal, maxChars = 12_000) {
  const r = await safePublicFetch(url, { ...(signal ? { signal } : {}), maxBytes: 1_500_000 });
  if (!r.ok) return { error: r.reason, status: r.status, kind: r.kind };
  if (/pdf/i.test(r.contentType))
    return { error: "That source is a PDF; open it from the link instead.", finalUrl: r.finalUrl };
  const text = /json/i.test(r.contentType) ? r.body : htmlToText(r.body);
  return {
    url,
    finalUrl: r.finalUrl,
    text: text.slice(0, maxChars),
    truncated: r.truncated || text.length > maxChars,
    chars: text.length,
  };
}
