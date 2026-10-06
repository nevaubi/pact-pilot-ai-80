import { CheckCircle2, Clock, Loader2, ShieldAlert, XCircle, FileText } from "lucide-react";
import { jurisdictionLabel, statusLabel, topicLabel, type AuthorityRow } from "@/lib/library";

export function StatusChip({ a }: { a: Pick<AuthorityRow, "status"> }) {
  const tone: Record<string, string> = {
    ready: "bg-ink-green/10 text-ink-green",
    stored: "bg-ink-amber/10 text-ink-amber",
    pending: "bg-raised text-muted-foreground",
    fetching: "bg-ink-blue/10 text-ink-blue",
    blocked: "bg-ink-red/10 text-ink-red",
    error: "bg-ink-red/10 text-ink-red",
  };
  const Icon =
    a.status === "ready"
      ? CheckCircle2
      : a.status === "fetching"
        ? Loader2
        : a.status === "stored"
          ? FileText
          : a.status === "blocked"
            ? ShieldAlert
            : a.status === "error"
              ? XCircle
              : Clock;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone[a.status] ?? tone["pending"]}`}>
      <Icon className={`h-3 w-3 ${a.status === "fetching" ? "animate-spin" : ""}`} />
      {statusLabel(a)}
    </span>
  );
}

export function JurChip({ j }: { j: string }) {
  const tone: Record<string, string> = {
    federal: "bg-ink-blue/10 text-ink-blue",
    illinois: "bg-ink-teal/10 text-ink-teal",
    cook_county: "bg-ink-purple/10 text-ink-purple",
    chicago: "bg-ink-amber/10 text-ink-amber",
  };
  return (
    <span className={`inline-flex whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[10px] font-semibold ${tone[j] ?? "bg-raised text-muted-foreground"}`}>
      {jurisdictionLabel(j)}
    </span>
  );
}

export function TopicChips({ topics, max = 3 }: { topics: string[]; max?: number }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {topics.slice(0, max).map((t) => (
        <span key={t} className="rounded-sm bg-raised px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {topicLabel(t)}
        </span>
      ))}
      {topics.length > max && <span className="text-[10px] text-muted-foreground">+{topics.length - max}</span>}
    </span>
  );
}

/** Renders ts_headline output: [[term]] → highlighted. */
export function Snippet({ text, className = "" }: { text: string; className?: string }) {
  const parts = text.split(/(\[\[[^\]]+\]\])/g);
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.startsWith("[[") && p.endsWith("]]") ? (
          <mark key={i} className="rounded-sm bg-ink-amber/25 px-0.5 text-foreground">
            {p.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}
