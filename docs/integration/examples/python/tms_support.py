"""Client for the TMS integration API. Standard library only: copy this file into your project.

    from tms_support import TmsClient

    tms = TmsClient("https://support.example.com", api_key)
    ticket = tms.create_ticket(
        customer={"externalId": "user-42", "name": "Asha Verma"},
        subject="The price on this listing looks wrong",
        body="The site shows 1,499 but the store charges 1,799.",
        external_ref="MYN-48213",
    )
    tms.report_event("scraper.run_failed", "Scraper exited with code 1", severity="error")
    tms.resolve_event("scraper.run_failed")

Webhooks and chat identities:

    if not verify_webhook_signature(raw_body, headers.get("X-TMS-Signature"), secret):
        return 401
    token = sign_chat_identity(secret, sub="user-42", name="Asha Verma")

Keep the API key and both secrets on your server. Python 3.8+.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

__all__ = [
    "TmsClient",
    "TmsError",
    "sign_chat_identity",
    "sign_webhook",
    "verify_webhook_signature",
]

SIGNATURE_HEADER = "X-TMS-Signature"
EVENT_HEADER = "X-TMS-Event"
DELIVERY_HEADER = "X-TMS-Delivery"
DEFAULT_TOLERANCE_SECONDS = 300


class TmsError(Exception):
    """A request the API refused, or that never reached it.

    `status` is the HTTP status (0 when there was no answer); a 429 carries
    `retry_after` in seconds.
    """

    def __init__(self, status: int, message: str, body: Any = None, retry_after: Optional[int] = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.body = body
        self.retry_after = retry_after


class TmsClient:
    """The TMS integration API for one integration."""

    def __init__(self, base_url: str, api_key: str, timeout: float = 5.0):
        self._base = base_url.rstrip("/") + "/api/v1"
        self._api_key = api_key
        self._timeout = timeout

    # ---- Tickets ----

    def who_am_i(self) -> Dict[str, Any]:
        """Who this key is. A cheap way to check the connection and the key."""
        return self._request("GET", "/integration")

    def create_ticket(
        self,
        customer: Dict[str, str],
        subject: str,
        body: str,
        *,
        category: Optional[str] = None,
        priority: Optional[str] = None,
        tags: Optional[List[str]] = None,
        external_ref: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        ai: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Raises a ticket for one of your users.

        `customer` needs an `externalId` (your own id for the person) or an
        `email`. With an `idempotency_key`, a retry of the same call returns
        the ticket made the first time.
        """
        payload = _without_none(
            {
                "customer": customer,
                "subject": subject,
                "body": body,
                "category": category,
                "priority": priority,
                "tags": tags,
                "externalRef": external_ref,
                "metadata": metadata,
                "ai": ai,
            }
        )
        return self._request("POST", "/integration/tickets", payload, idempotency_key=idempotency_key)

    def get_ticket(self, reference: str) -> Dict[str, Any]:
        return self._request("GET", "/integration/tickets/" + _segment(reference))

    def list_tickets(
        self,
        external_ref: Optional[str] = None,
        state: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        customer: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Your tickets, newest first. `state`: open, pending, resolved or closed.

        `customer` is your own id for a person (their `externalId`): only their tickets.
        """
        query = {
            "externalRef": external_ref,
            "customer": customer,
            "state": state,
            "limit": limit,
            "offset": offset,
        }
        return self._request("GET", "/integration/tickets", query=query)

    def messages(self, reference: str, after: Optional[str] = None) -> List[Dict[str, Any]]:
        """What the customer wrote and was sent. `after` (a `createdAt`) returns only newer ones."""
        path = "/integration/tickets/" + _segment(reference) + "/messages"
        return self._request("GET", path, query={"after": after})

    def add_message(
        self, reference: str, body: str, idempotency_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """The customer's follow-up, written in your app."""
        path = "/integration/tickets/" + _segment(reference) + "/messages"
        return self._request("POST", path, {"body": body}, idempotency_key=idempotency_key)

    def rate(self, reference: str, rating: int, comment: Optional[str] = None) -> Dict[str, Any]:
        """The customer's rating (1 to 5) of a solved ticket, given in your app."""
        path = "/integration/tickets/" + _segment(reference) + "/rating"
        return self._request("POST", path, _without_none({"rating": rating, "comment": comment}))

    # ---- Incidents ----

    def report_event(
        self,
        fingerprint: str,
        title: str,
        *,
        severity: str = "error",
        source: Optional[str] = None,
        message: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Something of yours is failing. Reports with one fingerprint share one ticket.

        `severity`: info, warning, error or critical.
        """
        payload = _without_none(
            {
                "fingerprint": fingerprint,
                "status": "firing",
                "title": title,
                "severity": severity,
                "source": source,
                "message": message,
                "details": details,
            }
        )
        return self._request("POST", "/integration/events", payload)

    def resolve_event(self, fingerprint: str, message: Optional[str] = None) -> Dict[str, Any]:
        """It has recovered. Resolves the incident, and its ticket if nobody has taken it."""
        payload = _without_none({"fingerprint": fingerprint, "status": "resolved", "message": message})
        return self._request("POST", "/integration/events", payload)

    def incidents(self, status: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        return self._request("GET", "/integration/incidents", query={"status": status, "limit": limit})

    # ---- Phone numbers ----

    def start_phone_verification(
        self,
        external_id: str,
        phone: str,
        *,
        email: Optional[str] = None,
        name: Optional[str] = None,
        title: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Sends a 6-digit code to the customer's WhatsApp. Needs the `integration:customer` scope.

        `phone` is the full international number. The code works for 10
        minutes, and a new code retires the earlier one. Returns `expiresAt`
        and `sentVia` (`template` or `text`). A `TmsError` says why nothing was
        sent: 409 (WhatsApp cannot reach this number now), 429 (wait
        `retry_after` seconds) or 502 (Meta refused).
        """
        payload = {"customer": _phone_customer(external_id, email, name, title), "phone": phone}
        return self._request("POST", "/integration/customers/phone-verifications", payload)

    def check_phone_verification(
        self,
        external_id: str,
        phone: str,
        code: str,
        *,
        email: Optional[str] = None,
        name: Optional[str] = None,
        title: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Checks the code the customer typed. On success the number is proven for them.

        `title` is how the customer chose to be addressed ("Mr.", "Ms.", "Mrs.",
        "Mx." or "Dr."); the support AI then uses it with their name.

        Returns `{"verified": True, "phone": ...}`. A wrong code is a
        `TmsError` with status 400 and `err.body["reason"]` one of
        `wrong-code`, `expired`, `too-many-attempts` or `no-code`.
        """
        payload = {
            "customer": _phone_customer(external_id, email, name, title),
            "phone": phone,
            "code": code,
        }
        return self._request("POST", "/integration/customers/phone-verifications/check", payload)

    def send_customer_notice(self, external_id: str, text: str, about: Optional[str] = None) -> Dict[str, Any]:
        """Tells a customer something in writing: a return approved, a refund issued.

        Your sentence goes, as it is, to the number that customer has confirmed,
        over WhatsApp. Needs the `integration:customer` scope. Returns
        `{"sent": True, "via": "whatsapp"}`, or `{"sent": False, "reason": ...}`
        when it could not go out (no confirmed number, or they have not written
        on WhatsApp in the last 24 hours). A 404 `TmsError` means TMS does not
        know this customer of yours.
        """
        payload: Dict[str, Any] = {"customer": {"externalId": external_id}, "text": text}
        if about:
            payload["about"] = about
        return self._request("POST", "/integration/customers/notices", payload)

    # ---- Transport ----

    def _request(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        *,
        query: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        url = self._base + path
        pairs = {k: v for k, v in (query or {}).items() if v is not None}
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs, quote_via=urllib.parse.quote)
        headers = {"Authorization": "Bearer " + self._api_key, "Accept": "application/json"}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return _parse(response.read())
        except urllib.error.HTTPError as err:
            body = _parse(err.read())
            message = body.get("message") if isinstance(body, dict) else None
            retry_after = err.headers.get("Retry-After") if err.headers else None
            raise TmsError(
                err.code,
                str(message or "Request failed with status %d" % err.code),
                body,
                int(retry_after) if retry_after and retry_after.isdigit() else None,
            ) from None
        except (urllib.error.URLError, OSError) as err:
            reason = getattr(err, "reason", err)
            raise TmsError(0, "Could not reach TMS: %s" % reason) from None


# ---- Webhooks ----


def sign_webhook(raw_body: str, secret: str, timestamp: int) -> str:
    """The header TMS sends for `raw_body` at `timestamp`: `t=<unix>,v1=<hex HMAC-SHA256>`."""
    digest = hmac.new(
        secret.encode("utf-8"), ("%d.%s" % (timestamp, raw_body)).encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return "t=%d,v1=%s" % (timestamp, digest)


def verify_webhook_signature(
    raw_body: Any,
    signature_header: Optional[str],
    secret: str,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[int] = None,
) -> bool:
    """Whether a webhook really came from TMS.

    Pass the raw request body (str or bytes), exactly as received: a parsed
    and re-serialised copy will not match. A timestamp too far from now is
    refused, which stops replays. Deliveries can repeat: use the payload's
    `id` to do each one's work once.
    """
    if not signature_header:
        return False
    parts = {}
    for pair in signature_header.split(","):
        key, _, value = pair.partition("=")
        parts[key.strip()] = value.strip()
    try:
        timestamp = int(parts.get("t", ""))
    except ValueError:
        return False
    given = parts.get("v1", "").lower()
    if not given:
        return False
    current = int(time.time()) if now is None else now
    if abs(current - timestamp) > tolerance_seconds:
        return False
    body = raw_body.decode("utf-8") if isinstance(raw_body, (bytes, bytearray)) else raw_body
    expected = sign_webhook(body, secret, timestamp).split("v1=", 1)[1]
    return hmac.compare_digest(expected, given)


# ---- Chat identity ----


def sign_chat_identity(
    secret: str,
    *,
    sub: Optional[str] = None,
    email: Optional[str] = None,
    name: Optional[str] = None,
    ttl_seconds: int = 300,
    now: Optional[int] = None,
) -> str:
    """A token that vouches for a signed-in visitor to the chat widget.

    Pass it to `TMSChat.init({ identityToken })`. `sub` is your own id for
    the person: the same id your API calls use as `customer.externalId`.
    Sign it per page load, with the integration's chat identity secret.
    """
    if not sub and not email:
        raise ValueError("A chat identity needs a sub or an email")
    issued = int(time.time()) if now is None else now
    claims: Dict[str, Any] = {}
    if sub:
        claims["sub"] = sub
    if name:
        claims["name"] = name
    if email:
        claims["email"] = email
    claims["iat"] = issued
    claims["exp"] = issued + ttl_seconds
    signing_input = _b64url(_compact({"alg": "HS256", "typ": "JWT"})) + "." + _b64url(_compact(claims))
    signature = hmac.new(secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return signing_input + "." + _b64url(signature)


# ---- Helpers ----


def _without_none(values: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def _phone_customer(
    external_id: str, email: Optional[str], name: Optional[str], title: Optional[str] = None
) -> Dict[str, Any]:
    return _without_none({"externalId": external_id, "email": email, "name": name, "title": title})


def _segment(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _parse(raw: bytes) -> Any:
    if not raw:
        return None
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


def _compact(value: Dict[str, Any]) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
