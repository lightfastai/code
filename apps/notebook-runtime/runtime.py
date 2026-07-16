from __future__ import annotations

import asyncio
import hashlib
import hmac
import http.client
import json
import os
import re
import sys
from collections import deque
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from queue import Empty
from typing import Any, Protocol

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from jupyter_client import AsyncKernelManager

SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
DEFAULT_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024
DEFAULT_EXECUTION_TIMEOUT_SECONDS = 120.0
DEFAULT_EVENT_HISTORY_LIMIT = 4096
DEFAULT_COMMAND_CACHE_LIMIT = 512

Event = dict[str, Any]


class KernelClient(Protocol):
    def start_channels(self) -> None: ...

    def stop_channels(self) -> None: ...

    async def wait_for_ready(self, timeout: float) -> None: ...

    def execute(self, code: str, *, allow_stdin: bool, stop_on_error: bool) -> str: ...

    async def get_iopub_msg(self, timeout: float) -> dict[str, Any]: ...


class KernelManager(Protocol):
    async def start_kernel(self, *, cwd: str) -> None: ...

    def client(self) -> KernelClient: ...

    async def interrupt_kernel(self) -> None: ...

    async def restart_kernel(self, *, now: bool) -> None: ...

    async def shutdown_kernel(self, *, now: bool) -> None: ...


@dataclass
class CommandRecord:
    fingerprint: str
    events: list[Event] = field(default_factory=list)
    completed: asyncio.Event = field(default_factory=asyncio.Event)


