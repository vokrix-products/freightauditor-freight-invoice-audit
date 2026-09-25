# FreightAuditor — Freight Invoice Contract Audit

## Product
FreightAuditor audits freight invoices against carrier rate schedules. Shippers feed in PDF/Excel/CSV/plain-text invoices and rate schedules. Each document is normalized into a shared schema, classified as invoice or rate sheet, and given a status.

Statuses (must match `records.status` and `data.tsx` in the dashboard):
- `valid:good` — required fields present and every check passes
- `missing:critical` — a required field is missing
- `flagged:critical` — duplicate invoice, variance, or total mismatch
- `expired:warning` — rate schedule is past its expiry date
- `contract-review:warning` — needs human review
- `unmapped:warning` — document type unknown

## Archetype
Pure processing backend, no web framework, plus a React dashboard.

- `processor.py` — entry point `process_file(file_bytes)`
- `llm_extractor.py` — optional DeepSeek fallback for unstructured text
- `poller.py` — polls `jobs` for `process_upload` rows and writes `records`
- `run_demo.py` — self-contained demo
- `run_tests.py` — self-tests

## Poller input
`process_file(file_bytes)` accepts bytes of one PDF, XLSX, CSV, or text file. PDF uses pdfplumber; XLSX uses openpyxl headers; CSV uses a sniffer; plain text is treated as unstructured.

**OCR is out of scope.** A scanned PDF with no text layer will not extract. Most carrier invoices arrive as emailed PDFs, so this is the main input risk.

Each result record has `title`, `status`, `due_date`, `details`. The poller stores `status` for the badge, `title` and `due_date` for the row, and `details` for drill-down.

## Checks performed
- Required fields present for the detected document type
- Invoice arithmetic: total vs freight + fuel + accessorial. The fuel surcharge may appear as its own line *or* nested as the first line inside the accessorial subtotal — both layouts are accepted, so a correct invoice is not flagged.
- Rate schedule missing or expired
- Duplicate detection within a single document

**Not implemented:** comparing an invoice's charges against the contracted rate for the lane. `expected_freight_charge`, `total_expected_charge` and `overcharge_amount` are not populated, so the product reports no overcharge figure. The dashboard's money card shows *charges reviewed*, not *recovered*.

## Usage
- `python3 run_demo.py` — demo ok
- `python3 run_tests.py` — all tests passed

## Configuration
- `DEEPSEEK_API_KEY` — optional; without it unstructured documents return `unmapped:warning`
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `PRODUCT_ID` — required by the poller
- Dashboard build variables: `VITE_PRODUCT_NAME`, `VITE_PRODUCT_DESCRIPTION`, `VITE_DEEPSEEK_API_KEY`, `VITE_PAYWALL_TITLE`, plus the `VITE_RECORDS_*` / `VITE_FILTER_*` labels

## Deployment
- **Poller** — Coolify app, project "vokrix product pollers". Claims a job atomically before processing, so multiple pollers cannot double-process the same upload.
- **Dashboard** — Coolify app, https://freightauditor-freight-invoice-audit.vokrix.co
- **DNS** — Cloudflare A record pointing at the Coolify host
- **Railway** — legacy service, being retired. The QA agent's preflight still expects it.

## Links
- Dashboard: https://freightauditor-freight-invoice-audit.vokrix.co
- Landing: https://vokrix.co/freightauditor-freight-invoice-audit
- Billing: price_1UDPKK2c9uGCcgMSwoPWulll
- Outreach: active
