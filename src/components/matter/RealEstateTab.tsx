import { cloneElement, lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Check, ExternalLink, Save, ListPlus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, Json } from "@/integrations/supabase/types";
import { propertyQ, tableQ, logActivity, fmtDate } from "@/lib/data";
import { mut, tryAction } from "@/lib/mutate";
import { authoritiesQ, type AuthorityRow } from "@/lib/library";
import { contractDates, transferTaxes, taxProration, requirementsFor, holidayName, money, RATES, type Requirement } from "@/lib/realestate";
import { Panel } from "@/components/kit";
import { AuthoritySheet } from "@/components/library/AuthoritySheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const TitleReview = lazy(() => import("./TitleReview").then((m) => ({ default: m.TitleReview })));

type Prop = Tables<"matter_properties">;
type Flags = { foreignSeller?: boolean; exchange1031?: boolean; entityBuyerNonFinanced?: boolean; commonInterest?: boolean; individuallyMetered?: boolean };

const SIDES = ["Buyer", "Seller", "Lender", "Landlord", "Tenant", "Other"];
const TYPES = ["Residential (1-4 units)", "Condominium", "Townhome / HOA", "Multifamily (5+ units)", "Commercial", "Industrial", "Mixed-use", "Vacant land"];
const COUNTIES = ["Cook", "DuPage", "Lake", "Will", "Kane", "McHenry", "Kendall", "Other"];

const blank = (matterId: string): Prop => ({
  matter_id: matterId,
  side: "Buyer",
  address: null,
  city: null,
  county: "Cook",
  state: "IL",
  zip: null,
  pin: null,
  property_type: "Residential (1-4 units)",
  year_built: null,
  in_chicago: false,
  purchase_price: null,
  earnest_money: null,
  loan_amount: null,
  acceptance_date: null,
  closing_date: null,
  title_company: null,
  lender: null,
  survey_date: null,
  last_tax_bill: null,
  tax_year: null,
  proration_pct: 105,
  notes: null,
  flags: {},
  attorney_review_days: 5,
  inspection_days: 5,
  earnest_days: null,
  prior_year_unpaid: null,
  updated_at: new Date().toISOString(),
});

