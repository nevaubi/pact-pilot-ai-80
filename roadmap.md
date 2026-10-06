# Mirza — deep second pass roadmap

Priority order: (a) broken → (b) core non-AI flows → (c) AI desk → (d) polish.

## Ready (next pass)
- [ ] OCR for scanned PDFs (the 10 MB upload on "1420 W. Fulton Purchase" has no readable text, so it can't be mapped)
- [ ] Matter-level "Catch me up" memo button that files the Assist summary as a note in one click
- [ ] Bulk edit on the closing checklist (reorder by drag, multi-select status)
- [ ] Deadline reminders on Today for the next 30 days with a per-user "mine only" filter
- [ ] Export matter summary (tasks, deadlines, checklist) to Word alongside drafts

- [x] Core flows browser-verified: new/edit matter, tasks, deadlines, notes (add/edit), contacts link, file upload, closing items, reload keeps tab, contacts page add/edit, template upload+edit, settings profile
- [x] AI flows browser-verified: Assist streaming + follow-up history + save-to-notes + session persistence; Map this deal tick-to-add; meeting notes tidy-up + save; closing suggestions; template fill from matter; redlines accept/reject + save
- [x] AI hardening: friendly 400/401/402/403/404/429/5xx messages, bounded 429/5xx backoff, NoObjectGeneratedError fallback, run-ID reuse, streaming route for Assist, usage returned + shown on every result
- [x] One-round-trip matter context with per-file and total document caps
- [x] mut()/tryAction() on every write; confirmations on every delete; ListState loading/empty/error on every list
- [x] Tab in URL; theme applied before paint; matter edit/delete; contact edit/delete; note edit/delete; draft delete/status/title; template original kept in storage
- [x] Auth screens verified: wrong-password message, forgot-password form, sign-up form, sign-out → /auth, protected route redirect
- [x] Assist Stop verified; 402 px phone layout verified (no horizontal scroll on matter, closing, draft); dark mode persists across navigation
- [x] Matter delete verified: cascades tasks/files rows, removes storage objects, keeps ai_runs for cost history
- [x] Test data cleaned (two test matters, test contact); sample house template kept as "Sample — Asset Purchase Agreement"

## Done
