import { supabase } from "@/integrations/supabase/client";
import { queryOptions } from "@tanstack/react-query";
import type { Tables } from "@/integrations/supabase/types";

export const PRACTICE_AREAS = ["Corporate", "Real Estate", "Estate Planning", "Finance", "Compliance"] as const;
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
  queryOptions({ queryKey: ["matter", id], queryFn: () => q(supabase.from("matters").select("*").eq("id", id).single()) });
export const tableQ = <T extends "tasks" | "deadlines" | "notes" | "files" | "drafts" | "closing_items" | "activity">(
  table: T,
  matterId: string,
) =>
  queryOptions({
    queryKey: [table, matterId],
    queryFn: () => {
      const order = table === "closing_items" ? "position" : table === "deadlines" ? "due_on" : "created_at";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = supabase.from(table as any) as any;
      return q<Tables<T>[]>(t.select("*").eq("matter_id", matterId).order(order, { ascending: order !== "created_at" }));
    },
  });
export const matterContactsQ = (matterId: string) =>
  queryOptions({
    queryKey: ["matter_contacts", matterId],
    queryFn: () => q(supabase.from("matter_contacts").select("id,relationship,contacts(*)").eq("matter_id", matterId)),
  });
export const contactsQ = queryOptions({
  queryKey: ["contacts"],
  queryFn: () => q(supabase.from("contacts").select("*").order("name")),
});
export const templatesQ = queryOptions({
  queryKey: ["templates"],
  queryFn: () => q(supabase.from("templates").select("*").order("name")),
});

export async function logActivity(matterId: string | null, message: string) {
  const { data } = await supabase.auth.getUser();
  await supabase.from("activity").insert({ matter_id: matterId, message, actor: data.user?.email?.split("@")[0] ?? "user" });
}

export function fmtDate(d?: string | null) {
  if (!d) return "—";
  return new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
export function daysUntil(d: string) {
  const t = new Date(d + "T00:00:00").getTime();
  const now = new Date(new Date().toDateString()).getTime();
  return Math.round((t - now) / 86400000);
}
