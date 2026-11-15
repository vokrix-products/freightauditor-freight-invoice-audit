import csv
import io
import os
import re
from datetime import date, datetime
from typing import Any, Dict, List

import pdfplumber
from openpyxl import load_workbook

from llm_extractor import extract_from_unstructured_text

STATUS_MISSING = "missing:critical"
STATUS_EXPIRED = "expired:warning"
STATUS_VALID = "valid:good"
STATUS_FLAGGED = "flagged:critical"
STATUS_CONTRACT_REVIEW = "contract-review:warning"
STATUS_UNMAPPED = "unmapped:warning"

FLOAT_TOLERANCE = 0.01

NUMERIC_FIELDS = {
    "actual_weight",
    "billable_weight",
    "freight_charge",
    "fuel_surcharge",
    "accessorial_charges",
    "total_charges",
    "discount_amount",
    "minimum_charge",
    "base_rate",
    "expected_freight_charge",
    "expected_fuel_surcharge",
    "expected_accessorial_charges",
    "total_expected_charge",
    "variance",
    "overcharge_amount",
}

KEY_ALIASES_RAW = {
    "invoice_number": ["invoice number", "invoice no", "invoice #", "invoice_num", "invoiceid", "inv no", "invoice_number"],
    "carrier_name": ["carrier name", "carrier", "supplier", "vendor name", "vendor", "carrier_name"],
    "ship_date": ["ship date", "shipment date", "shipping date", "date shipped", "shipdate", "ship_date"],
    "bill_of_lading_pro_number": ["bill of lading", "pro number", "pro no", "bol", "bol/pro", "bol_number", "pro_number", "bill of lading / pro number"],
    "origin_location": ["origin location", "origin", "origin city", "origin address", "origin city/state/postal code", "origin_zip", "origin zone"],
    "destination_location": ["destination location", "destination", "destination city", "destination address", "destination city/state/postal code", "destination_zip", "destination zone"],
    "actual_weight": ["actual weight", "actual weight (lbs)", "actual_weight", "weight"],
    "billable_weight": ["billable weight", "billed weight", "billable_weight", "billing weight"],
    "freight_charge": ["freight charge", "freight", "freight charges", "freight_charge", "linehaul", "line haul", "linehaul charge", "line haul charge", "transportation charge", "transportation charges"],
    "fuel_surcharge": ["fuel surcharge", "fuel", "fuel_surcharge", "fsc"],
    "accessorial_codes": ["accessorial code", "accessorial codes", "accessorial_code"],
    "accessorial_descriptions": ["accessorial description", "accessorial descriptions", "accessorial_desc"],
    "accessorial_charges": ["accessorial charge", "accessorial charges", "accessorial_charge"],
    "total_charges": ["total charges", "total charge", "total", "invoice total", "total_charges", "price", "amount", "total_amount", "total amount", "grand total", "invoice amount", "net amount due", "total amount due"],
    "discount_amount": ["discount amount", "discount", "discounts", "total discount", "discount_amount", "discounts and allowances", "contractual discount", "early payment discount"],
    "payment_due_date": ["payment due date", "due date", "payment_due_date", "due_date", "invoice due date"],
    "currency": ["currency", "curr"],
    "invoice_line_items": ["invoice line item details", "line item details", "line_items", "invoice line-item details", "invoice_line_items"],
    "source_file_name": ["source file name", "source filename", "filename"],
    "contract_rate_sheet_identifier": ["contract/rate-sheet identifier", "contract id", "rate sheet id", "rate_sheet_id", "contract_rate_sheet_identifier", "contract_reference"],
    "effective_date": ["effective date", "effective", "eff date", "effective_date", "rate_sheet_effective_date", "rate sheet effective date"],
    "expiration_date": ["expiration date", "expiration", "exp date", "expiration_date", "rate_sheet_expiration_date", "rate sheet expiration date"],
    "origin_zone_zip_postal": ["origin zone/zip/postal code", "origin zone", "origin_zip", "origin postal", "origin_zone", "origin_zone_zip_postal"],
    "destination_zone_zip_postal": ["destination zone/zip/postal code", "destination zone", "destination_zip", "destination postal", "destination_zone", "destination_zone_zip_postal"],
    "freight_class_commodity": ["freight class/commodity", "freight class", "commodity", "class", "freight_class", "product", "freight_class_commodity"],
    "rate_basis": ["rate basis", "rate_basis", "basis"],
    "minimum_charge": ["minimum charge", "minimum_charge", "min charge"],
    "base_rate": ["base rate", "base_rate", "rate"],
    "fuel_surcharge_table": ["fuel surcharge table/percentage schedule", "fuel surcharge table", "fuel schedule", "fuel percentage", "fuel_surcharge_table", "fuel_surcharge_schedule", "fuel surcharge schedule"],
    "accessorial_rule_code_description_amount": ["accessorial rule/code/description/amount", "accessorial rule", "accessorial code"],
    "expected_freight_charge": ["expected freight charge", "expected freight", "expected_freight_charge"],
    "expected_fuel_surcharge": ["expected fuel surcharge", "expected fuel", "expected_fuel_surcharge"],
    "expected_accessorial_charges": ["expected accessorial charges", "expected accessorial", "expected_accessorial_charges"],
    "total_expected_charge": ["total expected charge", "total expected", "total_expected_charge"],
    "variance": ["variance"],
    "overcharge_amount": ["overcharge amount", "overcharge"],
    "matched_rate_line_reference": ["matched rate line reference", "matched rate line"],
    "invoice_status": ["invoice status"],
    "rate_sheet_status": ["rate-sheet status", "rate sheet status"],
    "mapping_template_version": ["mapping template version"],
}


