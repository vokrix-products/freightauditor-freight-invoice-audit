# FreightAuditor — Freight Invoice Contract Audit

## Product
FreightAuditor audits freight invoices against carrier rate schedules. Shippers feed in PDF/Excel/CSV/plain-text invoices and rate schedules. Each document is normalized into a shared schema, classified as invoice or rate sheet, and given a status.

Statuses (must match `records.status` and `data.tsx` in the dashboard):
- `valid:good` — required fields present and every check passes
- `missing:critical` — a required field is missing
- `flagged:critical` — duplicate invoice, overcharge, variance, or total mismatch
- `expired:warning` — rate schedule is past its expiry date
- `contract-review:warning` — needs human review
- `unmapped:warning` — document type unknown

## Archetype
Pure processing backend, no web framework, plus a React dashboard.

- `processor.py` — entry point `process_file(file_bytes)`
- `rate_audit.py` — invoice-versus-contract audit; pure functions, called by the poller
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
- Duplicate detection **across uploads**, scoped per customer (`apply_cross_upload_duplicates`)
- Contracted-rate audit against the customer's rate lines (`rate_audit.py`)

## Contracted-rate audit
The poller, not `process_file()`, supplies the customer's rate lines and a market diesel price — auditing an invoice means comparing it against other documents that a single-document processor cannot see.

- **Lane match** on origin and destination ZIP, read from the rate sheet (`origin_zone_zip_postal`) and the invoice (`origin_location`) alike. An invoice with no matching contracted lane is left untouched, so invoices from carriers with no rate sheet on file are not marked for review.
- **Line-haul** — `weight / 100 * base_rate` against the invoice's rated line. The weight comes from that line, never from `actual_weight`, which is the total across every line on the shipment. Rate bases other than per-100 lbs / cwt / flat cannot be derived and produce `contract-review:warning` instead of a figure.
- **Fuel** — the contract's `fuel_surcharge_table` is looked up against the U.S. No. 2 Diesel retail price (EIA series `EMD_EPD2D_PTE_NUS_DPG`) for the most recent weekly period on or before the ship date. A market price outside the contracted bands is reported as `contract-review:warning` naming both prices; no percentage is invented.
- **Result** — `overcharge_amount` plus a plain-English note in `details._notes`, and `flagged:critical` when the difference exceeds one cent.

`expected_freight_charge` and `total_expected_charge` are deliberately **not** populated. `_assign_status` compares `expected_freight_charge` against `freight_charge`, which is the transportation subtotal and includes pallet and pallet-jack lines that no contract rate governs; populating it reported a 325.20 variance on a correct invoice. The finding is recorded in `overcharge_amount`, which is not one of the compared fields.

`freight_charge` itself must be the invoice's stated **Transportation Charges subtotal**, not a single line's charge, because that is what `_assign_status` sums against the total. The extraction prompt names the subtotal explicitly for this reason: when it read the first line's `$896.00` instead of the subtotal `$1,095.20`, a correct invoice was reported as `total charges do not match freight+fuel+accessorial`.

## Known limits
- **Extraction is an LLM call.** The prompt names every field the audit needs — `freight_class`, `weight` and `rate_per_100lbs` on each rated line, and `freight_charge` as the subtotal. That is what makes the audit able to price a line at all: while the prompt asked only for `description` and `amount`, no line carried a weight the audit could use, so every invoice returned `contract-review:warning` with no figure. A line the extractor still returns without those keys is reported the same way rather than guessed at, because a wrong overcharge figure is worse than none.
- **No mileage exists anywhere in the schema**, so a per-mile rate basis cannot be audited.
- **The contracted fuel table may not cover the market.** When it does not, the audit says so rather than borrowing a percentage from a band that does not apply.
- **Re-processing a job replaces the records written from that same file**, unless one of them carries `approved_at`, in which case both sets are kept. Records from a *different* upload are flagged as duplicates, never replaced — the audit trail is the evidence.

## Usage
- `python3 run_demo.py` — demo ok
- `python3 run_tests.py` — all tests passed

## Trial limit
An unsubscribed account is capped at three uploads. The count is of `jobs` in `pending`/`processing`/`completed`, so archiving a job frees a slot and deleting records does not.

The gate reads `subscriptions` for a row matching `(customer_id, product_id)` with status `active` or `trialing`. That table is keyed per product, so a customer subscribed to this product *and* another is recognised on both — whereas `app_metadata.product_id` is a single scalar and can only ever name one product, which is why the gate no longer relies on it alone. It is still honoured as an additional paid signal, so no existing payer becomes gated.

## Configuration
- `DEEPSEEK_API_KEY` — optional; without it unstructured documents return `unmapped:warning`
- `EIA_API_KEY` — optional; without it the market diesel price is unknown, so the fuel surcharge cannot be audited and invoices report `contract-review:warning`
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `PRODUCT_ID` — required by the poller
- Dashboard build variables: `VITE_PRODUCT_NAME`, `VITE_PRODUCT_DESCRIPTION`, `VITE_DEEPSEEK_API_KEY`, `VITE_PAYWALL_TITLE`, plus the `VITE_RECORDS_*` / `VITE_FILTER_*` labels

## Deployment
- **Poller** — Coolify app, project "vokrix product pollers". Claims a job atomically before processing, so multiple pollers cannot double-process the same upload.
- **Dashboard** — Coolify app, https://freightauditor-freight-invoice-audit.vokrix.co
- **DNS** — Cloudflare A record pointing at the Coolify host

## Links
- Dashboard: https://freightauditor-freight-invoice-audit.vokrix.co
- Landing: https://vokrix.co/freightauditor-freight-invoice-audit
- Billing: price_1UDPKK2c9uGCcgMSwoPWulll
- Outreach: active
