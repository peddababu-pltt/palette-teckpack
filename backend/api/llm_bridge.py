"""Loopback bridge that lets the pipeline subprocesses use the platform's ctx.llm.

Every Claude and Gemini call in this plugin lives in a pipeline subprocess
(backend/pipeline/*.py via the `anthropic` SDK, *.mjs via `@google/genai`),
and a subprocess has no PluginContext to call ctx.llm with. Both SDKs do honor
a base-URL env var, though (ANTHROPIC_BASE_URL, GOOGLE_GEMINI_BASE_URL), so on
the hosted platform the route that spawns a job points those at this tiny
HTTP server on 127.0.0.1, which answers in each provider's wire format by
calling ctx.llm with the same model id. The scripts stay untouched, the
provider keys never leave the platform, and no third-party host has to be in
capabilities.external_network.

Under `pltt dev` ctx.llm is the local OpenAI-only stand-in (Claude and Gemini
ids are "hosted only" there), so the bridge stays off and the scripts keep
calling the providers directly with the keys from .palette/.env.local.
TECHPACK_LLM_BRIDGE=1/0 forces it either way.

With PALETTE_API_KEY set, the bridge answers from the Palette LLM gateway
(PALETTE_LLM_BASE_URL, an OpenAI chat-completions API) instead of ctx.llm,
locally and hosted alike, and no Anthropic / Google key is needed at all.
Claude and Gemini Pro ids map to palette-llm-max, Gemini Flash to palette-vlm;
PALETTE_LLM_MODEL forces one seat for every call.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import time
from typing import Any

import requests

# Image-heavy JSON prompts (one image per pattern piece) can take minutes.
_SESSION_TTL_S = 6 * 3600
# Neither SDK sends a max-token default we can see on every call; these match
# what the providers themselves would allow without one.
_GEMINI_DEFAULT_MAX_TOKENS = 8192
_TOKEN_ENV = "TECHPACK_LLM_BRIDGE_TOKEN"

_sessions: dict[str, tuple[Any, float]] = {}
_port: int | None = None


_GATEWAY_DEFAULT_URL = "https://llm.pltt.dev"
# The gateway's seats think before answering and that counts against
# max_tokens; the scripts' 1024-token budgets were sized for plain replies.
_GATEWAY_MIN_TOKENS = 4096
_GATEWAY_TIMEOUT_S = 900


def _gateway_model(model: str | None) -> str:
    forced = os.environ.get("PALETTE_LLM_MODEL")
    if forced:
        return forced
    model = (model or "").lower()
    if model.startswith("palette-"):
        return model
    return "palette-vlm" if "flash" in model else "palette-llm-max"


class PaletteGateway:
    """Stand-in for ctx.llm that calls the Palette LLM gateway with an API key.
    Unlike a request's ctx.llm it isn't request-scoped, so it keeps working for
    the whole background pipeline."""

    def __init__(self, api_key: str, base_url: str | None = None):
        self.api_key = api_key
        self.url = (base_url or _GATEWAY_DEFAULT_URL).rstrip("/").removesuffix("/playground")
        self.url += "/v1/chat/completions"

    def _post(self, payload: dict) -> dict:
        resp = requests.post(
            self.url, json=payload, timeout=_GATEWAY_TIMEOUT_S,
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        if not resp.ok:
            raise RuntimeError(f"Palette gateway HTTP {resp.status_code}: {resp.text[:500]}")
        return resp.json()

    async def chat(self, messages: list[dict], *, model=None, system=None, max_tokens=1024,
                   temperature=None, response_format=None, fallback=False) -> dict:
        payload: dict[str, Any] = {
            "model": _gateway_model(model),
            "messages": ([{"role": "system", "content": system}] if system else []) + messages,
            "max_tokens": max(int(max_tokens or 0), _GATEWAY_MIN_TOKENS),
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if response_format:
            payload["response_format"] = response_format
        if os.environ.get("PALETTE_LLM_EFFORT"):
            payload["reasoning_effort"] = os.environ["PALETTE_LLM_EFFORT"]
        data = await asyncio.to_thread(self._post, payload)
        choice = (data.get("choices") or [{}])[0]
        usage = data.get("usage") or {}
        return {
            "text": (choice.get("message") or {}).get("content") or "",
            "model": data.get("model") or payload["model"],
            "stop_reason": choice.get("finish_reason"),
            "input_tokens": usage.get("prompt_tokens"),
            "output_tokens": usage.get("completion_tokens"),
        }


def gateway_from(env: dict) -> PaletteGateway | None:
    key = env.get("TECHPACK_LLM_API_KEY") or env.get("PALETTE_API_KEY")
    url = env.get("TECHPACK_LLM_BASE_URL") or env.get("PALETTE_LLM_BASE_URL")
    return PaletteGateway(key, url) if key else None


def enabled(ctx) -> bool:
    forced = os.environ.get("TECHPACK_LLM_BRIDGE")
    if forced in ("0", "1"):
        return forced == "1"
    return type(ctx.llm).__name__ not in ("LocalLLMService", "UnavailablePlatformService")


def _ensure_server() -> int:
    """Bind synchronously (so the port is known right now) and let the event
    loop start serving on its next tick; connections that arrive before that
    just wait in the listen backlog."""
    global _port
    if _port is None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        sock.listen(64)
        sock.setblocking(False)
        asyncio.get_running_loop().create_task(asyncio.start_server(_handle, sock=sock))
        _port = sock.getsockname()[1]
    return _port


def env_for(ctx, llm: Any = None) -> dict[str, str]:
    """Env overrides for one job's subprocesses; {} when the bridge is off.
    `llm` (e.g. a PaletteGateway) answers instead of ctx.llm and turns the
    bridge on regardless of `enabled()`."""
    if llm is None and not enabled(ctx):
        return {}
    port = _ensure_server()
    now = time.monotonic()
    for token, (_, born) in list(_sessions.items()):
        if now - born > _SESSION_TTL_S:
            _sessions.pop(token, None)
    token = secrets.token_urlsafe(24)
    _sessions[token] = (llm or ctx.llm, now)
    base = f"http://127.0.0.1:{port}"
    return {
        _TOKEN_ENV: token,
        "ANTHROPIC_BASE_URL": f"{base}/a/{token}",
        "GOOGLE_GEMINI_BASE_URL": f"{base}/g/{token}",
        # The scripts check a key is present before calling; the bridge ignores it.
        "ANTHROPIC_API_KEY": "palette-platform",
        "GOOGLE_AI_API_KEY": "palette-platform",
        "GEMINI_API_KEY": "palette-platform",
    }


def release(env: dict | None) -> None:
    if env and env.get(_TOKEN_ENV):
        _sessions.pop(env[_TOKEN_ENV], None)


# ---------------------------------------------------------------- translation

def _data_url(mime: str, data: str) -> dict:
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}}


def _anthropic_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    return "".join(b.get("text", "") for b in value or [] if isinstance(b, dict) and b.get("type") == "text")


def anthropic_to_chat(body: dict) -> tuple[list[dict], dict]:
    messages = []
    for m in body.get("messages") or []:
        content = m.get("content")
        if isinstance(content, str):
            parts: Any = content
        else:
            parts = []
            for block in content or []:
                kind = block.get("type")
                if kind == "text":
                    parts.append({"type": "text", "text": block.get("text", "")})
                elif kind == "image" and (block.get("source") or {}).get("type") == "base64":
                    src = block["source"]
                    parts.append(_data_url(src.get("media_type", "image/png"), src.get("data", "")))
                else:
                    raise ValueError(f"unsupported Anthropic content block: {kind!r}")
        messages.append({"role": "assistant" if m.get("role") == "assistant" else "user", "content": parts})
    opts = {
        "model": body.get("model"),
        "system": _anthropic_text(body.get("system")) or None,
        "max_tokens": int(body.get("max_tokens") or 1024),
        "temperature": float(body.get("temperature", 1.0)),
    }
    return messages, opts


_ANTHROPIC_STOP = {
    "length": "max_tokens", "tool_calls": "tool_use", "content_filter": "refusal", "stop": "end_turn",
}


def chat_to_anthropic(reply: dict) -> dict:
    return {
        "id": f"msg_bridge_{secrets.token_hex(8)}",
        "type": "message",
        "role": "assistant",
        "model": reply.get("model"),
        "content": [{"type": "text", "text": reply.get("text") or ""}],
        "stop_reason": _ANTHROPIC_STOP.get(reply.get("stop_reason"), "end_turn"),
        "stop_sequence": None,
        "usage": {
            "input_tokens": int(reply.get("input_tokens") or 0),
            "output_tokens": int(reply.get("output_tokens") or 0),
        },
    }


def _gemini_parts(parts: list) -> list[dict]:
    out = []
    for p in parts or []:
        inline = p.get("inlineData") or p.get("inline_data")
        if "text" in p:
            out.append({"type": "text", "text": p["text"]})
        elif inline:
            mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
            out.append(_data_url(mime, inline.get("data", "")))
        else:
            raise ValueError(f"unsupported Gemini part: {sorted(p)}")
    return out


def gemini_to_chat(model: str, body: dict) -> tuple[list[dict], dict]:
    messages = [
        {"role": "assistant" if c.get("role") == "model" else "user", "content": _gemini_parts(c.get("parts"))}
        for c in body.get("contents") or []
    ]
    sys_inst = body.get("systemInstruction") or body.get("system_instruction")
    system = None
    if isinstance(sys_inst, dict):
        system = "".join(p.get("text", "") for p in sys_inst.get("parts") or [])
    elif sys_inst:
        system = str(sys_inst)
    cfg = body.get("generationConfig") or body.get("generation_config") or {}
    opts: dict[str, Any] = {
        "model": model.removeprefix("models/"),
        "system": system,
        "max_tokens": int(
            cfg.get("maxOutputTokens") or cfg.get("max_output_tokens") or _GEMINI_DEFAULT_MAX_TOKENS
        ),
        "temperature": float(cfg.get("temperature", 1.0)),
    }
    if (cfg.get("responseMimeType") or cfg.get("response_mime_type")) == "application/json":
        opts["response_format"] = {"type": "json_object"}
    return messages, opts


_GEMINI_STOP = {"length": "MAX_TOKENS", "content_filter": "SAFETY", "stop": "STOP"}


def chat_to_gemini(reply: dict) -> dict:
    inp, out = int(reply.get("input_tokens") or 0), int(reply.get("output_tokens") or 0)
    return {
        "candidates": [{
            "content": {"role": "model", "parts": [{"text": reply.get("text") or ""}]},
            "finishReason": _GEMINI_STOP.get(reply.get("stop_reason"), "STOP"),
            "index": 0,
        }],
        "usageMetadata": {"promptTokenCount": inp, "candidatesTokenCount": out, "totalTokenCount": inp + out},
        "modelVersion": reply.get("model"),
    }


# ---------------------------------------------------------------- HTTP

def _is_platform_refusal(exc: Exception) -> bool:
    # palette_sdk registers PlatformServiceUnavailable/ModelUnavailable under a
    # shared module, so match on the class hierarchy by name.
    return any(c.__name__ == "PlatformServiceUnavailable" for c in type(exc).__mro__)


def _error(provider: str, status: int, message: str) -> dict:
    if provider == "a":
        kind = "invalid_request_error" if status < 500 else "api_error"
        return {"type": "error", "error": {"type": kind, "message": message}}
    code = "FAILED_PRECONDITION" if status < 500 else "INTERNAL"
    return {"error": {"code": status, "message": message, "status": code}}


async def dispatch(method: str, path: str, body: bytes) -> tuple[int, dict]:
    """Route one bridge request. Kept free of socket code so it can be tested."""
    parts = path.split("?", 1)[0].strip("/").split("/")
    provider = parts[0] if parts else ""
    if method != "POST" or len(parts) < 3 or provider not in ("a", "g"):
        return 404, _error(provider or "a", 404, f"no bridge route for {method} {path}")
    session = _sessions.get(parts[1])
    if session is None:
        return 401, _error(provider, 401, "unknown or expired bridge session")
    llm = session[0]
    try:
        req = json.loads(body or b"{}")
        if provider == "a":
            if parts[2:] != ["v1", "messages"]:
                return 404, _error("a", 404, f"unsupported Anthropic endpoint /{'/'.join(parts[2:])}")
            messages, opts = anthropic_to_chat(req)
        else:
            tail = "/".join(parts[2:])  # e.g. v1beta/models/gemini-2.5-pro:generateContent
            model_part = tail.split("/models/", 1)[-1] if "/models/" in tail else ""
            if not model_part.endswith(":generateContent"):
                return 404, _error("g", 404, f"unsupported Gemini endpoint /{tail}")
            messages, opts = gemini_to_chat(model_part.removesuffix(":generateContent"), req)
    except (ValueError, TypeError) as exc:
        return 400, _error(provider, 400, f"bridge could not translate the request: {exc}")
    try:
        try:
            reply = await llm.chat(messages, fallback=False, **opts)
        except Exception as exc:
            # The exact model first; when the platform won't run it (a workspace
            # security policy that pins one model -- "this workspace's security
            # policy runs gpt-5.5; 'claude-sonnet-4-6' was not run" -- or a
            # provider the platform has no key for), let it substitute the model
            # it will run rather than failing the whole pipeline step. Budget
            # refusals are not retried: a substitute would be refused the same.
            if not _is_platform_refusal(exc) or getattr(exc, "reason", None) == "billing_disabled":
                raise
            reply = await llm.chat(messages, fallback=True, **opts)
    except Exception as exc:
        status = 400 if _is_platform_refusal(exc) else 502
        return status, _error(provider, status, f"Palette ctx.llm: {exc}")
    return 200, chat_to_anthropic(reply) if provider == "a" else chat_to_gemini(reply)


async def _read_request(reader: asyncio.StreamReader) -> tuple[str, str, bytes]:
    request_line = (await reader.readline()).decode("latin-1").strip()
    method, path, _ = (request_line.split(" ", 2) + ["", ""])[:3]
    headers: dict[str, str] = {}
    while True:
        line = (await reader.readline()).decode("latin-1")
        if line in ("\r\n", "\n", ""):
            break
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    if headers.get("transfer-encoding", "").lower() == "chunked":
        chunks = []
        while True:
            size = int((await reader.readline()).split(b";")[0].strip() or b"0", 16)
            if size == 0:
                await reader.readline()
                break
            chunks.append(await reader.readexactly(size))
            await reader.readline()
        body = b"".join(chunks)
    else:
        body = await reader.readexactly(int(headers.get("content-length") or 0))
    return method, path, body


async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        method, path, body = await _read_request(reader)
        status, payload = await dispatch(method, path, body)
    except Exception as exc:  # malformed HTTP -- answer rather than hang the client
        status, payload = 400, _error("a", 400, f"bad bridge request: {exc}")
    data = json.dumps(payload).encode()
    reason = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found"}.get(status, "Error")
    writer.write(
        f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n"
        f"Content-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode() + data
    )
    try:
        await writer.drain()
    finally:
        writer.close()
