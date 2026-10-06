// Client-side law-library helpers: labels, queries and the browser-orchestrated sync loop.
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { extractText } from "@/lib/extract";
import { syncAuthority, indexAuthority } from "@/lib/library.functions";

export type AuthorityRow = Omit<Tables<"authorities">, "text">;

export const TOPICS = [
  ["real_estate", "Real estate"],
  ["tax", "Tax"],
  ["entity", "Entities"],
  ["estate_planning", "Estate planning"],
  ["finance", "Finance"],
  ["compliance", "Compliance"],
] as const;
export type Topic = (typeof TOPICS)[number][0];
export const topicLabel = (t: string) => TOPICS.find((x) => x[0] === t)?.[1] ?? t;

export const JURISDICTIONS = [
  ["federal", "Federal"],
  ["illinois", "Illinois"],
  ["cook_county", "Cook County"],
  ["chicago", "Chicago"],
  ["other", "Other"],
] as const;
export const jurisdictionLabel = (j: string) => JURISDICTIONS.find((x) => x[0] === j)?.[1] ?? j;

export const KINDS: Record<string, string> = {
  statute: "Statute",
  regulation: "Regulation",
  guidance: "Guidance",
  form: "Form",
  rule: "Rule",
  notice: "Notice",
  case: "Opinion",
  ordinance: "Ordinance",
};

/** Practice area → library topic, for matter-scoped defaults. */
export const practiceTopic: Record<string, Topic> = {
  "Real Estate": "real_estate",
  Corporate: "entity",
  "Estate Planning": "estate_planning",
  Finance: "finance",
  Compliance: "compliance",
};

export const STALE_DAYS = 30;
export const isStale = (a: { checked_at: string | null }) =>
  !a.checked_at || Date.now() - new Date(a.checked_at).getTime() > STALE_DAYS * 86_400_000;

const COLS =
  "id,key,jurisdiction,kind,source,citation,title,topics,url,fetch_url,storage_path,mime,text_chars,summary,version_label,fetched_at,checked_at,status,error,content_hash,is_catalog,added_by,meta,created_at,updated_at";

async function q<T>(p: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

export const authoritiesQ = queryOptions({
  queryKey: ["authorities"],
  queryFn: () => q<AuthorityRow[]>(supabase.from("authorities").select(COLS).order("jurisdiction").order("citation")),
  staleTime: 30_000,
});

export const authorityTextQ = (id: string) =>
  queryOptions({
    queryKey: ["authority-text", id],
    queryFn: () => q<{ text: string | null }>(supabase.from("authorities").select("text").eq("id", id).single()),
  });

export const authorityUpdatesQ = (id: string) =>
  queryOptions({
    queryKey: ["authority-updates", id],
    queryFn: () =>
      q(supabase.from("authority_updates").select("*").eq("authority_id", id).order("publication_date", { ascending: false }).limit(8)),
  });

export const matterAuthoritiesQ = (matterId: string) =>
  queryOptions({
    queryKey: ["matter_authorities", matterId],
    queryFn: () =>
      q(
        supabase
          .from("matter_authorities")
          .select(`id,note,created_at,authorities(${COLS})`)
          .eq("matter_id", matterId)
          .order("created_at", { ascending: false }),
      ),
  });

export type SearchHit = {
  authority_id: string;
  chunk_idx: number;
  heading: string | null;
  snippet: string;
  body: string;
  rank: number;
  citation: string;
  title: string;
  jurisdiction: string;
  url: string;
  version_label: string | null;
};

export const librarySearchQ = (query: string, topic?: string, jur?: string, ids?: string[]) =>
  queryOptions({
    queryKey: ["library-search", query, topic ?? null, jur ?? null, ids ?? null],
    queryFn: () =>
      q<SearchHit[]>(
        supabase.rpc("search_authorities", {
          q: query,
          ...(topic ? { topic } : {}),
          ...(jur ? { jur } : {}),
          ...(ids ? { ids } : {}),
          lim: 30,
        }),
      ),
    enabled: query.trim().length >= 2,
  });

// ---------- sync loop (browser orchestrated so PDFs can be read here) ----------

export type SyncProgress = { done: number; total: number; current: string | null; failures: string[] };

async function extractStoredPdf(path: string) {
  const { data, error } = await supabase.storage.from("law-library").download(path);
  if (error || !data) throw new Error(error?.message ?? "Couldn't download the stored PDF.");
  const text = await extractText(new File([data], "source.pdf", { type: "application/pdf" }), 250);
  return text;
}

/** Fetch + index one authority end to end, including browser-side PDF text extraction. */
export async function syncOne(a: Pick<AuthorityRow, "id" | "citation">) {
  const r = await syncAuthority({ data: { id: a.id } });
  if (r.status === "stored") {
    const { data: row } = await supabase.from("authorities").select("storage_path").eq("id", a.id).single();
    if (!row?.storage_path) throw new Error("Stored PDF path missing.");
    const text = await extractStoredPdf(row.storage_path);
    if (text.trim().length < 200) {
      await supabase
        .from("authorities")
        .update({ status: "error", error: "The PDF has no readable text (scanned image). Attach a text copy." })
        .eq("id", a.id);
      throw new Error(`${a.citation}: PDF has no readable text.`);
    }
    await indexAuthority({ data: { id: a.id, text } });
    return { status: "ready" as const };
  }
  if (r.status === "blocked" || r.status === "error") throw new Error(`${a.citation}: ${r.message}`);
  return r;
}

/** Run the sync for many authorities with small concurrency. Calls onProgress after each item. */
export async function syncMany(
  items: Pick<AuthorityRow, "id" | "citation">[],
  onProgress: (p: SyncProgress) => void,
  signal?: AbortSignal,
  concurrency = 2,
) {
  const p: SyncProgress = { done: 0, total: items.length, current: null, failures: [] };
  let i = 0;
  const worker = async () => {
    while (i < items.length && !signal?.aborted) {
      const a = items[i++]!;
      p.current = a.citation;
      onProgress({ ...p });
      try {
        await syncOne(a);
      } catch (e) {
        p.failures.push(e instanceof Error ? e.message : String(e));
      }
      p.done++;
      onProgress({ ...p });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  p.current = null;
  onProgress({ ...p });
  return p;
}

/** Items the automatic refresh should touch: never fetched, stale, or last attempt failed. */
export function needsSync(rows: AuthorityRow[], all = false) {
  return rows.filter((a) =>
    all
      ? a.status !== "fetching"
      : a.status === "pending" || a.status === "stored" || ((a.status === "ready" || a.status === "error") && isStale(a)),
  );
}

export function statusLabel(a: Pick<AuthorityRow, "status">) {
  return (
    {
      ready: "Ready",
      stored: "Stored — reading text",
      pending: "Not fetched yet",
      fetching: "Fetching…",
      blocked: "Blocked by site",
      error: "Fetch failed",
    } as Record<string, string>
  )[a.status] ?? a.status;
}
