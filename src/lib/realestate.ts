// Deterministic real-estate math and rules for Illinois / Cook County / Chicago closings.
// Every figure carries its authority; rates are constants verified against the official pages
// kept in the law library (see RATES.verifiedOn) — update there when a rate changes.

export const RATES = {
  verifiedOn: "2026-10-06",
  state: { per500: 0.5, cite: "35 ILCS 200/31-10", key: "ilcs:35:200", payer: "Seller" },
  county: { per500: 0.25, cite: "55 ILCS 5/5-1031", key: "ilcs:55:5", payer: "Seller" },
  chicago: {
    buyerPer500: 3.75,
    sellerPer500: 1.5,
    cite: "Chicago Mun. Code ch. 3-33 (Dept. of Finance, Real Property Transfer Tax)",
    key: "chicago:rptt",
  },
} as const;

export type MoneyLine = { label: string; amount: number; payer: string; cite: string; key: string; note?: string };

/** Transfer taxes on the full consideration; each tax is per $500 "or fraction thereof". */
export function transferTaxes(price: number, o: { inChicago: boolean; state?: string }): MoneyLine[] {
  if (!(price > 0)) return [];
  const units = Math.ceil(price / 500);
  const lines: MoneyLine[] = [];
  if ((o.state ?? "IL") === "IL") {
    lines.push({ label: "Illinois state transfer tax", amount: units * RATES.state.per500, payer: RATES.state.payer, cite: RATES.state.cite, key: RATES.state.key, note: "$0.50 per $500 of value or fraction thereof; customarily paid by the seller." });
    lines.push({ label: "County transfer tax", amount: units * RATES.county.per500, payer: RATES.county.payer, cite: RATES.county.cite, key: RATES.county.key, note: "$0.25 per $500 or fraction thereof; customarily paid by the seller." });
  }
  if (o.inChicago) {
    lines.push({ label: "Chicago transfer tax — city portion", amount: units * RATES.chicago.buyerPer500, payer: "Buyer", cite: RATES.chicago.cite, key: RATES.chicago.key, note: "$3.75 per $500 or fraction thereof; the buyer's portion under the ordinance." });
    lines.push({ label: "Chicago transfer tax — CTA portion", amount: units * RATES.chicago.sellerPer500, payer: "Seller", cite: RATES.chicago.cite, key: RATES.chicago.key, note: "$1.50 per $500 or fraction thereof; the seller's (CTA) portion." });
  }
  return lines;
}

// ---------- calendar helpers ----------

const pad = (n: number) => String(n).padStart(2, "0");
export const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseISO = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const nthWeekday = (y: number, m: number, weekday: number, n: number) => {
  const first = new Date(Date.UTC(y, m, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(y, m, 1 + offset + (n - 1) * 7));
};
const lastWeekday = (y: number, m: number, weekday: number) => {
  const last = new Date(Date.UTC(y, m + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(y, m, last.getUTCDate() - offset));
};
const observed = (d: Date) => (d.getUTCDay() === 6 ? addDays(d, -1) : d.getUTCDay() === 0 ? addDays(d, 1) : d);

/** U.S. federal legal public holidays (5 U.S.C. § 6103), with weekend observance. */
export function federalHolidays(year: number): { date: string; name: string }[] {
  const list: [Date, string][] = [
    [observed(new Date(Date.UTC(year, 0, 1))), "New Year's Day"],
    [nthWeekday(year, 0, 1, 3), "Birthday of Martin Luther King, Jr."],
    [nthWeekday(year, 1, 1, 3), "Washington's Birthday"],
    [lastWeekday(year, 4, 1), "Memorial Day"],
    [observed(new Date(Date.UTC(year, 5, 19))), "Juneteenth National Independence Day"],
    [observed(new Date(Date.UTC(year, 6, 4))), "Independence Day"],
    [nthWeekday(year, 8, 1, 1), "Labor Day"],
    [nthWeekday(year, 9, 1, 2), "Columbus Day"],
    [observed(new Date(Date.UTC(year, 10, 11))), "Veterans Day"],
    [nthWeekday(year, 10, 4, 4), "Thanksgiving Day"],
    [observed(new Date(Date.UTC(year, 11, 25))), "Christmas Day"],
  ];
  // Observed New Year's for the following year can land on Dec 31.
  const nextNY = observed(new Date(Date.UTC(year + 1, 0, 1)));
  if (nextNY.getUTCFullYear() === year) list.push([nextNY, "New Year's Day (observed)"]);
  return list.map(([d, name]) => ({ date: iso(d), name }));
}

export function holidayName(d: string) {
  const y = Number(d.slice(0, 4));
  return [...federalHolidays(y), ...federalHolidays(y - 1)].find((h) => h.date === d)?.name ?? null;
}

/** Contract "Business Day": Monday–Friday excluding federal holidays (Multi-Board form definition). */
export const isBusinessDay = (d: Date) => {
  const w = d.getUTCDay();
  return w !== 0 && w !== 6 && !holidayName(iso(d));
};
/** TRID "specific" business day: every calendar day except Sundays and federal holidays (12 CFR 1026.2(a)(6)). */
export const isTridBusinessDay = (d: Date) => d.getUTCDay() !== 0 && !holidayName(iso(d));

/** N business days after `from` (the start date itself is day 0). Negative N counts backwards. */
export function addBusinessDays(from: string, n: number, test = isBusinessDay) {
  let d = parseISO(from);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d = addDays(d, step);
    if (test(d)) left--;
  }
  return iso(d);
}

export function daysBetween(a: string, b: string) {
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / 86_400_000);
}

