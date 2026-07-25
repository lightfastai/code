from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from pathlib import Path

from study_skill import load_study_skill
from trace_store import VoiceTraceWriter, parse_tool_arguments


def _clock() -> Iterator[str]:
    yield "2026-07-15T00:00:00.000Z"
    yield "2026-07-15T00:00:01.000Z"
    yield "2026-07-15T00:00:02.000Z"


def _hash_body(record: dict[str, object]) -> str:
    body = {key: value for key, value in record.items() if key != "hash"}
    canonical = json.dumps(
        body,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def test_writes_append_only_hash_chained_trace(tmp_path: Path) -> None:
    clock = _clock()
    writer = VoiceTraceWriter(
        traces_dir=tmp_path,
        run_id="study-test-run",
        skill=load_study_skill(),
        document_ids=(),
        runtime={
            "adapter": {"id": "study-voice/livekit", "version": "1"},
            "model": {"provider": "groq", "name": "test"},
            "tools": [],
        },
        now=lambda: next(clock),
    )
    writer.append({"type": "user_message", "text": "Hello", "modality": "voice"})
    writer.finish(reason="completed")
    writer.finish(reason="error")

    records = [json.loads(line) for line in writer.path.read_text().splitlines()]
    assert [record["sequence"] for record in records] == [0, 1, 2]
    assert [record["event"]["type"] for record in records] == [
        "run_started",
        "user_message",
        "run_finished",
    ]
    assert records[0]["previousHash"] is None
    for index, record in enumerate(records):
        assert record["hash"] == _hash_body(record)
        if index > 0:
            assert record["previousHash"] == records[index - 1]["hash"]


def test_loads_external_skill_as_content_addressed_artifact(tmp_path: Path) -> None:
    skill_path = tmp_path / "SKILL.md"
    skill_path.write_text("# Study\n\nAsk a diagnostic question first.\n", encoding="utf-8")

    skill = load_study_skill(str(skill_path))

    assert skill.instructions.startswith("# Study")
    assert skill.source == str(skill_path.resolve())
    assert skill.content_hash == hashlib.sha256(skill.instructions.encode()).hexdigest()


def test_parses_structured_tool_arguments_without_requiring_them() -> None:
    assert parse_tool_arguments('{"query":"vectors"}') == {"query": "vectors"}
    assert parse_tool_arguments("not-json") == "not-json"
