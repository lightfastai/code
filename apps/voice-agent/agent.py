from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import AsyncGenerator, AsyncIterable
from pathlib import Path

from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import Agent, AgentServer, AgentSession, function_tool, inference, llm, room_io
from livekit.agents.voice import ModelSettings
from livekit.plugins import deepgram, groq, silero

from study_library import LocalStudyLibrary, StudyScope, scope_from_participant_metadata
from study_scene import SCENE_TOPIC, StudyScenePublisher
from study_skill import StudySkill, load_study_skill
from trace_store import VoiceTraceWriter, parse_tool_arguments


load_dotenv(os.getenv("T3_VOICE_ENV_FILE", ".env"))
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("t3-study-voice")

DEEPGRAM_AU_LISTEN_V1 = "https://api.au.deepgram.com/v1/listen"
DEEPGRAM_AU_SPEAK = "https://api.au.deepgram.com/v1/speak"
FIRST_TTS_CHUNK_TARGET = 80
FOLLOWING_TTS_CHUNK_TARGET = 150
MAX_TTS_CHUNK = 200


def _is_early_room_disconnect(error: RuntimeError) -> bool:
    message = str(error).lower()
    return "room disconnected" in message and "waiting for participant" in message


def _split_tts_buffer(buffer: str, target: int) -> tuple[str | None, str]:
    if len(buffer) < target:
        return None, buffer
    preferred_end = min(len(buffer), MAX_TTS_CHUNK)
    window = buffer[:preferred_end]
    boundaries = list(re.finditer(r"[.!?;](?:\s|$)", window))
    eligible = [match for match in boundaries if match.end() >= target]
    if eligible:
        end = eligible[0].end()
        return buffer[:end].strip(), buffer[end:].lstrip()
    if len(buffer) < MAX_TTS_CHUNK:
        return None, buffer
    space = window.rfind(" ", target)
    end = space + 1 if space >= target else preferred_end
    return buffer[:end].strip(), buffer[end:].lstrip()


async def buffer_tts_text(text: AsyncIterable[str]) -> AsyncGenerator[str, None]:
    buffer = ""
    target = FIRST_TTS_CHUNK_TARGET
    async for delta in text:
        buffer += delta
        while True:
            output, remainder = _split_tts_buffer(buffer, target)
            if output is None:
                break
            yield output + " "
            buffer = remainder
            target = FOLLOWING_TTS_CHUNK_TARGET
    if buffer.strip():
        yield buffer.strip()


class StudyVoiceAssistant(Agent):
    def __init__(
        self,
        library: LocalStudyLibrary,
        scope: StudyScope,
        skill: StudySkill,
        scene: StudyScenePublisher,
    ) -> None:
        self.library = library
        self.scope = scope
        self.scene = scene
        selected = library.list_documents(scope)
        selected_titles = ", ".join(str(item.get("title")) for item in selected) or "none"
        super().__init__(instructions=f"{skill.instructions}\n\nSelected books: {selected_titles}.")

    @function_tool
    async def search_study_library(self, query: str) -> str:
        """Search the user's selected local books for source-grounded passages.

        Args:
            query: A focused phrase describing the concept or passage to find.
        """
        hits = self.library.search(query, self.scope)
        if not hits:
            return "No matching extracted passage was found in the selected local books."
        return json.dumps(hits, ensure_ascii=False)

    @function_tool
    async def replace_study_scene(self, title: str, scene_json: str) -> str:
        """Replace the viewer's live interactive 3D scene with a semantic scene snapshot.

        Use this while explaining spatial ideas. The JSON object must contain `objects` made only
        from point, vector, segment, sphere, circle, or plane. Coordinates are `[x, y, z]`.
        Optional top-level fields are `camera`, `grid`, and `background`. Send a complete snapshot,
        not JavaScript and not an incremental patch.

        Args:
            title: A short learner-facing title for the interactive scene.
            scene_json: The complete validated semantic scene payload encoded as JSON.
        """
        sequence = await self.scene.replace(title, scene_json)
        return f"Live 3D scene updated at sequence {sequence}."

    @function_tool
    async def clear_study_scene(self) -> str:
        """Clear the live interactive 3D scene when it is no longer useful."""
        sequence = await self.scene.clear()
        return f"Live 3D scene cleared at sequence {sequence}."

    def tts_node(
        self, text: AsyncIterable[str], model_settings: ModelSettings
    ) -> AsyncIterable[rtc.AudioFrame]:
        return Agent.default.tts_node(self, buffer_tts_text(text), model_settings)


