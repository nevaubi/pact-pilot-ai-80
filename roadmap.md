# Mirza — deep second pass roadmap

Priority order: (a) broken → (b) core non-AI flows → (c) AI desk → (d) polish.

## Ready
- [ ] Browser-verify sign in / sign up (mint test user), Today, Matters list + new matter
- [ ] Browser-verify matter detail: every tab (Overview, Tasks, Deadlines, Contacts, Notes, Files, Closing, Drafts, Activity)
- [ ] Browser-verify document intake mapping with tick-to-add
- [ ] Browser-verify meeting notes processing
- [ ] Browser-verify template upload + draft fill + redline accept/reject
- [ ] Browser-verify closing checklist generation
- [ ] Browser-verify Contacts, Files hub, Templates, Settings
- [ ] AI hardening: strict schemas, NoObjectGeneratedError fallback, gateway error semantics in UI, streaming, run-ID reuse
- [ ] Data integrity audit: GRANTs, RLS, storage policies (files + templates), FKs/cascade
- [ ] UX completeness: loading/empty/error states, destructive confirmations, toasts, dark-mode tokens, responsive, head() metadata
- [ ] Performance/cost: batch matter-context queries, cap document text, show tokens per run
- [ ] Final written report

## Done
