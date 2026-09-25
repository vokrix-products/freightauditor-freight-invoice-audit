import os
import time
import json
import requests

SUPABASE_URL = os.environ['SUPABASE_URL']
SUPABASE_SERVICE_KEY = os.environ['SUPABASE_SERVICE_KEY']
PRODUCT_ID = os.environ['PRODUCT_ID']
ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

BUCKET = 'uploads'
RESULTS_BUCKET = 'results'

REQUEST_TIMEOUT = 30
MAX_ATTEMPTS = 3
POLL_INTERVAL_SECONDS = 60
STALE_CLAIM_MINUTES = 15

VALID_STATUSES = {
    'missing:critical',
    'expired:warning',
    'valid:good',
    'flagged:critical',
    'contract-review:warning',
    'unmapped:warning',
}

import processor


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _request(method, url, retry=True, **kwargs):
    """HTTP call with a timeout on every attempt and bounded retries.

    retry=False for non-idempotent POSTs: if the request reached Supabase but the
    response was lost, replaying it would insert the record a second time.
    """
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)
    attempts = MAX_ATTEMPTS if retry else 1
    last_error = None

    for attempt in range(1, attempts + 1):
        try:
            resp = requests.request(method, url, **kwargs)
            if resp.status_code >= 500 or resp.status_code == 429:
                raise requests.HTTPError(f"HTTP {resp.status_code}", response=resp)
            resp.raise_for_status()
            return resp
        except Exception as error:
            last_error = error
            if attempt >= attempts:
                break
            delay = 2 ** attempt
            print(f"request {method} {url} failed ({error}); retry in {delay}s", flush=True)
            time.sleep(delay)

    raise last_error


