# Mirza — deep second pass roadmap

Priority order: (a) broken → (b) core non-AI flows → (c) AI desk → (d) polish.

## Ready
- [ ] Browser-verify sign in / sign up / forgot password screens
- [ ] Verify Assist Stop button, phone-width layout (402px), dark mode parity
- [ ] Data integrity audit: storage policies, profiles upsert, cascade on matter delete (verify by deleting the test matter)
- [ ] Head metadata review on every route
- [ ] Clean up test data (test matter, test contact, test template) once verified
- [ ] Final written report

- [x] Core flows browser-verified: new/edit matter, tasks, deadlines, notes (add/edit), contacts link, file upload, closing items, reload keeps tab, contacts page add/edit, template upload+edit, settings profile
- [x] AI flows browser-verified: Assist streaming + follow-up history + save-to-notes + session persistence; Map this deal tick-to-add; meeting notes tidy-up + save; closing suggestions; template fill from matter; redlines accept/reject + save
- [x] AI hardening: friendly 400/401/402/403/404/429/5xx messages, bounded 429/5xx backoff, NoObjectGeneratedError fallback, run-ID reuse, streaming route for Assist, usage returned + shown on every result
- [x] One-round-trip matter context with per-file and total document caps
- [x] mut()/tryAction() on every write; confirmations on every delete; ListState loading/empty/error on every list
- [x] Tab in URL; theme applied before paint; matter edit/delete; contact edit/delete; note edit/delete; draft delete/status/title; template original kept in storage

## Done
