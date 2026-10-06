import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Panel, ListState, Confirm } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { mut, tryAction } from "@/lib/mutate";

const SOURCE_LABEL: Record<string, string> = {
  boundary: "Page crashed",
  window: "Script error",
  promise: "Background failure",
  office: "Document editor",
  save: "Save failed",
  ai: "AI request",
  manual: "Reported",
};

const PAGE_LABEL = (route: string) => {
  if (route.startsWith("/office/")) return "Document editor";
  if (route.startsWith("/matters/")) return "Matter";
  if (route.startsWith("/matters")) return "Matters";
  if (route.startsWith("/library")) return "Law library";
  if (route.startsWith("/templates")) return "Templates";
  if (route.startsWith("/files")) return "Files";
  if (route.startsWith("/contacts")) return "Contacts";
  if (route.startsWith("/settings")) return "Settings";
  if (route.startsWith("/today")) return "Today";
  return route;
};

type Row = {
  id: string;
  created_at: string;
  route: string;
  source: string;
  message: string;
  stack: string | null;
  context: unknown;
  user_agent: string | null;
  user_id: string;
};

/** The firm's error log: what broke, where, and when — reviewable without developer tools. */
export function ErrorLogPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["client-errors"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("client_errors")
        .select("id, created_at, route, source, message, stack, context, user_agent, user_id")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return data as Row[];
    },
  });
  const last7 = (q.data ?? []).filter((r) => Date.now() - new Date(r.created_at).getTime() < 7 * 864e5).length;

  function details(r: Row) {
    const ctx = r.context && typeof r.context === "object" ? JSON.stringify(r.context) : "";
    return [
      `When: ${new Date(r.created_at).toISOString()}`,
      `Where: ${r.route} (${SOURCE_LABEL[r.source] ?? r.source})`,
      `Message: ${r.message}`,
      ctx && ctx !== "{}" ? `Context: ${ctx}` : "",
      r.user_agent ? `Browser: ${r.user_agent}` : "",
      r.stack ? `\n${r.stack}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return (
    <Panel
      title={`Error log${last7 ? ` · ${last7} in the last 7 days` : ""}`}
      className="md:col-span-2"
      action={
        (q.data?.length ?? 0) > 0 ? (
          <Confirm
            title="Clear the error log?"
            description="Removes every logged error for the firm. New ones will keep being recorded."
            action="Clear log"
            onConfirm={() =>
              tryAction(async () => {
                await mut(supabase.from("client_errors").delete().not("id", "is", null).select("id"), { success: "Error log cleared" });
                qc.invalidateQueries({ queryKey: ["client-errors"] });
              })
            }
          >
            <Button size="sm" variant="ghost" className="h-7 text-xs">Clear</Button>
          </Confirm>
        ) : null
      }
    >
      <ListState query={q} rows={2} empty="No errors recorded. Problems anyone at the firm hits in the app — a page that fails, a save that doesn't go through, a document that won't open — appear here with the details support needs.">
        {(rows) => (
          <ul className="divide-y text-sm">
            {rows.map((r) => {
              const expanded = open === r.id;
              return (
                <li key={r.id} className="py-1.5">
                  <button
                    className="flex w-full items-start gap-2 text-left"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : r.id)}
                  >
                    {expanded ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{r.message}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {new Date(r.created_at).toLocaleString()} · {PAGE_LABEL(r.route)} · {SOURCE_LABEL[r.source] ?? r.source}
                      </span>
                    </span>
                  </button>
                  {expanded && (
                    <div className="ml-5 mt-1.5 space-y-1.5">
                      <pre className="max-h-48 overflow-auto rounded border bg-raised p-2 text-[11px] leading-relaxed whitespace-pre-wrap">{details(r)}</pre>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs"
                        onClick={() => navigator.clipboard.writeText(details(r)).then(() => toast.success("Details copied — paste them into a support message."))}
                      >
                        <Copy className="mr-1 h-3 w-3" />Copy details
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </ListState>
      <p className="mt-3 text-xs text-muted-foreground">
        Only the error text, page and browser are recorded — never document contents or sign-in details. Entries are shared with everyone at the firm.
      </p>
    </Panel>
  );
}
