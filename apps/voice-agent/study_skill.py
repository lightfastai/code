from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path


DEFAULT_STUDY_INSTRUCTIONS = (
    "You are a concise real-time study partner. Speak naturally without markdown. "
    "When the user asks about a selected book, call search_study_library before "
    "making book-specific claims and mention the returned page, chapter, or heading "
    "briefly. Ask one useful follow-up when it improves understanding."
)
MAX_SKILL_BYTES = 512 * 1024


@dataclass(frozen=True)
class StudySkill:
    name: str
    version: str
    content_hash: str
    source: str
    instructions: str

    def artifact_ref(self) -> dict[str, str]:
        return {
            "name": self.name,
            "version": self.version,
            "contentHash": self.content_hash,
            "source": self.source,
        }


def _make_skill(*, name: str, version: str, source: str, instructions: str) -> StudySkill:
    normalized = instructions.strip()
    if not normalized:
        raise ValueError("Study skill instructions cannot be empty.")
    return StudySkill(
        name=name.strip() or "study",
        version=version.strip() or "unversioned",
        content_hash=hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
        source=source,
        instructions=normalized,
    )


def load_study_skill(path_value: str | None = None) -> StudySkill:
    configured = path_value if path_value is not None else os.getenv("T3_STUDY_SKILL_PATH")
    if not configured:
        return _make_skill(
            name="study",
            version="builtin-v1",
            source="builtin://study-voice",
            instructions=DEFAULT_STUDY_INSTRUCTIONS,
        )

    path = Path(configured).expanduser().resolve()
    size = path.stat().st_size
    if size > MAX_SKILL_BYTES:
        raise ValueError(f"Study skill is larger than {MAX_SKILL_BYTES // 1024} KiB: {path}")
    return _make_skill(
        name=os.getenv("T3_STUDY_SKILL_NAME", path.parent.name or "study"),
        version=os.getenv("T3_STUDY_SKILL_VERSION", "local"),
        source=str(path),
        instructions=path.read_text(encoding="utf-8"),
    )
