import json
from pathlib import Path

import pytest

from study_library import LocalStudyLibrary, scope_from_participant_metadata


DOCUMENT_ID = "a" * 64


def make_library(root: Path) -> LocalStudyLibrary:
    (root / "derived" / "aa").mkdir(parents=True)
    (root / "index.json").write_text(
        json.dumps(
            {
                "version": 1,
                "documents": [
                    {
                        "id": DOCUMENT_ID,
                        "title": "Geometry",
                        "format": "pdf",
                        "tags": ["math"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (root / "derived" / "aa" / f"{DOCUMENT_ID}.text.json").write_text(
        json.dumps(
            {
                "version": 1,
                "documentId": DOCUMENT_ID,
                "segments": [
                    {
                        "id": "segment-1",
                        "text": "A normal vector is perpendicular to its plane.",
                        "heading": "Planes",
                        "anchor": {"type": "pdf-page", "page": 12},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return LocalStudyLibrary(root)


def test_metadata_scope_and_anchored_search(tmp_path: Path) -> None:
    scope = scope_from_participant_metadata(
        json.dumps({"selectedDocuments": [{"documentId": DOCUMENT_ID}]})
    )
    hits = make_library(tmp_path).search("normal vector plane", scope)

    assert scope.document_ids == (DOCUMENT_ID,)
    assert scope.has_explicit_selection
    assert hits[0]["documentTitle"] == "Geometry"
    assert hits[0]["anchor"] == {"type": "pdf-page", "page": 12}


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "{",
        "{}",
        json.dumps({"selectedDocuments": None}),
        json.dumps({"selectedDocuments": [{"documentId": "invalid"}]}),
        json.dumps(
            {
                "selectedDocuments": [
                    {"documentId": DOCUMENT_ID},
                    {"documentId": "invalid"},
                ]
            }
        ),
    ],
)
def test_missing_or_malformed_metadata_exposes_no_documents(raw: str, tmp_path: Path) -> None:
    scope = scope_from_participant_metadata(raw)
    library = make_library(tmp_path)

    assert not scope.has_explicit_selection
    assert scope.document_ids == ()
    assert library.list_documents(scope) == []
    assert library.search("normal vector plane", scope) == []
    assert "Geometry" not in json.dumps(library.list_documents(scope))


def test_explicit_empty_selection_exposes_no_documents(tmp_path: Path) -> None:
    scope = scope_from_participant_metadata(json.dumps({"selectedDocuments": []}))
    library = make_library(tmp_path)

    assert scope.has_explicit_selection
    assert scope.document_ids == ()
    assert library.list_documents(scope) == []
    assert library.search("normal vector plane", scope) == []
