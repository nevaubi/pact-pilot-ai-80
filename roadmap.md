# Mirza — roadmap

Priority order: (a) broken → (b) core non-AI flows → (c) AI desk → (d) polish.

## In progress (this pass)
- [ ] Law library: authoritative Illinois + federal sources auto-fetched and stored (eCFR, Federal Register, U.S. Code, IRS/IDOR publications, Cook County / Chicago pages, ILCS official links), full-text indexed, refreshable, fetch-on-request search of public law APIs, pin sources to a matter
- [ ] Tax red-flag checker per matter: grounded on library passages, verbatim-anchored quotes, flags only (never advice), persisted, tick-to-add tasks
- [ ] Real estate module: property & deal terms, business-day contract dates, Illinois/Cook/Chicago transfer tax + tax proration math with citations, jurisdiction requirements checklist, title commitment & survey review (AI, grounded, cross-referenced)
- [ ] Office: Word (.docx) editor with high-fidelity rendering and tracked suggestions, PDF viewer/annotator, spreadsheet editor; AI drafting side panel connected to the matter's files, pinned sources, house templates and the open document
- [ ] Compliance calendar generator (entity annual reports, UCC continuations) with authority links

## Ready (next pass)
- [ ] Semantic retrieval (embeddings) over the law library in addition to full-text search
- [ ] Case-law search (CourtListener) surfaced in Sources with court filters; token optional for higher limits
- [ ] Scheduled library refresh without opening the Library page

## Done
- [x] OCR for scanned PDFs (browser Tesseract, auto on upload + "Read scanned text" button)
- [x] Matter-level "Catch me up"; bulk closing checklist edits; 30-day Today reminders; matter summary export
- [x] Core and AI flows browser-verified; AI hardening (friendly errors, bounded backoff, run-ID reuse, streaming Assist)
- [x] mut()/tryAction() on every write; confirmations on every delete; ListState on every list
- [x] Compact professional UI pass; lazy-loaded heavy tabs; favicon + social preview
