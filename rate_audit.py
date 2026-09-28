"""Invoice-versus-contract rate audit.

Separate from processor.py on purpose. process_file() only ever sees one
document, and auditing an invoice means comparing it against the customer's
contracted rate lines and a market diesel price - both of which only the poller
can supply. Every function here is pure; the caller owns the database and the
network calls.

Five rules govern the code below. Each comes from a defect this product has
already shipped, or from a limit on the inputs, not from taste.

1. Never write expected_freight_charge. processor._assign_status compares
   expected_freight_charge against freight_charge, and freight_charge is the
   transportation SUBTOTAL - it includes pallet and pallet-jack lines that no
   contract rate governs. For invoice INV-2026-11487 that is 1095.20 against a
   contracted line-haul of 770.00, so populating the field would report a 325.20
   variance on a correct invoice. This module records its finding in
   overcharge_amount plus a note instead; overcharge_amount is not one of the
   fields _assign_status compares.

2. Never report a figure the inputs do not support. The audit needs one invoice
   line carrying the facts the contract's own rate basis needs: class, weight and
   rate per 100 lbs for a weight-based contract, or the mileage and the per-mile
   rate for a per-mile contract. llm_extractor.py is asked for those as their own
   keys, and parse_rated_line / parse_per_mile_line fall back to reading the
   description, because records written before that prompt change carry the facts
   only in prose - which is why the same PDF produced "Corrugated Boxes, Retail
   Goods (Class 100, 14,000 lbs @ $6.40/100lbs)" on one upload and "Corrugated
   Boxes, Retail Goods" on the next. When neither shape carries them, the audit
   says so and produces no number, because a wrong overcharge figure is worse
   than no figure in an audit product.

3. An invoice with no matching contracted lane is left untouched. Every invoice
   on hand from a carrier with no rate sheet would otherwise be marked
   contract-review:warning, which would bury the invoices that do carry a
   finding.

4. A directional contract rate prices one direction. Matching a lane backwards
   and applying the forward rate to a backhaul would invent a rate the contract
   does not promise, so a lane that matches only in reverse is reported as
   contract-review and priced at nothing. Invoice 20340 is that case.

5. A per-mile lane is priced from the mileage the invoice itself states, so the
   audit checks the rate and not the distance. Record 20340 bills 843 miles at
   $2.35/mile and rate sheet 20010 prices that same lane at $2.35/mile, so the
   audit confirms 843 * 2.35 = 1981.05 and reports nothing. Had the carrier
   billed 900 miles for the same movement the audit would take 900 as given and
   still report nothing: no field on either document carries an independent
   mileage, and no distance source is configured. Mileage is not auditable
   without one, and that is a limit of the inputs rather than a choice.
"""

import re

# Mirrored from processor.py rather than imported: importing processor pulls in
# pdfplumber and llm_extractor, and this module is pure logic.
STATUS_VALID = "valid:good"
STATUS_FLAGGED = "flagged:critical"
STATUS_CONTRACT_REVIEW = "contract-review:warning"

# One cent. Below this the difference is rounding, not a finding.
MONEY_TOLERANCE = 0.01

# Five digits not adjacent to another digit, so a street number like 45000 in an
# address does not read as a ZIP.
ZIP_PATTERN = re.compile(r"(?<!\d)(\d{5})(?!\d)")

# A rate sheet that spells its lane by city, e.g. "NC (Hickory)" or
# "WV (Charleston) 25301".
ZONE_PAREN_PATTERN = re.compile(r"([A-Z]{2})\s*\(([^)]+)\)")

# Contract fuel tables write the band with a hyphen, an en dash or an em dash
# depending on the carrier's template.
BAND_PATTERN = re.compile(r"\$?\s*(\d+(?:\.\d+)?)\s*[-\u2013\u2014]\s*\$?\s*(\d+(?:\.\d+)?)")
PERCENT_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*%")

