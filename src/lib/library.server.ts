// Server-only law-library helpers: fetch authoritative text from public law services,
// normalise it to plain text, chunk + index it for full-text search, and track updates.
// Never import from client code (loaded inside server-function handlers only).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables, Json } from "@/integrations/supabase/types";

type DB = SupabaseClient<Database>;
export type Authority = Tables<"authorities">;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 MirzaLawLibrary/1.0";
const TEXT_CAP = 2_000_000;
export const LIBRARY_BUCKET = "law-library";

export class FetchBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchBlocked";
  }
}

export async function fetchWithTimeout(url: string, ms = 20_000, init: RequestInit = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      redirect: "follow",
      signal: ctl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml,application/json,application/pdf;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    throw new FetchBlocked(
      /abort/i.test(m)
        ? "The site didn't answer in time (it may block automated downloads)."
        : `Couldn't reach the site (${m}).`,
    );
  } finally {
    clearTimeout(t);
  }
}

// ---------- text normalisation ----------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  sect: "§",
  para: "¶",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  copy: "©",
  reg: "®",
  deg: "°",
  frac12: "½",
  frac14: "¼",
  times: "×",
};

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

function tidy(s: string) {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Generic HTML → readable text. Keeps headings (as "## ") and list bullets; drops chrome. */
export function htmlToText(html: string): string {
  let h = html;
  const main = h.match(/<main[\s>][\s\S]*?<\/main>/i) ?? h.match(/<article[\s>][\s\S]*?<\/article>/i);
  if (main && main[0].length > 1500) h = main[0];
  else {
    const body = h.match(/<body[\s>][\s\S]*<\/body>/i);
    if (body) h = body[0];
  }
  h = h
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|form|button|select)[\s>][\s\S]*?<\/\1>/gi, " ")
    .replace(/<(h[1-6])[^>]*>/gi, "\n\n## ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|table|ul|ol|section|article|blockquote|dd|dt|pre|aside|figure)>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " ")
    .replace(/<\/(td|th)>/gi, " \t")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(h));
}

