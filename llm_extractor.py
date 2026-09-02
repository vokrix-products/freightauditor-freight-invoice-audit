import json
import os
import re
from typing import Any, Dict, List

from openai import OpenAI


def extract_from_unstructured_text(text: str) -> List[Dict[str, Any]]:
    if not os.environ.get("DEEPSEEK_API_KEY"):
        return []
    if not text or not text.strip():
        return []

    try:
        client = OpenAI(
            api_key=os.environ["DEEPSEEK_API_KEY"],
            base_url="https://api.deepseek.com",
        )
        response = client.chat.completions.create(
            model="deepseek-v4-flash",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a freight invoice and carrier rate sheet extractor. "
                        "Extract the RateMatch schema fields from the provided unstructured text. "
                        "The title field must be the carrier or vendor name, never a document type. "
                        "Return only valid JSON: an array of objects. "
                        "Use null for missing values. Do not wrap the JSON in markdown."
                    ),
                },
                {"role": "user", "content": text[:12000]},
            ],
            temperature=0,
        )

        content = response.choices[0].message.content or "[]"
        content = re.sub(r"```(?:json)?", "", content).strip()
        data = json.loads(content)

        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            return []

        return [item for item in data if isinstance(item, dict)]
    except Exception:
        return []
