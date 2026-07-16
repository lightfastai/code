from __future__ import annotations

import asyncio
import ctypes
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import shutil
import sys
import time
from collections import deque
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
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
DEFAULT_EVENT_LIMIT_BYTES = 1024 * 1024
DEFAULT_EXECUTION_TIMEOUT_SECONDS = 120.0
DEFAULT_TIMEOUT_IDLE_GRACE_SECONDS = 5.0
DEFAULT_EVENT_HISTORY_LIMIT = 4096
DEFAULT_COMMAND_CACHE_LIMIT = 512
METADATA_LIMIT_BYTES = 64 * 1024
ERROR_NAME_LIMIT_BYTES = 4 * 1024
ERROR_VALUE_LIMIT_BYTES = 128 * 1024
TRACEBACK_LIMIT_BYTES = 512 * 1024
TRACEBACK_LINE_LIMIT_BYTES = 16 * 1024
KERNEL_ENVIRONMENT_ALLOWLIST = (
    "LANG",
    "LC_ALL",
    "PATH",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONHASHSEED",
    "PYTHONUNBUFFERED",
    "TZ",
)

Event = dict[str, Any]


class KernelClient(Protocol):
    def start_channels(self) -> None: ...

    def stop_channels(self) -> None: ...

    async def wait_for_ready(self, timeout: float) -> None: ...

    def execute(self, code: str, *, allow_stdin: bool, stop_on_error: bool) -> str: ...

    async def get_iopub_msg(self, timeout: float) -> dict[str, Any]: ...


class KernelManager(Protocol):
    async def start_kernel(self, *, cwd: str, env: dict[str, str]) -> None: ...

    def client(self) -> KernelClient: ...

    async def interrupt_kernel(self) -> None: ...

    async def restart_kernel(self, *, now: bool) -> None: ...

    async def shutdown_kernel(self, *, now: bool) -> None: ...


@dataclass
class CommandRecord:
    fingerprint: str
    events: list[Event] = field(default_factory=list)
    completed: asyncio.Event = field(default_factory=asyncio.Event)
    updated: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None
    error: BaseException | None = None


@dataclass
class KernelSession:
    session_id: str
    manager: KernelManager
    client: KernelClient
    workspace: Path
    runtime_directory: Path
    connection_file: Path
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


def _json_size(value: Any) -> int | None:
    try:
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
    except (TypeError, ValueError):
        return None


def _truncate_json_string(value: Any, limit_bytes: int) -> str:
    text = str(value)
    if (_json_size(text) or limit_bytes + 1) <= limit_bytes:
        return text
    low = 0
    high = len(text)
    while low < high:
        midpoint = (low + high + 1) // 2
        size = _json_size(text[:midpoint])
        if size is not None and size <= limit_bytes:
            low = midpoint
        else:
            high = midpoint - 1
    return text[:low]


