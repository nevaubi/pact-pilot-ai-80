import type { ReactNode } from "react";
import { ShieldCheck, Gauge, Zap } from "lucide-react";
import { practiceInk } from "@/lib/data";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-4 pb-4 pt-6 md:px-8">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, action, children, className = "" }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border bg-card ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PracticeChip({ area }: { area: string }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-medium ${practiceInk[area] ?? "bg-muted text-muted-foreground"}`}>{area}</span>;
}

export function StatusDot({ status }: { status: string }) {
  const c: Record<string, string> = {
    Intake: "bg-ink-purple",
    Active: "bg-ink-green",
    Closing: "bg-ink-amber",
    "On hold": "bg-ink-slate",
    Closed: "bg-muted-foreground",
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${c[status] ?? "bg-ink-slate"}`} />
      {status}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

export type Effort = "normal" | "advanced";

export function EffortToggle({ value, onChange }: { value: Effort; onChange: (e: Effort) => void }) {
  return (
    <div className="inline-flex rounded-lg border bg-raised p-0.5 text-xs" role="radiogroup" aria-label="AI effort">
      {(["normal", "advanced"] as const).map((e) => (
        <button
          key={e}
          role="radio"
          aria-checked={value === e}
          onClick={() => onChange(e)}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors ${
            value === e ? (e === "advanced" ? "bg-ink-purple text-primary-foreground" : "bg-card text-foreground shadow-sm") : "text-muted-foreground"
          }`}
        >
          {e === "normal" ? <Gauge className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
          {e === "normal" ? "Normal" : "Advanced"}
        </button>
      ))}
    </div>
  );
}

export function EffortBadge({ effort }: { effort: Effort }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${effort === "advanced" ? "bg-ink-purple/15 text-ink-purple" : "bg-ink-blue/10 text-ink-blue"}`}>
      {effort}
    </span>
  );
}

export function ReviewBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-ink-amber/30 bg-ink-amber/10 px-3 py-2 text-xs text-foreground">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-amber" />
      <span>
        <b>Review before use.</b> This is a suggestion prepared for you — read it, check the sources, and decide what to keep. Nothing is saved until you choose.
      </span>
    </div>
  );
}

export function Why({ text }: { text: string }) {
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">Why</summary>
      <p className="mt-1 border-l-2 pl-2">{text}</p>
    </details>
  );
}
