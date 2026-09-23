from processor import _expand_rate_lanes, _normalize_row, process_file


def _csv(value: str) -> bytes:
    return value.encode("utf-8")


def test_invoice_valid():
    data = _csv(
        "invoice_number,carrier_name,ship_date,freight_charge,total_charges,payment_due_date\n"
        "INV-1,Carrier A,2025-04-01,100.00,100.00,2025-04-30\n"
    )
    records = process_file(data)
    assert len(records) == 1
    assert records[0]["status"] == "valid:good"
    assert records[0]["title"] == "Carrier A"
    assert records[0]["due_date"] == "2025-04-30"
    assert set(records[0].keys()) == {"title", "status", "details", "due_date"}


def test_invoice_missing():
    data = _csv(
        "invoice_number,carrier_name,ship_date\n"
        "INV-2,Carrier B,2025-05-01\n"
    )
    records = process_file(data)
    assert len(records) == 1
    assert records[0]["status"] == "missing:critical"


def test_invoice_duplicate():
    data = _csv(
        "invoice_number,carrier_name,ship_date,freight_charge,total_charges\n"
        "INV-3,Carrier C,2025-04-01,10,10\n"
        "INV-3,Carrier C,2025-04-02,20,20\n"
    )
    records = process_file(data)
    assert len(records) == 2
    assert all(record["status"] == "flagged:critical" for record in records)


def test_rate_sheet_valid():
    # Expiration kept in the future on purpose: this fixture was pinned to
    # 2026-01-01, so the moment that date passed the test asserted valid:good
    # against a sheet the code correctly reports as expired.
    data = _csv(
        "carrier_name,effective_date,expiration_date,origin_zone,destination_zone,freight_class,rate_basis,minimum_charge,base_rate,fuel_surcharge_table\n"
        "Carrier D,2025-01-01,2030-01-01,100,200,50,per cwt,50,25,table\n"
    )
    records = process_file(data)
    assert len(records) == 1
    assert records[0]["status"] == "valid:good"


def test_rate_sheet_expired():
    data = _csv(
        "carrier_name,effective_date,expiration_date,rate_basis,base_rate\n"
        "Carrier E,2020-01-01,2020-12-31,per cwt,25\n"
    )
    records = process_file(data)
    assert len(records) == 1
    assert records[0]["status"] == "expired:warning"


def test_unknown_text():
    data = b"Hello this is just text"
    records = process_file(data)
    assert isinstance(records, list)
    assert len(records) == 1
    assert records[0]["status"] == "unmapped:warning"


def test_rate_sheet_ignores_blank_invoice_columns():
    # Regression: the extractor returns every schema key with explicit nulls, so
    # an empty invoice_number column used to force document_type=invoice and the
    # rate sheet was reported missing invoice fields.
    data = _csv(
        "invoice_number,carrier_name,effective_date,expiration_date,rate_basis,base_rate\n"
        ",Carrier F,2025-01-01,2030-01-01,per cwt,25\n"
    )
    records = process_file(data)
    assert len(records) == 1
    assert records[0]["details"]["document_type"] == "rate_sheet"
    assert records[0]["status"] == "valid:good"


def test_rate_sheet_lanes_expand_to_rate_lines():
    sheet = _normalize_row(
        {
            "carrier_name": "Carrier G",
            "effective_date": "2025-01-01",
            "expiration_date": "2030-01-01",
            "lanes": [
                {
                    "origin_zone": "100",
                    "destination_zone": "200",
                    "freight_class": "50",
                    "rate_basis": "per cwt",
                    "base_rate": 25,
                    "minimum_charge": 50,
                },
                {
                    "origin_zone": "101",
                    "destination_zone": "201",
                    "freight_class": "55",
                    "rate_basis": "per cwt",
                    "base_rate": 30,
                    "minimum_charge": 60,
                },
            ],
        }
    )
    lines = _expand_rate_lanes(sheet)
    assert len(lines) == 2
    assert all(line["_document_type_hint"] == "rate_sheet" for line in lines)
    assert lines[0]["base_rate"] == 25.0
    assert lines[1]["base_rate"] == 30.0
    assert all(line["carrier_name"] == "Carrier G" for line in lines)


if __name__ == "__main__":
    test_invoice_valid()
    test_invoice_missing()
    test_invoice_duplicate()
    test_rate_sheet_valid()
    test_rate_sheet_expired()
    test_unknown_text()
    test_rate_sheet_ignores_blank_invoice_columns()
    test_rate_sheet_lanes_expand_to_rate_lines()
    print("all tests passed")
