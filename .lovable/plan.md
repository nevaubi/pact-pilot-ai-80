# Meta prompt for the deep second coding pass

Below is the prompt to paste into a fresh deep pass. Approving this plan starts that pass in this session; the text is also ready to copy for use elsewhere.

````text
You are doing a deep, second-pass build of Mirza — a matter-management platform for a boutique
transactional law firm — already scaffolded in this Lovable project (TanStack Start + Lovable Cloud +
Lovable AI Gateway). Do not redesign it. Your job is to make the existing product genuinely solid,
complete, and verified end to end, faithful to the original concept.

## Read first, in this order (source of truth)
1. AGENTS.md — architecture rules: AI calls live only in src/lib/ai.functions.ts (server-only); AI never
   writes data directly; drafts derive only from firm-uploaded house templates with [[Field]]/{{Field}}
   blanks; document text is extracted in the browser; all firm data is shared to any signed-in user.
2. .lovable/plan/ — the approved Phase 1 plan and scope boundaries.
3. The founder brief below (paraphrased, binding).

## Founder brief (binding principles)
Boutique transactional/compliance firms track matters with tasks, deadlines, contacts, notes, files,
closing checklists. Every deal feels like a different transaction even when routine — support the
attorney's judgment, don't over-process. AI is supportive, never primary: the attorney should not
follow the AI, the AI supports the attorneys. Roughly 60% of what AI can do is enough for 99% of cases
if it targets the painful, repetitive work: document intake, meeting notes, drafting help, closing
checklists, catch-me-up summaries.

## Non-negotiable product rules
- AI runs only on an explicit click. Every AI output shows a "Review before use" banner and a short
  "why/source" note pointing at the text it came from.
- AI returns suggestions the user ticks/accepts in the UI; it never writes to the database directly.
- Drafts only fill blanks of the firm's uploaded house templates; suggested edits are verbatim-anchored
  redlines the attorney accepts or rejects. The form is never rewritten.
- No invented facts, parties, dates or numbers. Unknown means say unknown. Tax points are flags, never advice.
- All signed-in users see all matters (phase 1 has no roles).
- AI model is openai/gpt-6-astra via server functions only. Normal effort = low reasoning, Advanced =
  high. Every run is logged to ai_runs with kind, effort and token usage. Normal/Advanced effort level
  is shown on each answer.

## What "high quality functional" means — do all of this
1. Verify every flow like a real user, not by reading code. For each of: sign in (+ email confirmation),
   Today, matter create/edit and every tab (Overview, Tasks, Deadlines, Contacts, Notes, Files, Closing,
   Drafts, Activity), document intake mapping with tick-to-add, meeting notes processing, template
   upload + draft fill + redline accept/reject, closing checklist generation, contacts directory, files
   hub, templates, settings — actually exercise it in the running app with real input and confirm the
   result reads back through the UI. Signed-out or empty-state checks do not count as verification.
2. Fix what's broken at the category level, not the instance. If one tab loses state on reload, fix the
   pattern everywhere. If one mutation lacks a loading or error state, add them everywhere.
3. Harden the AI paths: strict JSON schemas (object root, all properties required, no .min/.max bounds
   in schema — state limits in the prompt text and clamp in code), NoObjectGeneratedError fallback that
   parses the raw text, gateway error semantics surfaced in the UI (402 credits, 429 busy with backoff,
   403 blocked, 401 configuration), streaming on every call, no timeouts or retry-on-timeout wrappers,
   run-ID reuse across follow-ups.
4. Data integrity: RLS enabled with `to authenticated using (true)` plus GRANTs on every public table,
   storage policies for the files and templates buckets, correct foreign keys and cascade behavior.
   Starter sample rows come only from migration INSERT statements — never seed on page load.
5. UX completeness: loading, empty and error states on every list; confirmation on destructive actions;
   toasts on mutations; full dark-mode parity using semantic tokens only (no hardcoded colors);
   responsive down to phone width; unique head() metadata on every content route.
6. Performance and cost: batch matter-context queries into one round trip, cap document text sent to
   the model, log and display token usage per run.
7. Definition of done per item: compiles clean, exercised in the browser with screenshot evidence, no
   console/runtime errors in /tmp/observability, and the change reads back correctly through the UI.
8. Work in priority order: (a) anything broken, (b) core non-AI matter flows, (c) AI desk features,
   (d) polish. Do not start polish until (a)–(c) are verified.

Stay inside Phase 1 scope: no time & billing, no roles/permissions, no email/calendar sync, no
Office/PDF editor, no e-signature, no tax/international/market/case-law modules. When the existing
build contradicts the founder brief, the brief wins — fix the build, don't preserve the deviation.

Finish with a written report: what you verified end to end (with the evidence), what you fixed, and
known gaps remaining.
````

## How to use it

- In this chat: approve the plan and the pass runs here.
- In a new session: paste the prompt as the first message — it points the next pass at the binding
  docs already in the project (AGENTS.md, the archived plan), so context carries over.
