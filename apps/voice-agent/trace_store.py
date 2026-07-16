from __future__ import annotations

import hashlib
import json
import re
import threading
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from study_skill import StudySkill


RUN_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]*$", re.IGNORECASE)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _record_hash(body: Mapping[str, object]) -> str:
    return hashlib.sha256(_canonical_json(dict(body)).encode("utf-8")).hexdigest()


class VoiceTraceWriter:
    def __init__(
        self,
        *,
        traces_dir: Path,
        run_id: str,
        skill: StudySkill,
        document_ids: tuple[str, ...],
        runtime: Mapping[str, object],
        now: Callable[[], str] = _utc_now,
    ) -> None:
        if len(run_id) > 160 or not RUN_ID_PATTERN.fullmatch(run_id):
            raise ValueError(f"Invalid study trace run id: {run_id!r}")
        self.run_id = run_id
        self._now = now
        self._sequence = 0
        self._previous_hash: str | None = None
        self._finished = False
        self._lock = threading.Lock()
        traces_dir = traces_dir.expanduser().resolve()
        traces_dir.mkdir(parents=True, exist_ok=True)
        self.path = traces_dir / f"{run_id}.jsonl"
        self._file = self.path.open("x", encoding="utf-8", buffering=1)
        self.append(
            {
                "type": "run_started",
                "skill": skill.artifact_ref(),
                "runtime": dict(runtime),
                "documentIds": list(document_ids),
            }
        )

    def append(self, event: Mapping[str, Any]) -> None:
        with self._lock:
            if self._finished:
                raise RuntimeError("Cannot append to a finished study trace.")
            self._append_locked(event)

    def _append_locked(self, event: Mapping[str, Any]) -> None:
        body: dict[str, object] = {
            "version": 1,
            "runId": self.run_id,
            "sequence": self._sequence,
            "timestamp": self._now(),
            "previousHash": self._previous_hash,
            "event": dict(event),
        }
        digest = _record_hash(body)
        record = {**body, "hash": digest}
        self._file.write(_canonical_json(record) + "\n")
        self._file.flush()
        self._sequence += 1
        self._previous_hash = digest

    def finish(self, reason: str = "completed", outcome: str | None = None) -> None:
        with self._lock:
            if self._finished:
                return
            event: dict[str, object] = {"type": "run_finished", "reason": reason}
            if outcome:
                event["outcome"] = outcome
            self._append_locked(event)
            self._finished = True
            self._file.close()


def parse_tool_arguments(arguments: str) -> object:
    try:
        return json.loads(arguments)
    except json.JSONDecodeError:
        return arguments