def supabase_headers():
    return {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def download_file(bucket, file_path):
    if file_path.startswith(bucket + "/"):
        file_path = file_path[len(bucket) + 1:]
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{file_path}"
    resp = _request(
        "GET",
        url,
        headers={"Authorization": f"Bearer {SUPABASE_SERVICE_KEY}", "apikey": SUPABASE_SERVICE_KEY},
    )
    return resp.content


def fetch_pending_jobs():
    url = f"{SUPABASE_URL}/rest/v1/jobs"
    params = {
        "status": "eq.pending",
        "job_type": "eq.process_upload",
        "product_id": f"eq.{PRODUCT_ID}",
        "select": "*",
    }
    resp = _request("GET", url, headers=supabase_headers(), params=params)
    return resp.json()


def claim_job(job_id):
    """Atomically take ownership of a pending job so one poller processes it.

    Deliberately a single attempt with no retry. If the PATCH is applied but the
    response is lost, a replay would match 0 rows and we would wrongly conclude
    another worker owns the job. A failure here just leaves it pending for the
    next cycle.
    """
    headers = supabase_headers()
    headers["Prefer"] = "return=representation"
    url = f"{SUPABASE_URL}/rest/v1/jobs?id=eq.{job_id}&status=eq.pending"
    resp = requests.patch(
        url,
        headers=headers,
        json={"status": "processing", "started_at": _now_iso()},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    claimed = resp.json()
    return isinstance(claimed, list) and len(claimed) == 1


def release_stale_claims():
    """Return jobs abandoned mid-flight (poller died after claiming) to pending."""
    cutoff = time.strftime(
        "%Y-%m-%dT%H:%M:%SZ",
        time.gmtime(time.time() - STALE_CLAIM_MINUTES * 60),
    )
    headers = supabase_headers()
    headers["Prefer"] = "return=representation"
    resp = _request(
        "PATCH",
        f"{SUPABASE_URL}/rest/v1/jobs",
        headers=headers,
        params={
            "status": "eq.processing",
            "job_type": "eq.process_upload",
            "product_id": f"eq.{PRODUCT_ID}",
            "started_at": f"lt.{cutoff}",
        },
        json={"status": "pending"},
    )
    released = resp.json()
    if released:
        print(f"released {len(released)} stale claim(s)", flush=True)


def fetch_existing_invoice_numbers(customer_id, exclude_source_file_path=None):
    """Invoice numbers this customer has already had processed.

    Cross-upload duplicate detection needs history the processor cannot see: it
    only ever receives one file. Scoped to a single customer, because the same
    invoice number appearing under two different accounts is not a duplicate.

    Records written from the file currently being processed are skipped, so
    re-running a job does not flag its own previous output as a duplicate of
    itself.

    Note: PostgREST caps a single select at 1000 rows. A customer past that mark
    would have some history invisible here.
    """
    params = {
        "product_id": f"eq.{PRODUCT_ID}",
        "customer_id": f"eq.{customer_id}",
        "select": "details,source_file_path",
    }
    resp = _request(
        "GET",
        f"{SUPABASE_URL}/rest/v1/records",
        headers=supabase_headers(),
        params=params,
    )

    numbers = set()
    for row in resp.json():
        if exclude_source_file_path and row.get("source_file_path") == exclude_source_file_path:
            continue
        details = row.get("details") or {}
        invoice_number = details.get("invoice_number")
        if invoice_number is not None and str(invoice_number).strip():
            numbers.add(str(invoice_number).strip())
    return numbers


def upload_results(job_id, results, customer_id=None):
    """Upload the result file into the owning customer's folder.

    The key layout matters. The dashboard downloads result files as the signed-in
    user with the anon key, and the `results` bucket policy only grants access
    when the first path segment equals their uid:

        (storage.foldername(name))[1] = auth.uid()

    A flat `<job_id>.json` key has no folder segment at all, so
    storage.foldername() returns an empty array, the comparison is NULL, and the
    policy denies every download. Nesting under `<customer_id>/` is what makes the
    existing policy match.
    """
    prefix = f"{customer_id}/" if customer_id else ""
    path = f"{prefix}{job_id}.json"
    url = f"{SUPABASE_URL}/storage/v1/object/{RESULTS_BUCKET}/{path}"
    resp = _request(
        "POST",
        url,
        data=json.dumps(results),
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "apikey": SUPABASE_SERVICE_KEY,
            "Content-Type": "application/json",
            "x-upsert": "true",
        },
    )
    return f"{RESULTS_BUCKET}/{path}"


def update_job(job_id, status, output_file_path=None, result_summary=None, error_message=None):
    url = f"{SUPABASE_URL}/rest/v1/jobs?id=eq.{job_id}"
    payload = {"status": status, "completed_at": _now_iso()}
    if output_file_path is not None:
        payload["output_file_path"] = output_file_path
    if result_summary is not None:
        payload["result_summary"] = result_summary
    if error_message is not None:
        payload["error_message"] = error_message
    resp = _request("PATCH", url, headers=supabase_headers(), json=payload)


def notify(customer_id, success):
    try:
        payload = {
            "product_id": PRODUCT_ID,
            "customer_id": customer_id,
            "title": "Processing complete" if success else "Processing failed",
            "body": "Your upload has been processed successfully." if success else "There was an error processing your upload.",
            "type": "success" if success else "error",
            "read": False,
        }
        _request(
            "POST",
            f"{SUPABASE_URL}/rest/v1/notifications",
            headers=supabase_headers(),
            json=payload,
            retry=False,
        )
    except Exception as e:
        print(f"notification failed: {e}", flush=True)


def process_job(job):
    job_id = job["id"]
    customer_id = job["customer_id"]
    file_path = job["input_file_path"]

    try:
        claimed = claim_job(job_id)
    except Exception as error:
        print(f"job {job_id}: claim failed, leaving pending: {error}", flush=True)
        return

    if not claimed:
        return

    try:
        file_bytes = download_file(BUCKET, file_path)
        results = processor.process_file(file_bytes)
        if not isinstance(results, list):
            raise ValueError("processor.process_file must return a list")

        # Duplicate history is a nice-to-have, not a reason to fail an upload: if
        # the lookup is unavailable we process normally rather than losing the job.
        try:
            existing_invoices = fetch_existing_invoice_numbers(
                customer_id, exclude_source_file_path=file_path
            )
        except Exception as error:
            print(f"job {job_id}: duplicate lookup failed, continuing without it: {error}", flush=True)
            existing_invoices = set()
        results = processor.apply_cross_upload_duplicates(results, existing_invoices)

        inserted = 0
        for item in results:
            if not isinstance(item, dict):
                continue
            status = item.get("status")
            if status not in VALID_STATUSES:
                raise ValueError(f"Invalid record status: {status}")
            title = item.get("title")
            if not title or not str(title).strip():
                raise ValueError("Missing record title")
            record = {
                "product_id": PRODUCT_ID,
                "customer_id": customer_id,
                "title": title,
                "status": status,
                "details": item.get("details", {}),
                "source_file_path": file_path,
                "due_date": item.get("due_date"),
            }
            _request(
                "POST",
                f"{SUPABASE_URL}/rest/v1/records",
                headers=supabase_headers(),
                json=record,
                retry=False,
            )
            inserted += 1
        result_summary = f"Processed {inserted} records"
        output_file_path = upload_results(job_id, results, customer_id)
        update_job(job_id, "completed", output_file_path=output_file_path, result_summary=result_summary)
        notify(customer_id, True)
    except Exception as e:
        print(f"job {job_id} failed: {e}", flush=True)
        try:
            update_job(job_id, "failed", result_summary=str(e), error_message=str(e))
        except Exception as update_error:
            print(f"failed to update job: {update_error}", flush=True)
        try:
            notify(customer_id, False)
        except Exception as notify_error:
            print(f"failed to notify: {notify_error}", flush=True)


def poll():
    while True:
        try:
            release_stale_claims()
            jobs = fetch_pending_jobs()
            for job in jobs:
                process_job(job)
            print(f"poll ok: {len(jobs)} pending job(s) seen", flush=True)
        except Exception as e:
            print(f"polling error: {e}", flush=True)
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    print(
        f"Poller started (product={PRODUCT_ID}, timeout={REQUEST_TIMEOUT}s, "
        f"retries={MAX_ATTEMPTS}, poll={POLL_INTERVAL_SECONDS}s)",
        flush=True,
    )
    poll()
