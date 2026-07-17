from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TOKEN_PATTERN = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class StudyScope:
    document_ids: tuple[str, ...] = ()
    has_explicit_selection: bool = False


def scope_from_participant_metadata(raw: str) -> StudyScope:
    if not raw:
        return StudyScope()
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return StudyScope()
    if not isinstance(payload, dict) or "selectedDocuments" not in payload:
        return StudyScope()
    selected = payload["selectedDocuments"]
    if not isinstance(selected, list) or len(selected) > 32:
        return StudyScope()

    document_ids: list[str] = []
    seen: set[str] = set()
    for item in selected:
        if not isinstance(item, dict):
            return StudyScope()
        document_id = item.get("documentId")
        if not isinstance(document_id, str) or not re.fullmatch(r"[0-9a-f]{64}", document_id):
            return StudyScope()
        if document_id not in seen:
            seen.add(document_id)
            document_ids.append(document_id)
    return StudyScope(document_ids=tuple(document_ids), has_explicit_selection=True)


class LocalStudyLibrary:
    def __init__(self, root: Path) -> None:
        self.root = root.expanduser().resolve()

    def _index(self) -> list[dict[str, Any]]:
        path = self.root / "index.json"
        if not path.exists():
            return []
        payload = json.loads(path.read_text(encoding="utf-8"))
        documents = payload.get("documents", []) if isinstance(payload, dict) else []
        return [document for document in documents if isinstance(document, dict)]

    def list_documents(self, scope: StudyScope) -> list[dict[str, Any]]:
        if not scope.has_explicit_selection:
            return []
        allowed = set(scope.document_ids)
        return [
            {
                "documentId": document.get("id"),
                "title": document.get("title"),
                "format": document.get("format"),
                "tags": document.get("tags", []),
            }
            for document in self._index()
            if document.get("id") in allowed
        ]

    def _derived_document(self, document_id: str) -> dict[str, Any] | None:
        path = self.root / "derived" / document_id[:2] / f"{document_id}.text.json"
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None

    def search(self, query: str, scope: StudyScope, limit: int = 5) -> list[dict[str, Any]]:
        terms = tuple(dict.fromkeys(TOKEN_PATTERN.findall(query.lower())))
        if not terms:
            return []
        documents = self.list_documents(scope)
        hits: list[dict[str, Any]] = []
        for document in documents:
            document_id = document.get("documentId")
            if not isinstance(document_id, str):
                continue
            extracted = self._derived_document(document_id)
            if not extracted:
                continue
            for segment in extracted.get("segments", []):
                if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
                    continue
                text = segment["text"]
                normalized = text.lower()
                matched = [term for term in terms if term in normalized]
                if not matched:
                    continue
                first = min(normalized.find(term) for term in matched)
                start = max(0, first - 180)
                end = min(len(text), first + 620)
                excerpt = text[start:end].strip()
                hits.append(
                    {
                        "documentId": document_id,
                        "documentTitle": document.get("title"),
                        "documentFormat": document.get("format"),
                        "heading": segment.get("heading"),
                        "anchor": segment.get("anchor"),
                        "excerpt": excerpt,
                        "score": len(matched) / len(terms),
                    }
                )
        hits.sort(key=lambda hit: (-float(hit["score"]), str(hit.get("documentTitle", ""))))
        return hits[: max(1, min(limit, 10))]