export type KeyDate = { id: string; title: string; due_on: string; kind: string; basis: string; cite: string; key?: string };

export function contractDates(p: {
  acceptance?: string | null;
  closing?: string | null;
  attorneyReviewDays: number;
  inspectionDays: number;
  earnestDays?: number | null;
  financed: boolean;
  foreignSeller: boolean;
  exchange1031: boolean;
}): KeyDate[] {
  const out: KeyDate[] = [];
  if (p.acceptance) {
    out.push({
      id: "attorney-review",
      title: "Attorney review / modification period ends",
      due_on: addBusinessDays(p.acceptance, p.attorneyReviewDays),
      kind: "Contract",
      basis: `${p.attorneyReviewDays} business days after acceptance (${p.acceptance}); weekends and federal holidays skipped`,
      cite: "Multi-Board Residential Real Estate Contract — attorney review paragraph; confirm the executed contract's number of days",
    });
    out.push({
      id: "inspection",
      title: "Inspection period ends",
      due_on: addBusinessDays(p.acceptance, p.inspectionDays),
      kind: "Contract",
      basis: `${p.inspectionDays} business days after acceptance`,
      cite: "Multi-Board Residential Real Estate Contract — inspection paragraph; confirm the executed contract",
    });
    if (p.earnestDays && p.earnestDays > 0)
      out.push({
        id: "earnest",
        title: "Earnest money due",
        due_on: addBusinessDays(p.acceptance, p.earnestDays),
        kind: "Contract",
        basis: `${p.earnestDays} business days after acceptance`,
        cite: "Per the executed contract's earnest money paragraph",
      });
  }
  if (p.closing) {
    if (p.financed)
      out.push({
        id: "cd",
        title: "Latest day for borrower to receive the Closing Disclosure",
        due_on: addBusinessDays(p.closing, -3, isTridBusinessDay),
        kind: "Closing",
        basis: "Received no later than three business days before consummation; for this rule a business day is every day except Sundays and federal holidays",
        cite: "12 CFR 1026.19(f)(1)(ii); 12 CFR 1026.2(a)(6)",
        key: "ecfr:12:1026.19",
      });
    if (p.foreignSeller) {
      const d = addDays(parseISO(p.closing), 20);
      out.push({
        id: "firpta",
        title: "FIRPTA withholding due — Forms 8288 / 8288-A",
        due_on: iso(d),
        kind: "Filing",
        basis: "Within 20 days after the date of transfer",
        cite: "26 CFR 1.1445-1(c)",
        key: "ecfr:26:1.1445-1",
      });
    }
    if (p.exchange1031) {
      out.push({
        id: "1031-id",
        title: "§1031 identification period ends (45 days)",
        due_on: iso(addDays(parseISO(p.closing), 45)),
        kind: "Filing",
        basis: "45 calendar days after the transfer of the relinquished property; no extension for weekends or holidays",
        cite: "26 CFR 1.1031(k)-1(b)(2)",
        key: "ecfr:26:1.1031(k)-1",
      });
      out.push({
        id: "1031-ex",
        title: "§1031 exchange period ends (180 days)",
        due_on: iso(addDays(parseISO(p.closing), 180)),
        kind: "Filing",
        basis: "180 calendar days after the transfer, or the return due date if earlier",
        cite: "26 CFR 1.1031(k)-1(b)(2)",
        key: "ecfr:26:1.1031(k)-1",
      });
    }
  }
  return out;
}

