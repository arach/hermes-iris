"""Read redacted Hermes logs for the Iris visualizer.

The router is mounted at /api/plugins/iris/. Never reads credential stores,
state.db, or private Hermes objects. GET /live returns ``{cursor, events,
sessions}`` for events newer than an ISO-8601 or epoch cursor. Sessions come
from ``hermes sessions export --redact`` (subprocess, timeout), not from the
database file.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()

_MAX_BYTES = 1_500_000
_MAX_EVENTS = 2000
_LIVE_WINDOW_S = 2 * 60 * 60
_LIVE_MAX_EVENTS = 800
_SESSION_WINDOW = "3h"
_SESSION_TTL_S = 12.0
_EXPORT_TIMEOUT_S = 8.0
_EXPORT_MAX_CHARS = 6_000_000
_SESSION_CAP = 24
_MESSAGE_CAP = 120
_DELEGATE_TOOLS = {"delegate_task", "delegate", "spawn_agent", "spawn_subagent"}
_session_lock = threading.Lock()
_session_cache: dict = {"at": 0.0, "sessions": [], "events": []}
_SAMPLE_PATH = Path(__file__).resolve().parent / "sample-events.json"
_LINE = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2}) (?P<clock>\d{2}:\d{2}:\d{2}),(?P<ms>\d{3}) "
    r"(?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL)"
    r"(?: \[(?P<session>[^\]]+)\])? "
    r"(?P<logger>[A-Za-z0-9_.-]+): (?P<message>.*)$"
)
_TOOL_DONE = re.compile(r"\btool\s+([A-Za-z0-9_.-]+)\s+completed\b", re.IGNORECASE)
_SECRET_RES = (
    re.compile(r"(?i)\b(?:sk|rk|pk|ak)-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{8,}"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-+/=]{8,}"),
    re.compile(r"(?i)\b(?:api[_-]?key|secret|token|password|authorization)\s*[=:]\s*\S+"),
    re.compile(r"(?i)\bOPENCODE_[A-Z0-9_]*KEY\s*=\s*\S+"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
)
_DENIED_NAME_PARTS = (
    "auth.json",
    "credentials",
    "secret",
    ".env",
    "id_rsa",
    ".netrc",
    ".pgpass",
    ".npmrc",
    ".pypirc",
)

try:
    from zoneinfo import ZoneInfo

    _TZ = ZoneInfo("America/Toronto")
except Exception:  # pragma: no cover - tzdata missing
    _TZ = datetime.now().astimezone().tzinfo


def _load_sample() -> dict:
    try:
        data = json.loads(_SAMPLE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


_SAMPLE_DOC = _load_sample()


def _redact_text(value: str) -> str:
    out = value
    for pattern in _SECRET_RES:
        out = pattern.sub("[REDACTED]", out)
    return out


def _redact(value):
    if isinstance(value, str):
        return _redact_text(value)
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, dict):
        return {key: _redact(item) for key, item in value.items()}
    return value


def _logs_dir() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes") / "logs"


def _is_log_file(path: Path) -> bool:
    if path.is_symlink() or not path.is_file():
        return False
    if path.suffix.lower() != ".log":
        return False
    name = path.name.lower()
    return not any(part in name for part in _DENIED_NAME_PARTS)


def _read_tail(path: Path) -> str:
    size = path.stat().st_size
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        if size > _MAX_BYTES:
            handle.seek(max(0, size - _MAX_BYTES))
            handle.readline()
        return handle.read()


def _parse_ts(date: str, clock: str, ms: str) -> tuple[float, str]:
    stamp = datetime.strptime(f"{date} {clock}", "%Y-%m-%d %H:%M:%S").replace(
        tzinfo=_TZ,
        microsecond=int(ms) * 1000,
    )
    return stamp.timestamp(), stamp.isoformat(timespec="milliseconds")


def _component(logger: str) -> str:
    head = logger.split(".", 1)[0]
    return {
        "agent": "agent",
        "tools": "tools",
        "hermes_cli": "cli",
        "cli": "cli",
        "gateway": "gateway",
        "gui": "gui",
        "desktop": "gui",
        "cron": "cron",
    }.get(head, "other")


def _kind(level: str, logger: str, message: str) -> str:
    upper = level.upper()
    text = message.lower()
    if upper in {"ERROR", "CRITICAL"}:
        return "error"
    if upper == "WARNING":
        return "warning"
    if "api call" in text:
        return "api_call"
    if _TOOL_DONE.search(message):
        return "tool_result"
    if "tool call" in text or "executing tool" in text:
        return "tool_call"
    if "turn start" in text or text.startswith("starting turn"):
        return "turn_start"
    if "turn end" in text or "turn complete" in text or "finished turn" in text:
        return "turn_end"
    if logger.startswith("hermes_cli.plugin") or text.startswith("plugin "):
        return "plugin"
    if "inbound" in text:
        return "inbound"
    if text.startswith("response") or " sent response" in text:
        return "response"
    return "log"


def _tool_name(message: str) -> str | None:
    match = _TOOL_DONE.search(message)
    if match:
        return match.group(1)
    return None


def parse_log_line(line: str) -> dict | None:
    """Parse one Hermes file-log line. Return None when the line does not match."""
    match = _LINE.match(line.rstrip("\n"))
    if match is None:
        return None
    ts_unix, ts_iso = _parse_ts(match.group("date"), match.group("clock"), match.group("ms"))
    logger = match.group("logger")
    message = _redact_text(match.group("message"))
    if len(message) > 2000:
        message = message[:2000] + "..."
    level = match.group("level")
    session = match.group("session")
    return {
        "ts": f"{match.group('date')} {match.group('clock')},{match.group('ms')}",
        "ts_iso": ts_iso,
        "ts_unix": ts_unix,
        "level": level,
        "session_id": session or None,
        "logger": logger,
        "component": _component(logger),
        "message": message,
        "kind": _kind(level, logger, message),
        "tool_name": _tool_name(message),
    }


def _event_from_log(record: dict) -> dict:
    message = record.get("message") or ""
    title = message if len(message) <= 140 else message[:137] + "..."
    tool = record.get("tool_name")
    return {
        "ts_unix": record["ts_unix"],
        "ts_iso": record.get("ts_iso") or "",
        "kind": record.get("kind") or "log",
        "session_id": record.get("session_id"),
        "level": record.get("level") or "INFO",
        "title": title or record.get("kind") or "log",
        "detail": message[:2000],
        "tool_name": tool,
        "source": "log",
        "file": record.get("file"),
        "logger": record.get("logger"),
        "component": record.get("component"),
    }


def _stats(events: list[dict], sessions: list, logs: list[dict]) -> dict:
    levels: dict[str, int] = {}
    kinds: dict[str, int] = {}
    for event in events:
        level = str(event.get("level") or "INFO")
        kind = str(event.get("kind") or "log")
        levels[level] = levels.get(level, 0) + 1
        kinds[kind] = kinds.get(kind, 0) + 1
    messages = 0
    for session in sessions:
        if isinstance(session, dict):
            messages += len(session.get("messages") or [])
    return {
        "sessions": len(sessions),
        "messages": messages,
        "tool_calls": sum(1 for event in events if event.get("kind") == "tool_call"),
        "log_lines": len(logs),
        "events": len(events),
        "levels": levels,
        "kinds": kinds,
    }


def _read_logs(logs_dir: Path) -> tuple[list[dict], int, int]:
    if not logs_dir.is_dir():
        raise OSError("logs directory missing")
    records: list[dict] = []
    files_read = 0
    skipped = 0
    for path in sorted(logs_dir.iterdir()):
        if not _is_log_file(path):
            continue
        try:
            text = _read_tail(path)
        except OSError:
            skipped += 1
            continue
        files_read += 1
        for line in text.splitlines():
            parsed = parse_log_line(line)
            if parsed is None:
                continue
            parsed["file"] = path.name
            records.append(parsed)
    records.sort(key=lambda item: item["ts_unix"])
    return records, files_read, skipped


def _empty_document(note: str, mode: str) -> dict:
    now = datetime.now(_TZ).isoformat(timespec="seconds")
    return {
        "format": "hermes-logviz-events",
        "version": 1,
        "generated_at": now,
        "timezone": "America/Toronto",
        "source": {"mode": mode, "note": note},
        "stats": _stats([], [], []),
        "sessions": [],
        "logs": [],
        "events": [],
    }


def _sample_payload(note: str) -> dict:
    if not _SAMPLE_DOC:
        return _empty_document(note or "Bundled sample is missing.", "sample")
    data = json.loads(json.dumps(_SAMPLE_DOC))
    source = data.get("source")
    source = dict(source) if isinstance(source, dict) else {}
    source["mode"] = "sample"
    source["note"] = note
    data["source"] = source
    return _redact(data)


def _live_payload() -> dict:
    logs_dir = _logs_dir()
    logs, files_read, skipped = _read_logs(logs_dir)
    read_count = len(logs)
    events = [_event_from_log(record) for record in logs]
    truncated = False
    if len(events) > _MAX_EVENTS:
        events = events[-_MAX_EVENTS:]
        logs = logs[-_MAX_EVENTS:]
        truncated = True
    for index, event in enumerate(events, start=1):
        event["id"] = f"L{index}"
    note = f"Read {read_count} log records from {files_read} file(s) under ~/.hermes/logs."
    if truncated:
        note += f" Showing the latest {_MAX_EVENTS}."
    if skipped:
        note += f" Skipped {skipped} unreadable file(s)."
    now = datetime.now(_TZ).isoformat(timespec="seconds")
    files = sorted({str(record.get("file")) for record in logs if record.get("file")})
    payload = {
        "format": "hermes-logviz-events",
        "version": 1,
        "generated_at": now,
        "timezone": "America/Toronto",
        "source": {"mode": "live", "note": note, "logs_dir": "~/.hermes/logs"},
        "logging": {"files": files},
        "stats": _stats(events, [], logs),
        "sessions": [],
        "logs": logs,
        "events": events,
    }
    return _redact(payload)


def _normalize_source(source: str) -> str:
    value = (source or "auto").strip().lower()
    if value not in {"auto", "live", "sample"}:
        return "auto"
    return value


def _parse_since(value: str | None) -> float | None:
    """Accept epoch seconds or an ISO-8601 timestamp. None when absent or unusable."""
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        ts = float(text)
    except ValueError:
        ts = None
    else:
        if ts != ts or ts in {float("inf"), float("-inf")}:
            return None
        return ts
    try:
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=_TZ)
    return stamp.timestamp()


def _iso_from_unix(ts: float | None) -> str:
    if not isinstance(ts, (int, float)):
        return ""
    return datetime.fromtimestamp(ts, _TZ).isoformat(timespec="milliseconds")


def _as_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def _clip(value, limit: int) -> str:
    text = _redact_text(_text(value))
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _looks_failed(text: str) -> bool:
    if not text:
        return False
    if re.search(r"returned error", text, re.IGNORECASE):
        return True
    if re.search(r'"status"\s*:\s*"error"', text, re.IGNORECASE):
        return True
    if re.search(r'"success"\s*:\s*false', text):
        return True
    if re.search(r'"exit_code"\s*:\s*(?!0\b)-?\d+', text):
        return True
    for match in re.finditer(r'"error"\s*:\s*', text):
        rest = text[match.end() :].lstrip()
        if rest.startswith("null") or rest.startswith('""'):
            continue
        if rest.startswith(('"', "{", "[")) or rest[:1].isdigit() or rest.startswith("-"):
            return True
    return False


def _tool_call_name(call: dict) -> str:
    function = call.get("function")
    function = function if isinstance(function, dict) else {}
    name = call.get("name") or function.get("name") or call.get("tool_name") or ""
    return str(name)


def _tool_call_id(call: dict) -> str | None:
    for key in ("id", "tool_call_id", "call_id"):
        value = call.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _is_delegate(name: str) -> bool:
    lowered = (name or "").lower()
    return lowered in _DELEGATE_TOOLS or lowered.startswith("delegate")


def _round_ts(ts: float) -> float:
    return round(float(ts), 6)


def _export_raw_sessions() -> list[dict] | None:
    """Recent sessions via the public CLI. None when the command cannot be used."""
    binary = shutil.which("hermes")
    if not binary:
        return None
    command = [
        binary,
        "sessions",
        "export",
        "--redact",
        "--yes",
        "--format",
        "jsonl",
        "--newer-than",
        _SESSION_WINDOW,
        "-",
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=_EXPORT_TIMEOUT_S,
            check=False,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0 and not completed.stdout:
        return None
    raws: list[dict] = []
    stdout = completed.stdout or ""
    if len(stdout) > _EXPORT_MAX_CHARS:
        stdout = stdout[:_EXPORT_MAX_CHARS]
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and item.get("id"):
            raws.append(item)
    return raws


def _slim_message(message: dict) -> dict:
    calls = []
    for call in message.get("tool_calls") or []:
        if not isinstance(call, dict):
            continue
        function = call.get("function")
        function = function if isinstance(function, dict) else {}
        arguments = function.get("arguments")
        if arguments is None:
            arguments = call.get("arguments")
        calls.append(
            {
                "id": _tool_call_id(call),
                "type": call.get("type") or "function",
                "name": _tool_call_name(call),
                "arguments": _clip(arguments, 240),
            }
        )
    timestamp = message.get("timestamp")
    return {
        "id": message.get("id"),
        "role": message.get("role"),
        "content": _clip(message.get("content"), 480),
        "tool_name": message.get("tool_name"),
        "tool_call_id": message.get("tool_call_id"),
        "tool_calls": calls or None,
        "timestamp": timestamp if isinstance(timestamp, (int, float)) else None,
        "timestamp_iso": message.get("timestamp_iso") or _iso_from_unix(timestamp),
        "finish_reason": message.get("finish_reason"),
    }


def _slim_session(raw: dict, children: list[str]) -> dict:
    raw_messages = [item for item in (raw.get("messages") or []) if isinstance(item, dict)]
    messages = [
        item
        for item in raw_messages
        if item.get("role") != "system" and item.get("active") is not False
    ]
    if not messages:
        messages = [item for item in raw_messages if item.get("role") != "system"]
    messages.sort(key=lambda item: item.get("timestamp") or 0)
    slim_messages = [_slim_message(item) for item in messages[-_MESSAGE_CAP:]]
    started = raw.get("started_at")
    ended = raw.get("ended_at")
    started = started if isinstance(started, (int, float)) else None
    ended = ended if isinstance(ended, (int, float)) else None
    return {
        "id": str(raw.get("id")),
        "source": raw.get("source"),
        "model": raw.get("model"),
        "provider": raw.get("provider") or raw.get("billing_provider"),
        "cwd": raw.get("cwd"),
        "parent_session_id": raw.get("parent_session_id") or None,
        "child_session_ids": children,
        "started_at": started,
        "started_at_iso": _iso_from_unix(started),
        "ended_at": ended,
        "ended_at_iso": _iso_from_unix(ended),
        "end_reason": raw.get("end_reason"),
        "message_count": _as_int(raw.get("message_count")) or len(slim_messages),
        "tool_call_count": _as_int(raw.get("tool_call_count")),
        "api_call_count": _as_int(raw.get("api_call_count")),
        "input_tokens": _as_int(raw.get("input_tokens")),
        "output_tokens": _as_int(raw.get("output_tokens")),
        "title": raw.get("title"),
        "messages": slim_messages,
    }


def _session_event(
    session: dict,
    kind: str,
    ts: float | None,
    title: str,
    detail: str,
    tool_name: str | None = None,
    tool_call_id: str | None = None,
    level: str = "INFO",
) -> dict | None:
    if not isinstance(ts, (int, float)):
        return None
    event = {
        "id": "",
        "ts_unix": float(ts),
        "ts_iso": _iso_from_unix(float(ts)),
        "kind": kind,
        "session_id": session.get("id"),
        "level": level,
        "title": _clip(title, 140),
        "detail": _clip(detail, 480),
        "tool_name": tool_name,
        "source": "session",
        "file": None,
    }
    parent = session.get("parent_session_id")
    if parent:
        event["parent_session_id"] = parent
    if tool_call_id:
        event["tool_call_id"] = tool_call_id
    return event


def _events_from_session(session: dict) -> list[dict]:
    events: list[dict] = []

    def add(event: dict | None, suffix: str) -> None:
        if event is None:
            return
        event["id"] = f"ses-{session.get('id')}-{suffix}"
        events.append(event)

    model = session.get("model") or "agent"
    source = session.get("source") or "session"
    parent = session.get("parent_session_id") or ""
    add(
        _session_event(
            session,
            "session_start",
            session.get("started_at"),
            f"Session started ({model} / {source})",
            f"cwd={session.get('cwd') or ''} parent={parent}",
        ),
        "start",
    )
    for message in session.get("messages") or []:
        if not isinstance(message, dict):
            continue
        role = message.get("role") or "message"
        timestamp = message.get("timestamp")
        message_id = message.get("id")
        suffix = f"m{message_id}" if message_id is not None else f"t{timestamp}"
        calls = message.get("tool_calls") or []
        if calls:
            for index, call in enumerate(calls):
                if not isinstance(call, dict):
                    continue
                name = call.get("name") or "tool"
                kind = "delegate" if _is_delegate(name) else "tool_call"
                title = name if kind == "delegate" else f"tool_call:{name}"
                add(
                    _session_event(
                        session,
                        kind,
                        timestamp,
                        title,
                        call.get("arguments") or "",
                        name,
                        call.get("id"),
                    ),
                    f"{suffix}-c{index}",
                )
            continue
        if role == "tool":
            name = message.get("tool_name") or "tool"
            detail = message.get("content") or ""
            kind = "delegate" if _is_delegate(name) else "tool_result"
            title = f"{name} result" if kind == "delegate" else f"tool_result:{name}"
            level = "WARNING" if _looks_failed(detail) else "INFO"
            add(
                _session_event(
                    session,
                    kind,
                    timestamp,
                    title,
                    detail,
                    name,
                    message.get("tool_call_id"),
                    level,
                ),
                f"{suffix}-r",
            )
            continue
        if role in {"user", "assistant"}:
            add(
                _session_event(session, role, timestamp, role, message.get("content") or ""),
                suffix,
            )
    add(
        _session_event(
            session,
            "session_end",
            session.get("ended_at"),
            f"Session ended ({session.get('end_reason') or 'end'})",
            "",
        ),
        "end",
    )
    return events


def _load_recent_sessions() -> tuple[list[dict], list[dict]] | None:
    raws = _export_raw_sessions()
    if raws is None:
        return None

    def activity(raw: dict) -> float:
        for key in ("last_activity_at", "ended_at", "started_at"):
            value = raw.get(key)
            if isinstance(value, (int, float)):
                return float(value)
        return 0.0

    raws.sort(key=activity, reverse=True)
    raws = raws[:_SESSION_CAP]
    children: dict[str, list[str]] = {}
    for raw in raws:
        parent = raw.get("parent_session_id")
        session_id = raw.get("id")
        if parent and session_id:
            children.setdefault(str(parent), []).append(str(session_id))
    sessions = [
        _slim_session(raw, children.get(str(raw.get("id")), []))
        for raw in raws
        if raw.get("id")
    ]
    sessions.sort(key=lambda item: item.get("started_at") or 0)
    events: list[dict] = []
    for session in sessions:
        events.extend(_events_from_session(session))
    return sessions, events


def _cached_sessions() -> tuple[list[dict], list[dict]]:
    now = time.monotonic()
    with _session_lock:
        if now - float(_session_cache["at"]) < _SESSION_TTL_S:
            return list(_session_cache["sessions"]), list(_session_cache["events"])
    loaded = _load_recent_sessions()
    with _session_lock:
        _session_cache["at"] = time.monotonic()
        if loaded is not None:
            _session_cache["sessions"] = loaded[0]
            _session_cache["events"] = loaded[1]
        return list(_session_cache["sessions"]), list(_session_cache["events"])


def _log_events() -> list[dict]:
    try:
        logs, _, _ = _read_logs(_logs_dir())
    except OSError:
        return []
    events = []
    for record in logs:
        event = _event_from_log(record)
        digest = hashlib.sha1(
            "|".join(
                [
                    str(record.get("file") or ""),
                    str(record.get("ts_unix") or ""),
                    str(record.get("level") or ""),
                    str(record.get("message") or "")[:180],
                ]
            ).encode("utf-8", "replace")
        ).hexdigest()[:16]
        event["id"] = f"log-{digest}"
        tool = str(event.get("tool_name") or "")
        message = str(record.get("message") or "")
        if _is_delegate(tool) or "delegate_task" in message:
            if event.get("kind") in {"tool_call", "tool_result", "log"}:
                event["kind"] = "delegate"
        events.append(event)
    return events


def _cap_live_events(events: list[dict]) -> list[dict]:
    """Keep session structure when the log tail is noisy.

    Half the budget is reserved for session-derived events. Leftover room
    goes to the newest log lines.
    """
    if len(events) <= _LIVE_MAX_EVENTS:
        return events
    session_events = [event for event in events if event.get("source") == "session"]
    log_events = [event for event in events if event.get("source") != "session"]
    session_budget = min(len(session_events), _LIVE_MAX_EVENTS // 2)
    log_budget = _LIVE_MAX_EVENTS - session_budget
    kept = session_events[-session_budget:] + log_events[-log_budget:]
    kept.sort(key=lambda item: (item.get("ts_unix") or 0, str(item.get("id") or "")))
    return kept


def _live_snapshot(since: str | None) -> dict:
    """New events since ``since``, plus the current recent-session snapshot."""
    since_ts = _parse_since(since)
    sessions, session_events = _cached_sessions()
    parents = {
        str(session.get("id")): session.get("parent_session_id")
        for session in sessions
        if session.get("id") and session.get("parent_session_id")
    }
    combined = list(session_events)
    for event in _log_events():
        parent = parents.get(str(event.get("session_id") or ""))
        if parent and "parent_session_id" not in event:
            event["parent_session_id"] = parent
        combined.append(event)
    combined.sort(key=lambda item: (item.get("ts_unix") or 0, str(item.get("id") or "")))
    if since_ts is None:
        floor = time.time() - _LIVE_WINDOW_S
        chosen = [event for event in combined if (event.get("ts_unix") or 0) >= floor]
    else:
        since_rounded = _round_ts(since_ts)
        chosen = [
            event
            for event in combined
            if _round_ts(event.get("ts_unix") or 0) > since_rounded
        ]
    chosen = _cap_live_events(chosen)
    if chosen:
        cursor_ts = max(_round_ts(event.get("ts_unix") or 0) for event in chosen)
    elif since_ts is not None:
        cursor_ts = _round_ts(since_ts)
    else:
        cursor_ts = _round_ts(time.time())
    payload = {
        "cursor": f"{cursor_ts:.6f}",
        "events": chosen,
        "sessions": sessions,
    }
    return _redact(payload)


@router.get("/health")
async def health() -> dict:
    logs_dir = _logs_dir()
    readable = False
    log_files = 0
    note = "ready"
    try:
        if logs_dir.is_dir():
            readable = os.access(logs_dir, os.R_OK)
            if readable:
                log_files = sum(1 for path in logs_dir.iterdir() if _is_log_file(path))
        else:
            note = "~/.hermes/logs is not a directory. The events route returns the bundled sample."
    except OSError:
        readable = False
        note = "~/.hermes/logs is unreadable. The events route returns the bundled sample."
    stats = _SAMPLE_DOC.get("stats") if isinstance(_SAMPLE_DOC, dict) else None
    sample_events = stats.get("events") if isinstance(stats, dict) and isinstance(stats.get("events"), int) else 0
    return {
        "ok": True,
        "plugin": "iris",
        "version": "0.1.0",
        "logs_readable": readable,
        "log_files": log_files,
        "sample_bundled": bool(_SAMPLE_DOC),
        "sample_events": sample_events,
        "visualizer": "/dashboard-plugins/iris/iris.html",
        "note": note,
    }


@router.get("/events")
async def get_events(source: str = "auto") -> dict:
    mode = _normalize_source(source)
    if mode == "sample":
        return _sample_payload("Bundled sample.")
    try:
        payload = _live_payload()
    except OSError:
        payload = None
    except Exception:
        payload = None
    if payload and payload.get("events"):
        return payload
    if mode == "live":
        note = "Live logs were unreadable or empty. Showing the bundled sample."
    else:
        note = "Logs were unreadable or empty. Showing the bundled sample."
    return _sample_payload(note)


@router.get("/live")
async def get_live(since: str | None = None) -> dict:
    """Events newer than ``since`` (ISO-8601 or epoch seconds) plus recent sessions.

    ``cursor`` is epoch seconds with microsecond precision. Pass it back as
    ``since`` to receive only newer events. ``sessions`` is the current recent
    snapshot from ``hermes sessions export --redact``, not a delta.
    """
    return await asyncio.to_thread(_live_snapshot, since)
