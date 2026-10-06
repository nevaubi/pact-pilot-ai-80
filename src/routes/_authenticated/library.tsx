import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Globe, Link2, RefreshCw, Search, Square } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, ListState, LoadError } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtDate } from "@/lib/data";
import {
  authoritiesQ,
  librarySearchQ,
  needsSync,
  syncMany,
  JURISDICTIONS,
  TOPICS,
  KINDS,
  type AuthorityRow,
  type SyncProgress,
} from "@/lib/library";
import { StatusChip, JurChip, TopicChips, Snippet } from "@/components/library/SourceBits";
import { AuthoritySheet } from "@/components/library/AuthoritySheet";
import { PublicSearchDialog } from "@/components/library/PublicSearchDialog";
import { AddLinkDialog } from "@/components/library/AddLinkDialog";

export const Route = createFileRoute("/_authenticated/library")({
  head: () => ({
    meta: [
      { title: "Law library — Mirza" },
      { name: "description", content: "Authoritative Illinois and federal sources, stored and indexed for the firm." },
      { property: "og:title", content: "Law library — Mirza" },
      { property: "og:description", content: "Illinois and federal statutes, regulations and guidance, kept current for the firm." },
    ],
  }),
  component: LibraryPage,
  errorComponent: ({ error }) => (
    <div className="p-8">
      <LoadError error={error} />
    </div>
  ),
});

const ALL = "all";