# A rated line item as older records carry it, e.g.
# "Corrugated Boxes, Retail Goods (Class 100, 14,000 lbs @ $6.40/100lbs)".
# Kept as a fallback: records written before llm_extractor.py asked for
# freight_class / weight / rate_per_100lbs have the facts only in this prose.
RATED_LINE_PATTERN = re.compile(
    r"class\s*(?P<freight_class>\d+(?:\.\d+)?)"
    r".*?(?P<weight>\d[\d,]*(?:\.\d+)?)\s*(?:lbs|lb|pounds)"
    r".*?\$?\s*(?P<rate>\d[\d,]*(?:\.\d+)?)\s*/\s*100",
    re.IGNORECASE | re.DOTALL,
)

# A per-mile line item, e.g.
# "Line-haul Rate (Mileage: 843 miles @ $2.35/mile)". Bounded to 80 characters
# between the mileage and the rate so two unrelated lines in one description
# cannot be spliced into a single match.
MILEAGE_LINE_PATTERN = re.compile(
    r"(?P<miles>\d[\d,]*(?:\.\d+)?)\s*(?:mi|mile|miles)\b"
    r".{0,80}?"
    r"\$?\s*(?P<rate>\d[\d,]*(?:\.\d+)?)\s*(?:/|\bper\b)\s*(?:mi|mile|miles)\b",
    re.IGNORECASE | re.DOTALL,
)


