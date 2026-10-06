import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink, Globe, Plus, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { searchPublicSources, addAuthority } from "@/lib/library.functions";
import { TOPICS, topicLabel, type Topic } from "@/lib/library";
import { JurChip } from "./SourceBits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Hit = Awaited<ReturnType<typeof searchPublicSources>>["hits"][number];
const PROVIDERS = [
  ["ecfr", "Federal regulations (eCFR)"],
  ["federal_register", "Federal Register"],
  ["courtlistener", "Court opinions — Illinois & federal"],
] as const;
const providerName: Record<string, string> = { ecfr: "eCFR", federal_register: "Federal Register", courtlistener: "Opinion" };

export function PublicSearchDialog({
  open,
  onClose,
  matterId,
  defaultTopic = "real_estate",
  initialQuery = "",
}: {
  open: boolean;
  onClose: () => void;
  matterId?: string;
  defaultTopic?: Topic;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [providers, setProviders] = useState<string[]>(["ecfr", "federal_register", "courtlistener"]);
  const [topic, setTopic] = useState<string>(defaultTopic);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [added, setAdded] = useState<Record<string, "busy" | "done">>({});
  const search = useServerFn(searchPublicSources);
  const add = useServerFn(addAuthority);
  const qc = useQueryClient();

  async function go() {
    if (query.trim().length < 2) return;
    setBusy(true);
    setHits(null);
    try {
      const r = await search({ data: { query: query.trim(), providers: providers as never } });
      setHits(r.hits);
      setErrors(r.errors);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
      setHits([]);
    } finally {
      setBusy(false);
    }
  }

  async function addHit(h: Hit) {
    if (!h.add) return;
    setAdded((s) => ({ ...s, [h.url]: "busy" }));
    try {
      const r = await add({
        data: {
          citation: h.citation,
          title: h.title,
          url: h.url,
          source: h.add.source as never,
          jurisdiction: h.jurisdiction,
          kind: h.kind,
          topics: [topic],
          meta: h.add.meta,
          ...(h.add.fetch_url ? { fetch_url: h.add.fetch_url } : {}),
          ...(matterId ? { matterId } : {}),
        },
      });
      setAdded((s) => ({ ...s, [h.url]: "done" }));
      qc.invalidateQueries({ queryKey: ["authorities"] });
      if (matterId) qc.invalidateQueries({ queryKey: ["matter_authorities", matterId] });
      if (r.status === "ready") toast.success(`${h.citation} added and indexed`, { description: matterId ? "Pinned to this matter." : undefined });
      else if (r.status === "stored") toast.success(`${h.citation} added`, { description: "The PDF is stored; its text will be read on the next library update." });
      else toast.warning(`${h.citation} added, but couldn't be fetched`, { description: "message" in r ? r.message : undefined });
    } catch (e) {
      setAdded((s) => {
        const c = { ...s };
        delete c[h.url];
        return c;
      });
      toast.error("Couldn't add that source", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" /> Search public law sources
          </DialogTitle>
          <DialogDescription>
            Live lookup in the eCFR, the Federal Register and CourtListener (Illinois and federal courts). Add a result to store its
            current text in the firm's library{matterId ? " and pin it to this matter" : ""}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. withholding on disposition by foreign person, 1026.19(f), attorney review Illinois" className="min-w-[16rem] flex-1" autoFocus aria-label="Search query" />
          <Button type="submit" disabled={busy || query.trim().length < 2}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Search
          </Button>
        </form>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {PROVIDERS.map(([id, label]) => (
            <label key={id} className="flex items-center gap-1.5">
              <Checkbox checked={providers.includes(id)} onCheckedChange={(v) => setProviders((p) => (v ? [...p, id] : p.filter((x) => x !== id)))} aria-label={label} />
              {label}
            </label>
          ))}
          <span className="ml-auto flex items-center gap-1.5">
            File under
            <Select value={topic} onValueChange={setTopic}>
              <SelectTrigger className="h-7 w-40 text-xs" aria-label="Topic">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TOPICS.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        </div>
        {errors.length > 0 && <p className="text-xs text-ink-amber">{errors.join(" · ")}</p>}
        {hits && (
          <ul className="divide-y rounded border bg-card">
            {hits.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No results from the selected services.</li>}
            {hits.map((h) => (
              <li key={h.url} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="rounded-sm bg-raised px-1.5 py-0.5 font-semibold text-muted-foreground">{providerName[h.provider] ?? h.provider}</span>
                    <JurChip j={h.jurisdiction} />
                    <span className="font-mono">{h.citation}</span>
                    {h.date && <span className="text-muted-foreground">· {h.date}</span>}
                  </div>
                  <p className="mt-0.5 text-sm font-medium">{h.title}</p>
                  {h.snippet && <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{h.snippet}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" asChild aria-label="Open">
                    <a href={h.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                  {h.add && (
                    <Button size="sm" variant="outline" onClick={() => addHit(h)} disabled={!!added[h.url]}>
                      {added[h.url] === "done" ? <Check className="mr-1 h-3.5 w-3.5 text-ink-green" /> : added[h.url] === "busy" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
                      {added[h.url] === "done" ? "Added" : matterId ? "Add & pin" : "Add"}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">
          Illinois statutes are kept on the official ILGA site; the library's Illinois acts are listed by citation under {topicLabel("real_estate")}, {topicLabel("tax")} and the other topics, and can be refreshed or attached from there.
        </p>
      </DialogContent>
    </Dialog>
  );
}
