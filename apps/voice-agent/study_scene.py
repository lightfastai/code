from __future__ import annotations

import json
import math
import re
from collections.abc import Awaitable, Callable, Mapping
from typing import Any


SCENE_TOPIC = "t3.study.scene.v1"
MAX_SCENE_JSON_BYTES = 128 * 1024
MAX_OBJECTS = 128
ID_PATTERN = re.compile(r"^[a-z0-9_-]+$", re.IGNORECASE)
COLOR_PATTERN = re.compile(r"^(#[0-9a-f]{3,8}|[a-z]+)$", re.IGNORECASE)


class SceneValidationError(ValueError):
    pass


def _object(value: object, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SceneValidationError(f"{context} must be an object.")
    return value


def _keys(
    value: Mapping[str, object],
    *,
    required: set[str],
    optional: set[str],
    context: str,
) -> None:
    missing = required - value.keys()
    unknown = value.keys() - required - optional
    if missing:
        raise SceneValidationError(f"{context} is missing: {', '.join(sorted(missing))}.")
    if unknown:
        raise SceneValidationError(f"{context} has unknown fields: {', '.join(sorted(unknown))}.")


def _number(value: object, context: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SceneValidationError(f"{context} must be a finite number.")
    number = float(value)
    if positive and number <= 0:
        raise SceneValidationError(f"{context} must be greater than zero.")
    return number


def _vec3(value: object, context: str) -> None:
    if not isinstance(value, list) or len(value) != 3:
        raise SceneValidationError(f"{context} must contain exactly three numbers.")
    for index, coordinate in enumerate(value):
        _number(coordinate, f"{context}[{index}]")


def _style(value: Mapping[str, object], context: str) -> None:
    color = value.get("color")
    if color is not None and (
        not isinstance(color, str) or len(color) > 32 or not COLOR_PATTERN.fullmatch(color)
    ):
        raise SceneValidationError(f"{context}.color is invalid.")
    opacity = value.get("opacity")
    if opacity is not None and not 0 <= _number(opacity, f"{context}.opacity") <= 1:
        raise SceneValidationError(f"{context}.opacity must be between zero and one.")
    label = value.get("label")
    if label is not None and (not isinstance(label, str) or not 0 < len(label.strip()) <= 120):
        raise SceneValidationError(f"{context}.label must contain 1..120 characters.")


def _scene_object(value: object, index: int) -> None:
    item = _object(value, f"objects[{index}]")
    kind = item.get("type")
    common = {"color", "opacity", "label"}
    shapes: dict[str, tuple[set[str], set[str]]] = {
        "point": ({"type", "id", "position"}, {"radius", *common}),
        "vector": ({"type", "id", "start", "end"}, common),
        "segment": ({"type", "id", "start", "end"}, common),
        "sphere": ({"type", "id", "center", "radius"}, {"wireframe", *common}),
        "circle": ({"type", "id", "center", "normal", "radius"}, common),
        "plane": ({"type", "id", "center", "normal", "width", "height"}, common),
    }
    shape = shapes.get(kind) if isinstance(kind, str) else None
    if shape is None:
        raise SceneValidationError(f"objects[{index}].type is unsupported.")
    _keys(item, required=shape[0], optional=shape[1], context=f"objects[{index}]")
    object_id = item["id"]
    if (
        not isinstance(object_id, str)
        or len(object_id) > 128
        or not ID_PATTERN.fullmatch(object_id)
    ):
        raise SceneValidationError(f"objects[{index}].id is invalid.")
    for key in ("position", "start", "end", "center", "normal"):
        if key in item:
            _vec3(item[key], f"objects[{index}].{key}")
    for key in ("radius", "width", "height"):
        if key in item:
            _number(item[key], f"objects[{index}].{key}", positive=True)
    if "wireframe" in item and not isinstance(item["wireframe"], bool):
        raise SceneValidationError(f"objects[{index}].wireframe must be boolean.")
    _style(item, f"objects[{index}]")


def validate_scene_json(scene_json: str) -> dict[str, Any]:
    if len(scene_json.encode("utf-8")) > MAX_SCENE_JSON_BYTES:
        raise SceneValidationError("Scene JSON exceeds the 128 KiB limit.")
    try:
        payload = _object(json.loads(scene_json), "scene")
    except json.JSONDecodeError as error:
        raise SceneValidationError("Scene must be valid JSON.") from error
    _keys(
        payload,
        required={"objects"},
        optional={"camera", "grid", "background"},
        context="scene",
    )
    objects = payload["objects"]
    if not isinstance(objects, list) or len(objects) > MAX_OBJECTS:
        raise SceneValidationError(f"scene.objects must contain at most {MAX_OBJECTS} objects.")
    for index, item in enumerate(objects):
        _scene_object(item, index)

    background = payload.get("background")
    if background is not None and (
        not isinstance(background, str)
        or len(background) > 32
        or not COLOR_PATTERN.fullmatch(background)
    ):
        raise SceneValidationError("scene.background is invalid.")

    camera_value = payload.get("camera")
    if camera_value is not None:
        camera = _object(camera_value, "scene.camera")
        _keys(
            camera,
            required={"position", "target"},
            optional={"fieldOfView"},
            context="scene.camera",
        )
        _vec3(camera["position"], "scene.camera.position")
        _vec3(camera["target"], "scene.camera.target")
        if (
            "fieldOfView" in camera
            and not 15 <= _number(camera["fieldOfView"], "scene.camera.fieldOfView") <= 100
        ):
            raise SceneValidationError("scene.camera.fieldOfView must be between 15 and 100.")

    grid_value = payload.get("grid")
    if grid_value is not None:
        grid = _object(grid_value, "scene.grid")
        _keys(grid, required=set(), optional={"visible", "size", "divisions"}, context="scene.grid")
        if "visible" in grid and not isinstance(grid["visible"], bool):
            raise SceneValidationError("scene.grid.visible must be boolean.")
        if "size" in grid:
            _number(grid["size"], "scene.grid.size", positive=True)
        if "divisions" in grid:
            divisions = _number(grid["divisions"], "scene.grid.divisions")
            if not divisions.is_integer() or not 2 <= divisions <= 100:
                raise SceneValidationError("scene.grid.divisions must be an integer from 2 to 100.")
    return payload


class StudyScenePublisher:
    def __init__(
        self,
        publish: Callable[[str], Awaitable[None]],
        observe: Callable[[dict[str, object]], None],
    ) -> None:
        self._publish = publish
        self._observe = observe
        self._sequence = 0

    async def replace(self, title: str, scene_json: str) -> int:
        normalized_title = title.strip()
        if not 0 < len(normalized_title) <= 255:
            raise SceneValidationError("Scene title must contain 1..255 characters.")
        artifact = {
            "type": "artifact",
            "id": "voice-scene",
            "kind": "3d-scene",
            "schemaVersion": 1,
            "title": normalized_title,
            "payload": validate_scene_json(scene_json),
            "capabilities": ["orbit", "pan", "zoom", "reset-camera"],
        }
        message = {
            "type": "study.scene.replace",
            "version": 1,
            "sequence": self._sequence,
            "artifact": artifact,
        }
        await self._publish(json.dumps(message, ensure_ascii=False, separators=(",", ":")))
        self._observe(
            {
                "type": "environment_observation",
                "adapter": "study-live-scene",
                "observation": "scene_replaced",
                "payload": {"sequence": self._sequence, "artifact": artifact},
            }
        )
        self._sequence += 1
        return self._sequence - 1

    async def clear(self) -> int:
        message = {
            "type": "study.scene.clear",
            "version": 1,
            "sequence": self._sequence,
        }
        await self._publish(json.dumps(message, separators=(",", ":")))
        self._observe(
            {
                "type": "environment_observation",
                "adapter": "study-live-scene",
                "observation": "scene_cleared",
                "payload": {"sequence": self._sequence},
            }
        )
        self._sequence += 1
        return self._sequence - 1
