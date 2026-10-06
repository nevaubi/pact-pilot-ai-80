import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Panel, EffortToggle } from "@/components/kit";
import { useEffort } from "@/hooks/use-effort";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Mirza" },
      { name: "description", content: "Appearance, AI effort default and AI usage." },
      { property: "og:title", content: "Settings — Mirza" },
      { property: "og:description", content: "Mirza settings." },
    ],
  }),
  component: Settings,
});

function Settings() {
  const [effort, setEffort] = useEffort();
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const usage = useQuery({
    queryKey: ["ai-usage"],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const { data } = await supabase.from("ai_runs").select("effort,kind,input_tokens,output_tokens").gte("created_at", since);
      const rows = data ?? [];
      const sum = (e?: string) => rows.filter((r) => !e || r.effort === e).reduce((a, r) => a + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
      return { runs: rows.length, normal: rows.filter((r) => r.effort === "normal").length, advanced: rows.filter((r) => r.effort === "advanced").length, tokens: sum(), tokN: sum("normal"), tokA: sum("advanced") };
    },
  });

  return (
    <div className="pb-10">
      <PageHeader title="Settings" />
      <div className="grid max-w-4xl gap-4 px-4 md:grid-cols-2 md:px-8">
        <Panel title="Appearance">
          <label className="flex items-center justify-between text-sm">
            Dark mode
            <Switch checked={dark} onCheckedChange={(v) => { setDark(v); document.documentElement.classList.toggle("dark", v); localStorage.setItem("mirza-theme", v ? "dark" : "light"); }} />
          </label>
        </Panel>
        <Panel title="Default AI effort">
          <div className="space-y-2 text-sm">
            <EffortToggle value={effort} onChange={setEffort} />
            <p className="text-xs text-muted-foreground"><b>Normal</b> — everyday case management, notes and drafting help. Lower cost.<br /><b>Advanced</b> — deeper reading and issue-spotting. Uses more AI.</p>
          </div>
        </Panel>
        <Panel title="AI usage · last 30 days" className="md:col-span-2">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Requests" value={usage.data?.runs ?? 0} />
            <Stat label="Normal" value={usage.data?.normal ?? 0} sub={`${(usage.data?.tokN ?? 0).toLocaleString()} tokens`} />
            <Stat label="Advanced" value={usage.data?.advanced ?? 0} sub={`${(usage.data?.tokA ?? 0).toLocaleString()} tokens`} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">AI runs only when someone clicks an Assist action. Usage is recorded per matter so it can be reviewed against client bills.</p>
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-lg bg-raised p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold">{value.toLocaleString()}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