// ---------- property tax proration (taxes paid in arrears) ----------

export function taxProration(p: { lastBill: number; pct: number; closing: string; priorYearUnpaid?: number }) {
  if (!(p.lastBill > 0) || !p.closing) return null;
  const d = parseISO(p.closing);
  const y = d.getUTCFullYear();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInYear = leap ? 366 : 365;
  const dayOfYear = Math.round((d.getTime() - Date.UTC(y, 0, 1)) / 86_400_000) + 1; // through and including the closing date
  const estimated = (p.lastBill * p.pct) / 100;
  const perDiem = estimated / daysInYear;
  const currentYear = perDiem * dayOfYear;
  const prior = p.priorYearUnpaid ?? 0;
  return {
    daysInYear,
    dayOfYear,
    estimatedAnnual: estimated,
    perDiem,
    currentYearCredit: currentYear,
    priorYearUnpaid: prior,
    totalCredit: currentYear + prior,
    basis: `Estimated ${y} taxes = last full-year bill × ${p.pct}% = $${estimated.toFixed(2)}; per diem $${perDiem.toFixed(4)} × ${dayOfYear} days (Jan 1 through closing) = $${currentYear.toFixed(2)}${prior ? `, plus unpaid prior-year taxes $${prior.toFixed(2)}` : ""}.`,
    note: "Illinois property taxes are paid in arrears, so the seller credits the buyer at closing for taxes not yet billed. The proration percentage and the day-count convention come from the contract; Cook County bills in two installments (first installment 55% of the prior year's total).",
    cite: "35 ILCS 200/21-15, 21-25, 21-30 (installments); contract proration paragraph",
  };
}

// ---------- jurisdiction requirements (what must be delivered, by whom, under what) ----------

export type Property = {
  side: string;
  property_type: string;
  year_built: number | null;
  in_chicago: boolean;
  county: string;
  state: string;
  loan_amount: number | null;
  purchase_price: number | null;
};

export type Requirement = {
  id: string;
  title: string;
  responsible: string;
  when: "Before the contract binds" | "Before closing" | "At closing" | "After closing";
  cite: string;
  key: string | null;
  note: string;
  verify?: boolean;
};

const isResidential = (t: string) => /residential|condo|single|multi|co-op|cooperative/i.test(t);
const isCondo = (t: string) => /condo|co-op|cooperative/i.test(t);

