"""Quick local smoke test for the FastAPI backend without hitting Cosmos DB.

Run inside the virtualenv:

    source .venv/bin/activate
    python scripts/local_api_smoketest.py

The script forces the in-memory database implementation so it never makes
network calls. It exercises the auth and interview endpoints end-to-end.
"""

from __future__ import annotations

import os
import sys
from pprint import pprint

from fastapi.testclient import TestClient

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

print("module import complete, loading FastAPI app...", flush=True)
from app.main import app  # noqa: E402


def _call_endpoint(client: TestClient, method: str, path: str, *, label: str, **kwargs):
    print(f"calling {label}...", flush=True)
    response = client.request(method, path, **kwargs)
    print(f"{label} status:", response.status_code)
    try:
        payload = response.json()
    except ValueError:
        payload = response.text
    pprint(payload)
    return response


def main() -> None:
    print("starting local API smoke test...", flush=True)
    client = TestClient(app)

    signup_payload = {"userId": "demo-user", "password": "Pa55word!"}
    resp = _call_endpoint(client, "POST", "/auth/signup", label="signup", json=signup_payload)
    _call_endpoint(client, "POST", "/auth/signup", label="duplicate signup", json=signup_payload)

    token = resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    start_payload = {"interviewType": "Mock", "targetIndustry": "IT"}
    resp = _call_endpoint(
        client,
        "POST",
        "/interviews/start",
        label="interviews/start",
        json=start_payload,
        headers=headers,
    )
    interview_id = resp.json()["interviewId"]

    _call_endpoint(
        client,
        "POST",
        "/chat",
        label="chat",
        json={"interviewId": interview_id, "userMessage": "自己紹介をいたします。"},
        headers=headers,
    )
    _call_endpoint(
        client,
        "POST",
        "/chat",
        label="chat follow-up",
        json={"interviewId": interview_id, "userMessage": "私の強みはコミュニケーション力です。"},
        headers=headers,
    )
    _call_endpoint(client, "GET", "/interviews/", label="interviews/list", headers=headers)


if __name__ == "__main__":
    main()
