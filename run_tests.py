from processor import process_file


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
    data = _csv(
        "carrier_name,effective_date,expiration_date,origin_zone,destination_zone,freight_class,rate_basis,minimum_charge,base_rate,fuel_surcharge_table\n"
        "Carrier D,2025-01-01,2026-01-01,100,200,50,per cwt,50,25,table\n"
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


if __name__ == "__main__":
    test_invoice_valid()
    test_invoice_missing()
    test_invoice_duplicate()
    test_rate_sheet_valid()
    test_rate_sheet_expired()
    test_unknown_text()
    print("all tests passed")
