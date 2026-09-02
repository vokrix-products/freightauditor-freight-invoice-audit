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

VALID_STATUSES = {
    'missing:critical',
    'expired:warning',
    'valid:good',
    'flagged:critical',
    'contract-review:warning',
    'unmapped:warning',
}

import processor

def download_file(bucket, file_path):
    if file_path.startswith(bucket + "/"):
        file_path = file_path[len(bucket) + 1:]
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{file_path}"
    resp = requests.get(url, headers={"Authorization": f"Bearer {SUPABASE_SERVICE_KEY}", "apikey": SUPABASE_SERVICE_KEY})
    resp.raise_for_status()
    return resp.content

def supabase_headers():
    return {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

def fetch_pending_jobs():
    url = f"{SUPABASE_URL}/rest/v1/jobs"
    params = {
        "status": "eq.pending",
        "job_type": "eq.process_upload",
        "product_id": f"eq.{PRODUCT_ID}",
        "select": "*",
    }
    resp = requests.get(url, headers=supabase_headers(), params=params)
    resp.raise_for_status()
    return resp.json()

def upload_results(job_id, results):
    path = f"{job_id}.json"
    url = f"{SUPABASE_URL}/storage/v1/object/{RESULTS_BUCKET}/{path}"
    resp = requests.post(
        url,
        data=json.dumps(results),
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "apikey": SUPABASE_SERVICE_KEY,
            "Content-Type": "application/json",
            "x-upsert": "true",
        },
    )
    resp.raise_for_status()
    return f"{RESULTS_BUCKET}/{path}"

def update_job(job_id, status, output_file_path=None, result_summary=None):
    url = f"{SUPABASE_URL}/rest/v1/jobs?id=eq.{job_id}"
    payload = {"status": status, "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if output_file_path is not None:
        payload["output_file_path"] = output_file_path
    if result_summary is not None:
        payload["result_summary"] = result_summary
    resp = requests.patch(url, headers=supabase_headers(), json=payload)
    resp.raise_for_status()

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
        resp = requests.post(
            "https://njyvnmczoydsaewvfhyq.supabase.co/rest/v1/notifications",
            headers=supabase_headers(),
            json=payload,
        )
        resp.raise_for_status()
    except Exception as e:
        print(f"notification failed: {e}")

def process_job(job):
    job_id = job["id"]
    customer_id = job["customer_id"]
    file_path = job["input_file_path"]
    try:
        file_bytes = download_file(BUCKET, file_path)
        results = processor.process_file(file_bytes)
        if not isinstance(results, list):
            raise ValueError("processor.process_file must return a list")
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
            url = f"{SUPABASE_URL}/rest/v1/records"
            resp = requests.post(url, headers=supabase_headers(), json=record)
            resp.raise_for_status()
            inserted += 1
        result_summary = f"Processed {inserted} records"
        output_file_path = upload_results(job_id, results)
        update_job(job_id, "completed", output_file_path=output_file_path, result_summary=result_summary)
        notify(customer_id, True)
    except Exception as e:
        print(f"job {job_id} failed: {e}")
        try:
            update_job(job_id, "failed", result_summary=str(e))
        except Exception as update_error:
            print(f"failed to update job: {update_error}")
        try:
            notify(customer_id, False)
        except Exception as notify_error:
            print(f"failed to notify: {notify_error}")

def poll():
    while True:
        try:
            jobs = fetch_pending_jobs()
            for job in jobs:
                process_job(job)
        except Exception as e:
            print(f"polling error: {e}")
        time.sleep(60)

if __name__ == "__main__":
    print("Poller started")
    poll()
