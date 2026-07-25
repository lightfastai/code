import json
from pathlib import Path

import pytest

from agent import StudyVoiceAssistant, _is_early_room_disconnect
from study_library import LocalStudyLibrary, scope_from_participant_metadata
from study_skill import load_study_skill


DOCUMENT_ID = "a" * 64


def test_recognizes_expected_disconnect_while_waiting_for_participant() -> None:
    assert _is_early_room_disconnect(
        RuntimeError("room disconnected while waiting for participant")
    )
    assert not _is_early_room_disconnect(RuntimeError("failed to initialize participant"))


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "{",
        json.dumps({"selectedDocuments": []}),
        json.dumps({"selectedDocuments": [{"documentId": "invalid"}]}),
    ],
)
def test_unscoped_or_empty_metadata_leaks_no_library_titles_into_instructions(
    raw: str, tmp_path: Path
) -> None:
    (tmp_path / "index.json").write_text(
        json.dumps(
            {
                "version": 1,
                "documents": [
                    {
                        "id": DOCUMENT_ID,
                        "title": "Private Geometry Notes",
                        "format": "pdf",
                        "tags": ["private"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    assistant = StudyVoiceAssistant(
        LocalStudyLibrary(tmp_path),
        scope_from_participant_metadata(raw),
        load_study_skill(),
        scene=object(),  # type: ignore[arg-type]
    )

    assert "Private Geometry Notes" not in str(assistant.instructions)
    assert "Selected books: none." in str(assistant.instructions)
