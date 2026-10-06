# Mirza (web) — Phase 1

Rebuild Mirza as a web app, staying close to how the original Mac app looks and works: a left icon rail, a soft blue-tinted light theme (neutral grey dark theme), white cards, colored "ink" accents (purple, blue, green, amber, red, teal), and AI shown as small "verb" buttons ("Tidy up", "Map this deal") instead of a chatbot that pops up by itself. The AI only runs when someone clicks, and the person always reviews the result before it is saved.

## Scope in this build

**1. Matters core (works without AI)**
- Sign in: one email + password login, and everyone in the firm sees all matters.
- Today view: deadlines due soon, open tasks, recent activity.
- Matters: card and list views with filters by practice area (Corporate/M&A, Real Estate, Estate Planning, Finance, Compliance) and status.
- Matter detail, with tabs: Overview, Tasks, Deadlines, Contacts, Notes, Files, Closing, Drafts, Activity.
- Contacts directory, and a Files hub covering all matters.
- Starter sample matters so the first screen is not empty.

**2. Matter AI desk (a button on each matter)**
- An "Assist" panel on each matter. It knows that matter's context and nothing else unless asked.
- A Normal / Advanced effort switch. Normal covers summaries, tasks, notes and drafting. Advanced does deeper analysis and flags issues. Each answer shows which effort level it used.
- Document intake: drop in an LOI, purchase agreement or questionnaire. The AI suggests dates, deadlines, deliverables and parties. The user ticks which ones to add, and only those are saved.
- Meeting notes: paste or type rough notes (dictation in the browser is optional). The AI turns them into a clean summary plus suggested tasks.
- A "Review before use" banner on every AI output, plus a short "Why" note that points to the source text, so the attorney learns from it instead of just accepting it.

**3. Drafting + Closing**
- House template library: the firm uploads its own forms (.docx/.txt/.md) and tags them by practice area. No generic templates are included.
- Drafting assistant: pick a house template, answer the questions it asks, and Mirza fills in the template. The AI may only fill blanks and suggest edits. It never rewrites the form. Changes appear as a redline for the attorney to accept or reject.
- Closing checklist for each matter: deliverable, responsible party, status, due date and notes. The AI can build a starting checklist from the matter's documents and give a "where we stand" summary. Updating the checklist stays manual.

## Out of scope for now
Time and billing, roles and permissions, email and calendar sync, an Office/PDF editor, e-signature, tax, international, finance-market and case-law modules. The structure leaves room to add these later.

## Technical details
- Lovable Cloud: email/password auth with a `profiles` table, plus tables for matters, contacts, matter_contacts, tasks, deadlines, notes, files (storage bucket), templates (storage), drafts, closing_items, ai_runs (holds effort level, input/output and token usage for cost tracking) and activity. RLS limits access to signed-in users, and every record is shared across the firm.
- AI goes through Lovable AI Gateway using server functions with `openai/gpt-6-astra`. Normal uses low reasoning effort and Advanced uses high. Structured outputs (strict JSON schema) are used for intake, tasks and checklists, and every call streams.
- Text is pulled from uploaded files on the server (PDF and DOCX text only) and is never processed beyond that.
- Routes: `/auth`, `/` (Today), `/matters`, `/matters/$id` (tabs), `/contacts`, `/files`, `/templates`, `/settings`.
- Design tokens are carried over from Mirza's Theme (pastel light / neutral dark ramp, ink accents), and the rail icons follow the Phosphor style the original used.
