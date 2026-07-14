#!/usr/bin/env python3
"""MCP server for the Baileys WhatsApp REST API at your-domain.com.

Read tools (auto-allowed) expose chats, contacts, groups, messages, presence,
profile pictures, message/session status, and a composite chat-overview.
Write tools (send_message, send_media, send_location, send_reaction,
mark_chat_read) are intentionally NOT in the user's allowlist so the harness
prompts before each send.

Notable upstream quirks this server papers over:

* `GET /api/chats/{sid}` returns an empty data array because the Baileys
  wrapper does not persist WhatsApp's `messaging-history.set` event. WhatsApp
  delivers the chat index exactly once on initial pairing and never again on
  reconnect. Our `get_chat_overview` derives the chat list from recent
  messages (`GET /api/messages/{sid}`) plus contacts/groups for display
  names, mirroring the `/chats/overview` pattern used by WAHA.
* `GET /api/messages/{sid}` is hard-capped at `limit=100` per request.
* All errors come back as a `{success, data, timestamp}` envelope on success
  and `{success: false, error, code, details}` on validation errors, except
  the rate-limiter which returns plain-text `HTTP 429` with a `retry-after`
  header. Both shapes are handled.
* Rate limit is 100 requests per 15 minute window per IP across every
  endpoint. `get_chat_overview` is bounded to keep one composite call cheap.

Runs in two modes:

* **stdio** (default): one user, API key from env. `python server.py`
* **streamable HTTP** (`--http`): hosted multi-user mode. Each request must
  carry the caller's wapi key as `X-API-Key` (or `Authorization: Bearer`);
  the key is scoped to that request via a contextvar. Bind host/port with
  MCP_HTTP_HOST / MCP_HTTP_PORT (default 127.0.0.1:3002, put nginx in front).

Config via env:
    WHATSAPP_API_BASE         e.g. https://your-domain.com (required)
    WHATSAPP_API_KEY          X-API-Key (required in stdio mode only)
    WHATSAPP_DEFAULT_SESSION  session id used when a tool's `session` arg is
                              None; when unset, the single connected session
                              of the calling key is auto-resolved
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import mimetypes
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, ConfigDict, Field


API_BASE = os.environ.get("WHATSAPP_API_BASE", "").rstrip("/")
API_KEY = os.environ.get("WHATSAPP_API_KEY", "")
DEFAULT_SESSION = os.environ.get("WHATSAPP_DEFAULT_SESSION", "")
HTTP_MODE = "--http" in sys.argv

if not API_BASE or (not API_KEY and not HTTP_MODE):
    sys.stderr.write(
        "whatsapp_mcp: WHATSAPP_API_BASE must be set"
        " (and WHATSAPP_API_KEY in stdio mode)\n"
    )
    sys.exit(1)

# stdio mode: one user, key from env. --http mode: the server is shared, the
# key arrives per request and lives in a contextvar for that request only —
# no cross-user leakage.
_REQUEST_API_KEY: contextvars.ContextVar[str] = contextvars.ContextVar(
    "wapi_request_api_key", default=""
)


def _api_key() -> str:
    key = _REQUEST_API_KEY.get() or API_KEY
    if not key:
        raise ValueError(
            "No API key: send an X-API-Key header (HTTP) "
            "or set WHATSAPP_API_KEY (stdio)"
        )
    return key


from mcp.server.transport_security import TransportSecuritySettings

# The SDK's DNS-rebinding protection rejects unknown Host headers. Behind
# nginx the public hostname arrives here, so it must be allow-listed.
_ALLOWED_HOSTS = [
    h.strip()
    for h in os.environ.get(
        "MCP_ALLOWED_HOSTS",
        "127.0.0.1,localhost,127.0.0.1:3002,localhost:3002",
    ).split(",")
    if h.strip()
]

mcp = FastMCP(
    "whatsapp_mcp",
    host=os.environ.get("MCP_HTTP_HOST", "127.0.0.1"),
    port=int(os.environ.get("MCP_HTTP_PORT", "3002")),
    stateless_http=True,
    transport_security=TransportSecuritySettings(
        allowed_hosts=_ALLOWED_HOSTS,
        allowed_origins=[f"https://{h}" for h in _ALLOWED_HOSTS]
        + [f"http://{h}" for h in _ALLOWED_HOSTS],
    ),
)

# Module-level client gives us TCP/TLS connection reuse across tool calls.
# Lazy so the test harness can import the module without opening sockets.
_CLIENT: Optional[httpx.AsyncClient] = None


def _client() -> httpx.AsyncClient:
    global _CLIENT
    if _CLIENT is None or _CLIENT.is_closed:
        # No auth header here — the key is per-request (multi-user HTTP mode),
        # _request() attaches it. The pooled client is shared by all users.
        _CLIENT = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            headers={"Accept": "application/json"},
        )
    return _CLIENT


# api-key -> (expires_at, sessionId); avoids one /api/sessions round-trip per
# tool call for users who never pass `session` explicitly.
_SESSION_CACHE: dict[str, tuple[float, str]] = {}


async def _resolve_session(s: Optional[str]) -> str:
    """Explicit param > env default > the user's single connected session.

    The auto-resolve makes the hosted MCP zero-config for the common case
    (one phone number). Users with several sessions get an actionable error
    listing their session ids.
    """
    sid = (s or DEFAULT_SESSION).strip()
    if sid:
        return sid

    key = _api_key()
    cached = _SESSION_CACHE.get(key)
    if cached and cached[0] > time.time():
        return cached[1]

    sessions = await _request("GET", "/api/sessions") or []
    if not isinstance(sessions, list):
        sessions = []
    connected = [
        x for x in sessions
        if str(x.get("status") or "").upper() == "CONNECTED"
    ]
    pool = connected or sessions
    if len(pool) == 1:
        auto = str(pool[0].get("sessionId") or "").strip()
        if auto:
            _SESSION_CACHE[key] = (time.time() + 60.0, auto)
            return auto

    listing = ", ".join(
        f"{x.get('sessionId')} ({x.get('status')})" for x in sessions
    ) or "none"
    raise ValueError(
        "No session specified and no single connected session to default to. "
        f"Available sessions: {listing}. Pass `session` explicitly."
    )


def _normalize_jid(raw: str) -> str:
    """Best-effort canonicalization for the recipient field.

    * Bare digits → append `@s.whatsapp.net` (Baileys canonical for contacts).
    * `@c.us` (legacy WhatsApp-Web suffix) → rewritten to `@s.whatsapp.net`.
    * Anything else passes through verbatim (group `@g.us`, `@lid`, etc.).

    Idempotent. Callers can opt out by passing an already-suffixed JID.
    """
    s = raw.strip()
    if not s:
        return s
    if "@" not in s:
        digits = "".join(ch for ch in s if ch.isdigit() or ch == "+")
        digits = digits.lstrip("+")
        if digits:
            return f"{digits}@s.whatsapp.net"
        return s
    if s.endswith("@c.us"):
        return s[: -len("@c.us")] + "@s.whatsapp.net"
    return s


async def _request(
    method: str,
    path: str,
    *,
    params: Optional[dict[str, Any]] = None,
    json_body: Optional[dict[str, Any]] = None,
    files: Optional[dict[str, Any]] = None,
    data: Optional[dict[str, Any]] = None,
    timeout: Optional[float] = None,
    unwrap: bool = True,
) -> Any:
    """Make an HTTP call. By default unwraps the `{success, data, timestamp}`
    envelope so tool implementations don't have to.
    """
    url = f"{API_BASE}{path}"
    kw: dict[str, Any] = {}
    if timeout is not None:
        kw["timeout"] = timeout
    resp = await _client().request(
        method,
        url,
        params=params,
        json=json_body,
        files=files,
        data=data,
        headers={"X-API-Key": _api_key()},
        **kw,
    )
    resp.raise_for_status()
    if not resp.content:
        return None
    ctype = resp.headers.get("content-type", "")
    if "application/json" in ctype:
        payload = resp.json()
        return _unwrap(payload) if unwrap else payload
    return resp.text


def _format_error(e: Exception) -> str:
    if isinstance(e, httpx.HTTPStatusError):
        status = e.response.status_code

        # Rate limiter returns plain-text body with retry-after header.
        if status == 429:
            retry = e.response.headers.get("retry-after") or e.response.headers.get("Retry-After")
            suffix = f" Retry after {retry}s." if retry else ""
            return f"Error 429: rate limited (100 req / 15 min per IP).{suffix}"

        body: Any
        try:
            body = e.response.json()
        except Exception:
            body = (e.response.text or "").strip() or None

        if status == 401:
            return "Error 401: API key rejected. Check WHATSAPP_API_KEY."
        if status == 404:
            return f"Error 404: not found. Check session/chat/message id. {_short_err(body)}"
        if status == 400 or status == 422:
            return _format_validation_error(status, body)
        return f"Error {status}: {_short_err(body)}"
    if isinstance(e, httpx.TimeoutException):
        return "Error: upstream request timed out."
    if isinstance(e, httpx.RequestError):
        return f"Error: network failure: {e!r}"
    if isinstance(e, ValueError):
        return f"Error: {e}"
    return f"Error: {type(e).__name__}: {e}"


def _format_validation_error(status: int, body: Any) -> str:
    if isinstance(body, dict):
        msg = body.get("error") or "validation failed"
        details = body.get("details") or []
        if isinstance(details, list) and details:
            lines = [f"Error {status}: {msg}"]
            for d in details:
                if not isinstance(d, dict):
                    lines.append(f"  - {d}")
                    continue
                field = d.get("field") or d.get("path") or "?"
                m = d.get("message") or "invalid"
                val = d.get("value")
                loc = d.get("location")
                tail = f" (got {val!r}{', in ' + loc if loc else ''})" if val is not None else ""
                lines.append(f"  - {field}: {m}{tail}")
            return "\n".join(lines)
        return f"Error {status}: {msg}"
    return f"Error {status}: {_short_err(body)}"


def _short_err(body: Any, limit: int = 300) -> str:
    if body is None:
        return ""
    s = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
    return s if len(s) <= limit else s[:limit] + "…"


def _as_json(payload: Any) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False, default=str)


def _unwrap(payload: Any) -> Any:
    """Strip the Baileys `{success, data, timestamp}` envelope when present."""
    if isinstance(payload, dict) and "data" in payload and "success" in payload:
        return payload["data"]
    return payload


# Mapping of WhatsApp content-key → ("kind", "text-or-caption-field").
# Order matters; the first match wins. Reaction has a `text` field that holds
# the emoji, not a body — handled separately below.
_CONTENT_HANDLERS: list[tuple[str, str, Optional[str]]] = [
    ("conversation", "text", None),                       # plain string
    ("extendedTextMessage", "text", "text"),              # rich text + mentions
    ("imageMessage", "image", "caption"),
    ("videoMessage", "video", "caption"),
    ("audioMessage", "audio", None),
    ("documentMessage", "document", "caption"),
    ("documentWithCaptionMessage", "document", "caption"),
    ("stickerMessage", "sticker", None),
    ("contactMessage", "contact", "displayName"),
    ("contactsArrayMessage", "contacts", None),
    ("locationMessage", "location", "name"),
    ("liveLocationMessage", "location", "caption"),
    ("reactionMessage", "reaction", "text"),
    ("pollCreationMessage", "poll", "name"),
    ("pollCreationMessageV3", "poll", "name"),
    ("buttonsResponseMessage", "buttons-response", "selectedDisplayText"),
    ("templateButtonReplyMessage", "template-reply", "selectedDisplayText"),
    ("listResponseMessage", "list-response", "title"),
    ("ephemeralMessage", "ephemeral", None),              # wraps another message
    ("viewOnceMessage", "view-once", None),
    ("viewOnceMessageV2", "view-once", None),
    ("viewOnceMessageV2Extension", "view-once", None),
]
_PROTOCOL_KEYS = {"protocolMessage", "senderKeyDistributionMessage"}


def _extract_text_and_kind(content: dict) -> tuple[str, str, bool]:
    """Return (text, kind, is_protocol).

    `text` is a single human-readable string suitable for display. For media
    without a caption we synthesize `[image]` etc. For protocol/control
    messages we synthesize `[protocol: <type>]` so a reader can still see what
    happened without digging.
    """
    if not isinstance(content, dict):
        return "", "unknown", False

    # Unwrap ephemeral / view-once wrappers — they contain a nested message.
    inner = content
    for wrap_key in ("ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"):
        wrapped = inner.get(wrap_key)
        if isinstance(wrapped, dict):
            nested = wrapped.get("message")
            if isinstance(nested, dict):
                inner = nested
                break

    # Real content first.
    for key, kind, field in _CONTENT_HANDLERS:
        node = inner.get(key)
        if node is None:
            continue
        # Strings (conversation) vs dicts (everything else).
        if isinstance(node, str):
            return node, kind, False
        if isinstance(node, dict):
            text = ""
            if field and isinstance(node.get(field), str):
                text = node[field]
            if not text:
                text = f"[{kind}]"
            return text, kind, False

    # No real-content key. Was it just a protocol/control envelope?
    for k in _PROTOCOL_KEYS:
        if k in inner:
            ptype = None
            pnode = inner.get(k)
            if isinstance(pnode, dict):
                ptype = pnode.get("type") or pnode.get("name")
            return f"[protocol: {ptype or k}]", "protocol", True

    return "[unknown content]", "unknown", False


def _normalize_message(m: dict, *, include_raw: bool = False) -> dict:
    """Flatten a Baileys message envelope into a Claude-friendly shape."""
    content = m.get("content") or {}
    text, kind, is_protocol = _extract_text_and_kind(content)
    out: dict[str, Any] = {
        "messageId": m.get("messageId") or m.get("id"),
        "chatId": m.get("chatId"),
        "fromMe": m.get("fromMe"),
        "fromJid": m.get("fromJid"),
        "timestamp": m.get("timestamp"),
        "kind": kind,
        "isProtocol": is_protocol,
        "text": text,
        "status": m.get("status"),
    }
    quoted = m.get("quotedMessage")
    if isinstance(quoted, dict):
        out["quoted"] = {
            "messageId": quoted.get("messageId") or quoted.get("id"),
            "text": _extract_text_and_kind(quoted.get("content") or {})[0],
        }
    if include_raw:
        out["raw"] = m
    return out


def _normalize_send_response(payload: Any) -> dict:
    """Flatten Baileys' send-response envelope into a Claude-friendly shape.

    Baileys returns `{key:{remoteJid, fromMe, id}, message:{<contentKey>:...},
    messageTimestamp, status}`. We surface the fields Claude actually needs
    to chain follow-up calls (reaction, status check, reply): `messageId`,
    `to`, `fromMe`, `status`, `timestamp`, `kind`, `text`.
    """
    if not isinstance(payload, dict):
        return {"raw": payload}
    key = payload.get("key") or {}
    msg = payload.get("message") or {}
    text, kind, _ = _extract_text_and_kind(msg if isinstance(msg, dict) else {})
    ts = payload.get("messageTimestamp")
    # Baileys gives messageTimestamp as a unix-seconds string sometimes.
    if isinstance(ts, str) and ts.isdigit():
        from datetime import datetime, timezone
        ts = datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
    return {
        "messageId": key.get("id") if isinstance(key, dict) else None,
        "to": key.get("remoteJid") if isinstance(key, dict) else None,
        "fromMe": key.get("fromMe") if isinstance(key, dict) else None,
        "status": payload.get("status"),
        "timestamp": ts,
        "kind": kind,
        "text": text if text else None,
    }


def _display_name_for(
    jid: str,
    contacts_by_jid: dict[str, dict],
    groups_by_jid: dict[str, dict],
    contacts_by_lid: Optional[dict[str, dict]] = None,
) -> str:
    if jid.endswith("@g.us"):
        g = groups_by_jid.get(jid)
        for key in ("name", "subject"):
            v = g.get(key) if g else None
            if isinstance(v, str) and v.strip():
                return v.strip()
        return f"Group {jid}"
    # Baileys v7 routes many 1:1 chats by `@lid` — those won't match
    # contacts_by_jid (keyed by `@s.whatsapp.net`). Fall back to the
    # `metadata.lid` map built from the same contacts payload.
    c = contacts_by_jid.get(jid)
    if c is None and jid.endswith("@lid") and contacts_by_lid:
        c = contacts_by_lid.get(jid)
    if c:
        for k in ("name", "verifiedName", "pushName", "notify"):
            v = c.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    if "@" in jid:
        return jid.split("@", 1)[0]
    return jid


# ---------------------------------------------------------------------------
# Pydantic input models
# ---------------------------------------------------------------------------

_BASE = ConfigDict(str_strip_whitespace=True, extra="forbid")


class SessionOnly(BaseModel):
    model_config = _BASE
    session: Optional[str] = Field(
        default=None,
        description="Session id (e.g. 'mobile-lio'). Falls back to WHATSAPP_DEFAULT_SESSION when omitted.",
    )


class ListChatsInput(SessionOnly):
    limit: int = Field(default=50, ge=1, le=200, description="Max chats to return.")
    offset: int = Field(default=0, ge=0, description="Pagination offset.")


class ListContactsInput(SessionOnly):
    filter: Optional[str] = Field(
        default=None,
        description="Case-insensitive substring matched against contact name/notify/id. Applied client-side after fetch.",
        max_length=200,
    )


class GetMessagesInput(SessionOnly):
    chat_id: str = Field(..., description="Chat JID, e.g. '120363425776303829@g.us' or '4915...@s.whatsapp.net'.", min_length=1)
    limit: int = Field(default=50, ge=1, le=100, description="Max messages (server caps at 100).")
    offset: int = Field(default=0, ge=0, description="Pagination offset for older messages.")
    flatten: bool = Field(default=True, description="If true (default), each message is flattened to {messageId, chatId, fromMe, fromJid, timestamp, kind, isProtocol, text, status}. Set to false to get the raw Baileys envelope.")
    include_protocol: bool = Field(default=False, description="If false (default), drops protocolMessage / history-sync / sender-key-distribution noise so you only see real conversation content.")


class GetChatOverviewInput(SessionOnly):
    top_n: int = Field(default=20, ge=1, le=50, description="How many of the most-recent chats to return.")
    msgs_per_chat: int = Field(default=40, ge=1, le=100, description="Messages to keep per chat in the result.")
    max_messages_scan: int = Field(
        default=300,
        ge=100,
        le=1000,
        description="Total messages to scan to build the chat list. Higher = wider coverage of inactive chats but more requests. The server caps each request at 100 messages, so this becomes ceil(value/100) HTTP calls plus 2 for contacts+groups.",
    )
    include_protocol: bool = Field(
        default=False,
        description="If false (default), drops protocolMessage / history-sync noise from the per-chat message lists, and chats that have ONLY protocol noise are excluded from the result entirely.",
    )


class ContactIdInput(SessionOnly):
    contact_id: str = Field(..., description="Contact JID.", min_length=1)


class MessageIdInput(SessionOnly):
    message_id: str = Field(..., description="WhatsApp message id.", min_length=1)


class SendMessageInput(SessionOnly):
    to: str = Field(..., description="Recipient JID (groups end @g.us; individuals end @s.whatsapp.net). Bare phone numbers and @c.us are auto-normalized.", min_length=1)
    text: str = Field(..., description="Message body. Supports *bold*, _italic_, ~strike~, ```mono```, \\n line breaks, emojis.", min_length=1)


class EditMessageInput(SessionOnly):
    to: str = Field(..., description="Chat JID the original message was sent to.", min_length=1)
    message_id: str = Field(..., description="ID of the previously sent message to edit (from send_message's response or get_messages). Only your own messages, within WhatsApp's ~15-minute edit window.", min_length=1)
    text: str = Field(..., description="Replacement message body.", min_length=1)


class DeleteMessageInput(SessionOnly):
    to: str = Field(..., description="Chat JID the original message was sent to.", min_length=1)
    message_id: str = Field(..., description="ID of the previously sent message to delete for everyone. Only your own messages.", min_length=1)


class SendMediaInput(SessionOnly):
    to: str = Field(..., description="Recipient JID.", min_length=1)
    file_path: str = Field(..., description="Absolute path to a local file (image/doc/audio/video).", min_length=1)
    caption: Optional[str] = Field(default=None, description="Optional caption text.")
    file_name: Optional[str] = Field(default=None, description="Override filename sent to recipient (defaults to basename of file_path).")


class SendLocationInput(SessionOnly):
    to: str = Field(..., description="Recipient JID.", min_length=1)
    latitude: float = Field(..., ge=-90, le=90, description="Latitude in decimal degrees.")
    longitude: float = Field(..., ge=-180, le=180, description="Longitude in decimal degrees.")
    name: Optional[str] = Field(default=None, description="Place name shown on the location card.")
    address: Optional[str] = Field(default=None, description="Address line shown on the location card.")


class SendReactionInput(SessionOnly):
    to: str = Field(..., description="Recipient JID where the target message lives.", min_length=1)
    message_id: str = Field(..., description="Id of the message to react to.", min_length=1)
    emoji: str = Field(..., description="Single emoji character. Use empty string to remove an existing reaction.", max_length=8)


class MarkChatReadInput(SessionOnly):
    chat_id: str = Field(..., description="Chat JID to mark as read.", min_length=1)


# ---------------------------------------------------------------------------
# Read tools
# ---------------------------------------------------------------------------

@mcp.tool(
    name="list_chats",
    annotations={
        "title": "List WhatsApp chats (raw upstream view)",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def list_chats(params: ListChatsInput) -> str:
    """List chats as the upstream API knows them.

    KNOWN ISSUE: the your-domain.com backend currently returns an empty list
    here because it does not persist Baileys' history-sync event. Use
    `get_chat_overview` for the real "what's going on in my chats" view —
    that tool derives chats from recent messages and works regardless.

    Returns JSON list of chat objects (shape varies; expect at least
    `id`/`jid`, `name`, `isGroup`, `unreadCount`, `lastMessageTimestamp`).
    """
    try:
        sid = await _resolve_session(params.session)
        chats = await _request(
            "GET",
            f"/api/chats/{sid}",
            params={"limit": params.limit, "offset": params.offset},
        )
        return _as_json({"count": len(chats) if isinstance(chats, list) else 0, "chats": chats})
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="list_contacts",
    annotations={
        "title": "List WhatsApp contacts",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def list_contacts(params: ListContactsInput) -> str:
    """List contacts known to the session.

    The Baileys API has no server-side search. When `filter` is provided we
    fetch all contacts and apply a case-insensitive substring match against
    name / pushName / notify / verifiedName / id / jid fields before
    returning.

    Returns JSON: { count, contacts: [{ id, jid, name, pushName, ... }] }
    """
    try:
        sid = await _resolve_session(params.session)
        contacts = await _request("GET", f"/api/contacts/{sid}")
        if not isinstance(contacts, list):
            return _as_json({"count": 0, "contacts": contacts})
        if params.filter:
            needle = params.filter.lower()
            def _match(c: dict) -> bool:
                for key in ("name", "notify", "verifiedName", "pushName", "id", "jid", "shortName"):
                    v = c.get(key)
                    if isinstance(v, str) and needle in v.lower():
                        return True
                return False
            contacts = [c for c in contacts if isinstance(c, dict) and _match(c)]
        return _as_json({"count": len(contacts), "contacts": contacts})
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="list_groups",
    annotations={
        "title": "List WhatsApp groups",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def list_groups(params: SessionOnly) -> str:
    """List groups the session participates in (derived from observed messages).

    Returns JSON: { count, groups: [{ jid, name, participants, owner, creation }] }
    """
    try:
        sid = await _resolve_session(params.session)
        groups = await _request("GET", f"/api/groups/{sid}/list-from-messages")
        return _as_json({
            "count": len(groups) if isinstance(groups, list) else 0,
            "groups": groups,
        })
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="get_messages",
    annotations={
        "title": "Get messages for a single chat",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def get_messages(params: GetMessagesInput) -> str:
    """Fetch message history for a single chat, most-recent first.

    Bare phone numbers and `@c.us` JIDs are auto-normalized to
    `@s.whatsapp.net`. The server caps `limit` at 100; pass `offset` to
    walk further back.

    By default messages are flattened to `{messageId, chatId, fromMe,
    fromJid, timestamp, kind, isProtocol, text, status}` and protocol /
    history-sync noise is filtered out. Pass `flatten=false` to get the raw
    envelope or `include_protocol=true` to keep control messages.

    Returns JSON: { chatId, scanned, returned, droppedProtocol, messages }
    """
    try:
        sid = await _resolve_session(params.session)
        chat_id = _normalize_jid(params.chat_id)
        msgs = await _request(
            "GET",
            f"/api/messages/{sid}",
            params={"chatId": chat_id, "limit": params.limit, "offset": params.offset},
        )
        if not isinstance(msgs, list):
            return _as_json({"chatId": chat_id, "scanned": 0, "returned": 0, "messages": msgs})

        scanned = len(msgs)
        if params.flatten:
            normalized = [_normalize_message(m) for m in msgs if isinstance(m, dict)]
            if not params.include_protocol:
                kept = [n for n in normalized if not n.get("isProtocol")]
                dropped = len(normalized) - len(kept)
            else:
                kept = normalized
                dropped = 0
            return _as_json({
                "chatId": chat_id,
                "scanned": scanned,
                "returned": len(kept),
                "droppedProtocol": dropped,
                "messages": kept,
            })

        # Raw passthrough — still optionally drop protocol noise.
        if not params.include_protocol:
            def _is_proto(m: dict) -> bool:
                _, _, p = _extract_text_and_kind(m.get("content") or {})
                return p
            kept_raw = [m for m in msgs if isinstance(m, dict) and not _is_proto(m)]
            dropped = scanned - len(kept_raw)
        else:
            kept_raw = msgs
            dropped = 0
        return _as_json({
            "chatId": chat_id,
            "scanned": scanned,
            "returned": len(kept_raw),
            "droppedProtocol": dropped,
            "messages": kept_raw,
        })
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="get_chat_overview",
    annotations={
        "title": "Recent chats + their messages (derived view)",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def get_chat_overview(params: GetChatOverviewInput) -> str:
    """Composite read for "what's going on in my chats".

    The upstream `/api/chats/{sid}` is unreliable (empty after reconnect
    because the wrapper does not persist Baileys' history-sync event), so
    this tool derives the chat list from recent messages instead. Algorithm:

      1. Fetch contacts and groups in parallel (display-name lookup).
      2. Page through `/api/messages/{sid}` in 100-message chunks until we
         have scanned `max_messages_scan` messages or the API runs dry.
      3. Group messages by `chatId`, sort each group by timestamp descending,
         keep the most recent `msgs_per_chat`.
      4. Sort chats by their most-recent message timestamp descending, keep
         the top `top_n`.

    Cost: ceil(max_messages_scan/100) + 2 HTTP calls. The server rate-limits
    at 100 requests per 15 minute window — keep `max_messages_scan` modest.

    Returns JSON: {
        scannedMessages, distinctChats, generatedAt, chats: [{
            chatId, displayName, isGroup, messageCount, lastMessageTimestamp,
            messages
        }]
    }
    """
    try:
        sid = await _resolve_session(params.session)
        # Parallel fetch of the directory data — independent of messages paging.
        contacts_task = _request("GET", f"/api/contacts/{sid}")
        groups_task = _request("GET", f"/api/groups/{sid}/list-from-messages")
        contacts_raw, groups_raw = await asyncio.gather(
            contacts_task, groups_task, return_exceptions=True
        )
        contacts_list = contacts_raw if isinstance(contacts_raw, list) else []
        groups_list = groups_raw if isinstance(groups_raw, list) else []
        contacts_by_jid = {
            c["jid"]: c
            for c in contacts_list
            if isinstance(c, dict) and isinstance(c.get("jid"), str)
        }
        # Secondary index keyed on the LID identity stored in metadata.lid —
        # WhatsApp's multi-device protocol increasingly uses `@lid` JIDs as
        # chat ids, which don't match the contact's primary `@s.whatsapp.net`
        # jid. This map lets _display_name_for resolve names for those chats.
        contacts_by_lid: dict[str, dict] = {}
        for c in contacts_list:
            if not isinstance(c, dict):
                continue
            meta = c.get("metadata") or {}
            lid = meta.get("lid") if isinstance(meta, dict) else None
            if isinstance(lid, str) and lid:
                contacts_by_lid[lid] = c
        groups_by_jid = {
            g["jid"]: g
            for g in groups_list
            if isinstance(g, dict) and isinstance(g.get("jid"), str)
        }

        # Page through messages.
        page_size = 100
        all_msgs: list[dict] = []
        offset = 0
        while len(all_msgs) < params.max_messages_scan:
            remaining = params.max_messages_scan - len(all_msgs)
            page_limit = min(page_size, remaining)
            page = await _request(
                "GET",
                f"/api/messages/{sid}",
                params={"limit": page_limit, "offset": offset},
            )
            if not isinstance(page, list) or not page:
                break
            all_msgs.extend(m for m in page if isinstance(m, dict))
            offset += len(page)
            if len(page) < page_limit:
                # Server gave us fewer than we asked for → no more data.
                break

        # Normalize first so we can filter/inspect by kind.
        normalized_all = [_normalize_message(m) for m in all_msgs]
        protocol_dropped_total = 0

        # Group by chatId.
        by_chat: dict[str, list[dict]] = {}
        for n in normalized_all:
            cid = n.get("chatId")
            if not isinstance(cid, str):
                continue
            if not params.include_protocol and n.get("isProtocol"):
                protocol_dropped_total += 1
                continue
            by_chat.setdefault(cid, []).append(n)

        # Build per-chat summaries.
        summaries: list[dict] = []
        for cid, msgs in by_chat.items():
            msgs.sort(key=lambda m: str(m.get("timestamp") or ""), reverse=True)
            if not msgs:
                continue
            summaries.append({
                "chatId": cid,
                "displayName": _display_name_for(cid, contacts_by_jid, groups_by_jid, contacts_by_lid),
                "isGroup": cid.endswith("@g.us"),
                "messageCount": len(msgs),
                "lastMessageTimestamp": msgs[0].get("timestamp"),
                "lastMessagePreview": msgs[0].get("text", "")[:140],
                "messages": msgs[: params.msgs_per_chat],
            })

        summaries.sort(
            key=lambda s: str(s.get("lastMessageTimestamp") or ""),
            reverse=True,
        )
        summaries = summaries[: params.top_n]

        from datetime import datetime, timezone
        return _as_json({
            "scannedMessages": len(all_msgs),
            "droppedProtocol": protocol_dropped_total,
            "distinctChats": len(by_chat),
            "returnedChats": len(summaries),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "chats": summaries,
        })
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="get_contact_presence",
    annotations={
        "title": "Get a contact's presence",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def get_contact_presence(params: ContactIdInput) -> str:
    """Get online/typing/last-seen presence for a contact.

    Marked non-idempotent because Baileys may issue a presence-subscribe as
    a side effect of the lookup.
    """
    try:
        sid = await _resolve_session(params.session)
        jid = _normalize_jid(params.contact_id)
        data = await _request("GET", f"/api/contacts/{sid}/{jid}/presence")
        return _as_json(data)
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="get_contact_profile_picture",
    annotations={
        "title": "Get a contact's profile picture",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def get_contact_profile_picture(params: ContactIdInput) -> str:
    """Get the profile picture URL (or data) for a contact."""
    try:
        sid = await _resolve_session(params.session)
        jid = _normalize_jid(params.contact_id)
        data = await _request("GET", f"/api/contacts/{sid}/{jid}/profile-picture")
        return _as_json(data)
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="get_message_status",
    annotations={
        "title": "Get delivery status of a specific message",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def get_message_status(params: MessageIdInput) -> str:
    """Get delivery state and transition timestamps for a message id."""
    try:
        sid = await _resolve_session(params.session)
        data = await _request(
            "GET", f"/api/messages/{sid}/by-id/{params.message_id}/status"
        )
        return _as_json(data)
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="get_session_status",
    annotations={
        "title": "Check WhatsApp session connection status",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def get_session_status(params: SessionOnly) -> str:
    """Check whether the WhatsApp session is connected and ready to send.

    Useful as a pre-flight before queueing important sends.
    """
    try:
        sid = await _resolve_session(params.session)
        data = await _request("GET", f"/api/sessions/{sid}/status")
        return _as_json(data)
    except Exception as e:
        return _format_error(e)


# ---------------------------------------------------------------------------
# Write tools (NOT allowlisted; harness prompts on every call)
# ---------------------------------------------------------------------------

@mcp.tool(
    name="send_message",
    annotations={
        "title": "Send a WhatsApp text message",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def send_message(params: SendMessageInput) -> str:
    """Send a text message to a contact or group.

    Recipient is a JID. For groups use the `@g.us` form. For individuals
    use `@s.whatsapp.net`; bare phone numbers and `@c.us` JIDs are
    auto-normalized. Look up JIDs via `list_contacts` / `list_groups` /
    `get_chat_overview` first.

    WhatsApp formatting:
        *bold*, _italic_, ~strikethrough~, ```monospace```, \\n for newlines.
    """
    try:
        sid = await _resolve_session(params.session)
        to = _normalize_jid(params.to)
        body = {"to": to, "content": {"text": params.text}}
        data = await _request("POST", f"/api/messages/{sid}/send", json_body=body)
        return _as_json(_normalize_send_response(data))
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="edit_message",
    annotations={
        "title": "Edit a sent WhatsApp message",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def edit_message(params: EditMessageInput) -> str:
    """Edit a message you already sent (WhatsApp allows ~15 minutes).

    Pass the chat JID and the message id returned by `send_message`
    (`messageId` field) or found via `get_messages`. Only `fromMe`
    messages can be edited; recipients see the edited text plus
    WhatsApp's "edited" marker.
    """
    try:
        sid = await _resolve_session(params.session)
        to = _normalize_jid(params.to)
        body = {
            "to": to,
            "content": {"text": params.text},
            "options": {"edit": params.message_id},
        }
        data = await _request("POST", f"/api/messages/{sid}/send", json_body=body)
        return _as_json(_normalize_send_response(data))
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="delete_message",
    annotations={
        "title": "Delete a sent WhatsApp message for everyone",
        "readOnlyHint": False,
        "destructiveHint": True,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def delete_message(params: DeleteMessageInput) -> str:
    """Delete a message you sent, for everyone in the chat.

    Pass the chat JID and the message id (from `send_message` /
    `get_messages`). Only `fromMe` messages; recipients see
    "This message was deleted".
    """
    try:
        sid = await _resolve_session(params.session)
        to = _normalize_jid(params.to)
        body = {
            "to": to,
            "content": {},
            "options": {"delete": params.message_id},
        }
        data = await _request("POST", f"/api/messages/{sid}/send", json_body=body)
        return _as_json(_normalize_send_response(data))
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="send_media",
    annotations={
        "title": "Send a WhatsApp media message",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def send_media(params: SendMediaInput) -> str:
    """Send an image/document/audio/video by uploading a local file.

    `file_path` must be absolute. MIME type is auto-detected from the
    filename extension. The file is streamed so large media won't blow up
    memory. `caption` and `file_name` are optional.

    KNOWN UPSTREAM BUG: the your-domain.com server returns HTTP 500 on
    `text/plain` and some other non-media uploads. Images, audio, and
    standard video formats work fine.
    """
    try:
        sid = await _resolve_session(params.session)
        path = Path(params.file_path)
        if not path.is_absolute():
            return f"Error: file_path must be absolute, got {params.file_path!r}"
        if not path.exists():
            return f"Error: file not found: {path}"
        if not path.is_file():
            return f"Error: not a regular file: {path}"

        to = _normalize_jid(params.to)
        fname = params.file_name or path.name
        mime, _ = mimetypes.guess_type(fname)
        if not mime:
            mime = "application/octet-stream"
        form: dict[str, Any] = {"to": to, "fileName": fname}
        if params.caption:
            form["caption"] = params.caption

        with path.open("rb") as fh:
            files = {"file": (fname, fh, mime)}
            data = await _request(
                "POST",
                f"/api/messages/{sid}/send-media",
                data=form,
                files=files,
                timeout=300.0,
            )
        return _as_json(_normalize_send_response(data))
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="send_location",
    annotations={
        "title": "Send a WhatsApp location pin",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def send_location(params: SendLocationInput) -> str:
    """Send a location card with lat/lng and optional name+address."""
    try:
        sid = await _resolve_session(params.session)
        to = _normalize_jid(params.to)
        body: dict[str, Any] = {
            "to": to,
            "latitude": params.latitude,
            "longitude": params.longitude,
        }
        if params.name is not None:
            body["name"] = params.name
        if params.address is not None:
            body["address"] = params.address
        data = await _request(
            "POST", f"/api/messages/{sid}/send-location", json_body=body
        )
        return _as_json(_normalize_send_response(data))
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="send_reaction",
    annotations={
        "title": "Send a reaction emoji to a message",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def send_reaction(params: SendReactionInput) -> str:
    """React to a specific message with an emoji.

    `emoji` is a single emoji character (or short ZWJ sequence). Pass an
    empty string to remove an existing reaction.
    """
    try:
        sid = await _resolve_session(params.session)
        to = _normalize_jid(params.to)
        body = {
            "to": to,
            "messageId": params.message_id,
            "emoji": params.emoji,
        }
        data = await _request(
            "POST", f"/api/messages/{sid}/send-reaction", json_body=body
        )
        return _as_json(_normalize_send_response(data))
    except Exception as e:
        return _format_error(e)


@mcp.tool(
    name="mark_chat_read",
    annotations={
        "title": "Mark a chat as read",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def mark_chat_read(params: MarkChatReadInput) -> str:
    """Mark all unread messages in a chat as read."""
    try:
        sid = await _resolve_session(params.session)
        chat_id = _normalize_jid(params.chat_id)
        data = await _request("POST", f"/api/chats/{sid}/{chat_id}/mark-read")
        return _as_json(data)
    except Exception as e:
        return _format_error(e)


def _run_http() -> None:
    """Hosted mode: streamable HTTP app behind nginx, per-request key auth."""
    import uvicorn
    from starlette.middleware.base import BaseHTTPMiddleware

    class ApiKeyMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            key = request.headers.get("x-api-key", "")
            if not key:
                auth = request.headers.get("authorization", "")
                if auth.lower().startswith("bearer "):
                    key = auth[7:].strip()
            token = _REQUEST_API_KEY.set(key)
            try:
                return await call_next(request)
            finally:
                _REQUEST_API_KEY.reset(token)

    app = mcp.streamable_http_app()
    app.add_middleware(ApiKeyMiddleware)
    uvicorn.run(
        app,
        host=mcp.settings.host,
        port=mcp.settings.port,
        log_level=os.environ.get("MCP_HTTP_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    if HTTP_MODE:
        _run_http()
    else:
        mcp.run()