/** eCFR versioner XML → text with "## " headings for sections and paragraphs preserved. */
export function ecfrXmlToText(xml: string): string {
  let x = xml
    .replace(/<\?xml[^>]*>/g, "")
    .replace(/<HEAD>([\s\S]*?)<\/HEAD>/g, "\n\n## $1\n")
    .replace(/<HED>([\s\S]*?)<\/HED>/g, "\n\n## $1\n")
    .replace(/<(P|FP|PSPACE|EXAMPLE|NOTE|EXTRACT|CITA|AUTH|SOURCE)[^>]*>/g, "\n")
    .replace(/<\/(P|FP|PSPACE|EXAMPLE|NOTE|EXTRACT|CITA|AUTH|SOURCE)>/g, "\n")
    .replace(/<DIV\d[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "");
  x = decodeEntities(x);
  return tidy(x);
}

/** Cornell LII statute/regulation page → the statute text only. */
export function liiToText(html: string): string {
  const start = html.indexOf('id="tab_default_1"');
  if (start < 0) return htmlToText(html);
  const endIdx = html.indexOf('id="tab_default_2"', start);
  const slice = html.slice(start, endIdx > 0 ? endIdx : undefined);
  const title = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
  const body = htmlToText(`<main>${slice}</main>`);
  return tidy(`${title ? `## ${decodeEntities(title)}\n\n` : ""}${body}`);
}

/** ILGA section document page (…/ilcs/documents/{doc}.htm) → statute text. */
export function ilgaToText(html: string): string {
  const t = htmlToText(html);
  // ILGA pages repeat the chapter banner; keep from the first "Sec." or "(" statute line onward when present.
  const i = t.search(/\n\s*(Sec\.|Section)\s*\d/);
  return i > 0 ? tidy(t.slice(Math.max(0, t.lastIndexOf("\n", i - 1)))) : t;
}

export async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- chunking + indexing ----------

const CHUNK_TARGET = 1400;
const CHUNK_MAX = 2200;
const MAX_CHUNKS = 1600;

const HEADING_RE = /^(## |§\s?\d|Sec\.\s?\d|Section\s\d|Subpart\s[A-Z]|PART\s\d|Article\s[IVXLC\d]|\d+(\.\d+)*\s+[A-Z])/;

export function chunkText(text: string): { idx: number; heading: string | null; body: string }[] {
  const lines = text.split("\n");
  const out: { idx: number; heading: string | null; body: string }[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  let size = 0;
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body.length > 40) out.push({ idx: out.length, heading, body });
    buf = [];
    size = 0;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (size >= CHUNK_TARGET) flush();
      else if (buf.length) buf.push("");
      continue;
    }
    if (HEADING_RE.test(line) && line.length < 180) {
      if (size > 200) flush();
      heading = line.replace(/^## /, "");
    }
    // Hard-wrap very long paragraphs so a chunk never exceeds CHUNK_MAX.
    let rest = line;
    while (rest.length > CHUNK_MAX) {
      const cut = rest.lastIndexOf(". ", CHUNK_MAX) + 1 || CHUNK_MAX;
      buf.push(rest.slice(0, cut));
      flush();
      rest = rest.slice(cut).trim();
    }
    buf.push(rest);
    size += rest.length + 1;
    if (size >= CHUNK_MAX) flush();
    if (out.length >= MAX_CHUNKS) break;
  }
  flush();
  return out.slice(0, MAX_CHUNKS);
}

/** Replace the authority's text + search chunks. Marks the row ready. */
export async function indexAuthorityText(
  supabase: DB,
  id: string,
  text: string,
  patch: Database["public"]["Tables"]["authorities"]["Update"] = {},
) {
  const clean = tidy(text).slice(0, TEXT_CAP);
  const hash = await sha256(clean);
  const { data: cur } = await supabase.from("authorities").select("content_hash").eq("id", id).maybeSingle();
  const unchanged = cur?.content_hash === hash;
  if (!unchanged) {
    const chunks = chunkText(clean);
    const { error: delErr } = await supabase.from("authority_chunks").delete().eq("authority_id", id);
    if (delErr) throw new Error(delErr.message);
    for (let i = 0; i < chunks.length; i += 150) {
      const batch = chunks.slice(i, i + 150).map((c) => ({ authority_id: id, ...c }));
      const { error } = await supabase.from("authority_chunks").insert(batch);
      if (error) throw new Error(error.message);
    }
  }
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("authorities")
    .update({
      ...patch,
      text: clean,
      text_chars: clean.length,
      content_hash: hash,
      status: "ready",
      error: null,
      checked_at: now,
      ...(unchanged ? {} : { fetched_at: now }),
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
  return { chars: clean.length, changed: !unchanged };
}

// ---------- source adapters ----------

type Meta = Record<string, Json | undefined>;
const meta = (a: Authority) => (a.meta && typeof a.meta === "object" && !Array.isArray(a.meta) ? (a.meta as Meta) : {});
const str = (v: Json | undefined) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

let ecfrDates: Record<number, string> | undefined;
async function ecfrCurrentDate(title: number) {
  if (!ecfrDates) {
    const r = await fetchWithTimeout("https://www.ecfr.gov/api/versioner/v1/titles.json", 15_000);
    if (!r.ok) throw new Error(`eCFR titles lookup failed (${r.status})`);
    const j = (await r.json()) as { titles: { number: number; up_to_date_as_of: string | null }[] };
    ecfrDates = Object.fromEntries(j.titles.map((t) => [t.number, t.up_to_date_as_of ?? ""]));
  }
  return ecfrDates[title] || new Date().toISOString().slice(0, 10);
}

export type FetchOutcome =
  | { kind: "text"; text: string; fetchUrl: string; versionLabel: string | null; mime: string }
  | { kind: "binary"; bytes: ArrayBuffer; fetchUrl: string; versionLabel: string | null; mime: string };

async function fetchEcfr(a: Authority): Promise<FetchOutcome> {
  const m = meta(a);
  const title = Number(str(m["title"]));
  const part = str(m["part"]);
  const section = str(m["section"]);
  const subpart = str(m["subpart"]);
  if (!title || !part) throw new Error("eCFR entry is missing title/part.");
  const date = await ecfrCurrentDate(title);
  const qs = new URLSearchParams({ part });
  if (section) qs.set("section", section);
  if (subpart) qs.set("subpart", subpart);
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-${title}.xml?${qs}`;
  const r = await fetchWithTimeout(url, 40_000);
  if (r.ok) {
    const text = ecfrXmlToText(await r.text());
    if (text.length > 100)
      return { kind: "text", text, fetchUrl: url, versionLabel: `eCFR, current as of ${date}`, mime: "application/xml" };
  }
  // Fallback: Cornell LII mirror for a single section.
  if (section) {
    const lii = `https://www.law.cornell.edu/cfr/text/${title}/${section}`;
    const r2 = await fetchWithTimeout(lii, 20_000);
    if (r2.ok) {
      const text = liiToText(await r2.text());
      if (text.length > 100)
        return { kind: "text", text, fetchUrl: lii, versionLabel: "LII mirror of the CFR (eCFR unavailable)", mime: "text/html" };
    }
  }
  throw new Error(`eCFR returned ${r.status} for ${title} CFR ${section || part}.`);
}

async function fetchUscode(a: Authority): Promise<FetchOutcome> {
  const m = meta(a);
  const title = str(m["title"]);
  const section = str(m["section"]);
  if (!title || !section) throw new Error("U.S. Code entry is missing title/section.");
  const lii = `https://www.law.cornell.edu/uscode/text/${title}/${section}`;
  const r = await fetchWithTimeout(lii, 20_000);
  if (!r.ok) throw new Error(`Cornell LII returned ${r.status}.`);
  const text = liiToText(await r.text());
  if (text.length < 100) throw new Error("No statute text found on the page.");
  return { kind: "text", text, fetchUrl: lii, versionLabel: `LII (U.S. Code), fetched ${new Date().toISOString().slice(0, 10)}`, mime: "text/html" };
}

function ilcsDoc(chapter: string, act: string, section: string) {
  return `${chapter.padStart(4, "0")}${act.padStart(4, "0")}0K${section}`;
}

async function fetchIlcs(a: Authority): Promise<FetchOutcome> {
  const m = meta(a);
  const chapter = str(m["chapter"]);
  const act = str(m["act"]);
  const sections = Array.isArray(m["sections"]) ? (m["sections"] as Json[]).map((s) => String(s)) : [];
  if (!chapter || !act || !sections.length) throw new Error("ILCS entry is missing chapter/act/sections.");
  const parts: string[] = [];
  let first: string | null = null;
  for (const s of sections) {
    const doc = ilcsDoc(chapter, act, s);
    const urls = [
      `https://www.ilga.gov/documents/legislation/ilcs/documents/${doc}.htm`,
      `https://www.ilga.gov/legislation/ilcs/fulltext.asp?DocName=${doc}`,
    ];
    let got: string | null = null;
    let lastErr = "";
    for (const u of urls) {
      try {
        const r = await fetchWithTimeout(u, 12_000);
        if (r.ok) {
          const t = ilgaToText(await r.text());
          if (t.length > 80) {
            got = t;
            first ??= u;
            break;
          }
        } else lastErr = `HTTP ${r.status}`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (e instanceof FetchBlocked && !parts.length) throw e; // site unreachable: stop early
      }
    }
    if (got) parts.push(`## ${chapter} ILCS ${act}/${s}\n${got}`);
    else parts.push(`## ${chapter} ILCS ${act}/${s}\n[Section could not be fetched: ${lastErr || "no text"}]`);
  }
  const fetched = parts.filter((p) => !p.includes("[Section could not be fetched")).length;
  if (!fetched) throw new FetchBlocked("The Illinois General Assembly site did not return the statute text.");
  return {
    kind: "text",
    text: parts.join("\n\n"),
    fetchUrl: first ?? a.url,
    versionLabel: `ILGA (Illinois Compiled Statutes), fetched ${new Date().toISOString().slice(0, 10)}${fetched < sections.length ? ` — ${sections.length - fetched} section(s) missing` : ""}`,
    mime: "text/html",
  };
}

async function fetchFederalRegister(a: Authority): Promise<FetchOutcome> {
  const m = meta(a);
  const num = str(m["document_number"]);
  if (!num) throw new Error("Federal Register entry is missing document_number.");
  const r = await fetchWithTimeout(`https://www.federalregister.gov/api/v1/documents/${encodeURIComponent(num)}.json`, 20_000);
  if (!r.ok) throw new Error(`Federal Register returned ${r.status}.`);
  const j = (await r.json()) as { raw_text_url?: string; body_html_url?: string; publication_date?: string; title?: string };
  const src = j.raw_text_url ?? j.body_html_url;
  if (!src) throw new Error("No text available for this document.");
  const r2 = await fetchWithTimeout(src, 40_000);
  if (!r2.ok) throw new Error(`Federal Register text returned ${r2.status}.`);
  const raw = await r2.text();
  const text = /<html|<body|<div/i.test(raw.slice(0, 2000)) ? htmlToText(raw) : tidy(raw);
  return { kind: "text", text: `## ${j.title ?? a.title}\n\n${text}`, fetchUrl: src, versionLabel: `Federal Register ${j.publication_date ?? ""}`.trim(), mime: "text/plain" };
}

async function fetchUrl(a: Authority): Promise<FetchOutcome> {
  const url = a.fetch_url || a.url;
  const r = await fetchWithTimeout(url, 40_000);
  if (!r.ok) {
    if (r.status === 403 || r.status === 429)
      throw new FetchBlocked(`The site refused the automated download (HTTP ${r.status}).`);
    throw new Error(`The source returned HTTP ${r.status}.`);
  }
  const ct = (r.headers.get("content-type") ?? "").toLowerCase();
  const buf = await r.arrayBuffer();
  const head = new TextDecoder("latin1").decode(buf.slice(0, 5));
  const isPdf = head.startsWith("%PDF") || ct.includes("application/pdf") || a.source === "pdf";
  const stamp = r.headers.get("last-modified");
  const versionLabel = stamp ? `Published copy, last modified ${new Date(stamp).toISOString().slice(0, 10)}` : `Fetched ${new Date().toISOString().slice(0, 10)}`;
  if (isPdf) {
    if (!head.startsWith("%PDF")) throw new Error("The link did not return a PDF (the page may have moved).");
    return { kind: "binary", bytes: buf, fetchUrl: url, versionLabel, mime: "application/pdf" };
  }
  const html = new TextDecoder("utf-8").decode(buf);
  if (/just a moment|cf-browser-verification|access denied/i.test(html.slice(0, 4000)))
    throw new FetchBlocked("The site requires a browser check and blocks automated downloads.");
  const text = htmlToText(html);
  if (text.length < 200) throw new Error("The page had no readable text.");
  return { kind: "text", text, fetchUrl: url, versionLabel, mime: "text/html" };
}

export async function fetchSource(a: Authority): Promise<FetchOutcome> {
  switch (a.source) {
    case "ecfr":
      return fetchEcfr(a);
    case "uscode":
      return fetchUscode(a);
    case "ilcs":
      return fetchIlcs(a);
    case "federal_register":
      return fetchFederalRegister(a);
    default:
      return fetchUrl(a);
  }
}

/** Latest Federal Register documents affecting a CFR part (stored on authority_updates). */
export async function refreshFederalRegisterUpdates(supabase: DB, a: Authority) {
  const m = meta(a);
  if (a.source !== "ecfr") return 0;
  const title = str(m["title"]);
  const part = str(m["part"]);
  if (!title || !part) return 0;
  const qs = new URLSearchParams({ order: "newest", per_page: "8" });
  qs.set("conditions[cfr][title]", title);
  qs.set("conditions[cfr][part]", part);
  for (const f of ["title", "type", "publication_date", "html_url", "pdf_url", "document_number", "abstract", "effective_on", "agencies"]) qs.append("fields[]", f);
  const r = await fetchWithTimeout(`https://www.federalregister.gov/api/v1/documents.json?${qs}`, 20_000);
  if (!r.ok) return 0;
  const j = (await r.json()) as {
    results?: {
      document_number: string;
      title: string;
      type?: string;
      publication_date?: string;
      effective_on?: string | null;
      html_url?: string;
      pdf_url?: string;
      abstract?: string | null;
      agencies?: { name?: string }[];
    }[];
  };
  const rows = (j.results ?? []).map((d) => ({
    authority_id: a.id,
    document_number: d.document_number,
    title: d.title,
    doc_type: d.type ?? null,
    agency: d.agencies?.map((x) => x.name).filter(Boolean).join(", ") || null,
    publication_date: d.publication_date ?? null,
    effective_on: d.effective_on ?? null,
    html_url: d.html_url ?? null,
    pdf_url: d.pdf_url ?? null,
    abstract: d.abstract ?? null,
  }));
  if (!rows.length) return 0;
  const { error } = await supabase.from("authority_updates").upsert(rows, { onConflict: "authority_id,document_number" });
  if (error) console.error("[library] updates upsert:", error.message);
  return rows.length;
}

/**
 * Fetch one authority end to end. Text sources are indexed immediately; PDFs are stored in the
 * law-library bucket and left in status "stored" for the browser to extract and index.
 */
export async function syncAuthority(supabase: DB, a: Authority) {
  const now = new Date().toISOString();
  try {
    const out = await fetchSource(a);
    if (out.kind === "text") {
      const r = await indexAuthorityText(supabase, a.id, out.text, {
        fetch_url: out.fetchUrl,
        version_label: out.versionLabel,
        mime: out.mime,
      });
      const updates = await refreshFederalRegisterUpdates(supabase, a).catch(() => 0);
      return { status: "ready" as const, chars: r.chars, changed: r.changed, updates };
    }
    const path = `${a.id}.pdf`;
    const { error: upErr } = await supabase.storage
      .from(LIBRARY_BUCKET)
      .upload(path, out.bytes, { contentType: out.mime, upsert: true });
    if (upErr) throw new Error(`Couldn't store the PDF: ${upErr.message}`);
    const { error } = await supabase
      .from("authorities")
      .update({
        storage_path: path,
        mime: out.mime,
        fetch_url: out.fetchUrl,
        version_label: out.versionLabel,
        status: "stored",
        error: null,
        fetched_at: now,
        checked_at: now,
      })
      .eq("id", a.id);
    if (error) throw new Error(error.message);
    return { status: "stored" as const, bytes: out.bytes.byteLength };
  } catch (e) {
    const blocked = e instanceof FetchBlocked;
    const message = e instanceof Error ? e.message : String(e);
    await supabase
      .from("authorities")
      .update({ status: blocked ? "blocked" : "error", error: message, checked_at: now })
      .eq("id", a.id);
    return { status: blocked ? ("blocked" as const) : ("error" as const), message };
  }
}

// ---------- public-source search (fetch on request) ----------

export type SourceHit = {
  provider: "ecfr" | "federal_register" | "courtlistener" | "library";
  citation: string;
  title: string;
  url: string;
  snippet: string;
  date: string | null;
  jurisdiction: "federal" | "illinois";
  kind: string;
  add: { source: string; meta: Record<string, string>; fetch_url?: string } | null;
};

export async function searchEcfr(query: string): Promise<SourceHit[]> {
  const r = await fetchWithTimeout(
    `https://www.ecfr.gov/api/search/v1/results?${new URLSearchParams({ query, per_page: "10", order: "relevance" })}`,
    15_000,
  );
  if (!r.ok) return [];
  const j = (await r.json()) as {
    results?: {
      starts_on?: string;
      type?: string;
      hierarchy?: { title?: string; part?: string; section?: string | null; subpart?: string | null };
      headings?: { section?: string | null; part?: string | null; chapter?: string | null };
      full_text_excerpt?: string | null;
    }[];
  };
  const strip = (s: string | null | undefined) => decodeEntities((s ?? "").replace(/<[^>]+>/g, ""));
  return (j.results ?? [])
    .filter((x) => x.hierarchy?.title && x.hierarchy?.part)
    .map((x) => {
      const t = x.hierarchy!.title!;
      const part = x.hierarchy!.part!;
      const sec = x.hierarchy!.section ?? null;
      const cite = sec ? `${t} CFR ${sec}` : `${t} CFR Part ${part}`;
      return {
        provider: "ecfr" as const,
        citation: cite,
        title: strip(sec ? x.headings?.section : x.headings?.part) || cite,
        url: sec ? `https://www.ecfr.gov/current/title-${t}/section-${sec}` : `https://www.ecfr.gov/current/title-${t}/part-${part}`,
        snippet: strip(x.full_text_excerpt).slice(0, 300),
        date: x.starts_on ?? null,
        jurisdiction: "federal" as const,
        kind: "regulation",
        add: { source: "ecfr", meta: sec ? { title: t, part, section: sec } : { title: t, part } },
      };
    });
}

export async function searchFederalRegister(query: string): Promise<SourceHit[]> {
  const qs = new URLSearchParams({ per_page: "8", order: "relevance" });
  qs.set("conditions[term]", query);
  for (const f of ["title", "type", "publication_date", "html_url", "document_number", "abstract", "agencies"]) qs.append("fields[]", f);
  const r = await fetchWithTimeout(`https://www.federalregister.gov/api/v1/documents.json?${qs}`, 15_000);
  if (!r.ok) return [];
  const j = (await r.json()) as {
    results?: { title: string; type?: string; publication_date?: string; html_url?: string; document_number: string; abstract?: string | null; agencies?: { name?: string }[] }[];
  };
  return (j.results ?? []).map((d) => ({
    provider: "federal_register" as const,
    citation: `${d.publication_date?.slice(0, 4) ?? ""} FR Doc. ${d.document_number}`.trim(),
    title: d.title,
    url: d.html_url ?? `https://www.federalregister.gov/d/${d.document_number}`,
    snippet: `${d.type ?? "Document"}${d.agencies?.length ? ` · ${d.agencies.map((a) => a.name).filter(Boolean).join(", ")}` : ""}${d.abstract ? ` — ${d.abstract.slice(0, 240)}` : ""}`,
    date: d.publication_date ?? null,
    jurisdiction: "federal" as const,
    kind: d.type?.toLowerCase().includes("rule") ? "rule" : "notice",
    add: { source: "federal_register", meta: { document_number: d.document_number } },
  }));
}

const IL_FED_COURTS = "ill illappct ca7 ilnd ilcd ilsd scotus";

export async function searchCourtListener(query: string): Promise<SourceHit[]> {
  const qs = new URLSearchParams({ q: query, type: "o", order_by: "score desc", court: IL_FED_COURTS });
  const token = process.env["COURTLISTENER_API_TOKEN"];
  const r = await fetchWithTimeout(`https://www.courtlistener.com/api/rest/v4/search/?${qs}`, 15_000, {
    headers: token ? { Authorization: `Token ${token}` } : {},
  });
  if (!r.ok) return [];
  const j = (await r.json()) as {
    results?: {
      caseName: string;
      citation?: string[];
      court: string;
      court_id?: string;
      dateFiled?: string;
      absolute_url: string;
      opinions?: { snippet?: string; download_url?: string | null }[];
    }[];
  };
  return (j.results ?? []).slice(0, 8).map((o) => {
    const page = `https://www.courtlistener.com${o.absolute_url}`;
    const dl = o.opinions?.[0]?.download_url ?? null;
    const isIl = /^ill/.test(o.court_id ?? "");
    return {
      provider: "courtlistener" as const,
      citation: o.citation?.[0] ?? o.caseName,
      title: `${o.caseName} (${o.court}${o.dateFiled ? `, ${o.dateFiled.slice(0, 4)}` : ""})`,
      url: page,
      snippet: decodeEntities((o.opinions?.[0]?.snippet ?? "").replace(/<[^>]+>/g, "")).slice(0, 300),
      date: o.dateFiled ?? null,
      jurisdiction: isIl ? ("illinois" as const) : ("federal" as const),
      kind: "case",
      add: { source: dl ? "pdf" : "html", meta: {}, fetch_url: dl ?? page },
    };
  });
}

// ---------- passages for AI grounding ----------

export type Passage = {
  ref: string;
  authority_id: string;
  citation: string;
  title: string;
  url: string;
  version: string | null;
  heading: string | null;
  body: string;
};

/** Ranked library passages for a set of queries, de-duplicated and capped by characters. */
export async function libraryPassages(
  supabase: DB,
  queries: string[],
  o: { topic?: string; ids?: string[]; charBudget: number; perQuery?: number },
): Promise<Passage[]> {
  const seen = new Set<string>();
  const out: Passage[] = [];
  let used = 0;
  for (const q of queries.filter(Boolean)) {
    const { data, error } = await supabase.rpc("search_authorities", {
      q,
      ...(o.topic ? { topic: o.topic } : {}),
      ...(o.ids ? { ids: o.ids } : {}),
      lim: o.perQuery ?? 6,
    });
    if (error) {
      console.error("[library] search:", error.message);
      continue;
    }
    for (const row of data ?? []) {
      const key = `${row.authority_id}:${row.chunk_idx}`;
      if (seen.has(key)) continue;
      if (used + row.body.length > o.charBudget) continue;
      seen.add(key);
      used += row.body.length;
      out.push({
        ref: `S${out.length + 1}`,
        authority_id: row.authority_id,
        citation: row.citation,
        title: row.title,
        url: row.url,
        version: row.version_label,
        heading: row.heading,
        body: row.body,
      });
    }
    if (used >= o.charBudget) break;
  }
  return out;
}

export function renderPassages(p: Passage[]) {
  if (!p.length) return "SOURCES: none available in the firm's library for this topic.";
  return `SOURCES (quote verbatim and cite by tag):\n${p
    .map((x) => `[${x.ref}] ${x.citation} — ${x.title}${x.heading ? ` › ${x.heading}` : ""}${x.version ? ` (${x.version})` : ""}\n${x.body}`)
    .join("\n\n")}`;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** True when `quote` appears verbatim (whitespace/quote-mark insensitive) in the passage with that ref. */
export function quoteVerified(passages: Passage[], ref: string | null | undefined, quote: string | null | undefined) {
  if (!ref || !quote) return false;
  const p = passages.find((x) => x.ref === ref.replace(/[[\]]/g, ""));
  if (!p) return false;
  const q = norm(quote).replace(/^[.…\s]+|[.…\s]+$/g, "");
  if (q.length < 12) return false;
  return norm(p.body).includes(q);
}
