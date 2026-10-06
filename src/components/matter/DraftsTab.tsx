import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { FilePlus2, Wand2, Check, X, Download, ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { suggestTemplateAnswers, suggestDraftEdits } from "@/lib/ai.functions";
import { tableQ, templatesQ, logActivity, fmtDateTime } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { templateFields, fillTemplate } from "@/lib/extract";
import { useEffort } from "@/hooks/use-effort";
import {
  Panel,
  ListState,
  DeleteButton,
  Confirm,
  EffortToggle,
  UsageNote,
  ReviewBanner,
  Why,
  PracticeChip,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

export const DRAFT_STATUS = ["Draft", "In review", "Final"];
const statusTone = (s: string) =>
  s === "Final"
    ? "bg-ink-green/10 text-ink-green"
    : s === "In review"
      ? "bg-ink-amber/10 text-ink-amber"
      : "bg-raised text-muted-foreground";

export function DraftsTab({ matter }: { matter: Tables<"matters"> }) {
  const q = useQuery(tableQ("drafts", matter.id));
  const qc = useQueryClient();
  const [mode, setMode] = useState<
    { kind: "list" } | { kind: "new" } | { kind: "edit"; id: string }
  >({ kind: "list" });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["drafts", matter.id] });
    qc.invalidateQueries({ queryKey: ["activity", matter.id] });
  };

  if (mode.kind === "new")
    return (
      <NewDraft
        matter={matter}
        onDone={(d) => {
          refresh();
          setMode(d ? { kind: "edit", id: d.id } : { kind: "list" });
        }}
      />
    );
  if (mode.kind === "edit") {
    const draft = q.data?.find((d) => d.id === mode.id);
    if (!draft)
      return (
        <Panel title="Draft">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Panel>
      );
    return (
      <DraftEditor
        matter={matter}
        draft={draft}
        onBack={() => setMode({ kind: "list" })}
        onChanged={refresh}
      />
    );
  }

  return (
    <Panel
      title="Drafts"
      action={
        <Button size="sm" onClick={() => setMode({ kind: "new" })}>
          <FilePlus2 className="mr-1.5 h-4 w-4" />
          New from house template
        </Button>
      }
    >
      <ListState
        query={q}
        empty={
          <>
            No drafts yet. Start one from your firm's house templates — the form stays exactly as
            written; only the blanks get filled.
          </>
        }
      >
        {(rows) => (
          <ul className="divide-y">
            {[...rows]
              .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
              .map((d) => (
                <li key={d.id} className="group flex items-center gap-2 py-2">
                  <button
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left hover:text-primary"
                    onClick={() => setMode({ kind: "edit", id: d.id })}
                  >
                    <span className="truncate text-sm font-medium">{d.title}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusTone(d.status)}`}
                      >
                        {d.status}
                      </span>
                      {fmtDateTime(d.updated_at)}
                    </span>
                  </button>
                  <DeleteButton
                    what="draft"
                    description={`"${d.title}" will be deleted. The house template is not affected.`}
                    onConfirm={() =>
                      tryAction(async () => {
                        await mut(supabase.from("drafts").delete().eq("id", d.id).select("id"), {
                          success: "Draft deleted",
                        });
                        refresh();
                      })
                    }
                    className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                  />
                </li>
              ))}
          </ul>
        )}
      </ListState>
    </Panel>
  );
}

function NewDraft({
  matter,
  onDone,
}: {
  matter: Tables<"matters">;
  onDone: (d?: Tables<"drafts">) => void;
}) {
  const tq = useQuery(templatesQ);
  const templates = tq.data ?? [];
  const [tpl, setTpl] = useState<Tables<"templates"> | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [whys, setWhys] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<{
    effort: "normal" | "advanced";
    usage: { inputTokens?: number | undefined; outputTokens?: number | undefined };
  } | null>(null);
  const [effort, setEffort] = useEffort();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useMemo(() => (tpl ? templateFields(tpl.body) : []), [tpl]);
  const suggest = useServerFn(suggestTemplateAnswers);

  async function fillFromMatter() {
    setBusy(true);
    setError(null);
    try {
      const r = await suggest({ data: { matterId: matter.id, effort, fields } });
      const a = { ...answers },
        w: Record<string, string> = { ...whys };
      let filled = 0;
      r.answers.forEach((x) => {
        if (x.value.trim() && !a[x.field]?.trim()) {
          a[x.field] = x.value.trim();
          w[x.field] = x.why;
          filled++;
        }
      });
      setAnswers(a);
      setWhys(w);
      setUsage({ effort, usage: r.usage });
      toast(
        filled
          ? `${filled} of ${fields.length} blanks suggested from the matter`
          : "Nothing in the matter answers these blanks yet.",
        {
          description: filled
            ? "Suggested values are marked — check each one."
            : "Add a summary, notes or documents to the matter first.",
        },
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!tpl || creating) return;
    setCreating(true);
    await tryAction(async () => {
      const data = await mut(
        supabase
          .from("drafts")
          .insert({
            matter_id: matter.id,
            template_id: tpl.id,
            title: `${tpl.name} — ${matter.client ?? matter.title}`,
            body: fillTemplate(tpl.body, answers),
          })
          .select()
          .single(),
        { success: "Draft created" },
      );
      await logActivity(matter.id, `Created draft from house template "${tpl.name}"`);
      onDone(data);
    });
    setCreating(false);
  }

  if (!tpl) {
    const sorted = [...templates].sort(
      (a, b) =>
        Number(b.practice_area === matter.practice_area) -
          Number(a.practice_area === matter.practice_area) || a.name.localeCompare(b.name),
    );
    return (
      <Panel
        title="Choose a house template"
        action={
          <Button size="sm" variant="ghost" onClick={() => onDone()}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back
          </Button>
        }
      >
        <ListState
          query={tq}
          empty={
            <>
              No house templates yet.{" "}
              <Link to="/templates" className="text-primary underline">
                Upload your firm's forms
              </Link>{" "}
              first.
            </>
          }
        >
          {() => (
            <ul className="grid gap-2 sm:grid-cols-2">
              {sorted.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => setTpl(t)}
                    className="w-full rounded-lg border bg-raised p-3 text-left transition-colors hover:border-primary"
                  >
                    <p className="text-sm font-medium">{t.name}</p>
                    <div className="mt-1 flex items-center gap-2">
                      {t.practice_area && <PracticeChip area={t.practice_area} />}
                      <span className="text-xs text-muted-foreground">
                        {templateFields(t.body).length} blanks
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ListState>
      </Panel>
    );
  }

  const answered = fields.filter((f) => answers[f]?.trim()).length;

  return (
    <Panel
      title={`Fill in: ${tpl.name}`}
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setTpl(null);
            setAnswers({});
            setWhys({});
            setUsage(null);
          }}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Templates
        </Button>
      }
    >
      {!fields.length ? (
        <p className="mb-3 text-sm text-muted-foreground">
          This template has no blanks marked with [[Field]] or {"{{Field}}"}. It will be copied as
          is.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              Answer the template's questions ({answered}/{fields.length}). Blanks you leave empty
              stay as placeholders in the draft.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <EffortToggle value={effort} onChange={setEffort} />
              <Button size="sm" variant="outline" disabled={busy} onClick={fillFromMatter}>
                <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                {busy ? "Looking through the matter…" : "Fill from matter"}
              </Button>
            </div>
          </div>
          {error && (
            <p className="mb-3 rounded-lg border border-ink-red/30 bg-ink-red/5 px-3 py-2 text-sm">
              {error}
            </p>
          )}
          {usage && (
            <div className="mb-3 space-y-2">
              <ReviewBanner />
              <UsageNote effort={usage.effort} usage={usage.usage} />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f} className="space-y-1">
                <Label className="text-xs">
                  {f}
                  {whys[f] && (
                    <span className="ml-1 rounded bg-ink-purple/10 px-1 text-[10px] text-ink-purple">
                      suggested
                    </span>
                  )}
                </Label>
                <Input
                  value={answers[f] ?? ""}
                  onChange={(e) => setAnswers({ ...answers, [f]: e.target.value })}
                />
                {whys[f] && <Why text={whys[f]} />}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="mt-4 flex justify-end">
        <Button onClick={create} disabled={creating}>
          {creating ? "Creating…" : "Create draft"}
        </Button>
      </div>
    </Panel>
  );
}

type Edit = {
  original: string;
  suggested: string;
  reason: string;
  state: "pending" | "accepted" | "rejected";
};

function DraftEditor({
  matter,
  draft,
  onBack,
  onChanged,
}: {
  matter: Tables<"matters">;
  draft: Tables<"drafts">;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [body, setBody] = useState(draft.body);
  const [title, setTitle] = useState(draft.title);
  const [instruction, setInstruction] = useState("");
  const [edits, setEdits] = useState<Edit[]>([]);
  const [usage, setUsage] = useState<{
    effort: "normal" | "advanced";
    usage: { inputTokens?: number | undefined; outputTokens?: number | undefined };
  } | null>(null);
  const [effort, setEffort] = useEffort();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useServerFn(suggestDraftEdits);
  const dirty = body !== draft.body || title !== draft.title;
  const remaining = useMemo(() => templateFields(body).length, [body]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  async function propose() {
    setBusy(true);
    setError(null);
    try {
      const r = await run({ data: { matterId: matter.id, effort, body, instruction } });
      const valid = r.edits.filter(
        (e) => e.original && e.original !== e.suggested && body.includes(e.original),
      );
      const dropped = r.edits.length - valid.length;
      if (!valid.length) toast("No targeted edits suggested — the house form looks fine as is.");
      else if (dropped)
        toast(
          `${dropped} suggestion${dropped > 1 ? "s" : ""} skipped because the quoted text wasn't found verbatim in the draft.`,
        );
      setEdits(valid.map((e) => ({ ...e, state: "pending" })));
      setUsage({ effort, usage: r.usage });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function decide(i: number, accept: boolean) {
    const e = edits[i];
    if (!e || e.state !== "pending") return;
    if (accept) {
      if (!body.includes(e.original)) {
        toast.error("That passage has changed since the suggestion was made.");
        setEdits(edits.map((x, j) => (j === i ? { ...x, state: "rejected" } : x)));
        return;
      }
      setBody((b) => b.replace(e.original, e.suggested));
    }
    setEdits(
      edits.map((x, j) => (j === i ? { ...x, state: accept ? "accepted" : "rejected" } : x)),
    );
  }
  function decideAll(accept: boolean) {
    let b = body;
    const next = edits.map((e) => {
      if (e.state !== "pending") return e;
      if (accept && b.includes(e.original)) {
        b = b.replace(e.original, e.suggested);
        return { ...e, state: "accepted" as const };
      }
      return { ...e, state: "rejected" as const };
    });
    setBody(b);
    setEdits(next);
  }
  async function save(extra: Partial<Tables<"drafts">> = {}) {
    setSaving(true);
    await tryAction(async () => {
      await mut(
        supabase
          .from("drafts")
          .update({
            body,
            title: title.trim() || draft.title,
            updated_at: new Date().toISOString(),
            ...extra,
          })
          .eq("id", draft.id)
          .select("id"),
        { success: extra.status ? `Marked ${extra.status}` : "Draft saved" },
      );
      if (extra.status) await logActivity(matter.id, `Draft "${title}" marked ${extra.status}`);
      onChanged();
    });
    setSaving(false);
  }
  function download() {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const html = `<html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="font-family:'Times New Roman',serif;font-size:12pt;line-height:1.5;white-space:pre-wrap">${esc(body)}</body></html>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff", html], { type: "application/msword" }));
    a.download = `${title.replace(/[\\/:*?"<>|]+/g, "-")}.doc`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const back = () => onBack();

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Panel
        className="lg:col-span-3"
        title={title}
        action={
          <div className="flex flex-wrap items-center gap-1">
            {dirty ? (
              <Confirm
                title="Leave without saving?"
                description="Your edits to this draft will be lost."
                action="Leave"
                onConfirm={back}
              >
                <Button size="sm" variant="ghost">
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  Drafts
                </Button>
              </Confirm>
            ) : (
              <Button size="sm" variant="ghost" onClick={back}>
                <ArrowLeft className="mr-1 h-4 w-4" />
                Drafts
              </Button>
            )}
            <Select
              value={draft.status}
              onValueChange={(v) => save({ status: v })}
              disabled={saving}
            >
              <SelectTrigger
                className={`h-8 w-28 text-xs ${statusTone(draft.status)}`}
                aria-label="Draft status"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DRAFT_STATUS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={download}>
              <Download className="mr-1 h-4 w-4" />
              Word
            </Button>
            <Button size="sm" onClick={() => save()} disabled={saving || !dirty}>
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </Button>
          </div>
        }
      >
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mb-2 h-8 bg-transparent font-medium"
          aria-label="Draft title"
        />
        {remaining > 0 && (
          <p className="mb-2 text-xs text-ink-amber">
            {remaining} blank{remaining > 1 ? "s" : ""} still unfilled — search for [[ or {"{{"} in
            the text.
          </p>
        )}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[60vh] bg-raised font-serif text-[13px] leading-relaxed"
          aria-label="Draft text"
        />
      </Panel>
      <Panel className="lg:col-span-2" title="Drafting assistant">
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Suggests small, targeted redlines to the house form for this deal. It never rewrites
            sections — you accept or reject each change.
          </p>
          <Textarea
            rows={3}
            placeholder="Optional: what should change? e.g. 'Seller is an Illinois LLC; closing is Nov 14'"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            aria-label="Instruction"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <EffortToggle value={effort} onChange={setEffort} />
            <Button size="sm" onClick={propose} disabled={busy}>
              <Wand2 className="mr-1.5 h-3.5 w-3.5" />
              {busy ? "Reviewing…" : "Suggest redlines"}
            </Button>
          </div>
          {error && (
            <p className="rounded-lg border border-ink-red/30 bg-ink-red/5 px-3 py-2 text-sm">
              {error}
            </p>
          )}
          {edits.length > 0 && (
            <>
              <ReviewBanner />
              <div className="flex flex-wrap items-center justify-between gap-2">
                {usage && <UsageNote effort={usage.effort} usage={usage.usage} />}
                {edits.some((e) => e.state === "pending") && (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => decideAll(true)}
                    >
                      Accept all
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => decideAll(false)}
                    >
                      Reject all
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
          <ul className="space-y-2">
            {edits.map((e, i) => (
              <li
                key={i}
                className={`rounded-lg border p-3 text-sm ${e.state !== "pending" ? "opacity-60" : ""}`}
              >
                <p className="leading-relaxed">
                  <span className="redline-del">{e.original}</span>{" "}
                  <span className="redline-ins">{e.suggested}</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{e.reason}</p>
                {e.state === "pending" ? (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => decide(i, true)}>
                      <Check className="mr-1 h-3.5 w-3.5 text-ink-green" />
                      Accept
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => decide(i, false)}>
                      <X className="mr-1 h-3.5 w-3.5" />
                      Reject
                    </Button>
                  </div>
                ) : (
                  <p className="mt-1 text-xs font-medium">
                    {e.state === "accepted" ? "Accepted" : "Rejected"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    </div>
  );
}