@dataclass
class KernelSession:
    session_id: str
    manager: KernelManager
    client: KernelClient
    workspace: Path
    sequence: int = 0
    events: deque[Event] = field(default_factory=deque)
    commands: dict[str, CommandRecord] = field(default_factory=dict)
    command_order: deque[str] = field(default_factory=deque)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _fingerprint(command_type: str, payload: dict[str, Any]) -> str:
    canonical = json.dumps(
        {"commandType": command_type, "payload": payload},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _require_string(body: dict[str, Any], name: str, *, max_length: int) -> str:
    value = body.get(name)
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Invalid {name}.")
    return value


def _require_code(body: dict[str, Any]) -> str:
    value = body.get("code")
    if not isinstance(value, str) or len(value) > 2 * 1024 * 1024:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid code.")
    return value


class RuntimeService:
    def __init__(
        self,
        *,
        kernel_factory: Callable[..., KernelManager] = AsyncKernelManager,
        workspace_root: str | Path = "/workspace",
        output_limit_bytes: int = DEFAULT_OUTPUT_LIMIT_BYTES,
        execution_timeout_seconds: float = DEFAULT_EXECUTION_TIMEOUT_SECONDS,
        event_history_limit: int = DEFAULT_EVENT_HISTORY_LIMIT,
        command_cache_limit: int = DEFAULT_COMMAND_CACHE_LIMIT,
    ) -> None:
        self.kernel_factory = kernel_factory
        self.workspace_root = Path(workspace_root)
        self.output_limit_bytes = output_limit_bytes
        self.execution_timeout_seconds = execution_timeout_seconds
        self.event_history_limit = event_history_limit
        self.command_cache_limit = command_cache_limit
        self.sessions: dict[str, KernelSession] = {}
        self.disposed_commands: dict[tuple[str, str], tuple[str, list[Event]]] = {}
        self._sessions_lock = asyncio.Lock()

    @staticmethod
    def _validate_session_id(session_id: str) -> None:
        if not SESSION_ID_PATTERN.fullmatch(session_id):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid sessionId.")

    def _event(
        self,
        session: KernelSession,
        command_id: str,
        event_type: str,
        *,
        execution_id: str | None = None,
        **fields: Any,
    ) -> Event:
        session.sequence += 1
        event: Event = {
            "type": event_type,
            "sessionId": session.session_id,
            "commandId": command_id,
            **({"executionId": execution_id} if execution_id is not None else {}),
            "sequence": session.sequence,
            **fields,
        }
        session.events.append(event)
        while len(session.events) > self.event_history_limit:
            session.events.popleft()
        return event

    def _rejected(
        self,
        session: KernelSession,
        command_id: str,
        *,
        execution_id: str | None,
        reason: str,
        message: str,
    ) -> Event:
        return self._event(
            session,
            command_id,
            "rejected",
            execution_id=execution_id,
            reason=reason,
            message=message,
        )

    async def _begin_command(
        self,
        session: KernelSession,
        command_id: str,
        fingerprint: str,
        *,
        execution_id: str | None = None,
    ) -> tuple[CommandRecord | None, list[Event] | None]:
        existing = session.commands.get(command_id)
        if existing is not None:
            if not hmac.compare_digest(existing.fingerprint, fingerprint):
                return None, [
                    self._rejected(
                        session,
                        command_id,
                        execution_id=execution_id,
                        reason="command-id-conflict",
                        message="The command ID was already used with a different payload.",
                    )
                ]
            await existing.completed.wait()
            return None, list(existing.events)

        record = CommandRecord(fingerprint=fingerprint)
        session.commands[command_id] = record
        session.command_order.append(command_id)
        while len(session.command_order) > self.command_cache_limit:
            oldest = session.command_order[0]
            candidate = session.commands[oldest]
            if not candidate.completed.is_set():
                break
            session.command_order.popleft()
            del session.commands[oldest]
        return record, None

    @staticmethod
    def _complete(record: CommandRecord, events: list[Event]) -> None:
        record.events.extend(events)
        record.completed.set()

    async def open_session(
        self,
        session_id: str,
        command_id: str,
        kernel_name: str = "python3",
    ) -> list[Event]:
        self._validate_session_id(session_id)
        fingerprint = _fingerprint("open", {"kernelName": kernel_name, "sessionId": session_id})
        async with self._sessions_lock:
            existing = self.sessions.get(session_id)
            if existing is not None:
                record, replay = await self._begin_command(existing, command_id, fingerprint)
                if replay is not None:
                    return replay
                assert record is not None
                events = [
                    self._event(existing, command_id, "accepted", commandType="open"),
                    self._event(existing, command_id, "kernel", state="idle"),
                ]
                self._complete(record, events)
                return events

            workspace = self.workspace_root / session_id
            workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
            manager = self.kernel_factory(kernel_name=kernel_name)
            client: KernelClient | None = None
            session = KernelSession(
                session_id=session_id,
                manager=manager,
                client=None,  # type: ignore[arg-type]
                workspace=workspace,
            )
            record = CommandRecord(fingerprint=fingerprint)
            session.commands[command_id] = record
            session.command_order.append(command_id)
            self.sessions[session_id] = session
            events = [
                self._event(session, command_id, "accepted", commandType="open"),
                self._event(session, command_id, "kernel", state="starting"),
            ]
            try:
                await manager.start_kernel(cwd=str(workspace))
                client = manager.client()
                client.start_channels()
                await client.wait_for_ready(timeout=30)
                session.client = client
                events.append(self._event(session, command_id, "kernel", state="idle"))
                self._complete(record, events)
                return events
            except BaseException:
                self.sessions.pop(session_id, None)
                if client is not None:
                    client.stop_channels()
                record.completed.set()
                raise

    def _get_session(self, session_id: str) -> KernelSession:
        self._validate_session_id(session_id)
        session = self.sessions.get(session_id)
        if session is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Notebook session not found.")
        return session

    async def execute(
        self,
        session_id: str,
        command_id: str,
        execution_id: str,
        code: str,
    ) -> AsyncIterator[Event]:
        session = self._get_session(session_id)
        fingerprint = _fingerprint(
            "execute", {"code": code, "executionId": execution_id, "sessionId": session_id}
        )
        record, replay = await self._begin_command(
            session, command_id, fingerprint, execution_id=execution_id
        )
        if replay is not None:
            for event in replay:
                yield event
            return
        assert record is not None

        emitted: list[Event] = []
        output_bytes = 0
        output_limited = False

        def emit(event_type: str, **fields: Any) -> Event:
            event = self._event(
                session, command_id, event_type, execution_id=execution_id, **fields
            )
            emitted.append(event)
            return event

        def emit_output_limit() -> Event | None:
            nonlocal output_limited
            if output_limited:
                return None
            output_limited = True
            return emit(
                "limit",
                kind="output",
                limit=self.output_limit_bytes,
                message=(
                    f"Execution output exceeded {self.output_limit_bytes} bytes and was truncated."
                ),
            )

        yield emit("accepted", commandType="execute")
        try:
            async with session.lock:
                msg_id = session.client.execute(code, allow_stdin=False, stop_on_error=True)
                loop = asyncio.get_running_loop()
                deadline = loop.time() + self.execution_timeout_seconds
                while True:
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        await session.manager.interrupt_kernel()
                        yield emit(
                            "limit",
                            kind="time",
                            limit=self.execution_timeout_seconds,
                            message=(
                                "Execution exceeded "
                                f"{self.execution_timeout_seconds:g} seconds and was interrupted."
                            ),
                        )
                        yield emit("kernel", state="interrupted")
                        yield emit("kernel", state="idle")
                        break
                    try:
                        message = await session.client.get_iopub_msg(timeout=min(remaining, 1.0))
                    except (TimeoutError, Empty):
                        continue
                    if message.get("parent_header", {}).get("msg_id") != msg_id:
                        continue
                    msg_type = message.get("header", {}).get("msg_type")
                    content = message.get("content", {})
                    if msg_type == "status":
                        state = content.get("execution_state")
                        if state in {"busy", "idle"}:
                            yield emit("kernel", state=state)
                            if state == "idle":
                                break
                    elif msg_type == "stream" and not output_limited:
                        name = content.get("name")
                        text = content.get("text")
                        if name not in {"stdout", "stderr"} or not isinstance(text, str):
                            continue
                        encoded = text.encode()
                        remaining_bytes = max(0, self.output_limit_bytes - output_bytes)
                        if len(encoded) <= remaining_bytes:
                            output_bytes += len(encoded)
                            yield emit("stream", name=name, text=text)
                        else:
                            truncated = encoded[:remaining_bytes].decode(errors="ignore")
                            if truncated:
                                output_bytes += len(truncated.encode())
                                yield emit("stream", name=name, text=truncated)
                            limit_event = emit_output_limit()
                            if limit_event is not None:
                                yield limit_event
                    elif msg_type in {"display_data", "execute_result"} and not output_limited:
                        data = content.get("data")
                        metadata = content.get("metadata", {})
                        if not isinstance(data, dict) or not isinstance(metadata, dict):
                            continue
                        encoded_size = len(
                            json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
                        )
                        if output_bytes + encoded_size > self.output_limit_bytes:
                            limit_event = emit_output_limit()
                            if limit_event is not None:
                                yield limit_event
                            continue
                        output_bytes += encoded_size
                        if msg_type == "display_data":
                            yield emit("display", data=data, metadata=metadata)
                        else:
                            yield emit(
                                "result",
                                data=data,
                                metadata=metadata,
                                executionCount=content.get("execution_count"),
                            )
                    elif msg_type == "error" and not output_limited:
                        yield emit(
                            "error",
                            ename=str(content.get("ename", "Error")),
                            evalue=str(content.get("evalue", "")),
                            traceback=[str(line) for line in content.get("traceback", [])],
                        )
        finally:
            self._complete(record, emitted)

    async def interrupt(self, session_id: str, command_id: str) -> list[Event]:
        session = self._get_session(session_id)
        fingerprint = _fingerprint("interrupt", {"sessionId": session_id})
        record, replay = await self._begin_command(session, command_id, fingerprint)
        if replay is not None:
            return replay
        assert record is not None
        events = [self._event(session, command_id, "accepted", commandType="interrupt")]
        try:
            await session.manager.interrupt_kernel()
            events.append(self._event(session, command_id, "kernel", state="interrupted"))
            return events
        finally:
            self._complete(record, events)

    async def restart(self, session_id: str, command_id: str) -> list[Event]:
        session = self._get_session(session_id)
        fingerprint = _fingerprint("restart", {"sessionId": session_id})
        record, replay = await self._begin_command(session, command_id, fingerprint)
        if replay is not None:
            return replay
        assert record is not None
        events = [
            self._event(session, command_id, "accepted", commandType="restart"),
            self._event(session, command_id, "kernel", state="starting"),
        ]
        try:
            async with session.lock:
                await session.manager.restart_kernel(now=True)
                await session.client.wait_for_ready(timeout=30)
            events.extend(
                [
                    self._event(session, command_id, "kernel", state="restarted"),
                    self._event(session, command_id, "kernel", state="idle"),
                ]
            )
            return events
        finally:
            self._complete(record, events)

    async def dispose(self, session_id: str, command_id: str) -> list[Event]:
        fingerprint = _fingerprint("dispose", {"sessionId": session_id})
        tombstone = self.disposed_commands.get((session_id, command_id))
        if tombstone is not None:
            previous_fingerprint, events = tombstone
            if hmac.compare_digest(previous_fingerprint, fingerprint):
                return list(events)
        session = self._get_session(session_id)
        record, replay = await self._begin_command(session, command_id, fingerprint)
        if replay is not None:
            return replay
        assert record is not None
        events = [self._event(session, command_id, "accepted", commandType="dispose")]
        try:
            async with session.lock:
                session.client.stop_channels()
                await session.manager.shutdown_kernel(now=True)
            events.append(self._event(session, command_id, "kernel", state="terminated"))
            self.sessions.pop(session_id, None)
            self.disposed_commands[(session_id, command_id)] = (fingerprint, list(events))
            return events
        finally:
            self._complete(record, events)

    def events_after(self, session_id: str, after_sequence: int) -> list[Event]:
        session = self._get_session(session_id)
        return [event for event in session.events if event["sequence"] > after_sequence]

    async def close(self) -> None:
        sessions = list(self.sessions.values())
        self.sessions.clear()
        for session in sessions:
            session.client.stop_channels()
            await session.manager.shutdown_kernel(now=True)


def create_app(*, service: RuntimeService, token: str) -> FastAPI:
    if not token:
        raise ValueError("A non-empty NOTEBOOK_RUNTIME_TOKEN is required.")

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await service.close()

    app = FastAPI(
        title="Lightfast Notebook Runtime",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )

    def authenticate(authorization: str | None = Header(default=None)) -> None:
        expected = f"Bearer {token}"
        if authorization is None or not hmac.compare_digest(authorization, expected):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid runtime credentials.",
                headers={"WWW-Authenticate": "Bearer"},
            )

    auth = Depends(authenticate)

    @app.get("/v1/health", dependencies=[auth])
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/sessions", dependencies=[auth])
    async def open_endpoint(request: Request) -> dict[str, list[Event]]:
        body = await request.json()
        return {
            "events": await service.open_session(
                _require_string(body, "sessionId", max_length=128),
                _require_string(body, "commandId", max_length=256),
                _require_string(body, "kernelName", max_length=128),
            )
        }

    @app.post("/v1/sessions/{session_id}/execute", dependencies=[auth])
    async def execute_endpoint(session_id: str, request: Request) -> StreamingResponse:
        body = await request.json()
        command_id = _require_string(body, "commandId", max_length=256)
        execution_id = _require_string(body, "executionId", max_length=256)
        code = _require_code(body)
        service._get_session(session_id)

        async def lines() -> AsyncIterator[bytes]:
            async for event in service.execute(session_id, command_id, execution_id, code):
                yield json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"

        return StreamingResponse(lines(), media_type="application/x-ndjson")

    @app.post("/v1/sessions/{session_id}/interrupt", dependencies=[auth])
    async def interrupt_endpoint(session_id: str, request: Request) -> dict[str, list[Event]]:
        body = await request.json()
        return {
            "events": await service.interrupt(
                session_id, _require_string(body, "commandId", max_length=256)
            )
        }

    @app.post("/v1/sessions/{session_id}/restart", dependencies=[auth])
    async def restart_endpoint(session_id: str, request: Request) -> dict[str, list[Event]]:
        body = await request.json()
        return {
            "events": await service.restart(
                session_id, _require_string(body, "commandId", max_length=256)
            )
        }

    @app.post("/v1/sessions/{session_id}/dispose", dependencies=[auth])
    async def dispose_endpoint(session_id: str, request: Request) -> dict[str, list[Event]]:
        body = await request.json()
        return {
            "events": await service.dispose(
                session_id, _require_string(body, "commandId", max_length=256)
            )
        }

    @app.get("/v1/sessions/{session_id}/events", dependencies=[auth])
    async def events_endpoint(session_id: str, afterSequence: int = 0) -> dict[str, list[Event]]:
        if afterSequence < 0:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid afterSequence.")
        return {"events": service.events_after(session_id, afterSequence)}

    return app