def make_stt() -> deepgram.STT:
    keyterms = [
        term.strip() for term in os.getenv("DEEPGRAM_KEYTERMS", "").split(",") if term.strip()
    ]
    return deepgram.STT(
        model="nova-3",
        language="en-AU",
        punctuate=True,
        smart_format=True,
        interim_results=True,
        base_url=DEEPGRAM_AU_LISTEN_V1,
        endpointing_ms=250,
        no_delay=True,
        mip_opt_out=True,
        keyterm=keyterms,
    )


def bind_trace_events(session: AgentSession, trace: VoiceTraceWriter) -> None:
    def append(event: dict[str, object]) -> None:
        try:
            trace.append(event)
        except Exception:
            logger.exception("failed to append study voice trace event")

    @session.on("conversation_item_added")
    def on_conversation_item(event: object) -> None:
        item = getattr(event, "item", None)
        if not isinstance(item, llm.ChatMessage):
            return
        text = item.text_content
        if not text or item.role not in ("user", "assistant"):
            return
        if item.role == "user":
            payload: dict[str, object] = {
                "type": "user_message",
                "text": text,
                "modality": "voice",
            }
            if item.transcript_confidence is not None:
                payload["confidence"] = max(0.0, min(1.0, item.transcript_confidence))
            append(payload)
            return

        assistant_payload: dict[str, object] = {
            "type": "assistant_message",
            "text": text,
            "modality": "voice",
            "interrupted": item.interrupted,
        }
        latency = getattr(item.metrics, "e2e_latency", None)
        if isinstance(latency, (int, float)) and latency >= 0:
            assistant_payload["latencyMs"] = round(latency * 1000)
        append(assistant_payload)

    @session.on("function_tools_executed")
    def on_function_tools(event: object) -> None:
        zipped = getattr(event, "zipped", None)
        if not callable(zipped):
            return
        for call, output in zipped():
            append(
                {
                    "type": "tool_call",
                    "callId": call.call_id,
                    "name": call.name,
                    "arguments": parse_tool_arguments(call.arguments),
                }
            )
            if output is not None:
                append(
                    {
                        "type": "tool_result",
                        "callId": output.call_id,
                        "name": output.name or call.name,
                        "output": output.output,
                        "isError": output.is_error,
                    }
                )

    @session.on("user_state_changed")
    def on_user_state(event: object) -> None:
        append(
            {
                "type": "state_changed",
                "actor": "user",
                "from": str(getattr(event, "old_state", "unknown")),
                "to": str(getattr(event, "new_state", "unknown")),
            }
        )

    @session.on("agent_state_changed")
    def on_agent_state(event: object) -> None:
        append(
            {
                "type": "state_changed",
                "actor": "assistant",
                "from": str(getattr(event, "old_state", "unknown")),
                "to": str(getattr(event, "new_state", "unknown")),
            }
        )

    @session.on("agent_false_interruption")
    def on_false_interruption(event: object) -> None:
        append(
            {
                "type": "interruption",
                "source": "user",
                "resumed": bool(getattr(event, "resumed", False)),
                "detail": "false interruption detected",
            }
        )

    @session.on("overlapping_speech")
    def on_overlapping_speech(event: object) -> None:
        append(
            {
                "type": "interruption",
                "source": "user",
                "detail": "overlapping speech"
                if bool(getattr(event, "is_interruption", False))
                else "overlapping speech without interruption",
            }
        )

    @session.on("error")
    def on_error(event: object) -> None:
        append(
            {
                "type": "environment_observation",
                "adapter": "study-voice/livekit",
                "observation": "error",
                "payload": {"message": str(getattr(event, "error", event))[:16_000]},
            }
        )