def _to_number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace("$", "").replace(",", "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def extract_zip(value):
    """The 5-digit ZIP in a location string, or None.

    Rate sheets write the lane as "NV (Reno) 89502" and invoices write the
    shipment address as "2200 Industrial Parkway, Reno, NV 89502". ZIP is the
    only part the two spellings share, so it is the join key.
    """
    if value is None:
        return None
    match = ZIP_PATTERN.search(str(value))
    return match.group(1) if match else None


def extract_zone(value):
    """The (state, city) in a location string, lower-cased city, or (None, None).

    Needed because a contract may spell its lanes without any ZIP at all.
    TransFreight writes "NC (Hickory)" -> "WV (Charleston)"; the invoice for the
    same movement writes "1200 Industrial Parkway, Hickory, NC 28601". State and
    city are what those two spellings share.
    """
    if value is None:
        return None, None
    text = str(value)

    parenthesised = ZONE_PAREN_PATTERN.search(text)
    if parenthesised:
        return parenthesised.group(1).upper(), parenthesised.group(2).strip().lower()

    parts = [part.strip() for part in text.split(",") if part.strip()]
    if len(parts) >= 2:
        tail = parts[-1].split()
        if tail and len(tail[0]) == 2 and tail[0].isalpha():
            return tail[0].upper(), parts[-2].lower()
    return None, None


def _lane_match(invoice_details, rate_lines):
    """(rate_line, reversed) for this shipment's lane, or (None, False).

    ZIP is tried first on both sides. A rate sheet that names no ZIP anywhere is
    additionally eligible for a state-and-city match; a sheet that does name ZIPs
    is matched on ZIPs alone, so exact matching is not loosened for the contracts
    that can support it.
    """
    origin_zip = extract_zip(invoice_details.get("origin_location"))
    destination_zip = extract_zip(invoice_details.get("destination_location"))
    origin_zone = extract_zone(invoice_details.get("origin_location"))
    destination_zone = extract_zone(invoice_details.get("destination_location"))

    zipped_match = None
    zoned_match = None
    reversed_match = None

    for line in rate_lines or []:
        if not isinstance(line, dict):
            continue

        line_origin_raw = line.get("origin_zone_zip_postal")
        line_destination_raw = line.get("destination_zone_zip_postal")

        if zipped_match is None and origin_zip and destination_zip:
            if (
                extract_zip(line_origin_raw) == origin_zip
                and extract_zip(line_destination_raw) == destination_zip
            ):
                zipped_match = line
                continue

        if None in origin_zone or None in destination_zone:
            continue

        line_origin_zone = extract_zone(line_origin_raw)
        line_destination_zone = extract_zone(line_destination_raw)
        if None in line_origin_zone or None in line_destination_zone:
            continue

        if extract_zip(line_origin_raw) or extract_zip(line_destination_raw):
            continue

        if line_origin_zone == origin_zone and line_destination_zone == destination_zone:
            if zoned_match is None:
                zoned_match = line
        elif line_origin_zone == destination_zone and line_destination_zone == origin_zone:
            if reversed_match is None:
                reversed_match = line

    if zipped_match is not None:
        return zipped_match, False
    if zoned_match is not None:
        return zoned_match, False
    return reversed_match, True


def match_rate_line(invoice_details, rate_lines):
    """The contracted rate line covering this shipment's lane, or None.

    A lane the contract covers only in reverse is not returned: see rule 4.
    """
    line, reversed_lane = _lane_match(invoice_details, rate_lines)
    if reversed_lane:
        return None
    return line


def parse_rated_line(line_items):
    """The one invoice line that carries class, weight and rate.

    Two shapes are accepted. The extractor is asked for freight_class, weight and
    rate_per_100lbs as their own keys, which is the reliable shape; records
    written before that prompt change carry the same three facts inside the
    description string, which RATED_LINE_PATTERN reads.

    Returns None when no line carries all three. That is the guard: without them
    the contracted charge for the shipment cannot be computed at all, and
    guessing from the transportation subtotal would count pallet and
    pallet-jack charges that no contract rate governs.
    """
    for item in line_items or []:
        if not isinstance(item, dict):
            continue

        amount = _to_number(item.get("amount"))
        if amount is None:
            continue

        weight = _to_number(item.get("weight"))
        rate = _to_number(item.get("rate_per_100lbs"))
        if weight is not None and rate is not None:
            freight_class = item.get("freight_class")
            return {
                "freight_class": None if freight_class is None else str(freight_class),
                "weight": weight,
                "rate": rate,
                "amount": amount,
            }

        description = str(item.get("description") or "")
        match = RATED_LINE_PATTERN.search(description)
        if not match:
            continue
        weight = _to_number(match.group("weight"))
        rate = _to_number(match.group("rate"))
        if weight is None or rate is None:
            continue
        return {
            "freight_class": match.group("freight_class"),
            "weight": weight,
            "rate": rate,
            "amount": amount,
        }
    return None


def parse_per_mile_line(line_items):
    """The one invoice line that carries mileage and a per-mile rate.

    Same two shapes as parse_rated_line: the extractor's miles / rate_per_mile
    keys first, then the description. Record 20340 carries
    "Line-haul Rate (Mileage: 843 miles @ $2.35/mile)" as prose, which is the
    shape MILEAGE_LINE_PATTERN reads.
    """
    for item in line_items or []:
        if not isinstance(item, dict):
            continue

        amount = _to_number(item.get("amount"))
        if amount is None:
            continue

        miles = _to_number(item.get("miles"))
        rate = _to_number(item.get("rate_per_mile"))
        if miles is not None and rate is not None:
            return {"miles": miles, "rate": rate, "amount": amount}

        description = str(item.get("description") or "")
        match = MILEAGE_LINE_PATTERN.search(description)
        if not match:
            continue
        miles = _to_number(match.group("miles"))
        rate = _to_number(match.group("rate"))
        if miles is None or rate is None:
            continue
        return {"miles": miles, "rate": rate, "amount": amount}
    return None


def expected_linehaul(weight, base_rate, rate_basis):
    """The contracted line-haul charge for a weight-based basis, or None.

    Only bases computable from the shipment's weight are supported here. A
    per-mile contract is priced by the caller from the mileage on the invoice
    line, because it does not use the weight at all - this function correctly
    returns None for "per mile", and that is not a gap any more.
    """
    if weight is None or base_rate is None:
        return None
    basis = str(rate_basis or "").lower()
    if "100" in basis or "cwt" in basis or "hundred" in basis:
        return weight / 100.0 * base_rate
    if "flat" in basis:
        return float(base_rate)
    return None


def _band_texts(entry):
    if isinstance(entry, dict):
        return [str(value) for value in entry.values() if value is not None]
    return [str(entry)]


def _band_bounds(entry):
    for text in _band_texts(entry):
        match = BAND_PATTERN.search(text)
        if match:
            return float(match.group(1)), float(match.group(2))
    return None, None


def _band_percent(entry):
    for text in _band_texts(entry):
        match = PERCENT_PATTERN.search(text)
        if match:
            return float(match.group(1)) / 100.0
    return None


def fuel_table_maximum(fuel_surcharge_table):
    """Highest diesel price the contracted fuel table covers, or None.

    None also means the table could not be read at all, which the caller treats
    as "no fuel audit" rather than as a finding.
    """
    maximum = None
    for entry in fuel_surcharge_table or []:
        _, high = _band_bounds(entry)
        if high is None:
            continue
        maximum = high if maximum is None else max(maximum, high)
    return maximum


def lookup_fuel_band(fuel_surcharge_table, diesel_price):
    """Contracted fuel surcharge for a diesel price, or None when out of range.

    The price bands are the contract's own; a market price above the highest band
    means the contract does not cover today's market, which is a finding in
    itself rather than a number to invent.
    """
    if diesel_price is None:
        return None
    for entry in fuel_surcharge_table or []:
        low, high = _band_bounds(entry)
        if low is None or high is None:
            continue
        if low - 0.005 <= diesel_price <= high + 0.005:
            return _band_percent(entry)
    return None


def audit_invoice(invoice_details, rate_lines, diesel_price=None):
    """Audit one invoice against the customer's contracted rate lines.

    Returns {"status": str|None, "notes": [str], "updates": dict}. A None status
    means the record keeps the status processor.py already gave it.
    """
    notes = []
    updates = {}
    status = None
    detected = 0.0

    rate_line, reversed_lane = _lane_match(invoice_details, rate_lines)
    if rate_line is None:
        return {"status": None, "notes": notes, "updates": updates}

    reference = str(
        rate_line.get("contract_rate_sheet_identifier") or rate_line.get("title") or ""
    ).strip()
    updates["matched_rate_line_reference"] = reference or None

    origin = extract_zip(invoice_details.get("origin_location"))
    destination = extract_zip(invoice_details.get("destination_location"))

    # Fuel coverage is checked before the rated line, and independently of it.
    # Deciding whether the contract's fuel table covers the market price needs
    # only the contract and the market price, so an invoice whose rated line
    # cannot be read must still be told the table does not reach today's diesel.
    # Record 20321 is the case that exposed this: no rated line, and no fuel note
    # either, because the rated-line guard returned first.
    table = rate_line.get("fuel_surcharge_table")
    maximum_band = fuel_table_maximum(table)
    fuel_percent = None
    if maximum_band is not None:
        fuel_percent = lookup_fuel_band(table, diesel_price)
        if fuel_percent is None:
            if diesel_price is None:
                notes.append("fuel cannot be audited: market diesel price unavailable")
            else:
                notes.append(
                    f"fuel cannot be audited: market diesel {diesel_price:.3f} is outside "
                    f"the contracted table (highest band {maximum_band:.2f})"
                )
            status = STATUS_CONTRACT_REVIEW

    if reversed_lane:
        reverse_origin = str(rate_line.get("origin_zone_zip_postal") or "").strip()
        reverse_destination = str(rate_line.get("destination_zone_zip_postal") or "").strip()
        reverse_rate = _to_number(rate_line.get("base_rate"))
        reverse_basis = str(rate_line.get("rate_basis") or "").strip()
        if reverse_origin and reverse_destination and reverse_rate is not None:
            rate_text = f"at {reverse_rate:.2f} {reverse_basis}".strip()
            notes.append(
                f"cannot audit against the contracted rate: the contract "
                f"{reference or 'on file'} prices {reverse_origin} -> {reverse_destination} "
                f"{rate_text}; this invoice runs the opposite direction, and a directional "
                "rate does not price the reverse haul"
            )
        else:
            notes.append(
                "cannot audit against the contracted rate: the contract "
                f"{reference or 'on file'} covers this lane only in the opposite direction, "
                "and a directional rate does not price the reverse haul"
            )
        return {"status": STATUS_CONTRACT_REVIEW, "notes": notes, "updates": updates}

    basis_text = str(rate_line.get("rate_basis") or "")
    basis = basis_text.lower()
    base_rate = _to_number(rate_line.get("base_rate"))
    line_items = invoice_details.get("invoice_line_items")

    if "mile" in basis:
        audited_line = parse_per_mile_line(line_items)
        if audited_line is None:
            notes.append(
                "cannot audit against the contracted rate: no invoice line carried the "
                "mileage and the per-mile rate the contract prices from"
            )
            return {"status": STATUS_CONTRACT_REVIEW, "notes": notes, "updates": updates}
        if base_rate is None:
            notes.append(
                "cannot audit against the contracted rate: the rate sheet states no base rate"
            )
            return {"status": STATUS_CONTRACT_REVIEW, "notes": notes, "updates": updates}
        expected = audited_line["miles"] * base_rate
        invoiced = audited_line["amount"]
        difference = invoiced - expected
        if abs(difference) > MONEY_TOLERANCE:
            detected += difference
            notes.append(
                f"line-haul overcharge of {difference:.2f}: invoiced "
                f"{invoiced:.2f} at {audited_line['rate']:.2f}/mile for "
                f"{audited_line['miles']:.0f} miles against contracted "
                f"{expected:.2f} at {base_rate:.2f}/mile"
            )
    else:
        rated_line = parse_rated_line(line_items)
        if rated_line is None:
            notes.append(
                "cannot audit against the contracted rate: no invoice line carried "
                "class, weight and rate"
            )
            return {"status": STATUS_CONTRACT_REVIEW, "notes": notes, "updates": updates}

        expected = expected_linehaul(rated_line["weight"], base_rate, basis_text)
        if expected is None:
            notes.append(
                "cannot audit against the contracted rate: rate basis "
                f"'{rate_line.get('rate_basis')}' is not derivable from the invoice fields on hand"
            )
            return {"status": STATUS_CONTRACT_REVIEW, "notes": notes, "updates": updates}

        invoiced = rated_line["amount"]
        difference = invoiced - expected
        if abs(difference) > MONEY_TOLERANCE:
            detected += difference
            notes.append(
                f"line-haul overcharge of {difference:.2f}: invoiced "
                f"{rated_line['amount']:.2f} at {rated_line['rate']:.2f}/100lbs against "
                f"contracted {expected:.2f} at {base_rate:.2f}/100lbs for "
                f"{origin} to {destination}"
            )

    # The fuel variance, unlike the coverage check above, does need the audited
    # line: the contract expresses the surcharge as a percentage of the line-haul
    # charge, not of the transportation subtotal.
    if fuel_percent is not None:
        actual_fuel = _to_number(invoice_details.get("fuel_surcharge"))
        if actual_fuel is not None:
            expected_fuel = fuel_percent * invoiced
            fuel_difference = actual_fuel - expected_fuel
            if abs(fuel_difference) > MONEY_TOLERANCE:
                detected += fuel_difference
                notes.append(
                    f"fuel surcharge variance of {fuel_difference:.2f}: invoiced "
                    f"{actual_fuel:.2f} against contracted {fuel_percent * 100:.2f}% of "
                    f"line-haul = {expected_fuel:.2f}"
                )

    if abs(detected) > MONEY_TOLERANCE:
        updates["overcharge_amount"] = round(detected, 2)
        status = STATUS_FLAGGED

    return {"status": status, "notes": notes, "updates": updates}


def apply_rate_audit(result_records, rate_lines, diesel_price_for=None):
    """Annotate invoice records with the contracted-rate audit.

    diesel_price_for is a callable taking an ISO ship date and returning the
    market diesel price, or None when it cannot be resolved. Passing the lookup
    in keeps this function free of network access and makes it testable.

    A flagged duplicate from cross-upload detection outranks a contract-review
    finding, so an existing flagged:critical is never downgraded.
    """
    if not rate_lines:
        return result_records

    updated_records = []
    for item in result_records:
        if not isinstance(item, dict):
            updated_records.append(item)
            continue

        details = item.get("details")
        if not isinstance(details, dict) or details.get("document_type") != "invoice":
            updated_records.append(item)
            continue

        try:
            diesel_price = diesel_price_for(details.get("ship_date")) if diesel_price_for else None
        except Exception:
            diesel_price = None

        outcome = audit_invoice(details, rate_lines, diesel_price)

        notes = list(details.get("_notes") or [])
        for note in outcome["notes"]:
            if note not in notes:
                notes.append(note)

        updated = dict(item)
        updated["details"] = {**details, **outcome["updates"], "_notes": notes}

        if outcome["status"] == STATUS_FLAGGED:
            updated["status"] = STATUS_FLAGGED
        elif outcome["status"] and item.get("status") == STATUS_VALID:
            updated["status"] = outcome["status"]

        updated_records.append(updated)

    return updated_records
