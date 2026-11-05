"""Record Gemini response usage locally, without prompts, responses or paths.

Call record_usage(body, model, started_at) immediately after decoding a response.
This module makes no network calls and uses only the Python standard library.
"""
import datetime
import json
import os
from pathlib import Path
import re
import uuid

FIELDS = ("promptTokenCount", "candidatesTokenCount", "cachedContentTokenCount",
          "thoughtsTokenCount", "toolUsePromptTokenCount", "totalTokenCount")


def record_usage(body, model, started_at=None, *, work="Planning", ledger=None):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    raw = body.get("usageMetadata") or {}
    usage = {k: v for k, v in raw.items()
             if k in FIELDS and type(v) is int and 0 <= v <= 9007199254740991}
    missing = not usage
    if not missing and "totalTokenCount" not in usage:
        usage["totalTokenCount"] = sum(usage.get(k, 0) for k in
            ("promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "toolUsePromptTokenCount"))
    model = body.get("modelVersion") or model
    if not isinstance(model, str) or not re.fullmatch(r"gemini-[a-zA-Z0-9._-]+", model):
        model = "unknown"
    if work not in ("Building", "Writing", "Shipping", "Testing", "Research", "Planning"):
        work = "Planning"
    started = now
    if isinstance(started_at, str):
        try:
            parsed = datetime.datetime.fromisoformat(started_at.replace("Z", "+00:00"))
            if parsed.tzinfo and parsed <= datetime.datetime.fromisoformat(now):
                started = parsed.isoformat()
        except ValueError:
            pass
    row = {"schema": "buildstats-gemini/1", "id": str(uuid.uuid4()),
           "timestamp": now, "startedAt": started, "model": model, "work": work,
           "usageMissing": missing, "usage": usage}
    target = Path(ledger) if ledger is not None else Path(os.environ.get("BUILDSTATS_HOME", Path.home() / ".buildstats")) / "gemini-usage.jsonl"
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        # One append per small record; never write raw response objects.
        data = (json.dumps(row, separators=(",", ":")) + "\n").encode()
        if os.write(fd, data) != len(data):
            raise OSError("incomplete usage record")
    finally:
        os.close(fd)
    return row
