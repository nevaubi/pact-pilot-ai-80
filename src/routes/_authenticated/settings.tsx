import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Panel, EffortToggle, ListState } from "@/components/kit";
import { useEffort } from "@/hooks/use-effort";
import { mut, tryAction } from "@/lib/mutate";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

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

const KIND_LABEL: Record<string, string> = {
  ask: "Assist questions",
  intake: "Document mapping",
  meeting: "Meeting notes",
  closing: "Closing checklists",
  draft_fill: "Template fill",
  draft_edit: "Redlines",
};

function Settings() {
  const [effort, setEffort] = useEffort();
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const usage = useQuery({
    queryKey: ["ai-usage"],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const { data, error } = await supabase
        .from("ai_runs")
        .select(
          "effort,kind,input_tokens,output_tokens,matter_id,created_at,matters(id,title,number)",
        )
        .gte("created_at", since)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      const tok = (r: { input_tokens: number | null; output_tokens: number | null }) =>
        (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
      const sum = (e?: string) =>
        rows.filter((r) => !e || r.effort === e).reduce((a, r) => a + tok(r), 0);
      const byMatter = new Map<
        string,
        {
          id: string | null;
          title: string;
          runs: number;
          tokens: number;
          normal: number;
          advanced: number;
        }
      >();
      const byKind = new Map<string, { runs: number; tokens: number }>();
      for (const r of rows) {
        const key = r.matter_id ?? "none";
        const m = byMatter.get(key) ?? {
          id: r.matter_id,
          title: r.matters
            ? `${r.matters.number ? r.matters.number + " · " : ""}${r.matters.title}`
            : "Deleted matter",
          runs: 0,
          tokens: 0,
          normal: 0,
          advanced: 0,
        };
        m.runs++;
        m.tokens += tok(r);
        if (r.effort === "advanced") m.advanced++;
        else m.normal++;
        byMatter.set(key, m);
        const k = byKind.get(r.kind) ?? { runs: 0, tokens: 0 };
        k.runs++;
        k.tokens += tok(r);
        byKind.set(r.kind, k);
      }
      return {
        runs: rows.length,
        normal: rows.filter((r) => r.effort === "normal").length,
        advanced: rows.filter((r) => r.effort === "advanced").length,
        tokens: sum(),
        tokN: sum("normal"),
        tokA: sum("advanced"),
        matters: [...byMatter.values()].sort((a, b) => b.tokens - a.tokens),
        kinds: [...byKind.entries()]
          .map(([kind, v]) => ({ kind, ...v }))
          .sort((a, b) => b.tokens - a.tokens),
      };
    },
  });
  const mattersQ = { ...usage, data: usage.data?.matters };

  return (
    <div className="pb-10">
      <PageHeader title="Settings" />
      <div className="grid max-w-4xl gap-4 px-4 md:grid-cols-2 md:px-8">
        <ProfilePanel />
        <Panel title="Appearance">
          <label className="flex items-center justify-between text-sm">
            Dark mode
            <Switch
              checked={dark}
              onCheckedChange={(v) => {
                setDark(v);
                document.documentElement.classList.toggle("dark", v);
                localStorage.setItem("mirza-theme", v ? "dark" : "light");
              }}
            />
          </label>
        </Panel>
        <Panel title="Default AI effort" className="md:col-span-2">
          <div className="flex flex-wrap items-start gap-4 text-sm">
            <EffortToggle value={effort} onChange={setEffort} />
            <p className="max-w-xl text-xs text-muted-foreground">
              <b>Normal</b> — everyday case management, notes and drafting help. Lower cost, faster.
              <br />
              <b>Advanced</b> — reads the matter's documents in full and reasons more carefully for
              issue-spotting. Uses noticeably more AI. You can switch per request.
            </p>
          </div>
        </Panel>
        <Panel title="AI usage · last 30 days" className="md:col-span-2">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label="Requests"
              value={usage.data?.runs ?? 0}
              sub={`${(usage.data?.tokens ?? 0).toLocaleString()} tokens`}
            />
            <Stat
              label="Normal"
              value={usage.data?.normal ?? 0}
              sub={`${(usage.data?.tokN ?? 0).toLocaleString()} tokens`}
            />
            <Stat
              label="Advanced"
              value={usage.data?.advanced ?? 0}
              sub={`${(usage.data?.tokA ?? 0).toLocaleString()} tokens`}
            />
          </div>
          {usage.data && usage.data.kinds.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {usage.data.kinds.map((k) => (
                <span key={k.kind} className="rounded-md bg-raised px-2 py-1 text-muted-foreground">
                  <b className="text-foreground">{KIND_LABEL[k.kind] ?? k.kind}</b> · {k.runs} ·{" "}
                  {k.tokens.toLocaleString()} tok
                </span>
              ))}
            </div>
          )}
          <h3 className="mb-1 mt-4 text-xs font-semibold text-muted-foreground">By matter</h3>
          <ListState query={mattersQ} rows={2} empty="No AI has been used in the last 30 days.">
            {(rows) => (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">Matter</th>
                    <th className="py-1 text-right font-medium">Requests</th>
                    <th className="hidden py-1 text-right font-medium sm:table-cell">
                      Normal / Adv.
                    </th>
                    <th className="py-1 text-right font-medium">Tokens</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((m) => (
                    <tr key={m.id ?? "none"}>
                      <td className="py-1.5 pr-2">
                        {m.id ? (
                          <Link
                            to="/matters/$id"
                            params={{ id: m.id }}
                            className="hover:text-primary"
                          >
                            {m.title}
                          </Link>
                        ) : (
                          m.title
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{m.runs}</td>
                      <td className="hidden py-1.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                        {m.normal} / {m.advanced}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {m.tokens.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ListState>
          <p className="mt-3 text-xs text-muted-foreground">
            AI runs only when someone clicks an Assist action. Usage is recorded per matter so it
            can be reviewed against client bills. Lovable AI usage is billed to the workspace's
            credits.
          </p>
        </Panel>
      </div>
    </div>
  );
}

function ProfilePanel() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      setEmail(data.user.email ?? "");
      const { data: p } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", data.user.id)
        .maybeSingle();
      const n =
        p?.full_name ?? (data.user.user_metadata?.["full_name"] as string | undefined) ?? "";
      setName(n);
      setSaved(n);
    });
  }, []);
  async function save() {
    setBusy(true);
    await tryAction(async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      await mut(
        supabase.from("profiles").upsert({ id: data.user.id, full_name: name.trim() }).select("id"),
        { success: "Name saved" },
      );
      setSaved(name.trim());
    });
    setBusy(false);
  }
  return (
    <Panel title="Your profile">
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="pf-name" className="text-xs">
            Display name
          </Label>
          <Input
            id="pf-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="How your name appears in activity"
          />
        </div>
        <p className="text-xs text-muted-foreground">{email}</p>
        <Button type="submit" size="sm" disabled={busy || name.trim() === saved}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </form>
    </Panel>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-lg bg-raised p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