export function requirementsFor(p: Property, o: { foreignSeller: boolean; entityBuyerNonFinanced: boolean; commonInterest: boolean; individuallyMetered: boolean }): Requirement[] {
  const r: Requirement[] = [];
  const res = isResidential(p.property_type);
  const condo = isCondo(p.property_type);
  if (p.state === "IL") {
    if (res)
      r.push({
        id: "rrpda",
        title: "Residential Real Property Disclosure Report delivered before the contract is signed",
        responsible: "Seller",
        when: "Before the contract binds",
        cite: "765 ILCS 77/20; exemptions at 765 ILCS 77/15",
        key: "ilcs:765:77",
        note: "Required for 1–4 unit residential property, condominium units and co-ops unless an exemption applies (estates, court-ordered transfers, transfers between co-owners or to a spouse/lineal relative, foreclosure deeds).",
      });
    if (res)
      r.push({
        id: "radon",
        title: "Radon pamphlet and Disclosure of Information on Radon Hazards",
        responsible: "Seller",
        when: "Before the contract binds",
        cite: "420 ILCS 46/10",
        key: "ilcs:420:46",
        note: "Residential sales; the IEMA pamphlet and the signed disclosure form go to the buyer before the buyer is obligated.",
      });
    if (res && p.year_built !== null && p.year_built < 1978)
      r.push({
        id: "lead",
        title: "Lead-based paint disclosure, EPA pamphlet and 10-day evaluation opportunity (pre-1978 housing)",
        responsible: "Seller",
        when: "Before the contract binds",
        cite: "42 U.S.C. § 4852d; 24 CFR Part 35 Subpart A; 40 CFR 745.107",
        key: "ecfr:24:35:A",
        note: `Built ${p.year_built}: target housing. Keep the signed disclosure for three years.`,
      });
    if (condo)
      r.push({
        id: "condo-221",
        title: "Condominium resale disclosures (§22.1) and paid-assessment letter from the association",
        responsible: "Seller / Association",
        when: "Before closing",
        cite: "765 ILCS 605/22.1; 765 ILCS 605/9",
        key: "ilcs:765:605",
        note: "Declaration, bylaws, rules, budget, reserves, pending litigation, and the association's statement of unpaid assessments.",
      });
    if (o.commonInterest && !condo)
      r.push({
        id: "cica",
        title: "Common interest community resale disclosure",
        responsible: "Seller / Association",
        when: "Before closing",
        cite: "765 ILCS 160/1-35",
        key: "ilcs:765:160",
        note: "Townhome and HOA communities covered by the Common Interest Community Association Act.",
      });
    r.push({
      id: "ptax203",
      title: "Illinois Real Estate Transfer Declaration (PTAX-203 / MyDec)",
      responsible: "Seller (prepared with title)",
      when: "At closing",
      cite: "35 ILCS 200/31-25",
      key: "idor:ptax-203",
      note: "Filed with every recorded conveyance unless exempt; the county will not record without it (or the exemption statement).",
    });
    r.push({
      id: "stamps",
      title: "State and county transfer tax stamps",
      responsible: "Seller",
      when: "At closing",
      cite: "35 ILCS 200/31-10; 55 ILCS 5/5-1031",
      key: "ilcs:35:200",
      note: "$0.50 (state) + $0.25 (county) per $500 of consideration; check exemptions under 35 ILCS 200/31-45.",
    });
    if (p.in_chicago) {
      r.push({
        id: "fpc",
        title: "Chicago Full Payment Certificate (water/sewer) obtained before transfer stamps issue",
        responsible: "Seller",
        when: "Before closing",
        cite: "Chicago Dept. of Finance — Full Payment Certificates",
        key: "chicago:fpc",
        note: "Required on every Chicago transfer, exempt or not; apply early — final readings and open balances delay closings.",
      });
      r.push({
        id: "chi-stamps",
        title: "Chicago Real Property Transfer Tax declaration and stamps (city and CTA portions)",
        responsible: "Buyer (city portion) / Seller (CTA portion)",
        when: "At closing",
        cite: "Chicago Mun. Code ch. 3-33; Dept. of Finance RPTT page",
        key: "chicago:rptt",
        note: "$3.75 per $500 buyer portion plus $1.50 per $500 CTA portion, unless an exemption applies.",
      });
      if (res && !condo)
        r.push({
          id: "zoning",
          title: "Certificate of Zoning Compliance (residential buildings with five or fewer units)",
          responsible: "Seller",
          when: "Before closing",
          cite: "Chicago Dept. of Planning & Development — Certificate of Zoning Compliance",
          key: "chicago:zoning",
          note: "Not required for condominium units or co-ops; confirms the legal number of dwelling units.",
          verify: true,
        });
      if (res && o.individuallyMetered)
        r.push({
          id: "heating",
          title: "Heating cost disclosure to the buyer",
          responsible: "Seller",
          when: "Before the contract binds",
          cite: "Chicago Heating Cost Disclosure Ordinance (ch. 5-16) and rules",
          key: "chicago:heating",
          note: "Residential buildings where the buyer will pay heat on an individually metered basis.",
        });
    } else
      r.push({
        id: "muni",
        title: "Municipal transfer stamp / point-of-sale inspection / final water reading requirements",
        responsible: "Seller (confirm with the municipality)",
        when: "Before closing",
        cite: "Local ordinance — add it to the library by link once identified",
        key: null,
        note: "Many suburbs require a municipal transfer stamp, a final water bill, or a point-of-sale inspection. Confirm for this municipality.",
        verify: true,
      });
  }
  r.push({
    id: "firpta",
    title: o.foreignSeller ? "FIRPTA withholding (15%) and Forms 8288 / 8288-A, or a withholding certificate" : "Seller's certification of non-foreign status (FIRPTA affidavit)",
    responsible: o.foreignSeller ? "Buyer (withholding agent) / Title" : "Seller",
    when: "At closing",
    cite: "26 U.S.C. § 1445; 26 CFR 1.1445-2",
    key: "ecfr:26:1.1445-2",
    note: o.foreignSeller
      ? "The buyer is the withholding agent; remit within 20 days after transfer. Reduced rate/exception may apply to a residence under $1,000,000."
      : "Without the affidavit the buyer must withhold; the residence exception needs the buyer's own certification.",
  });
  r.push({
    id: "1099s",
    title: "Form 1099-S reporting by the reporting person (or seller's principal-residence certification)",
    responsible: "Title / closing agent",
    when: "At closing",
    cite: "26 CFR 1.6045-4",
    key: "ecfr:26:1.6045-4",
    note: "The settlement agent reports unless an exception applies; a principal-residence certification can relieve reporting.",
  });
  if ((p.loan_amount ?? 0) > 0 && res)
    r.push({
      id: "trid",
      title: "Closing Disclosure received by the borrower at least three business days before consummation",
      responsible: "Lender",
      when: "Before closing",
      cite: "12 CFR 1026.19(f)(1)(ii)",
      key: "ecfr:12:1026.19",
      note: "Changes to APR beyond tolerance, the loan product or a prepayment penalty restart the three-day clock.",
    });
  if (res && o.entityBuyerNonFinanced)
    r.push({
      id: "rre",
      title: "FinCEN Residential Real Estate report for a non-financed transfer to an entity or trust",
      responsible: "Reporting person (title/closing agent) — confirm current enforcement status",
      when: "After closing",
      cite: "31 CFR Part 1031",
      key: "ecfr:31:1031",
      note: "The rule's enforcement status has changed since it was adopted; check the library's Federal Register activity and FinCEN's page before relying on it.",
      verify: true,
    });
  r.push({
    id: "title",
    title: "Title commitment reviewed; ALTA statement, lien waivers and payoff letters ordered",
    responsible: "Seller / Title",
    when: "Before closing",
    cite: "215 ILCS 155 (Title Insurance Act); 770 ILCS 60 (Mechanics Lien Act)",
    key: "ilcs:770:60",
    note: "Clear mortgages, judgments and tax liens; waive standard exceptions with the ALTA statement and (for extended coverage) a current survey.",
  });
  if (!condo)
    r.push({
      id: "survey",
      title: "Current plat of survey (ALTA/NSPS for commercial) delivered and compared with Schedule B",
      responsible: "Seller",
      when: "Before closing",
      cite: "Contract survey paragraph; extended coverage requirements of the title insurer",
      key: null,
      note: "Encroachments, setback and easement conflicts should be matched against the recorded exceptions.",
    });
  if (res && p.side === "Buyer")
    r.push({
      id: "homestead",
      title: "Apply for or confirm the homeowner (homestead) exemption with the county assessor",
      responsible: "Buyer",
      when: "After closing",
      cite: "35 ILCS 200/15-175",
      key: "ilcs:35:200",
      note: "Exemptions follow the occupant; a missed application costs a full year's savings.",
    });
  return r;
}

export const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
