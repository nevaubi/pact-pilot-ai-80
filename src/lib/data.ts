import { supabase } from "@/integrations/supabase/client";
import { queryOptions } from "@tanstack/react-query";
import type { Tables } from "@/integrations/supabase/types";

export const PRACTICE_AREAS = [
  "Corporate",
  "Real Estate",
  "Estate Planning",
  "Finance",
  "Compliance",
] as const;
export const STATUSES = ["Intake", "Active", "Closing", "On hold", "Closed"] as const;

export const practiceInk: Record<string, string> = {
  Corporate: "text-ink-blue bg-ink-blue/10",
  "Real Estate": "text-ink-green bg-ink-green/10",
  "Estate Planning": "text-ink-purple bg-ink-purple/10",
  Finance: "text-ink-amber bg-ink-amber/10",
  Compliance: "text-ink-teal bg-ink-teal/10",
};

async function q<T>(p: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

export const mattersQ = queryOptions({
  queryKey: ["matters"],
  queryFn: () => q(supabase.from("matters").select("*").order("created_at", { ascending: false })),
});
export const matterQ = (id: string) =>
  queryOptions({
    queryKey: ["matter", id],
    queryFn: () =>
      q<Tables<"matters"> | null>(supabase.from("matters").select("*").eq("id", id).maybeSingle()),
  });
export const tableQ = <
  T extends "tasks" | "deadlines" | "notes" | "files" | "drafts" | "closing_items" | "activity",
>(
  table: T,
  matterId: string,
) =>
  queryOptions({
    queryKey: [table, matterId],
    queryFn: () => {
      const order =
        table === "closing_items" ? "position" : table === "deadlines" ? "due_on" : "created_at";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = supabase.from(table as any) as any;
      return q<Tables<T>[]>(
        t
          .select("*")
          .eq("matter_id", matterId)
          .order(order, { ascending: order !== "created_at" }),
      );
    },
  });
export const matterContactsQ = (matterId: string) =>
  queryOptions({
    queryKey: ["matter_contacts", matterId],
    queryFn: () =>
      q(
        supabase
          .from("matter_contacts")
          .select("id,relationship,contacts(*)")
          .eq("matter_id", matterId),
      ),
  });
export const contactsQ = queryOptions({
  queryKey: ["contacts"],
  queryFn: () => q(supabase.from("contacts").select("*").order("name")),
});
export const templatesQ = queryOptions({
  queryKey: ["templates"],
  queryFn: () => q(supabase.from("templates").select("*").order("name")),
});
/** Persisted AI reviews (tax flags, title/survey review) for a matter, newest first. */
export const reviewsQ = (matterId: string, kind: string) =>
  queryOptions({
    queryKey: ["reviews", matterId, kind],
    queryFn: () =>
      q(
        supabase
          .from("reviews")
          .select("*")
          .eq("matter_id", matterId)
          .eq("kind", kind)
          .order("created_at", { ascending: false })
          .limit(20),
      ),
  });
export const propertyQ = (matterId: string) =>
  queryOptions({
    queryKey: ["property", matterId],
    queryFn: () =>
      q<Tables<"matter_properties"> | null>(
        supabase.from("matter_properties").select("*").eq("matter_id", matterId).maybeSingle(),
      ),
  });

let actorCache: { id: string; name: string } | null = null;

/** Display name for the signed-in user: profile full name, else the email's local part. */
export async function currentActor(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const u = data.user;
  if (!u) return "user";
  if (actorCache?.id === u.id) return actorCache.name;
  const { data: p } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", u.id)
    .maybeSingle();
  const name =
    p?.full_name?.trim() ||
    (u.user_metadata?.["full_name"] as string | undefined)?.trim() ||
    u.email?.split("@")[0] ||
    "user";
  actorCache = { id: u.id, name };
  return name;
}

/** Best-effort audit line. Never throws — the action it describes already succeeded. */
export async function logActivity(matterId: string | null, message: string) {
  try {
    const actor = await currentActor();
    await supabase.from("activity").insert({ matter_id: matterId, message, actor });
  } catch {
    /* activity is informational */
  }
}

/** Next sequential matter number for the current year, e.g. 2026-015. */
export async function nextMatterNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const { data } = await supabase.from("matters").select("number").like("number", `${year}-%`);
  const max = (data ?? []).reduce((m, r) => {
    const n = Number((r.number ?? "").split("-")[1]);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `${year}-${String(max + 1).padStart(3, "0")}`;
}

export function fmtDate(d?: string | null) {
  if (!d) return "—";
  return new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
export function fmtDateTime(d: string) {
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
export function daysUntil(d: string) {
  const t = new Date(d + "T00:00:00").getTime();
  const now = new Date(new Date().toDateString()).getTime();
  return Math.round((t - now) / 86400000);
}
/** "3d", "Today", "2d late" — shared by every deadline list. */
export function dueLabel(d: string) {
  const n = daysUntil(d);
  return {
    n,
    label: n < 0 ? `${-n}d late` : n === 0 ? "Today" : `${n}d`,
    tone: n < 0 ? "text-ink-red" : n <= 7 ? "text-ink-amber" : "text-muted-foreground",
  };
}
export const todayISO = () => new Date().toISOString().slice(0, 10);