def _bounded_traceback(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value[:1000]:
        line = _truncate_json_string(item, TRACEBACK_LINE_LIMIT_BYTES)
        candidate = [*result, line]
        size = _json_size(candidate)
        if size is None or size > TRACEBACK_LIMIT_BYTES:
            break
        result.append(line)
    return result


def _kernel_environment(runtime_directory: Path) -> dict[str, str]:
    environment = {
        name: value
        for name in KERNEL_ENVIRONMENT_ALLOWLIST
        if (value := os.environ.get(name)) is not None
    }
    environment["HOME"] = os.environ.get("HOME", str(Path.home()))
    environment["PATH"] = environment.get("PATH", os.defpath)
    environment["PYTHONNOUSERSITE"] = "1"
    environment["IPYTHONDIR"] = str(runtime_directory / "ipython")
    environment["JUPYTER_RUNTIME_DIR"] = str(runtime_directory / "jupyter")
    environment["MPLCONFIGDIR"] = str(runtime_directory / "matplotlib")
    return environment


def _set_non_dumpable() -> None:
    if sys.platform != "linux":
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


class RuntimeService:
    def __init__(
        self,
        *,
        kernel_factory: Callable[..., KernelManager] = AsyncKernelManager,
        workspace_root: str | Path = "/workspace",
        runtime_root: str | Path = "/tmp/notebook-sessions",
        output_limit_bytes: int = DEFAULT_OUTPUT_LIMIT_BYTES,
        event_limit_bytes: int = DEFAULT_EVENT_LIMIT_BYTES,
        execution_timeout_seconds: float = DEFAULT_EXECUTION_TIMEOUT_SECONDS,
        timeout_idle_grace_seconds: float = DEFAULT_TIMEOUT_IDLE_GRACE_SECONDS,
        event_history_limit: int = DEFAULT_EVENT_HISTORY_LIMIT,
        command_cache_limit: int = DEFAULT_COMMAND_CACHE_LIMIT,
    ) -> None:
        self.kernel_factory = kernel_factory
        self.workspace_root = Path(workspace_root)
        self.runtime_root = Path(runtime_root)
        self.output_limit_bytes = output_limit_bytes
        self.event_limit_bytes = event_limit_bytes
        self.execution_timeout_seconds = execution_timeout_seconds
        self.timeout_idle_grace_seconds = timeout_idle_grace_seconds
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
        cell_id: str | None = None,
        **fields: Any,
    ) -> Event:
        if (execution_id is None) != (cell_id is None):
            raise RuntimeError("Execution-scoped notebook events require executionId and cellId.")
        session.sequence += 1
        event: Event = {
            "type": event_type,
            "sessionId": session.session_id,
            "commandId": command_id,
            **({"executionId": execution_id} if execution_id is not None else {}),
            **({"cellId": cell_id} if cell_id is not None else {}),
            "sequence": session.sequence,
            **fields,
        }
        event_size = _json_size(event)
        if event_size is None or event_size > self.event_limit_bytes:
            raise RuntimeError("Notebook runtime attempted to emit an oversized event.")
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
        cell_id: str | None = None,
        reason: str,
        message: str,
    ) -> Event:
        return self._event(
            session,
            command_id,
            "rejected",
            execution_id=execution_id,
            cell_id=cell_id,
            reason=reason,
            message=message,
        )

    async def _begin_command(
        self,
        session: KernelSession,
        command_id: str,
        fingerprint: str,
    ) -> tuple[CommandRecord | None, list[Event] | None]:
        existing = session.commands.get(command_id)
        if existing is not None:
            if not hmac.compare_digest(existing.fingerprint, fingerprint):
                return None, [
                    self._rejected(
                        session,
                        command_id,
                        execution_id=None,
                        reason="command-id-conflict",
                        message="The command ID was already used with a different payload.",
                    )
                ]
            await existing.completed.wait()
            return None, list(existing.events)

        record = self._new_command_record(session, command_id, fingerprint)
        return record, None

    def _new_command_record(
        self, session: KernelSession, command_id: str, fingerprint: str
    ) -> CommandRecord:
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
        return record

    def _begin_execution_command(
        self,
        session: KernelSession,
        command_id: str,
        fingerprint: str,
        execution_id: str,
        cell_id: str,
    ) -> tuple[CommandRecord | None, list[Event] | None, bool]:
        existing = session.commands.get(command_id)
        if existing is not None:
            if not hmac.compare_digest(existing.fingerprint, fingerprint):
                return (
                    None,
                    [
                        self._rejected(
                            session,
                            command_id,
                            execution_id=execution_id,
                            cell_id=cell_id,
                            reason="command-id-conflict",
                            message="The command ID was already used with a different payload.",
                        )
                    ],
                    False,
                )
            return existing, None, False
        return self._new_command_record(session, command_id, fingerprint), None, True

    @staticmethod
    def _complete(record: CommandRecord, events: list[Event]) -> None:
        record.events.extend(events)
        record.completed.set()
        record.updated.set()

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

            if self.sessions:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Runtime already owns a different notebook session.",
                )

            workspace = self.workspace_root / session_id
            workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
            runtime_directory = self.runtime_root / session_id
            runtime_directory.mkdir(mode=0o700, parents=True, exist_ok=False)
            connection_file = runtime_directory / "connection.json"
            manager = self.kernel_factory(
                kernel_name=kernel_name,
                connection_file=str(connection_file),
            )
            client: KernelClient | None = None
            session = KernelSession(
                session_id=session_id,
                manager=manager,
                client=None,  # type: ignore[arg-type]
                workspace=workspace,
                runtime_directory=runtime_directory,
                connection_file=connection_file,
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
                await manager.start_kernel(
                    cwd=str(workspace), env=_kernel_environment(runtime_directory)
                )
                client = manager.client()
                client.start_channels()
                await client.wait_for_ready(timeout=30)
                connection_file.unlink(missing_ok=True)
                session.client = client
                events.append(self._event(session, command_id, "kernel", state="idle"))
                self._complete(record, events)
                return events
            except BaseException:
                if client is not None:
                    client.stop_channels()
                with suppress(BaseException):
                    await manager.shutdown_kernel(now=True)
                self.sessions.pop(session_id, None)
                shutil.rmtree(runtime_directory, ignore_errors=True)
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
        cell_id: str,
        code: str,
    ) -> AsyncIterator[Event]:
        session = self._get_session(session_id)
        fingerprint = _fingerprint(
            "execute",
            {
                "cellId": cell_id,
                "code": code,
                "executionId": execution_id,
                "sessionId": session_id,
            },
        )
        record, replay, is_new = self._begin_execution_command(
            session, command_id, fingerprint, execution_id, cell_id
        )
        if replay is not None:
            for event in replay:
                yield event
            return
        assert record is not None
        if is_new:
            task = asyncio.create_task(
                self._run_execution(session, command_id, execution_id, cell_id, code, record)
            )
            record.task = task
            task.add_done_callback(
                lambda completed_task: self._finalize_execution_task(
                    session, command_id, execution_id, cell_id, record, completed_task
                )
            )
        index = 0
        while True:
            record.updated.clear()
            while index < len(record.events):
                yield record.events[index]
                index += 1
            if record.completed.is_set():
                if record.error is not None:
                    raise record.error
                return
            await record.updated.wait()

    async def _run_execution(
        self,
        session: KernelSession,
        command_id: str,
        execution_id: str,
        cell_id: str,
        code: str,
        record: CommandRecord,
    ) -> None:
        output_bytes = 0
        output_limited = False

        def emit(event_type: str, **fields: Any) -> Event:
            event = self._event(
                session,
                command_id,
                event_type,
                execution_id=execution_id,
                cell_id=cell_id,
                **fields,
            )
            record.events.append(event)
            record.updated.set()
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

        def event_size(event_type: str, **fields: Any) -> int | None:
            return _json_size(
                {
                    "type": event_type,
                    "sessionId": session.session_id,
                    "commandId": command_id,
                    "executionId": execution_id,
                    "cellId": cell_id,
                    "sequence": session.sequence + 1,
                    **fields,
                }
            )

        def event_fits(event_type: str, **fields: Any) -> bool:
            size = event_size(event_type, **fields)
            return size is not None and size <= self.event_limit_bytes

        def bounded_stream_text(name: str, text: str) -> tuple[str, bool]:
            if event_fits("stream", name=name, text=text):
                return text, False
            low = 0
            high = len(text)
            while low < high:
                midpoint = (low + high + 1) // 2
                size = event_size("stream", name=name, text=text[:midpoint])
                if size is not None and size <= self.event_limit_bytes:
                    low = midpoint
                else:
                    high = midpoint - 1
            return text[:low], True

        emit("accepted", commandType="execute")
        try:
            async with session.lock:
                msg_id = session.client.execute(code, allow_stdin=False, stop_on_error=True)
                loop = asyncio.get_running_loop()
                deadline = loop.time() + self.execution_timeout_seconds
                timed_out = False
                while True:
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        if not timed_out:
                            await session.manager.interrupt_kernel()
                            emit(
                                "limit",
                                kind="time",
                                limit=self.execution_timeout_seconds,
                                message=(
                                    "Execution exceeded "
                                    f"{self.execution_timeout_seconds:g} seconds and was "
                                    "interrupted."
                                ),
                            )
                            emit("kernel", state="interrupted")
                            timed_out = True
                            deadline = loop.time() + self.timeout_idle_grace_seconds
                            continue

                        emit("kernel", state="starting")
                        try:
                            await session.manager.restart_kernel(now=True)
                            await session.client.wait_for_ready(timeout=30)
                            session.connection_file.unlink(missing_ok=True)
                        except BaseException:
                            session.client.stop_channels()
                            with suppress(BaseException):
                                await session.manager.shutdown_kernel(now=True)
                            if self.sessions.get(session.session_id) is session:
                                self.sessions.pop(session.session_id)
                            emit(
                                "error",
                                ename="RuntimeRecoveryError",
                                evalue=(
                                    "The kernel did not become idle after interruption and "
                                    "recovery failed."
                                ),
                                traceback=[],
                            )
                            emit("kernel", state="terminated")
                            break
                        emit("kernel", state="restarted")
                        emit("kernel", state="idle")
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
                            if state == "idle" or not timed_out:
                                emit("kernel", state=state)
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
                            bounded_text, event_truncated = bounded_stream_text(name, text)
                            if bounded_text:
                                output_bytes += len(bounded_text.encode())
                                emit("stream", name=name, text=bounded_text)
                            if event_truncated:
                                emit_output_limit()
                        else:
                            truncated = encoded[:remaining_bytes].decode(errors="ignore")
                            if truncated:
                                bounded_text, _ = bounded_stream_text(name, truncated)
                                if bounded_text:
                                    output_bytes += len(bounded_text.encode())
                                    emit("stream", name=name, text=bounded_text)
                            emit_output_limit()
                    elif msg_type in {"display_data", "execute_result"} and not output_limited:
                        data = content.get("data")
                        metadata = content.get("metadata", {})
                        if not isinstance(data, dict) or not isinstance(metadata, dict):
                            continue
                        metadata_size = _json_size(metadata)
                        if metadata_size is None or metadata_size > METADATA_LIMIT_BYTES:
                            metadata = {}
                            metadata_size = 2
                        data_size = _json_size(data)
                        if data_size is None:
                            continue
                        encoded_size = data_size + metadata_size
                        if output_bytes + encoded_size > self.output_limit_bytes:
                            emit_output_limit()
                            continue
                        execution_count = content.get("execution_count")
                        if (
                            not isinstance(execution_count, int)
                            or isinstance(execution_count, bool)
                            or execution_count < 0
                        ):
                            execution_count = None
                        fields = {"data": data, "metadata": metadata}
                        if msg_type == "execute_result":
                            fields["executionCount"] = execution_count
                        if not event_fits(
                            "display" if msg_type == "display_data" else "result", **fields
                        ):
                            emit_output_limit()
                            continue
                        output_bytes += encoded_size
                        if msg_type == "display_data":
                            emit("display", data=data, metadata=metadata)
                        else:
                            emit(
                                "result",
                                data=data,
                                metadata=metadata,
                                executionCount=execution_count,
                            )
                    elif msg_type == "error" and not output_limited:
                        error_fields = {
                            "ename": _truncate_json_string(
                                content.get("ename", "Error"), ERROR_NAME_LIMIT_BYTES
                            ),
                            "evalue": _truncate_json_string(
                                content.get("evalue", ""), ERROR_VALUE_LIMIT_BYTES
                            ),
                            "traceback": _bounded_traceback(content.get("traceback", [])),
                        }
                        encoded_size = _json_size(error_fields)
                        if (
                            encoded_size is None
                            or output_bytes + encoded_size > self.output_limit_bytes
                        ):
                            emit_output_limit()
                            continue
                        output_bytes += encoded_size
                        emit("error", **error_fields)
        except asyncio.CancelledError:
            emit("kernel", state="terminated")
        except BaseException as error:
            record.error = error
        finally:
            record.completed.set()
            record.updated.set()

    def _finalize_execution_task(
        self,
        session: KernelSession,
        command_id: str,
        execution_id: str,
        cell_id: str,
        record: CommandRecord,
        task: asyncio.Task[None],
    ) -> None:
        if record.completed.is_set():
            if not task.cancelled():
                task.exception()
            return
        if task.cancelled():
            accepted = any(event["type"] == "accepted" for event in record.events)
            event = (
                self._event(
                    session,
                    command_id,
                    "kernel",
                    execution_id=execution_id,
                    cell_id=cell_id,
                    state="terminated",
                )
                if accepted
                else self._rejected(
                    session,
                    command_id,
                    execution_id=execution_id,
                    cell_id=cell_id,
                    reason="execution-cancelled",
                    message="Execution was cancelled before it started.",
                )
            )
            record.events.append(event)
        else:
            record.error = task.exception()
        record.completed.set()
        record.updated.set()

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
                session.connection_file.unlink(missing_ok=True)
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
            await self._cancel_session_tasks(session)
            async with session.lock:
                session.client.stop_channels()
                await session.manager.shutdown_kernel(now=True)
            events.append(self._event(session, command_id, "kernel", state="terminated"))
            self.sessions.pop(session_id, None)
            shutil.rmtree(session.runtime_directory, ignore_errors=True)
            self.disposed_commands[(session_id, command_id)] = (fingerprint, list(events))
            return events
        finally:
            self._complete(record, events)

    def events_after(self, session_id: str, after_sequence: int) -> list[Event]:
        session = self._get_session(session_id)
        return [event for event in session.events if event["sequence"] > after_sequence]

    def event_replay(self, session_id: str, after_sequence: int) -> dict[str, Any]:
        session = self._get_session(session_id)
        baseline_sequence = (
            session.events[0]["sequence"] - 1 if session.events else session.sequence
        )
        return {
            "baselineSequence": baseline_sequence,
            "events": [
                event for event in session.events if event["sequence"] > after_sequence
            ],
        }

    async def close(self) -> None:
        sessions = list(self.sessions.values())
        self.sessions.clear()
        for session in sessions:
            try:
                await self._cancel_session_tasks(session)
                session.client.stop_channels()
                await session.manager.shutdown_kernel(now=True)
            finally:
                shutil.rmtree(session.runtime_directory, ignore_errors=True)

    @staticmethod
    async def _cancel_session_tasks(session: KernelSession) -> None:
        tasks = {
            record.task
            for record in session.commands.values()
            if record.task is not None and not record.task.done()
        }
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def create_app(*, service: RuntimeService, token: str, bootstrap_enabled: bool = False) -> FastAPI:
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
    bootstrap_claimed = not bootstrap_enabled
    bootstrap_lock = asyncio.Lock()

    @app.post("/v1/bootstrap")
    async def bootstrap_endpoint() -> dict[str, str]:
        nonlocal bootstrap_claimed
        async with bootstrap_lock:
            if bootstrap_claimed or service.sessions:
                bootstrap_claimed = True
                raise HTTPException(status.HTTP_409_CONFLICT, "Bootstrap unavailable.")
            bootstrap_claimed = True
            return {"token": token}

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
        cell_id = _require_string(body, "cellId", max_length=64)
        code = _require_code(body)
        service._get_session(session_id)

        async def lines() -> AsyncIterator[bytes]:
            async for event in service.execute(
                session_id, command_id, execution_id, cell_id, code
            ):
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
    async def events_endpoint(session_id: str, afterSequence: int = 0) -> dict[str, Any]:
        if afterSequence < 0:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid afterSequence.")
        return service.event_replay(session_id, afterSequence)

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
    os.environ.pop("NOTEBOOK_RUNTIME_TOKEN", None)
    token = secrets.token_urlsafe(32)
    service = RuntimeService(
        workspace_root=os.environ.get("NOTEBOOK_WORKSPACE_ROOT", "/workspace"),
        output_limit_bytes=_positive_int_env(
            "NOTEBOOK_OUTPUT_LIMIT_BYTES", DEFAULT_OUTPUT_LIMIT_BYTES
        ),
        event_limit_bytes=_positive_int_env(
            "NOTEBOOK_EVENT_LIMIT_BYTES", DEFAULT_EVENT_LIMIT_BYTES
        ),
        execution_timeout_seconds=_positive_float_env(
            "NOTEBOOK_EXECUTION_TIMEOUT_SECONDS", DEFAULT_EXECUTION_TIMEOUT_SECONDS
        ),
        timeout_idle_grace_seconds=_positive_float_env(
            "NOTEBOOK_TIMEOUT_IDLE_GRACE_SECONDS", DEFAULT_TIMEOUT_IDLE_GRACE_SECONDS
        ),
    )
    return create_app(service=service, token=token, bootstrap_enabled=True)


def serve() -> None:
    _set_non_dumpable()
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
    _set_non_dumpable()
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


def bootstrap() -> None:
    _set_non_dumpable()
    deadline = time.monotonic() + 30
    while True:
        connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=1)
        try:
            connection.request("POST", "/v1/bootstrap")
            response = connection.getresponse()
            payload = response.read(1024)
            if response.status != status.HTTP_200_OK:
                raise RuntimeError("bootstrap unavailable")
            decoded = json.loads(payload)
            token = decoded.get("token")
            if not isinstance(token, str) or not token:
                raise RuntimeError("bootstrap unavailable")
            sys.stdout.write(f"{token}\n")
            return
        except ConnectionError:
            if time.monotonic() >= deadline:
                raise RuntimeError("bootstrap unavailable") from None
            time.sleep(0.025)
        finally:
            connection.close()


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "proxy":
        proxy()
    elif len(sys.argv) == 2 and sys.argv[1] == "bootstrap":
        try:
            bootstrap()
        except BaseException:
            sys.stderr.write("bootstrap unavailable\n")
            raise SystemExit(1) from None
    else:
        serve()
