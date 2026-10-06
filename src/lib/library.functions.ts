import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Law-library server functions (auth-protected). Heavy helpers live in library.server.ts and are
// loaded inside handlers only so nothing server-side leaks into the client bundle.

const uuid = z.string().uuid();

/** Fetch (or re-fetch) one authority from its public source and index it. */
export const syncAuthority = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: uuid }).parse(d))
  .handler(async ({ data, context }) => {
    const { syncAuthority: run } = await import("./library.server");
    const { data: a, error } = await context.supabase.from("authorities").select("*").eq("id", data.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!a) throw new Error("Source not found.");
    await context.supabase.from("authorities").update({ status: "fetching", error: null }).eq("id", a.id);
    return run(context.supabase, a);
  });

/** Index text the browser extracted from a stored PDF (or an attorney-attached copy). */
export const indexAuthority = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; text: string; versionLabel?: string; storagePath?: string; mime?: string }) =>
    z
      .object({
        id: uuid,
        text: z.string().min(50).max(2_500_000),
        versionLabel: z.string().max(200).optional(),
        storagePath: z.string().max(300).optional(),
        mime: z.string().max(100).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { indexAuthorityText } = await import("./library.server");
    return indexAuthorityText(context.supabase, data.id, data.text, {
      ...(data.versionLabel ? { version_label: data.versionLabel } : {}),
      ...(data.storagePath ? { storage_path: data.storagePath } : {}),
      ...(data.mime ? { mime: data.mime } : {}),
    });
  });

/** Live search of public law services (fetch on request) plus the firm's own indexed library. */
export const searchPublicSources = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { query: string; providers?: string[] }) =>
    z
      .object({
        query: z.string().min(2).max(300),
        providers: z.array(z.enum(["ecfr", "federal_register", "courtlistener"])).max(3).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { searchEcfr, searchFederalRegister, searchCourtListener } = await import("./library.server");
    const want = new Set(data.providers ?? ["ecfr", "federal_register", "courtlistener"]);
    const errors: string[] = [];
    const safe = <T>(name: string, p: Promise<T[]>) =>
      p.catch((e) => {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        return [] as T[];
      });
    const [a, b, c] = await Promise.all([
      want.has("ecfr") ? safe("eCFR", searchEcfr(data.query)) : Promise.resolve([]),
      want.has("federal_register") ? safe("Federal Register", searchFederalRegister(data.query)) : Promise.resolve([]),
      want.has("courtlistener") ? safe("CourtListener", searchCourtListener(data.query)) : Promise.resolve([]),
    ]);
    return { hits: [...a, ...b, ...c], errors };
  });

/** Add a source found via search (or a pasted URL) to the library and fetch it right away. */
export const addAuthority = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      citation: string;
      title: string;
      url: string;
      source: string;
      jurisdiction: string;
      kind: string;
      topics: string[];
      meta?: Record<string, string>;
      fetch_url?: string;
      matterId?: string;
    }) =>
      z
        .object({
          citation: z.string().min(1).max(200),
          title: z.string().min(1).max(400),
          url: z.string().url().max(1000),
          source: z.enum(["ecfr", "uscode", "ilcs", "federal_register", "pdf", "html", "url"]),
          jurisdiction: z.enum(["federal", "illinois", "cook_county", "chicago", "other"]),
          kind: z.string().min(1).max(40),
          topics: z.array(z.string().max(40)).max(8),
          meta: z.record(z.string().max(200)).optional(),
          fetch_url: z.string().url().max(1000).optional(),
          matterId: uuid.optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { syncAuthority: run, sha256 } = await import("./library.server");
    const key = `user:${(await sha256(`${data.source}|${data.fetch_url ?? data.url}|${JSON.stringify(data.meta ?? {})}`)).slice(0, 24)}`;
    const existing = await context.supabase.from("authorities").select("*").eq("key", key).maybeSingle();
    let row = existing.data;
    if (!row) {
      const { data: ins, error } = await context.supabase
        .from("authorities")
        .insert({
          key,
          citation: data.citation,
          title: data.title,
          url: data.url,
          fetch_url: data.fetch_url ?? null,
          source: data.source,
          jurisdiction: data.jurisdiction,
          kind: data.kind,
          topics: data.topics,
          meta: data.meta ?? {},
          is_catalog: false,
          added_by: context.userId,
          status: "fetching",
        })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      row = ins;
    }
    if (data.matterId) {
      await context.supabase
        .from("matter_authorities")
        .upsert({ matter_id: data.matterId, authority_id: row.id }, { onConflict: "matter_id,authority_id", ignoreDuplicates: true });
    }
    const result = row.status === "ready" ? { status: "ready" as const, chars: row.text_chars, changed: false, updates: 0 } : await run(context.supabase, row);
    return { id: row.id, ...result };
  });