function LibraryPage() {
  const q = useQuery(authoritiesQ);
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [jur, setJur] = useState(ALL);
  const [topic, setTopic] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [open, setOpen] = useState<AuthorityRow | null>(null);
  const [publicSearch, setPublicSearch] = useState(false);
  const [addLink, setAddLink] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoStarted = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const search = useQuery(librarySearchQ(debounced, topic === ALL ? undefined : topic, jur === ALL ? undefined : jur));

  const rows = useMemo(() => {
    let r = q.data ?? [];
    if (jur !== ALL) r = r.filter((a) => a.jurisdiction === jur);
    if (topic !== ALL) r = r.filter((a) => a.topics.includes(topic));
    if (status !== ALL) r = r.filter((a) => (status === "attention" ? a.status === "blocked" || a.status === "error" : a.status === status));
    return r;
  }, [q.data, jur, topic, status]);

  const stats = useMemo(() => {
    const all = q.data ?? [];
    const ready = all.filter((a) => a.status === "ready").length;
    const attention = all.filter((a) => a.status === "blocked" || a.status === "error").length;
    const last = all.reduce<string | null>((m, a) => (a.checked_at && (!m || a.checked_at > m) ? a.checked_at : m), null);
    return { total: all.length, ready, attention, last };
  }, [q.data]);

  async function runSync(all: boolean) {
    const items = needsSync(q.data ?? [], all);
    if (!items.length) {
      toast("The library is up to date.");
      return;
    }
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setProgress({ done: 0, total: items.length, current: null, failures: [] });
    const p = await syncMany(
      items,
      (pr) => {
        setProgress(pr);
        if (pr.done % 3 === 0) qc.invalidateQueries({ queryKey: ["authorities"] });
      },
      ctl.signal,
    );
    qc.invalidateQueries({ queryKey: ["authorities"] });
    setProgress(null);
    if (ctl.signal.aborted) toast("Library update stopped.");
    else if (p.failures.length)
      toast.warning(`Library updated — ${p.failures.length} source${p.failures.length > 1 ? "s" : ""} need attention`, {
        description: "Open a source marked Blocked or Fetch failed to attach a copy.",
      });
    else toast.success(`Library updated — ${p.total} source${p.total > 1 ? "s" : ""} checked`);
  }

  // Automatic refresh: first visit of the day fetches anything new or stale, in the background.
  useEffect(() => {
    if (!q.data || autoStarted.current) return;
    autoStarted.current = true;
    const key = `mirza-library-sync-${new Date().toISOString().slice(0, 10)}`;
    if (sessionStorage.getItem(key)) return;
    const pending = needsSync(q.data);
    if (!pending.length) return;
    sessionStorage.setItem(key, "1");
    toast(`Updating the library — ${pending.length} source${pending.length > 1 ? "s" : ""} to fetch`, {
      description: "You can keep working; sources appear as they finish.",
    });
    void runSync(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  const byId = useMemo(() => new Map((q.data ?? []).map((a) => [a.id, a])), [q.data]);
  const searching = debounced.length >= 2;

  return (
    <div>
      <PageHeader
        title="Law library"
        subtitle={
          q.data
            ? `${stats.ready} of ${stats.total} sources ready${stats.attention ? ` · ${stats.attention} need attention` : ""}${stats.last ? ` · last checked ${fmtDate(stats.last.slice(0, 10))}` : ""}`
            : "Authoritative Illinois and federal sources, stored and indexed for the firm"
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setPublicSearch(true)}>
              <Globe className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Search public sources</span>
            </Button>
            <Button variant="outline" onClick={() => setAddLink(true)}>
              <Link2 className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Add by link</span>
            </Button>
            {progress ? (
              <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                <Square className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden sm:inline">Stop</span>
              </Button>
            ) : (
              <Button onClick={() => runSync(true)} disabled={!q.data}>
                <RefreshCw className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden sm:inline">Update library</span>
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-3 p-4 md:p-6">
        {progress && (
          <div className="rounded border bg-card px-3 py-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span>
                Updating {progress.done} of {progress.total}
                {progress.current ? <span className="text-muted-foreground"> — {progress.current}</span> : null}
              </span>
              {progress.failures.length > 0 && <span className="text-ink-amber">{progress.failures.length} need attention</span>}
            </div>
            <Progress value={(progress.done / Math.max(1, progress.total)) * 100} className="mt-1.5 h-1.5" />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the stored text — e.g. non-foreign status, transfer declaration, annual report" className="pl-8" aria-label="Search library" />
          </div>
          <Select value={jur} onValueChange={setJur}>
            <SelectTrigger className="w-36" aria-label="Jurisdiction">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All jurisdictions</SelectItem>
              {JURISDICTIONS.map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={topic} onValueChange={setTopic}>
            <SelectTrigger className="w-40" aria-label="Topic">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All topics</SelectItem>
              {TOPICS.map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-36" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              <SelectItem value="ready">Ready</SelectItem>
              <SelectItem value="pending">Not fetched</SelectItem>
              <SelectItem value="attention">Needs attention</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {searching ? (
          <section className="rounded border bg-card">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
              <span>{search.isPending ? "Searching…" : `${search.data?.length ?? 0} passages match “${debounced}”`}</span>
              <span>Full-text search over the stored copies only</span>
            </div>
            <ListState query={search} empty="No stored text matches. Try fewer words, or search the public sources." rows={4}>
              {(hits) => (
                <ul className="divide-y">
                  {hits.map((h) => {
                    const a = byId.get(h.authority_id);
                    return (
                      <li key={`${h.authority_id}:${h.chunk_idx}`} className="px-3 py-2.5">
                        <button className="text-left" onClick={() => a && setOpen(a)}>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <JurChip j={h.jurisdiction} />
                            <span className="font-mono font-medium">{h.citation}</span>
                            <span className="text-muted-foreground">· {h.title}</span>
                            {h.heading && <span className="text-muted-foreground">› {h.heading}</span>}
                          </div>
                          <p className="mt-1 text-sm leading-relaxed">
                            <Snippet text={h.snippet} />
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </ListState>
          </section>
        ) : (
          <section className="rounded border bg-card">
            <ListState query={{ ...q, data: q.data ? rows : undefined }} empty="No sources match these filters." rows={8}>
              {(list) => (
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] uppercase text-muted-foreground">
                    <tr className="border-b">
                      <th className="px-3 py-2 font-semibold">Citation</th>
                      <th className="px-3 py-2 font-semibold">Source</th>
                      <th className="hidden px-3 py-2 font-semibold lg:table-cell">Topics</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="hidden px-3 py-2 font-semibold md:table-cell">Checked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {list.map((a) => (
                      <tr key={a.id} className="cursor-pointer hover:bg-raised/60" onClick={() => setOpen(a)}>
                        <td className="px-3 py-2 align-top">
                          <div className="flex items-center gap-1.5">
                            <JurChip j={a.jurisdiction} />
                            <span className="whitespace-nowrap font-mono text-xs">{a.citation}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <p className="font-medium leading-snug">{a.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {KINDS[a.kind] ?? a.kind}
                            {a.version_label ? ` · ${a.version_label}` : ""}
                          </p>
                        </td>
                        <td className="hidden px-3 py-2 align-top lg:table-cell">
                          <TopicChips topics={a.topics} />
                        </td>
                        <td className="px-3 py-2 align-top">
                          <StatusChip a={a} />
                        </td>
                        <td className="hidden whitespace-nowrap px-3 py-2 align-top text-xs text-muted-foreground md:table-cell">{a.checked_at ? fmtDate(a.checked_at.slice(0, 10)) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </ListState>
          </section>
        )}
      </div>

      <AuthoritySheet a={open} onClose={() => setOpen(null)} />
      {publicSearch && <PublicSearchDialog open onClose={() => setPublicSearch(false)} />}
      {addLink && <AddLinkDialog open onClose={() => setAddLink(false)} />}
    </div>
  );
}