export function RealEstateTab({ matter }: { matter: Tables<"matters"> }) {
  const qc = useQueryClient();
  const q = useQuery(propertyQ(matter.id));
  const deadlines = useQuery(tableQ("deadlines", matter.id));
  const closing = useQuery(tableQ("closing_items", matter.id));
  const lib = useQuery(authoritiesQ);
  const [form, setForm] = useState<Prop>(() => blank(matter.id));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openAuth, setOpenAuth] = useState<AuthorityRow | null>(null);
  useEffect(() => {
    if (q.data) {
      setForm(q.data);
      setDirty(false);
    }
  }, [q.data]);

  const byKey = useMemo(() => new Map((lib.data ?? []).filter((a) => a.key).map((a) => [a.key!, a])), [lib.data]);
  const flags = (form.flags ?? {}) as Flags;
  const set = <K extends keyof Prop>(k: K, v: Prop[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };
  const setFlag = (k: keyof Flags, v: boolean) => set("flags", { ...flags, [k]: v } as unknown as Json);
  const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/[,$\s]/g, "")));

  async function save() {
    setSaving(true);
    await tryAction(async () => {
      const { updated_at: _u, ...row } = form;
      void _u;
      await mut(supabase.from("matter_properties").upsert(row, { onConflict: "matter_id" }).select("matter_id"), { success: "Property saved" });
      await logActivity(matter.id, "Updated property and deal terms");
      qc.invalidateQueries({ queryKey: ["property", matter.id] });
      qc.invalidateQueries({ queryKey: ["activity", matter.id] });
      setDirty(false);
    });
    setSaving(false);
  }

  const dates = useMemo(
    () =>
      contractDates({
        acceptance: form.acceptance_date,
        closing: form.closing_date,
        attorneyReviewDays: form.attorney_review_days,
        inspectionDays: form.inspection_days,
        earnestDays: form.earnest_days,
        financed: (form.loan_amount ?? 0) > 0,
        foreignSeller: !!flags.foreignSeller,
        exchange1031: !!flags.exchange1031,
      }),
    [form, flags.foreignSeller, flags.exchange1031],
  );
  const taxes = useMemo(() => transferTaxes(form.purchase_price ?? 0, { inChicago: form.in_chicago, state: form.state }), [form.purchase_price, form.in_chicago, form.state]);
  const proration = useMemo(
    () => (form.last_tax_bill && form.closing_date ? taxProration({ lastBill: form.last_tax_bill, pct: form.proration_pct, closing: form.closing_date, priorYearUnpaid: form.prior_year_unpaid ?? 0 }) : null),
    [form.last_tax_bill, form.closing_date, form.proration_pct, form.prior_year_unpaid],
  );
  const reqs = useMemo(
    () =>
      requirementsFor(form, {
        foreignSeller: !!flags.foreignSeller,
        entityBuyerNonFinanced: !!flags.entityBuyerNonFinanced,
        commonInterest: !!flags.commonInterest || form.property_type === "Townhome / HOA",
        individuallyMetered: !!flags.individuallyMetered,
      }),
    [form, flags],
  );

  const existingDeadlines = new Set((deadlines.data ?? []).map((d) => d.title.toLowerCase()));
  const existingClosing = new Set((closing.data ?? []).map((c) => c.deliverable.toLowerCase()));
  const [reqSel, setReqSel] = useState<Record<string, boolean>>({});

  async function addDeadline(d: (typeof dates)[number]) {
    await tryAction(async () => {
      await mut(supabase.from("deadlines").insert({ matter_id: matter.id, title: d.title, due_on: d.due_on, kind: d.kind, source: "realestate" }).select("id"), { success: "Deadline added" });
      await logActivity(matter.id, `Added deadline ${d.title} (${d.due_on})`);
      qc.invalidateQueries({ queryKey: ["deadlines", matter.id] });
      qc.invalidateQueries({ queryKey: ["today-deadlines"] });
    });
  }
  async function addRequirements() {
    const picked = reqs.filter((r) => reqSel[r.id] && !existingClosing.has(r.title.toLowerCase()));
    if (!picked.length) {
      toast("Tick the requirements to add first.");
      return;
    }
    await tryAction(async () => {
      const base = 200 + (closing.data?.length ?? 0);
      await mut(
        supabase
          .from("closing_items")
          .insert(picked.map((r, i) => ({ matter_id: matter.id, deliverable: r.title, responsible: r.responsible, notes: `${r.when}. ${r.cite}. ${r.note}`, position: base + i })))
          .select("id"),
        { success: `${picked.length} item${picked.length > 1 ? "s" : ""} added to the closing checklist` },
      );
      await logActivity(matter.id, `Added ${picked.length} jurisdiction requirement${picked.length > 1 ? "s" : ""} to the closing checklist`);
      qc.invalidateQueries({ queryKey: ["closing_items", matter.id] });
      setReqSel({});
    });
  }

  const openCite = (r: { key: string | null }) => {
    const a = r.key ? byKey.get(r.key) : undefined;
    if (a) setOpenAuth(a);
  };
  const sideTotals = taxes.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.payer]: (acc[l.payer] ?? 0) + l.amount }), {});

  if (q.isPending) return <Skeleton className="h-64 w-full rounded" />;

  return (
    <div className="space-y-4">
      {/* Property & deal terms */}
      <Panel
        title="Property & deal terms"
        action={
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            <Save className="mr-1.5 h-3.5 w-3.5" /> {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Our side">
            <Select value={form.side} onValueChange={(v) => set("side", v)}>
              <SelectTrigger aria-label="Our side">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIDES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Property type">
            <Select value={form.property_type} onValueChange={(v) => set("property_type", v)}>
              <SelectTrigger aria-label="Property type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Year built">
            <Input inputMode="numeric" value={form.year_built ?? ""} onChange={(e) => set("year_built", num(e.target.value))} placeholder="e.g. 1962" />
          </Field>
          <Field label="PIN">
            <Input value={form.pin ?? ""} onChange={(e) => set("pin", e.target.value || null)} placeholder="14-21-305-032-0000" className="font-mono" />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Input value={form.address ?? ""} onChange={(e) => set("address", e.target.value || null)} placeholder="Street address" />
          </Field>
          <Field label="City">
            <Input value={form.city ?? ""} onChange={(e) => set("city", e.target.value || null)} />
          </Field>
          <Field label="County">
            <Select value={form.county} onValueChange={(v) => set("county", v)}>
              <SelectTrigger aria-label="County">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COUNTIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Purchase price">
            <Input inputMode="decimal" value={form.purchase_price ?? ""} onChange={(e) => set("purchase_price", num(e.target.value))} placeholder="650000" />
          </Field>
          <Field label="Earnest money">
            <Input inputMode="decimal" value={form.earnest_money ?? ""} onChange={(e) => set("earnest_money", num(e.target.value))} />
          </Field>
          <Field label="Loan amount (0 if cash)">
            <Input inputMode="decimal" value={form.loan_amount ?? ""} onChange={(e) => set("loan_amount", num(e.target.value))} />
          </Field>
          <Field label="Lender">
            <Input value={form.lender ?? ""} onChange={(e) => set("lender", e.target.value || null)} />
          </Field>
          <Field label="Date of acceptance">
            <Input type="date" value={form.acceptance_date ?? ""} onChange={(e) => set("acceptance_date", e.target.value || null)} />
          </Field>
          <Field label="Closing date">
            <Input type="date" value={form.closing_date ?? ""} onChange={(e) => set("closing_date", e.target.value || null)} />
          </Field>
          <Field label="Title company">
            <Input value={form.title_company ?? ""} onChange={(e) => set("title_company", e.target.value || null)} />
          </Field>
          <Field label="Survey date">
            <Input type="date" value={form.survey_date ?? ""} onChange={(e) => set("survey_date", e.target.value || null)} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
          <Flag label="Inside the City of Chicago" checked={form.in_chicago} onChange={(v) => set("in_chicago", v)} />
          <Flag label="Seller may be a foreign person (FIRPTA)" checked={!!flags.foreignSeller} onChange={(v) => setFlag("foreignSeller", v)} />
          <Flag label="§1031 exchange" checked={!!flags.exchange1031} onChange={(v) => setFlag("exchange1031", v)} />
          <Flag label="Buyer is an entity or trust paying without a loan" checked={!!flags.entityBuyerNonFinanced} onChange={(v) => setFlag("entityBuyerNonFinanced", v)} />
          <Flag label="HOA / common interest community" checked={!!flags.commonInterest} onChange={(v) => setFlag("commonInterest", v)} />
          <Flag label="Buyer will pay individually metered heat (Chicago)" checked={!!flags.individuallyMetered} onChange={(v) => setFlag("individuallyMetered", v)} />
        </div>
        <div className="mt-3">
          <Label className="text-xs text-muted-foreground">Notes</Label>
          <Textarea value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value || null)} rows={2} placeholder="Deal-specific notes: who holds earnest money, special terms, occupancy…" className="mt-1" />
        </div>
      </Panel>

      {/* Key dates */}
      <Panel
        title="Key dates"
        action={
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Attorney review</span>
            <Input className="h-7 w-14 text-xs" inputMode="numeric" value={form.attorney_review_days} onChange={(e) => set("attorney_review_days", Number(e.target.value) || 0)} aria-label="Attorney review business days" />
            <span className="text-muted-foreground">Inspection</span>
            <Input className="h-7 w-14 text-xs" inputMode="numeric" value={form.inspection_days} onChange={(e) => set("inspection_days", Number(e.target.value) || 0)} aria-label="Inspection business days" />
            <span className="text-muted-foreground">Earnest</span>
            <Input className="h-7 w-14 text-xs" inputMode="numeric" value={form.earnest_days ?? ""} onChange={(e) => set("earnest_days", num(e.target.value))} placeholder="—" aria-label="Earnest money business days" />
            <span className="text-muted-foreground">business days</span>
          </div>
        }
      >
        {!form.acceptance_date && !form.closing_date ? (
          <p className="text-sm text-muted-foreground">Enter the date of acceptance and the closing date above to compute the contract, lender and tax deadlines.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y">
              {dates.map((d) => {
                const exists = existingDeadlines.has(d.title.toLowerCase());
                const hol = holidayName(d.due_on);
                return (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs">{fmtDate(d.due_on)}</td>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{d.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {d.basis}. <span className="font-mono">{d.cite}</span>
                        {hol ? <span className="text-ink-amber"> · falls on {hol}</span> : null}
                      </div>
                    </td>
                    <td className="py-2 text-right">
                      <Button size="sm" variant={exists ? "ghost" : "outline"} disabled={exists} onClick={() => addDeadline(d)}>
                        {exists ? <Check className="mr-1 h-3.5 w-3.5 text-ink-green" /> : <CalendarPlus className="mr-1 h-3.5 w-3.5" />}
                        {exists ? "On calendar" : "Add deadline"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Contract periods count Monday–Friday and skip federal holidays, as the Multi-Board form defines “Business Day”; confirm the day counts against the executed contract. Lender and tax deadlines use their own statutory day-count rules, shown on each line.
        </p>
      </Panel>

      {/* Closing math */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Transfer taxes">
          {!taxes.length ? (
            <p className="text-sm text-muted-foreground">Enter the purchase price to compute state, county and Chicago transfer taxes.</p>
          ) : (
            <>
              <table className="w-full text-sm">
                <tbody className="divide-y">
                  {taxes.map((l) => (
                    <tr key={l.label}>
                      <td className="py-1.5 pr-2">
                        <div>{l.label}</div>
                        <button className="text-left font-mono text-[11px] text-ink-blue hover:underline" onClick={() => openCite(l)}>
                          {l.cite}
                        </button>
                      </td>
                      <td className="py-1.5 pr-2 text-xs text-muted-foreground">{l.payer}</td>
                      <td className="py-1.5 text-right font-mono">{money(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {Object.entries(sideTotals).map(([payer, amt]) => (
                    <tr key={payer} className="border-t">
                      <td className="py-1.5 font-medium" colSpan={2}>
                        {payer} pays
                      </td>
                      <td className="py-1.5 text-right font-mono font-medium">{money(amt)}</td>
                    </tr>
                  ))}
                </tfoot>
              </table>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Per $500 of consideration or fraction thereof. Who pays follows Chicago-area custom; the contract controls. Exemptions under 35 ILCS 200/31-45 and the Chicago ordinance are not applied automatically. Rates verified {RATES.verifiedOn} against the sources in the library.
              </p>
            </>
          )}
        </Panel>
        <Panel title="Property tax proration">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Last full-year bill">
              <Input inputMode="decimal" value={form.last_tax_bill ?? ""} onChange={(e) => set("last_tax_bill", num(e.target.value))} placeholder="9000" />
            </Field>
            <Field label="Tax year">
              <Input inputMode="numeric" value={form.tax_year ?? ""} onChange={(e) => set("tax_year", num(e.target.value))} placeholder="2025" />
            </Field>
            <Field label="Proration %">
              <Input inputMode="decimal" value={form.proration_pct} onChange={(e) => set("proration_pct", Number(e.target.value) || 100)} />
            </Field>
            <Field label="Prior-year unpaid">
              <Input inputMode="decimal" value={form.prior_year_unpaid ?? ""} onChange={(e) => set("prior_year_unpaid", num(e.target.value))} placeholder="0" />
            </Field>
          </div>
          {proration ? (
            <div className="mt-3 space-y-1 text-sm">
              <div className="flex items-baseline justify-between">
                <span>Credit from seller to buyer at closing</span>
                <span className="font-mono text-base font-semibold">{money(proration.totalCredit)}</span>
              </div>
              <p className="text-xs text-muted-foreground">{proration.basis}</p>
              <p className="text-[11px] text-muted-foreground">
                {proration.note} <span className="font-mono">{proration.cite}</span>
              </p>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">Enter the last full-year tax bill and a closing date to estimate the proration credit.</p>
          )}
        </Panel>
      </div>

      {/* Requirements */}
      <Panel
        title={`What this closing requires — ${form.in_chicago ? "Chicago, " : ""}${form.county} County, ${form.state}`}
        action={
          <Button size="sm" onClick={addRequirements} disabled={!Object.values(reqSel).some(Boolean)}>
            <ListPlus className="mr-1.5 h-3.5 w-3.5" /> Add selected to closing checklist
          </Button>
        }
      >
        <ul className="divide-y">
          {reqs.map((r) => (
            <RequirementRow key={r.id} r={r} exists={existingClosing.has(r.title.toLowerCase())} checked={!!reqSel[r.id]} onCheck={(v) => setReqSel({ ...reqSel, [r.id]: v })} onCite={() => openCite(r)} hasCite={!!(r.key && byKey.get(r.key))} />
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-muted-foreground">Generated from the property record by fixed rules with citations — not by AI. Items marked “verify” depend on facts the record doesn't hold.</p>
      </Panel>

      <Suspense fallback={<Skeleton className="h-40 w-full rounded" />}>
        <TitleReview matter={matter} property={q.data ?? null} onOpenAuthority={(a) => setOpenAuth(a)} />
      </Suspense>

      <AuthoritySheet a={openAuth} onClose={() => setOpenAuth(null)} matterId={matter.id} />
    </div>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactElement<{ id?: string }>; className?: string }) {
  const id = `re-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const isSelect = children.type === Select;
  return (
    <div className={`space-y-1 ${className}`}>
      <Label htmlFor={isSelect ? undefined : id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {isSelect ? children : cloneElement(children, { id })}
    </div>
  );
}

function Flag({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(!!v)} aria-label={label} />
      {label}
    </label>
  );
}

function RequirementRow({ r, exists, checked, onCheck, onCite, hasCite }: { r: Requirement; exists: boolean; checked: boolean; onCheck: (v: boolean) => void; onCite: () => void; hasCite: boolean }) {
  return (
    <li className="flex items-start gap-2.5 py-2">
      <Checkbox className="mt-0.5" checked={checked} disabled={exists} onCheckedChange={(v) => onCheck(!!v)} aria-label={r.title} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{r.title}</span>
          {exists && <span className="rounded bg-ink-green/10 px-1.5 py-0.5 text-[10px] font-semibold text-ink-green">On checklist</span>}
          {r.verify && <span className="rounded bg-ink-amber/10 px-1.5 py-0.5 text-[10px] font-semibold text-ink-amber">verify</span>}
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{r.responsible}</span> · {r.when} ·{" "}
          {hasCite ? (
            <button className="font-mono text-ink-blue hover:underline" onClick={onCite}>
              {r.cite}
            </button>
          ) : (
            <span className="font-mono">{r.cite}</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{r.note}</p>
      </div>
      {hasCite && (
        <Button size="icon" variant="ghost" aria-label="Open source" onClick={onCite}>
          <ExternalLink className="h-4 w-4" />
        </Button>
      )}
    </li>
  );
}
