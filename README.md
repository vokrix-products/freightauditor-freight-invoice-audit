# RateMatch — Freight Invoice Contract Audit

## Product
RateMatch audits freight invoices against carrier rate sheets. Shippers feed in PDF/Excel/CSV/plain-text invoices and carrier rate schedules. RateMatch normalizes each document into a shared schema, decides invoice vs rate sheet, and assigns a status.

Statuses:
- valid:good — required fields present and checks pass
- missing:critical — required fields missing
- flagged:critical — duplicate invoice or variance
- expired:warning — rate sheet expired
- contract-review:warning — needs human review
- unmapped:warning — type unknown

## Archetype
Pure processing backend, no web framework. Files:
- processor.py — entry point process_file(file_bytes)
- llm_extractor.py — optional DeepSeek fallback for unstructured text
- run_demo.py — self-contained demo
- run_tests.py — self-tests

## Poller input
process_file(file_bytes) accepts bytes of one PDF, XLSX, CSV, or text file. PDF uses pdfplumber; XLSX uses openpyxl headers; CSV uses a sniffer; plain text is treated as unstructured. OCR is out of scope.

Each result record has title, status, due_date, details. The poller stores status for the badge, title and due_date for the row, and details for drill-down.

## Usage
- python3 run_demo.py — demo ok
- python3 run_tests.py — all tests passed

## Configuration
DEEPSEEK_API_KEY optional; without it unstructured docs return unmapped:warning.

Dashboard: https://ratematch-freight-invoice-contract-audit.vokrix.co
Vercel: ratematch-freight-invoice-contract-audit
Cloudflare: ratematch-freight-invoice-contract-audit.vokrix.co
Railway: freightauditor-freight-invoice-audit
Cloudflare: freightauditor-freight-invoice-audit.vokrix.co


Billing: price_1UDPKK2c9uGCcgMSwoPWulll

Landing: https://vokrix.co/freightauditor-freight-invoice-audit

Outreach: active
