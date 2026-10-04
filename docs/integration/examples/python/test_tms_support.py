"""Tests for tms_support.py. Run with: python -m unittest test_tms_support

The signature vectors are the same file the TypeScript SDK's tests read, so
both clients are held to one contract. The client is exercised over real HTTP
against a small server started here.
"""

import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from tms_support import (
    TmsClient,
    TmsError,
    sign_chat_identity,
    sign_webhook,
    verify_webhook_signature,
)

VECTORS_PATH = os.environ.get(
    "TMS_SIGNATURE_VECTORS",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "signature-vectors.json"),
)
with open(VECTORS_PATH, encoding="utf-8") as handle:
    VECTORS = json.load(handle)


class WebhookSignatures(unittest.TestCase):
    def test_signs_as_tms_does(self):
        for vector in VECTORS["webhook"]:
            with self.subTest(vector["name"]):
                header = sign_webhook(vector["body"], vector["secret"], vector["timestamp"])
                self.assertEqual(header, vector["header"])
                self.assertTrue(
                    verify_webhook_signature(
                        vector["body"], vector["header"], vector["secret"], now=vector["timestamp"]
                    )
                )
                self.assertTrue(
                    verify_webhook_signature(
                        vector["body"].encode("utf-8"),
                        vector["header"],
                        vector["secret"],
                        now=vector["timestamp"] + 60,
                    )
                )

    def test_refuses_anything_else(self):
        vector = VECTORS["webhook"][0]
        at = vector["timestamp"]
        body, header, secret = vector["body"], vector["header"], vector["secret"]
        self.assertFalse(verify_webhook_signature(body + " ", header, secret, now=at))
        self.assertFalse(verify_webhook_signature(body, header, "another-secret", now=at))
        self.assertFalse(verify_webhook_signature(body, None, secret, now=at))
        self.assertFalse(verify_webhook_signature(body, "v1=abc", secret, now=at))
        self.assertFalse(verify_webhook_signature(body, "t=abc,v1=abc", secret, now=at))
        # Too old to be a fresh delivery: a replay.
        self.assertFalse(verify_webhook_signature(body, header, secret, now=at + 301))


class ChatIdentity(unittest.TestCase):
    def test_signs_the_token_tms_verifies(self):
        vector = VECTORS["identity"]
        token = sign_chat_identity(
            vector["secret"],
            now=vector["issuedAt"],
            ttl_seconds=vector["ttlSeconds"],
            **vector["claims"],
        )
        self.assertEqual(token, vector["token"])

    def test_needs_someone_to_vouch_for(self):
        with self.assertRaises(ValueError):
            sign_chat_identity("secret", name="Nobody")


class _Handler(BaseHTTPRequestHandler):
    """Records each request and answers what the test queued."""

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        self.server.seen.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": json.loads(raw) if raw else None,
            }
        )
        status, body, headers = self.server.answers.pop(0) if self.server.answers else (200, {}, {})
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _handle
    do_POST = _handle

    def log_message(self, *args):  # Keep the test output quiet.
        pass


class Client(unittest.TestCase):
    def setUp(self):
        self.server = HTTPServer(("127.0.0.1", 0), _Handler)
        self.server.seen = []
        self.server.answers = []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.tms = TmsClient("http://127.0.0.1:%d/" % self.server.server_port, "tms_sk_test")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_raises_a_ticket_with_the_key_and_an_idempotency_key(self):
        self.server.answers.append((201, {"reference": "TMS-7"}, {}))
        ticket = self.tms.create_ticket(
            {"externalId": "shopper-42"},
            "Wrong price",
            "The listing shows the wrong price.",
            external_ref="MYN-48213",
            metadata={"price_current": 1499},
            idempotency_key="report-0001",
        )
        self.assertEqual(ticket["reference"], "TMS-7")
        (seen,) = self.server.seen
        self.assertEqual((seen["method"], seen["path"]), ("POST", "/api/v1/integration/tickets"))
        self.assertEqual(seen["headers"]["authorization"], "Bearer tms_sk_test")
        self.assertEqual(seen["headers"]["idempotency-key"], "report-0001")
        self.assertEqual(
            seen["body"],
            {
                "customer": {"externalId": "shopper-42"},
                "subject": "Wrong price",
                "body": "The listing shows the wrong price.",
                "externalRef": "MYN-48213",
                "metadata": {"price_current": 1499},
            },
        )

    def test_builds_the_other_requests(self):
        self.tms.who_am_i()
        self.tms.get_ticket("TMS-7")
        self.tms.list_tickets(external_ref="MYN 1", state="open", limit=5)
        self.tms.messages("TMS-7", after="2026-10-01T10:00:00.000Z")
        self.tms.add_message("TMS-7", "Still wrong")
        self.tms.rate("TMS-7", 5, "Thanks")
        self.tms.report_event("job.failed", "Job failed", source="worker")
        self.tms.resolve_event("job.failed", "Fine again")
        self.tms.incidents(status="open")
        self.assertEqual(
            ["%s %s" % (s["method"], s["path"]) for s in self.server.seen],
            [
                "GET /api/v1/integration",
                "GET /api/v1/integration/tickets/TMS-7",
                "GET /api/v1/integration/tickets?externalRef=MYN%201&state=open&limit=5",
                "GET /api/v1/integration/tickets/TMS-7/messages?after=2026-10-01T10%3A00%3A00.000Z",
                "POST /api/v1/integration/tickets/TMS-7/messages",
                "POST /api/v1/integration/tickets/TMS-7/rating",
                "POST /api/v1/integration/events",
                "POST /api/v1/integration/events",
                "GET /api/v1/integration/incidents?status=open",
            ],
        )
        self.assertEqual(self.server.seen[4]["body"], {"body": "Still wrong"})
        self.assertEqual(self.server.seen[5]["body"], {"rating": 5, "comment": "Thanks"})
        self.assertEqual(
            self.server.seen[6]["body"],
            {
                "fingerprint": "job.failed",
                "status": "firing",
                "title": "Job failed",
                "severity": "error",
                "source": "worker",
            },
        )
        self.assertEqual(
            self.server.seen[7]["body"],
            {"fingerprint": "job.failed", "status": "resolved", "message": "Fine again"},
        )

    def test_a_refusal_says_why_and_when_to_retry(self):
        self.server.answers.append(
            (429, {"message": "Too many requests. Try again in 12 seconds."}, {"Retry-After": "12"})
        )
        with self.assertRaises(TmsError) as caught:
            self.tms.who_am_i()
        self.assertEqual(caught.exception.status, 429)
        self.assertEqual(caught.exception.message, "Too many requests. Try again in 12 seconds.")
        self.assertEqual(caught.exception.retry_after, 12)

    def test_an_unreachable_helpdesk_is_an_error_not_a_crash(self):
        down = TmsClient("http://127.0.0.1:1", "tms_sk_test", timeout=1.0)
        with self.assertRaises(TmsError) as caught:
            down.who_am_i()
        self.assertEqual(caught.exception.status, 0)


if __name__ == "__main__":
    unittest.main()
