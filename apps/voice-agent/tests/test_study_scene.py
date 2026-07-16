from __future__ import annotations

import asyncio
import json

import pytest

from study_scene import SceneValidationError, StudyScenePublisher, validate_scene_json


def test_validates_semantic_scene_payloads() -> None:
    scene = validate_scene_json(
        json.dumps(
            {
                "camera": {"position": [5, 4, 6], "target": [0, 0, 0]},
                "objects": [
                    {
                        "type": "circle",
                        "id": "unit-circle",
                        "center": [0, 0, 0],
                        "normal": [0, 0, 1],
                        "radius": 1,
                    }
                ],
            }
        )
    )

    assert scene["objects"][0]["id"] == "unit-circle"


def test_rejects_executable_and_unknown_scene_objects() -> None:
    with pytest.raises(SceneValidationError, match="unsupported"):
        validate_scene_json(json.dumps({"objects": [{"type": "script", "source": "alert(1)"}]}))


def test_publishes_monotonic_scene_messages_and_observations() -> None:
    messages: list[dict[str, object]] = []
    observations: list[dict[str, object]] = []

    async def publish(payload: str) -> None:
        messages.append(json.loads(payload))

    async def run() -> None:
        publisher = StudyScenePublisher(publish, observations.append)
        await publisher.replace(
            "A vector",
            json.dumps(
                {"objects": [{"type": "vector", "id": "v", "start": [0, 0, 0], "end": [1, 2, 0]}]}
            ),
        )
        await publisher.clear()

    asyncio.run(run())

    assert [message["sequence"] for message in messages] == [0, 1]
    assert [message["type"] for message in messages] == [
        "study.scene.replace",
        "study.scene.clear",
    ]
    assert [event["observation"] for event in observations] == [
        "scene_replaced",
        "scene_cleared",
    ]