server = AgentServer()


@server.rtc_session(agent_name="t3-study-voice")
async def entrypoint(ctx: agents.JobContext) -> None:
    try:
        participant = await ctx.wait_for_participant()
    except RuntimeError as error:
        if not _is_early_room_disconnect(error):
            raise
        logger.info("voice room closed before the participant joined")
        return
    scope = scope_from_participant_metadata(participant.metadata)
    library_root = Path(os.getenv("T3_STUDY_LIBRARY", "~/.t3/study-library"))
    library = LocalStudyLibrary(library_root)
    skill = load_study_skill()
    model_name = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
    max_completion_tokens = int(os.getenv("GROQ_MAX_COMPLETION_TOKENS", "600"))
    tts_service = deepgram.TTS(
        model=os.getenv("DEEPGRAM_TTS_MODEL", "aura-2-athena-en"),
        base_url=DEEPGRAM_AU_SPEAK,
        mip_opt_out=True,
    )
    tts_service.prewarm()
    session = AgentSession(
        stt=make_stt(),
        vad=silero.VAD.load(
            min_speech_duration=0.05,
            min_silence_duration=0.35,
            activation_threshold=0.45,
        ),
        llm=groq.LLM(
            model=model_name,
            temperature=0.0,
            max_completion_tokens=max_completion_tokens,
            service_tier="on_demand",
        ),
        tts=tts_service,
        turn_handling={
            "turn_detection": inference.TurnDetector(),
            "endpointing": {"min_delay": 0.3, "max_delay": 1.5},
            "interruption": {"enabled": True, "mode": "vad", "min_duration": 0.2},
        },
        aec_warmup_duration=0,
    )
    traces_dir = Path(os.getenv("T3_STUDY_TRACE_DIR", str(library_root / "loop" / "traces")))
    trace = VoiceTraceWriter(
        traces_dir=traces_dir,
        run_id=ctx.room.name,
        skill=skill,
        document_ids=scope.document_ids,
        runtime={
            "adapter": {"id": "study-voice/livekit", "version": "1"},
            "model": {
                "provider": "groq",
                "name": model_name,
                "settings": {
                    "temperature": 0.0,
                    "maxCompletionTokens": max_completion_tokens,
                },
            },
            "tools": [
                {"name": "search_study_library", "version": "1"},
                {"name": "replace_study_scene", "version": "1"},
                {"name": "clear_study_scene", "version": "1"},
            ],
        },
    )

    async def publish_scene(payload: str) -> None:
        await ctx.room.local_participant.publish_data(payload, reliable=True, topic=SCENE_TOPIC)

    def observe_scene(event: dict[str, object]) -> None:
        try:
            trace.append(event)
        except Exception:
            logger.exception("failed to append live scene trace event")

    scene = StudyScenePublisher(publish_scene, observe_scene)
    bind_trace_events(session, trace)

    async def finish_trace(shutdown_reason: str) -> None:
        if shutdown_reason == "participant_disconnected":
            reason = "disconnected"
        elif shutdown_reason == "error":
            reason = "error"
        elif shutdown_reason == "user_initiated":
            reason = "cancelled"
        else:
            reason = "completed"
        trace.finish(reason=reason, outcome=shutdown_reason)

    ctx.add_shutdown_callback(finish_trace)
    logger.info("starting voice study room", extra={"document_count": len(scope.document_ids)})
    await session.start(
        room=ctx.room,
        agent=StudyVoiceAssistant(library, scope, skill, scene),
        room_options=room_io.RoomOptions(),
        record=False,
    )


if __name__ == "__main__":
    agents.cli.run_app(server)