# Fields that prove a document really is an invoice / rate sheet. Detection scores
# these by VALUE. It must not use key presence: the extractor returns the whole
# schema with explicit nulls, so every document has an invoice_number key.
INVOICE_MARKER_FIELDS = (
    "invoice_number",
    "invoice_date",
    "ship_date",
    "freight_charge",
    "invoice_line_items",
    "total_charges",
    "bill_of_lading_pro_number",
)

RATE_SHEET_MARKER_FIELDS = (
    "lanes",
    "contract_rate_sheet_identifier",
    "effective_date",
    "expiration_date",
    "rate_basis",
    "base_rate",
    "minimum_charge",
    "fuel_surcharge_table",
)


def _token(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


KEY_ALIASES = {
    canonical: {_token(alias) for alias in aliases}
    for canonical, aliases in KEY_ALIASES_RAW.items()
}


def _canonical_key(raw_key: str) -> str:
    token = _token(str(raw_key))
    for canonical, aliases in KEY_ALIASES.items():
        if token in aliases:
            return canonical
    return str(raw_key).strip().lower().replace(" ", "_")


def _clean_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        if value.lower() in {"none", "null", "nan", ""}:
            return None
    return value


def _to_float(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace("$", "").replace(",", "").strip()
    if not text or text.lower() in {"none", "null", "nan", ""}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _has_value(record: Dict[str, Any], field: str) -> bool:
    """True when a field carries real content. Nulls, blanks and empty
    containers all mean the document did not actually provide that field."""
    value = record.get(field)
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, (list, dict)):
        return len(value) > 0
    if isinstance(value, bool):
        return value
    return True


def _parse_date(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text or text.lower() in {"none", "null", "nan", ""}:
        return None
    for fmt in (
        "%Y-%m-%d",
        "%m/%d/%Y",
        "%m-%d-%Y",
        "%d-%b-%Y",
        "%b %d, %Y",
        "%B %d, %Y",
        "%Y/%m/%d",
        "%Y-%m-%d %I:%M %p",
        "%b %d, %Y %I:%M %p",
        "%B %d, %Y %I:%M %p",
    ):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except Exception:
        return None


def _iso_date(value: Any) -> Any:
    parsed = _parse_date(value)
    if parsed:
        return parsed.isoformat()
    return None


def _heuristic_carrier(text: str) -> Any:
    match = re.search(r"(?:carrier|vendor|supplier|carrier name|vendor name)\s*[:|-]\s*([A-Za-z0-9 .&]+)", text, re.I)
    if match:
        return match.group(1).strip()
    return None


def _normalize_row(row: Dict[str, Any]) -> Dict[str, Any]:
    if "raw_text" in row:
        raw = row.get("raw_text") or ""
        return {
            "_type": "unknown",
            "raw_text": raw,
            "carrier_name": _heuristic_carrier(raw),
            "_ocr": bool(row.get("_ocr")),
        }

    normalized: Dict[str, Any] = {}
    for raw_key, value in row.items():
        canonical = _canonical_key(raw_key)
        normalized[canonical] = _clean_value(value)

    for field in NUMERIC_FIELDS:
        if field in normalized:
            normalized[field] = _to_float(normalized[field])

    return normalized


def _expand_rate_lanes(record: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Split a rate sheet with a lanes[] array into one record per rate line.

    A rate sheet is audited line by line, and the per-row duplicate check in
    _assign_status already assumes one row per lane. Every line inherits the
    sheet-level fields (carrier, effective/expiration date, contract id); lane
    fields win where they carry a value.
    """
    lanes = record.get("lanes")
    if not isinstance(lanes, list) or not lanes:
        return [record]

    sheet_fields = {key: value for key, value in record.items() if key != "lanes"}
    expanded: List[Dict[str, Any]] = []

    for index, lane in enumerate(lanes):
        if not isinstance(lane, dict):
            continue
        merged = dict(sheet_fields)
        for raw_key, value in lane.items():
            canonical = _canonical_key(raw_key)
            cleaned = _clean_value(value)
            if cleaned is not None:
                merged[canonical] = cleaned
        for field in NUMERIC_FIELDS:
            if field in merged:
                merged[field] = _to_float(merged[field])
        merged["_rate_line_index"] = index
        merged["_document_type_hint"] = "rate_sheet"
        expanded.append(merged)

    return expanded or [record]


def _detect_document_type(record: Dict[str, Any]) -> str:
    invoice_score = sum(1 for field in INVOICE_MARKER_FIELDS if _has_value(record, field))
    rate_score = sum(1 for field in RATE_SHEET_MARKER_FIELDS if _has_value(record, field))

    if rate_score > invoice_score:
        return "rate_sheet"
    if invoice_score:
        return "invoice"
    if rate_score:
        return "rate_sheet"
    if _has_value(record, "carrier_name"):
        return "invoice"
    return "unknown"


def _assign_status(record: Dict[str, Any], all_rows: List[Dict[str, Any]]):
    doc_type = record.get("_type") or "unknown"

    if doc_type == "invoice":
        # total_charges is required, not optional. The whole arithmetic block
        # below sits behind `if total is not None`, so an invoice whose total was
        # never extracted skipped every check and fell through to valid:good -
        # reported as verified when nothing had been verified. Record 20348
        # (Cascadia INV-2025-00112) is that case: freight 333.00, fuel 150.00 and
        # accessorials 125.00 present, no total, and the dashboard showed a clean
        # invoice. An invoice that cannot be checked must not be reported as
        # checked.
        required = [
            "invoice_number",
            "carrier_name",
            "ship_date",
            "freight_charge",
            "total_charges",
        ]
        missing = [field for field in required if record.get(field) in (None, "")]
        if missing:
            return STATUS_MISSING, [f"missing required fields: {', '.join(missing)}"]

        invoice_no = str(record.get("invoice_number") or "").strip()
        duplicate_count = sum(
            1
            for row in all_rows
            if str(row.get("invoice_number") or "").strip() == invoice_no
        )
        if invoice_no and duplicate_count > 1:
            return STATUS_FLAGGED, ["duplicate invoice number in file"]

        total = record.get("total_charges")
        freight = record.get("freight_charge")
        fuel = record.get("fuel_surcharge")
        accessorial = record.get("accessorial_charges")
        discount = record.get("discount_amount")
        if total is not None:
            # Carriers lay the total out more than one way, and the check has to
            # accept every layout a correct invoice actually uses - a false
            # positive on a correct invoice is the worst thing a freight audit
            # can report.
            #
            # Either the fuel surcharge is its own line beside the accessorial
            # subtotal, so all three components add up to the total; or fuel is
            # the first line INSIDE the accessorial subtotal, so adding it a
            # second time counts it twice and flags a correct invoice. That is
            # INV-2024-89341, hence the second candidate.
            #
            # Or the invoice states a gross and then deducts its own discounts to
            # reach the amount due, so the total the audit reads is a NET and the
            # components sum to a gross. That is IronOak INV-2024-004219: gross
            # 2,464.25 less a 185.00 contractual and a 45.21 early-payment
            # discount gives the 2,234.04 the invoice states, and comparing the
            # gross against the net reported 230.21 of variance on an invoice
            # that is correct. Hence the third candidate.
            #
            # The discount candidate needs all four figures, so an invoice that
            # states no discount is checked exactly as it was before.
            separated = [
                value for value in (freight, fuel, accessorial) if value is not None
            ]
            candidates: List[float] = []
            if separated:
                candidates.append(sum(separated))
            if freight is not None and accessorial is not None and fuel is not None:
                candidates.append(float(freight) + float(accessorial))
            if discount is not None and len(separated) == 3:
                candidates.append(sum(separated) - float(discount))
            if candidates and all(
                abs(float(total) - candidate) > FLOAT_TOLERANCE for candidate in candidates
            ):
                return STATUS_FLAGGED, [
                    "total charges do not match freight+fuel+accessorial, "
                    "or the same less any discount"
                ]

        variance_pairs = [
            ("expected_freight_charge", "freight_charge"),
            ("expected_fuel_surcharge", "fuel_surcharge"),
            ("expected_accessorial_charges", "accessorial_charges"),
            ("total_expected_charge", "total_charges"),
        ]
        for expected_field, actual_field in variance_pairs:
            expected = record.get(expected_field)
            actual = record.get(actual_field)
            if expected is not None and actual is not None:
                difference = float(actual) - float(expected)
                if abs(difference) > FLOAT_TOLERANCE:
                    return STATUS_FLAGGED, [f"variance for {expected_field}: {difference:.2f}"]

        return STATUS_VALID, []

    if doc_type == "rate_sheet":
        required = ["carrier_name", "effective_date", "expiration_date", "rate_basis", "base_rate"]
        missing = [field for field in required if record.get(field) in (None, "")]
        if missing:
            return STATUS_MISSING, [f"missing required rate sheet fields: {', '.join(missing)}"]

        expiration = _parse_date(record.get("expiration_date"))
        if expiration and expiration < date.today():
            return STATUS_EXPIRED, ["rate sheet expired"]

        # A "minimum charge above 3x base rate" rule used to live here. It
        # compared a flat dollar minimum ($150.00) against a rate expressed per
        # 100 lbs ($5.50), so 150 > 5.50 * 3 fired on every rate sheet carrying a
        # minimum charge and pushed it to contract-review. It stayed hidden while
        # every sheet on hand was expired, because the expiry branch returns
        # first. Removed rather than re-tuned: the two figures are in different
        # units, so there is no threshold that makes the comparison sound.

        rate_key = (
            record.get("origin_zone_zip_postal"),
            record.get("destination_zone_zip_postal"),
            record.get("freight_class_commodity"),
        )
        if rate_key[0] is not None or rate_key[1] is not None:
            duplicate_count = sum(
                1
                for row in all_rows
                if (
                    row.get("origin_zone_zip_postal"),
                    row.get("destination_zone_zip_postal"),
                    row.get("freight_class_commodity"),
                )
                == rate_key
            )
            if duplicate_count > 1:
                return STATUS_CONTRACT_REVIEW, ["duplicate rate line for same origin/destination/class"]

        rate_basis = str(record.get("rate_basis") or "").lower()
        if rate_basis not in {"flat", "minimum charge", "per unit"} and not record.get("fuel_surcharge_table"):
            return STATUS_CONTRACT_REVIEW, ["missing fuel surcharge schedule"]

        return STATUS_VALID, []

    return STATUS_UNMAPPED, ["unable to identify document type"]


def _carrier_key(value):
    """Carrier name normalized for comparison, or None when it is not known.

    "Unknown Vendor" is the title process_file falls back to when no carrier was
    extracted, so it has to read as "not known" rather than as a carrier name -
    otherwise two unrelated invoices with unreadable carriers would look like the
    same carrier and their shared invoice number like a duplicate.

    Matching is exact on the normalized tokens, so two spellings of one carrier
    ("TransFreight Logistics" and "TransFreight Logistics LLC") count as different
    carriers and their shared number is not flagged.
    """
    if value is None:
        return None
    token = re.sub(r"[^a-z0-9]+", "", str(value).lower())
    if not token or token in {"unknown", "unknownvendor", "none", "null"}:
        return None
    return token


def _split_history(existing_invoice_numbers):
    """Sort the caller's history into numbers, carrier pairs and carrierless numbers.

    Accepts both shapes the caller may pass: bare invoice-number strings, which is
    what the poller sent before carriers travelled with the history, and
    (carrier, number) pairs. A bare string means that row's carrier is unknown, so
    it is matched on the number alone.
    """
    numbers = set()
    pairs = set()
    carrierless = set()

    for entry in existing_invoice_numbers or []:
        if entry is None:
            continue

        if isinstance(entry, (tuple, list)):
            if len(entry) != 2:
                continue
            carrier, number = entry
        else:
            carrier, number = None, entry

        number = str(number).strip() if number is not None else ""
        if not number:
            continue

        numbers.add(number)
        key = _carrier_key(carrier)
        if key is None:
            carrierless.add(number)
        else:
            pairs.add((key, number))

    return numbers, pairs, carrierless


DUPLICATE_UPLOAD_NOTE = "duplicate invoice number from a previous upload"


def apply_cross_upload_duplicates(
    result_records: List[Dict[str, Any]],
    existing_invoice_numbers: Any,
) -> List[Dict[str, Any]]:
    """Flag records whose invoice number this customer has already had processed.

    The duplicate check inside _assign_status can only see the rows produced by a
    single process_file call, so a carrier billing the same invoice number across
    two separate uploads was never caught - which is precisely the overbilling a
    shipper wants surfaced. The poller passes in the invoice numbers already
    stored for that customer and anything that repeats comes back flagged.

    Kept as a pure function over the caller's data: the poller owns the customer
    scope and the database access, this owns the decision. A duplicate overrides
    valid/expired but never discards the existing notes, so a missing-field
    reason stays visible alongside the duplicate reason.

    Matching is scoped by carrier as well as by number. Invoice numbers are issued
    per carrier, so a number alone does not identify an invoice: records 20349 and
    20384 both read INV-2024-87123, but 20349 is SwiftLine Logistics billing 254.11
    and 20384 is TransFreight Logistics LLC billing 4,100.21, and flagging one as a
    duplicate of the other is a false positive. The carrier is read from the record
    title, which is where process_file puts carrier_name.

    When either side's carrier is unknown - a history row written before this, or
    an invoice whose carrier could not be read - the number alone decides, so a
    true duplicate is still caught.
    """
    numbers, carrier_pairs, carrierless = _split_history(existing_invoice_numbers)
    if not numbers:
        return result_records

    updated_records: List[Dict[str, Any]] = []
    for item in result_records:
        if not isinstance(item, dict):
            updated_records.append(item)
            continue

        details = item.get("details")
        if not isinstance(details, dict):
            updated_records.append(item)
            continue

        invoice_number = details.get("invoice_number")
        if invoice_number is None or not str(invoice_number).strip():
            updated_records.append(item)
            continue

        number = str(invoice_number).strip()
        if number not in numbers:
            updated_records.append(item)
            continue

        carrier = _carrier_key(details.get("carrier_name")) or _carrier_key(item.get("title"))
        matched = (
            number in carrierless
            or carrier is None
            or (carrier, number) in carrier_pairs
        )
        if not matched:
            updated_records.append(item)
            continue

        notes = list(details.get("_notes") or [])
        if DUPLICATE_UPLOAD_NOTE not in notes:
            notes.append(DUPLICATE_UPLOAD_NOTE)

        updated = dict(item)
        updated["details"] = {**details, "_notes": notes}
        updated["status"] = STATUS_FLAGGED
        updated_records.append(updated)

    return updated_records


# A page carrying fewer than this many characters has no usable text layer.
# A scan yields a handful of characters or none; a real invoice page yields
# hundreds. Too high and a clean invoice is needlessly rasterised at 200 dpi;
# too low and a scan still reaches the extractor as noise.
OCR_MIN_CHARS_PER_PAGE = 40
OCR_DPI = 200


def _ocr_pdf(file_bytes: bytes) -> str:
    """Read a PDF that carries no text layer by rasterising and OCRing it.

    Carrier invoices usually arrive as emailed PDFs, and a fair share of those
    are scans. Before this, a scan produced no record at all and its bytes fell
    through to the text reader, which decoded the PDF as UTF-8 with errors
    ignored and handed several thousand characters of binary noise to the
    extractor - so the failure was not merely empty, it was plausible-looking.

    Returns "" when pytesseract or its tesseract binary is unavailable, or when
    a page cannot be rasterised. The caller then reports the document as
    unreadable rather than inventing fields from nothing.
    """
    try:
        try:
            import pymupdf
        except ImportError:
            import fitz as pymupdf
        import pytesseract
        from PIL import Image
    except Exception:
        print("ocr unavailable: pymupdf, pytesseract or pillow is not installed")
        return ""

    pages: List[str] = []
    try:
        document = pymupdf.open(stream=file_bytes, filetype="pdf")
    except Exception as error:
        print(f"ocr failed: cannot open pdf ({error})")
        return ""

    try:
        zoom = OCR_DPI / 72.0
        matrix = pymupdf.Matrix(zoom, zoom)
        for page in document:
            pixmap = page.get_pixmap(matrix=matrix)
            image = Image.frombytes(
                "RGB", (pixmap.width, pixmap.height), pixmap.samples
            )
            pages.append(pytesseract.image_to_string(image))
    except Exception as error:
        # The usual cause is the tesseract binary missing from the image, which
        # only the Dockerfile can fix.
        print(f"ocr failed: {error}")
        return ""
    finally:
        document.close()

    return "\n".join(pages).strip()


TEXT_MODEL_FLAG = "FREIGHTAUDITOR_TEXT_MODEL"

_LINE_AMOUNT = re.compile(r"\$?\s*(-?\d[\d,]*(?:\.\d{1,2})?)\s*$")
_BRACKETED = re.compile(r"\([^)]*\)")
_DOLLAR = re.compile(r"\$\s*(\d[\d,]*(?:\.\d{1,2})?)")
_ANY_DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4})\b")
_LBS_RATE = re.compile(
    r"(\d[\d,]*(?:\.\d+)?)\s*(?:lbs?|pounds)\s*@\s*\$?\s*(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_INVOICE_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]*")

# Label, canonical field. Matched case-insensitively on the same line as the
# value, which is how an invoice and a rate sheet both present these.
_TEXT_LABELS = (
    ("invoice number", "invoice_number"),
    ("invoice no", "invoice_number"),
    ("bill of lading", "bill_of_lading_pro_number"),
    ("pro number", "bill_of_lading_pro_number"),
    ("ship date", "ship_date"),
    ("invoice date", "invoice_date"),
    ("due date", "payment_due_date"),
    ("effective date", "effective_date"),
    ("expiration date", "expiration_date"),
    ("effective", "effective_date"),
    ("expires", "expiration_date"),
)

_DATE_FIELDS = {
    "ship_date",
    "invoice_date",
    "payment_due_date",
    "effective_date",
    "expiration_date",
}


_ZIP = re.compile(r"\b(\d{5})(?:-\d{4})?\b")
_WINDOW = re.compile(
    # Longest unit first. With day|days, "180 days" matched day and the captured
    # text read "within 180 day", which then travelled onto the claim document.
    r"(?:within|no later than)\s+(\d+)\s+(days|day|months|month)"
    r"|(\d+)\s+(days|day|months|month)\s+(?:of|from|after)\s+(?:the\s+)?"
    r"(?:invoice|delivery|ship|receipt)",
    re.IGNORECASE,
)
_FUEL_ROW = re.compile(
    r"\$?\s*(\d+\.\d+)\s*(?:-|\u2013|to)\s*\$?\s*(\d+\.\d+).*?(\d+(?:\.\d+)?)\s*%"
)
_MIN_CHARGE = re.compile(
    r"minimum\s+charge[^0-9$]*\$?\s*(\d[\d,]*(?:\.\d{1,2})?)", re.IGNORECASE
)
_PER_100 = re.compile(
    r"\$\s*(\d+(?:\.\d+)?)\s*per\s+100\s*(?:lbs?|pounds)", re.IGNORECASE
)


def _parse_rate_sheet_extras(text: str, lines: List[str], record: Dict[str, Any]) -> None:
    """Read the rate-sheet structures the label reader cannot see.

    A rate sheet is not a list of labelled figures, it is a set of tables: lanes,
    a fuel band table, and a filing period written as prose. Label matching alone
    drops all three, and without them there is no contract to audit against -
    every invoice would come back contract-review:warning with no figure, which
    is the failure the README already documents. These four are read explicitly
    so the model is not the only thing that can open a rate agreement.
    """
    if "claim_window_days" not in record:
        match = _WINDOW.search(text)
        if match:
            value = match.group(1) or match.group(3)
            unit = (match.group(2) or match.group(4) or "").lower()
            if value:
                days = int(value) * (30 if unit.startswith("month") else 1)
                if days > 0:
                    record["claim_window_days"] = days
                    record["claim_window_text"] = match.group(0).strip()

    if "base_rate" not in record:
        match = _PER_100.search(text)
        if match:
            record["base_rate"] = _to_float(match.group(1))
            record["rate_basis"] = "per 100 lbs"

    if "minimum_charge" not in record:
        match = _MIN_CHARGE.search(text)
        if match:
            record["minimum_charge"] = _to_float(match.group(1))

    bands: List[Dict[str, Any]] = []
    for line in lines:
        match = _FUEL_ROW.search(line)
        if not match:
            continue
        low = _to_float(match.group(1))
        high = _to_float(match.group(2))
        percent = _to_float(match.group(3))
        if low is None or high is None or percent is None:
            continue
        bands.append(
            {
                "fuel_price_range": f"${low:.2f} - ${high:.2f} / gal",
                "surcharge_percent": percent,
            }
        )
    if bands and not record.get("fuel_surcharge_table"):
        record["fuel_surcharge_table"] = bands

    for line in lines:
        lowered = line.lower()
        zips = _ZIP.findall(line)
        if not zips:
            continue
        # Word boundaries matter: "Total" contains "to", and a total line must
        # never be read as a destination.
        if re.search(r"\borigin\b", lowered) and not record.get("origin_zone_zip_postal"):
            record["origin_zone_zip_postal"] = zips[0]
            record.setdefault("origin_location", line.split(":", 1)[-1].strip())
        elif re.search(r"\bdestination\b", lowered) and not record.get("destination_zone_zip_postal"):
            record["destination_zone_zip_postal"] = zips[-1]
            record.setdefault("destination_location", line.split(":", 1)[-1].strip())


_HEADING_WORDS = re.compile(
    r"\b(?:INVOICE|RATE\s+AGREEMENT|RATE\s+SHEET|RATE\s+SCHEDULE|"
    r"AGREEMENT|SCHEDULE|STATEMENT|SUMMARY|DETAILS|CONTRACT|TARIFF|"
    r"CONFIRMATION)\b",
    re.IGNORECASE,
)


def _carrier_from_header(lines: List[str]) -> Any:
    """The carrier name from the top of a document, joining a wrapped line.

    A generated invoice carries the name across two lines - "REDWOOD FREIGHT"
    then "SYSTEMS INVOICE" - so reading only the first line called the carrier
    REDWOOD FREIGHT while the rate sheet's labelled field said REDWOOD FREIGHT
    SYSTEMS. Duplicate detection keys on the carrier together with the invoice
    number, so the two spellings never matched and a re-uploaded invoice would
    not be caught as a duplicate, which is silent.

    Joins consecutive leading lines that carry no label and no long number, then
    removes the document-type word that shares a line with the tail of the name.
    """
    collected: List[str] = []
    for line in lines[:4]:
        text = line.strip()
        if not text:
            break
        if ":" in text[:40] or re.search(r"\d{3,}", text):
            break
        trimmed = _HEADING_WORDS.sub("", text).strip(" \t-,")
        if not trimmed:
            # A line that was nothing but a document-type word ("CONTRACT",
            # "INVOICE") ends the heading. Carrying on past it read the rate
            # sheet's type label as part of the carrier name, so the sheet said
            # REDWOOD FREIGHT SYSTEMS CONTRACT while the invoice said REDWOOD
            # FREIGHT SYSTEMS, and duplicate matching keys on the carrier.
            break
        collected.append(trimmed)
        if len(collected) >= 3:
            break
    name = re.sub(r"\s{2,}", " ", " ".join(collected)).strip()
    return name if re.search(r"[A-Za-z]{3}", name) else None


def _parse_text_fields(text: str) -> List[Dict[str, Any]]:
    """Read an invoice or rate sheet from plain text without calling a model.

    Used for text recovered by OCR: sending that to DeepSeek would put a
    per-page price on the one input a free tier is meant to absorb, and OCR
    output is the narrower input anyway - a transcript of printed lines, where a
    labelled figure can be read directly.

    Deliberately conservative. A field is taken only when a known label shares
    the line with a figure; nothing is inferred from an unlabelled line. A field
    left missing flows to missing:critical or contract-review:warning, which is
    honest. A guessed figure would flow to a wrong overcharge, which is not, and
    that is the one rule this codebase repeats.

    The weak spot is genuine multiline layouts - several charges inside one
    table cell, or a total split across rows - where this reads less than the
    model does. It reports less rather than misreading.
    """
    if not text or not text.strip():
        return []

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return []

    record: Dict[str, Any] = {"_type": "unknown"}

    carrier = _heuristic_carrier(text)
    if carrier:
        record["carrier_name"] = carrier
    else:
        header_name = _carrier_from_header(lines)
        if header_name:
            record["carrier_name"] = header_name

    for line in lines:
        lowered = line.lower()

        dates = [value for value in (_iso_date(item) for item in _ANY_DATE.findall(line)) if value]
        if len(dates) >= 2 and re.search(r"\bthrough\b|\bthru\b", lowered):
            record.setdefault("effective_date", dates[0])
            record.setdefault("expiration_date", dates[-1])

        for label, field in _TEXT_LABELS:
            if field in record or label not in lowered:
                continue
            tail = line[lowered.index(label) + len(label):]
            if field in _DATE_FIELDS:
                found = _ANY_DATE.search(tail)
                if found:
                    iso = _iso_date(found.group(1))
                    if iso:
                        record[field] = iso
                continue
            token = _INVOICE_TOKEN.search(tail.lstrip(" :#-"))
            if token:
                record[field] = token.group(0)

        if ":" in line:
            head, _, value = line.partition(":")
            value = value.strip()
            head_token = _token(head)
            if value:
                if head_token in {"origin", "originlocation"}:
                    record.setdefault("origin_zone_zip_postal", value)
                    record.setdefault("origin_location", value)
                elif head_token in {"destination", "destinationlocation"}:
                    record.setdefault("destination_zone_zip_postal", value)
                    record.setdefault("destination_location", value)
                elif head_token in {"ratebasis", "basis"}:
                    record.setdefault("rate_basis", value)

        stripped = _BRACKETED.sub(" ", line)
        amount = None
        label = ""
        amount_match = _LINE_AMOUNT.search(stripped)
        if amount_match:
            amount = _to_float(amount_match.group(1))
            label = stripped[: amount_match.start()]
        else:
            money = _DOLLAR.search(stripped)
            if money and ":" in stripped:
                amount = _to_float(money.group(1))
                label = stripped.split(":", 1)[0]
        if amount is None:
            continue
        label = label.strip(" .:-\t")
        if not label or not re.search(r"[A-Za-z]", label):
            continue
        canonical = _canonical_key(label)
        if canonical in NUMERIC_FIELDS and canonical not in record:
            record[canonical] = amount

    items: List[Dict[str, Any]] = []
    for line in lines:
        match = _LBS_RATE.search(line)
        if not match:
            continue
        dollars = _DOLLAR.findall(line)
        if len(dollars) < 2:
            continue
        item: Dict[str, Any] = {
            "weight": _to_float(match.group(1)),
            "rate_per_100lbs": _to_float(match.group(2)),
            "description": _BRACKETED.sub(" ", line).split("$")[0].strip(" ."),
        }
        amount = _to_float(dollars[-1])
        if amount is not None:
            item["amount"] = amount
        items.append(item)
    if items:
        record["invoice_line_items"] = items

    _parse_rate_sheet_extras(text, lines, record)

    if len(record) <= 1:
        return []
    return [record]


def _try_pdf(file_bytes: bytes) -> List[Dict[str, Any]]:
    try:
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            text = "\n".join(page.extract_text() or "" for page in pdf.pages)
            page_count = len(pdf.pages)
    except Exception:
        return []

    if len(text.strip()) >= OCR_MIN_CHARS_PER_PAGE * max(page_count, 1):
        return [{"raw_text": text}]

    ocr_text = _ocr_pdf(file_bytes)
    if ocr_text:
        return [{"raw_text": ocr_text, "_ocr": True}]

    if text.strip():
        return [{"raw_text": text}]
    return []


def _try_excel(file_bytes: bytes) -> List[Dict[str, Any]]:
    try:
        workbook = load_workbook(io.BytesIO(file_bytes), data_only=True)
    except Exception:
        return []

    rows: List[Dict[str, Any]] = []
    for worksheet in workbook.worksheets:
        raw_rows = list(worksheet.iter_rows(values_only=True))
        if not raw_rows:
            continue

        headers: List[str] = []
        for header in raw_rows[0]:
            if header is None or str(header).strip() == "":
                headers.append("")
            else:
                headers.append(str(header).strip().lower())

        if not any(headers):
            continue

        for values in raw_rows[1:]:
            if not any(value is not None and str(value).strip() != "" for value in values):
                continue
            row: Dict[str, Any] = {}
            for idx, value in enumerate(values):
                key = headers[idx] if idx < len(headers) and headers[idx] else f"column_{idx}"
                row[key] = value
            rows.append(row)

    return rows


def _try_text_or_csv(file_bytes: bytes) -> List[Dict[str, Any]]:
    try:
        text = file_bytes.decode("utf-8", errors="ignore")
    except Exception:
        return []

    if not text.strip():
        return []

    sample = text[:512]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
    except csv.Error:
        dialect = None

    if dialect:
        try:
            reader = csv.DictReader(io.StringIO(text), dialect=dialect)
            rows: List[Dict[str, Any]] = []
            for row in reader:
                if any(value is not None and str(value).strip() != "" for value in row.values()):
                    cleaned: Dict[str, Any] = {}
                    for key, value in row.items():
                        if key is None:
                            continue
                        cleaned[str(key).strip().lower()] = value
                    rows.append(cleaned)
            if rows:
                return rows
        except Exception:
            pass

    return [{"raw_text": text}]


def _extract_rows(file_bytes: bytes) -> List[Dict[str, Any]]:
    # A PDF identifies itself in its first bytes. Running the text reader over
    # PDF bytes was how a scan became binary noise instead of an honest failure:
    # the reader decoded the file as UTF-8 with errors ignored and returned it
    # as a document.
    if file_bytes[:5] == b"%PDF-":
        return _try_pdf(file_bytes)

    rows = _try_pdf(file_bytes)
    if rows:
        return rows

    rows = _try_excel(file_bytes)
    if rows:
        return rows

    rows = _try_text_or_csv(file_bytes)
    if rows:
        return rows

    return []


def process_file(file_bytes: bytes) -> List[Dict[str, Any]]:
    raw_rows = _extract_rows(file_bytes)

    use_model_for_text = os.environ.get(
        TEXT_MODEL_FLAG, "on"
    ).strip().lower() not in {"0", "off", "false", "no"}

    normalized_rows: List[Dict[str, Any]] = []
    for row in raw_rows:
        if "raw_text" in row:
            ocr = bool(row.get("_ocr"))
            extracted: List[Dict[str, Any]] = []
            if ocr or not use_model_for_text:
                # OCR text never reaches the model. A scanned page that cost a
                # call on every read would price the free tier per document.
                extracted = _parse_text_fields(row["raw_text"])
            else:
                extracted = extract_from_unstructured_text(row["raw_text"])
            if extracted:
                for item in extracted:
                    normalized = _normalize_row(item)
                    if normalized:
                        if ocr:
                            # _normalize_row builds a fresh dict, so the flag has
                            # to be carried by hand or the OCR warning is lost on
                            # exactly the documents that parsed.
                            normalized["_ocr"] = True
                        normalized_rows.append(normalized)
            else:
                normalized = _normalize_row(row)
                if normalized:
                    normalized["_ocr"] = ocr
                    normalized_rows.append(normalized)
        else:
            normalized = _normalize_row(row)
            if normalized:
                normalized_rows.append(normalized)

    normalized_rows = [row for row in normalized_rows if row]

    expanded_rows: List[Dict[str, Any]] = []
    for row in normalized_rows:
        expanded_rows.extend(_expand_rate_lanes(row))
    normalized_rows = expanded_rows

    output: List[Dict[str, Any]] = []
    for record in normalized_rows:
        forced_type = record.pop("_document_type_hint", None)
        ocr_used = bool(record.pop("_ocr", False))
        document_type = forced_type or _detect_document_type(record)
        record["_type"] = document_type

        status, notes = _assign_status(record, normalized_rows)

        if ocr_used:
            # Text read from pixels is less reliable than text read from the
            # file, so the row says so. Without this an OCR'd invoice that
            # produced a wrong figure would look exactly like a clean one.
            notes = list(notes) + [
                "read by OCR: this PDF has no text layer, so figures are "
                "recovered from the scanned image and are worth checking against "
                "the original"
            ]

        title = (
            record.get("carrier_name")
            or record.get("supplier")
            or record.get("vendor_name")
            or "Unknown Vendor"
        )
        due_date_value = record.get("payment_due_date") or record.get("due_date")
        if due_date_value is None and document_type == "rate_sheet":
            # The "Due / Expires" column and the Upcoming Expirations widget both
            # read due_date. A rate sheet has no payment due date, so without this
            # the one document type that actually expires could never surface.
            due_date_value = record.get("expiration_date")
        due_date = _iso_date(due_date_value)

        details: Dict[str, Any] = {}
        for key, value in record.items():
            if key in {
                "carrier_name",
                "supplier",
                "vendor_name",
                "payment_due_date",
                "due_date",
                "_type",
                "title",
                "status",
            }:
                continue
            if key == "raw_text":
                details["raw_text_snippet"] = str(value)[:500] if value else None
                continue
            details[key] = value

        details["document_type"] = document_type
        details["_notes"] = notes

        output.append(
            {
                "title": title,
                "status": status,
                "details": details,
                "due_date": due_date,
            }
        )

    return output