def _positive_int_env(name: str, default: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive.")
    return value


def _positive_float_env(name: str, default: float) -> float:
    value = float(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive.")
    return value


def build_app_from_environment() -> FastAPI:
    service = RuntimeService(
        workspace_root=os.environ.get("NOTEBOOK_WORKSPACE_ROOT", "/workspace"),
        output_limit_bytes=_positive_int_env(
            "NOTEBOOK_OUTPUT_LIMIT_BYTES", DEFAULT_OUTPUT_LIMIT_BYTES
        ),
        execution_timeout_seconds=_positive_float_env(
            "NOTEBOOK_EXECUTION_TIMEOUT_SECONDS", DEFAULT_EXECUTION_TIMEOUT_SECONDS
        ),
    )
    return create_app(service=service, token=os.environ.get("NOTEBOOK_RUNTIME_TOKEN", ""))


def serve() -> None:
    uvicorn.run(
        "runtime:build_app_from_environment",
        factory=True,
        host="127.0.0.1",
        port=8080,
        workers=1,
        access_log=False,
        log_level="warning",
    )


def proxy() -> None:
    envelope = json.loads(sys.stdin.buffer.readline())
    method = envelope["method"]
    path = envelope["path"]
    token = envelope["token"]
    body = envelope.get("body")
    encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=135)
    try:
        connection.request(
            method,
            path,
            body=encoded,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json, application/x-ndjson",
                **({"Content-Type": "application/json"} if encoded is not None else {}),
            },
        )
        response = connection.getresponse()
        sys.stdout.buffer.write(
            json.dumps({"status": response.status}, separators=(",", ":")).encode() + b"\n"
        )
        sys.stdout.buffer.flush()
        while chunk := response.read(64 * 1024):
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
    finally:
        connection.close()


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "proxy":
        proxy()
    else:
        serve()
