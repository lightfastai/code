from __future__ import annotations

import asyncio
import json
from collections import deque
from typing import Any

import httpx
import pytest
from fastapi import HTTPException

from runtime import RuntimeService, build_app_from_environment, create_app


def message(
    msg_type: str,
    content: dict[str, Any],
    *,
    parent_id: str = "execute-1",
) -> dict[str, Any]:
    return {
        "header": {"msg_type": msg_type},
        "parent_header": {"msg_id": parent_id},
        "content": content,
    }


class FakeKernelClient:
    def __init__(self) -> None:
        self.messages: deque[dict[str, Any]] = deque()
        self.execute_count = 0
        self.channels_started = False
        self.channels_stopped = False
        self.active = False
        self.delivered_messages: list[dict[str, Any]] = []
        self.readiness_error: BaseException | None = None

    def start_channels(self) -> None:
        self.channels_started = True

    def stop_channels(self) -> None:
        self.channels_stopped = True

    async def wait_for_ready(self, timeout: float) -> None:
        assert timeout > 0
        if self.readiness_error is not None:
            raise self.readiness_error

    def execute(self, code: str, *, allow_stdin: bool, stop_on_error: bool) -> str:
        assert allow_stdin is False
        assert stop_on_error is True
        if self.active:
            raise RuntimeError("A new execution raced a kernel that was still active.")
        self.active = True
        self.execute_count += 1
        msg_id = f"execute-{self.execute_count}"
        if code == "ordered":
            self.messages.extend(
                [
                    message("stream", {"name": "stdout", "text": "ignored"}, parent_id="other"),
                    message("status", {"execution_state": "busy"}, parent_id=msg_id),
                    message("execute_input", {"execution_count": 7}, parent_id=msg_id),
                    message("stream", {"name": "stdout", "text": "one\n"}, parent_id=msg_id),
                    message(
                        "display_data",
                        {"data": {"image/png": "cG5n"}, "metadata": {"isolated": True}},
                        parent_id=msg_id,
                    ),
                    message(
                        "execute_result",
                        {
                            "data": {"text/plain": "2"},
                            "metadata": {},
                            "execution_count": 7,
                        },
                        parent_id=msg_id,
                    ),
                    message("status", {"execution_state": "idle"}, parent_id=msg_id),
                ]
            )
        elif code == "error":
            self.messages.extend(
                [
                    message("status", {"execution_state": "busy"}, parent_id=msg_id),
                    message("execute_input", {"execution_count": 10}, parent_id=msg_id),
                    message(
                        "error",
                        {"ename": "ValueError", "evalue": "boom", "traceback": ["trace"]},
                        parent_id=msg_id,
                    ),
                    message("status", {"execution_state": "idle"}, parent_id=msg_id),
                ]
            )
        elif code == "print":
            self.messages.extend(
                [
                    message("status", {"execution_state": "busy"}, parent_id=msg_id),
                    message("execute_input", {"execution_count": 8}, parent_id=msg_id),
                    message("stream", {"name": "stdout", "text": "printed\n"}, parent_id=msg_id),
                    message("status", {"execution_state": "idle"}, parent_id=msg_id),
                ]
            )
        elif code == "assignment":
            self.messages.extend(
                [
                    message("status", {"execution_state": "busy"}, parent_id=msg_id),
                    message("execute_input", {"execution_count": 9}, parent_id=msg_id),
                    message("status", {"execution_state": "idle"}, parent_id=msg_id),
                ]
            )
        elif code == "large":
            self.messages.extend(
                [
                    message("status", {"execution_state": "busy"}, parent_id=msg_id),
                    message("stream", {"name": "stdout", "text": "0123456789"}, parent_id=msg_id),
                    message("stream", {"name": "stderr", "text": "dropped"}, parent_id=msg_id),
                    message("status", {"execution_state": "idle"}, parent_id=msg_id),
                ]
            )
        elif code == "wait":
            pass
        return msg_id

    async def get_iopub_msg(self, timeout: float) -> dict[str, Any]:
        if self.messages:
            item = self.messages.popleft()
            self.delivered_messages.append(item)
            if (
                item.get("header", {}).get("msg_type") == "status"
                and item.get("content", {}).get("execution_state") == "idle"
            ):
                self.active = False
            return item
        await asyncio.sleep(min(timeout, 0.01))
        raise TimeoutError


class FakeKernelManager:
    def __init__(self, kernel_name: str, connection_file: str | None = None) -> None:
        self.kernel_name = kernel_name
        self.connection_file = connection_file
        self.client_instance = FakeKernelClient()
        self.started = False
        self.interrupt_count = 0
        self.restart_count = 0
        self.shutdown_count = 0
        self.cwd: str | None = None
        self.env: dict[str, str] | None = None
        self.idle_on_interrupt = False

    async def start_kernel(self, *, cwd: str, env: dict[str, str] | None = None) -> None:
        self.started = True
        self.cwd = cwd
        self.env = env
        if self.connection_file is not None:
            path = __import__("pathlib").Path(self.connection_file)
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_text("connection-secret")

    def client(self) -> FakeKernelClient:
        return self.client_instance

    async def interrupt_kernel(self) -> None:
        self.interrupt_count += 1
        if self.idle_on_interrupt:
            self.client_instance.messages.append(
                message(
                    "status",
                    {"execution_state": "idle"},
                    parent_id=f"execute-{self.client_instance.execute_count}",
                )
            )

    async def restart_kernel(self, *, now: bool) -> None:
        assert now is True
        self.restart_count += 1
        self.client_instance.messages.clear()
        self.client_instance.active = False
        if self.connection_file is not None:
            __import__("pathlib").Path(self.connection_file).write_text("connection-secret")

    async def shutdown_kernel(self, *, now: bool) -> None:
        assert now is True
        self.shutdown_count += 1
        self.client_instance.active = False


@pytest.fixture
def service(tmp_path: Any) -> RuntimeService:
    return RuntimeService(
        kernel_factory=FakeKernelManager,
        workspace_root=tmp_path / "workspace",
        runtime_root=tmp_path / "runtime",
        output_limit_bytes=1024,
        execution_timeout_seconds=0.03,
        timeout_idle_grace_seconds=0.03,
    )


async def open_session(service: RuntimeService) -> tuple[FakeKernelManager, list[dict[str, Any]]]:
    events = await service.open_session("session-1", "open-1", "python3")
    manager = service.sessions["session-1"].manager
    assert isinstance(manager, FakeKernelManager)
    return manager, events


async def test_runtime_token_is_private_and_kernel_environment_is_sanitized(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("NOTEBOOK_RUNTIME_TOKEN", "kernel-must-not-see-this")
    monkeypatch.setenv("UNSAFE_HOST_SECRET", "kernel-must-not-see-this-either")
    service = RuntimeService(
        kernel_factory=FakeKernelManager,
        workspace_root=tmp_path / "workspace",
        runtime_root=tmp_path / "runtime",
    )

    manager, _ = await open_session(service)

    assert manager.env is not None
    assert "NOTEBOOK_RUNTIME_TOKEN" not in manager.env
    assert "UNSAFE_HOST_SECRET" not in manager.env

    build_app_from_environment()
    assert "NOTEBOOK_RUNTIME_TOKEN" not in __import__("os").environ


async def test_open_failure_shuts_down_started_kernel_and_removes_session(
    tmp_path: Any,
) -> None:
    created: list[FakeKernelManager] = []

    def factory(kernel_name: str, connection_file: str | None = None) -> FakeKernelManager:
        manager = FakeKernelManager(kernel_name, connection_file)
        manager.client_instance.readiness_error = RuntimeError("readiness failed")
        created.append(manager)
        return manager

    service = RuntimeService(
        kernel_factory=factory,
        workspace_root=tmp_path / "workspace",
        runtime_root=tmp_path / "runtime",
    )

    with pytest.raises(RuntimeError, match="readiness failed"):
        await service.open_session("failed-session", "failed-open")

    assert "failed-session" not in service.sessions
    assert created[0].started is True
    assert created[0].client_instance.channels_stopped is True
    assert created[0].shutdown_count == 1


async def test_session_uses_removed_connection_file_including_restart(
    service: RuntimeService,
) -> None:
    first, _ = await open_session(service)

    assert first.connection_file is not None
    assert not __import__("os").path.exists(first.connection_file)

    await service.restart("session-1", "restart-connection-file")
    assert not __import__("os").path.exists(first.connection_file)

    first_runtime = __import__("pathlib").Path(first.connection_file).parent
    await service.dispose("session-1", "dispose-connection-file")
    assert not first_runtime.exists()


async def test_sidecar_rejects_a_second_distinct_session(tmp_path: Any) -> None:
    created: list[FakeKernelManager] = []

    def factory(kernel_name: str, connection_file: str | None = None) -> FakeKernelManager:
        manager = FakeKernelManager(kernel_name, connection_file)
        created.append(manager)
        return manager

    service = RuntimeService(
        kernel_factory=factory,
        workspace_root=tmp_path / "workspace",
        runtime_root=tmp_path / "runtime",
    )
    first, _ = await open_session(service)
    reopened = await service.open_session("session-1", "open-again", "python3")

    with pytest.raises(HTTPException) as raised:
        await service.open_session("session-2", "open-2", "python3")

    assert raised.value.status_code == 409
    assert raised.value.detail == "Runtime already owns a different notebook session."
    assert reopened[-1] == {
        "type": "kernel",
        "sessionId": "session-1",
        "commandId": "open-again",
        "sequence": reopened[-1]["sequence"],
        "state": "idle",
    }
    assert len(created) == 1
    assert list(service.sessions) == ["session-1"]
    assert service.sessions["session-1"].manager is first


async def test_orders_matching_iopub_messages_through_idle(service: RuntimeService) -> None:
    _, opened = await open_session(service)
    events = [
        event
        async for event in service.execute(
            "session-1", "command-1", "execution-1", "cell-1", "ordered"
        )
    ]

    assert [event["type"] for event in opened] == ["accepted", "kernel", "kernel"]
    assert [event["type"] for event in events] == [
        "accepted",
        "kernel",
        "execution",
        "stream",
        "display",
        "result",
        "kernel",
    ]
    assert events[1]["state"] == "busy"
    assert events[2]["executionCount"] == 7
    assert events[3]["text"] == "one\n"
    assert events[4]["data"] == {"image/png": "cG5n"}
    assert events[5]["executionCount"] == 7
    assert events[-1]["state"] == "idle"
    assert [event["sequence"] for event in [*opened, *events]] == list(range(1, 11))


async def test_reports_execution_counts_without_result_outputs(service: RuntimeService) -> None:
    await open_session(service)
    for index, (code, expected_count) in enumerate(
        [("print", 8), ("assignment", 9), ("error", 10)], start=1
    ):
        events = [
            event
            async for event in service.execute(
                "session-1",
                f"count-command-{index}",
                f"count-execution-{index}",
                f"cell-{index}",
                code,
            )
        ]
        execution = next(event for event in events if event["type"] == "execution")
        assert execution["executionCount"] == expected_count
        assert execution["cellId"] == f"cell-{index}"


async def test_normalizes_kernel_errors(service: RuntimeService) -> None:
    await open_session(service)
    events = [
        event
        async for event in service.execute(
            "session-1", "command-error", "execution-error", "cell-error", "error"
        )
    ]
    error = next(event for event in events if event["type"] == "error")
    assert error == {
        "type": "error",
        "sessionId": "session-1",
        "commandId": "command-error",
        "executionId": "execution-error",
        "cellId": "cell-error",
        "sequence": error["sequence"],
        "ename": "ValueError",
        "evalue": "boom",
        "traceback": ["trace"],
    }


async def test_bounds_complete_events_and_all_untrusted_kernel_fields(
    service: RuntimeService,
) -> None:
    service.output_limit_bytes = 10 * 1024 * 1024
    manager, _ = await open_session(service)
    huge = "x" * (2 * 1024 * 1024)
    manager.client_instance.messages.extend(
        [
            message("status", {"execution_state": "busy"}),
            message(
                "display_data",
                {"data": {"text/plain": "ok"}, "metadata": {"attacker": huge}},
            ),
            message("status", {"execution_state": "idle"}),
        ]
    )
    display_events = [
        event
        async for event in service.execute(
            "session-1",
            "bounded-metadata",
            "bounded-metadata-execution",
            "cell-bounded-metadata",
            "bounded-metadata",
        )
    ]
    manager.client_instance.messages.extend(
        [
            message("status", {"execution_state": "busy"}, parent_id="execute-2"),
            message(
                "error",
                {"ename": huge, "evalue": huge, "traceback": [huge, huge]},
                parent_id="execute-2",
            ),
            message("status", {"execution_state": "idle"}, parent_id="execute-2"),
        ]
    )
    error_events = [
        event
        async for event in service.execute(
            "session-1",
            "bounded-error",
            "bounded-error-execution",
            "cell-bounded-error",
            "bounded-error",
        )
    ]
    events = [*display_events, *error_events]

    display = next(event for event in events if event["type"] == "display")
    error = next(event for event in events if event["type"] == "error")
    assert display["metadata"] != {"attacker": huge}
    assert error["ename"] != huge
    assert error["evalue"] != huge
    assert error["traceback"] != [huge, huge]
    assert all(
        len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()) <= 1024 * 1024
        for event in events
    )


async def test_duplicate_command_replays_without_executing_twice(service: RuntimeService) -> None:
    manager, _ = await open_session(service)
    first = [
        event
        async for event in service.execute(
            "session-1", "same", "execution-1", "cell-1", "ordered"
        )
    ]
    replay = [
        event
        async for event in service.execute(
            "session-1", "same", "execution-1", "cell-1", "ordered"
        )
    ]
    assert replay == first
    assert manager.client_instance.execute_count == 1
    assert all(event["cellId"] == "cell-1" for event in first)

    rejected = [
        event
        async for event in service.execute(
            "session-1", "same", "execution-2", "cell-2", "error"
        )
    ]
    assert len(rejected) == 1
    assert rejected[0]["type"] == "rejected"
    assert rejected[0]["reason"] == "command-id-conflict"
    assert rejected[0]["cellId"] == "cell-2"


async def test_execution_survives_subscriber_cancellation_and_replays_terminal_events(
    service: RuntimeService,
) -> None:
    manager, _ = await open_session(service)
    stream = service.execute(
        "session-1", "disconnect", "disconnect-execution", "cell-disconnect", "wait"
    )
    accepted = await anext(stream)
    assert accepted["type"] == "accepted"
    pending = asyncio.create_task(anext(stream))
    await asyncio.sleep(0.01)
    pending.cancel()
    with __import__("contextlib").suppress(asyncio.CancelledError):
        await pending
    await stream.aclose()

    await asyncio.sleep(0.1)
    replay = [
        event
        async for event in service.execute(
            "session-1", "disconnect", "disconnect-execution", "cell-disconnect", "wait"
        )
    ]

    assert manager.client_instance.execute_count == 1
    assert any(
        event["type"] == "kernel" and event["state"] in {"idle", "terminated"} for event in replay
    )


async def test_dispose_finalizes_execution_cancelled_before_owner_task_starts(
    service: RuntimeService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await open_session(service)
    original_create_task = asyncio.create_task
    owner_created = asyncio.Event()
    owner_release = asyncio.Event()

    def intercept_owner(coroutine: Any, *args: Any, **kwargs: Any) -> asyncio.Task[Any]:
        code = getattr(coroutine, "cr_code", None)
        if getattr(code, "co_name", None) != "_run_execution":
            return original_create_task(coroutine, *args, **kwargs)

        async def held_owner() -> None:
            try:
                await owner_release.wait()
                await coroutine
            finally:
                if getattr(coroutine, "cr_frame", None) is not None:
                    coroutine.close()

        task = original_create_task(held_owner(), *args, **kwargs)
        owner_created.set()
        return task

    monkeypatch.setattr(asyncio, "create_task", intercept_owner)
    stream = service.execute(
        "session-1",
        "pre-start-cancel",
        "pre-start-cancel-execution",
        "cell-pre-start-cancel",
        "ordered",
    )
    subscriber = original_create_task(anext(stream))
    await asyncio.wait_for(owner_created.wait(), timeout=0.1)
    record = service.sessions["session-1"].commands["pre-start-cancel"]
    owner_task = record.task
    assert owner_task is not None

    await service.dispose("session-1", "dispose-pre-start")
    cancelled = await asyncio.wait_for(subscriber, timeout=0.1)

    assert cancelled["type"] == "rejected"
    assert cancelled["reason"] == "execution-cancelled"
    assert cancelled["cellId"] == "cell-pre-start-cancel"
    assert record.completed.is_set()
    assert owner_task.done()
    with pytest.raises(StopAsyncIteration):
        await anext(stream)


async def test_interrupt_restart_and_dispose_are_ordered(service: RuntimeService) -> None:
    manager, _ = await open_session(service)
    interrupted = await service.interrupt("session-1", "interrupt-1")
    restarted = await service.restart("session-1", "restart-1")
    disposed = await service.dispose("session-1", "dispose-1")

    assert [event["type"] for event in interrupted] == ["accepted", "kernel"]
    assert interrupted[-1]["state"] == "interrupted"
    assert [event["state"] for event in restarted if event["type"] == "kernel"] == [
        "starting",
        "restarted",
        "idle",
    ]
    assert disposed[-1]["state"] == "terminated"
    assert manager.interrupt_count == manager.restart_count == manager.shutdown_count == 1
    assert manager.client_instance.channels_stopped is True


async def test_output_and_time_limits_emit_structured_events(service: RuntimeService) -> None:
    service.output_limit_bytes = 5
    manager, _ = await open_session(service)
    output_events = [
        event
        async for event in service.execute(
            "session-1", "large", "execution-large", "cell-large", "large"
        )
    ]
    streams = [event for event in output_events if event["type"] == "stream"]
    limits = [event for event in output_events if event["type"] == "limit"]
    assert [event["text"] for event in streams] == ["01234"]
    assert limits == [
        {
            "type": "limit",
            "sessionId": "session-1",
            "commandId": "large",
            "executionId": "execution-large",
            "cellId": "cell-large",
            "sequence": limits[0]["sequence"],
            "kind": "output",
            "limit": 5,
            "message": "Execution output exceeded 5 bytes and was truncated.",
        }
    ]

    timed_out = [
        event
        async for event in service.execute(
            "session-1", "wait", "execution-wait", "cell-wait", "wait"
        )
    ]
    assert any(event["type"] == "limit" and event["kind"] == "time" for event in timed_out)
    assert manager.interrupt_count == 1


async def test_timeout_waits_for_real_idle_or_restarts_before_next_execution(
    service: RuntimeService,
) -> None:
    service.timeout_idle_grace_seconds = 0.02
    manager, _ = await open_session(service)
    manager.idle_on_interrupt = True

    drained = [
        event
        async for event in service.execute(
            "session-1", "timeout-drain", "timeout-drain-execution", "cell-timeout-drain", "wait"
        )
    ]

    assert drained[-1] == {
        **drained[-1],
        "type": "kernel",
        "state": "idle",
    }
    assert any(
        item.get("parent_header", {}).get("msg_id") == "execute-1"
        and item.get("content", {}).get("execution_state") == "idle"
        for item in manager.client_instance.delivered_messages
    )
    assert manager.restart_count == 0

    manager.idle_on_interrupt = False
    recovered = [
        event
        async for event in service.execute(
            "session-1",
            "timeout-restart",
            "timeout-restart-execution",
            "cell-timeout-restart",
            "wait",
        )
    ]
    assert [event.get("state") for event in recovered if event["type"] == "kernel"][-3:] == [
        "starting",
        "restarted",
        "idle",
    ]
    assert manager.restart_count == 1

    following = [
        event
        async for event in service.execute(
            "session-1",
            "after-recovery",
            "after-recovery-execution",
            "cell-after-recovery",
            "ordered",
        )
    ]
    assert any(event["type"] == "stream" and event["text"] == "one\n" for event in following)


async def test_resume_returns_only_events_after_sequence(service: RuntimeService) -> None:
    await open_session(service)
    await service.interrupt("session-1", "interrupt-resume")
    events = service.events_after("session-1", 3)
    assert [event["sequence"] for event in events] == [4, 5]


async def test_trimmed_execution_replay_keeps_cell_identity_without_accepted_event(
    service: RuntimeService,
) -> None:
    service.event_history_limit = 2
    await open_session(service)
    events = [
        event
        async for event in service.execute(
            "session-1", "trimmed", "execution-trimmed", "cell-trimmed", "ordered"
        )
    ]
    replay = service.event_replay("session-1", 0)

    assert any(event["type"] == "accepted" for event in events)
    assert all(event["type"] != "accepted" for event in replay["events"])
    assert all(event["cellId"] == "cell-trimmed" for event in replay["events"])


async def test_resume_api_reports_trimmed_history_baseline(service: RuntimeService) -> None:
    service.event_history_limit = 2
    await open_session(service)
    await service.interrupt("session-1", "interrupt-resume")
    app = create_app(service=service, token="test-token")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runtime") as client:
        response = await client.get(
            "/v1/sessions/session-1/events?afterSequence=0",
            headers={"authorization": "Bearer test-token"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "baselineSequence": 3,
        "events": service.events_after("session-1", 0),
    }


async def test_api_requires_bearer_authentication(service: RuntimeService) -> None:
    app = create_app(service=service, token="test-token")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runtime") as client:
        missing = await client.post(
            "/v1/sessions",
            json={"sessionId": "session-api", "commandId": "open-api", "kernelName": "python3"},
        )
        wrong = await client.post(
            "/v1/sessions",
            headers={"authorization": "Bearer wrong"},
            json={"sessionId": "session-api", "commandId": "open-api", "kernelName": "python3"},
        )
        accepted = await client.post(
            "/v1/sessions",
            headers={"authorization": "Bearer test-token"},
            json={"sessionId": "session-api", "commandId": "open-api", "kernelName": "python3"},
        )

    assert missing.status_code == wrong.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json()["events"][-1]["state"] == "idle"


async def test_bootstrap_token_is_claimed_once_before_sessions_exist(
    service: RuntimeService,
) -> None:
    app = create_app(service=service, token="bootstrap-secret", bootstrap_enabled=True)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runtime") as client:
        claimed = await client.post("/v1/bootstrap")
        replay = await client.post("/v1/bootstrap")

    assert claimed.status_code == 200
    assert claimed.json() == {"token": "bootstrap-secret"}
    assert replay.status_code == 409
    assert replay.json() == {"detail": "Bootstrap unavailable."}


async def test_execute_api_streams_ndjson(service: RuntimeService) -> None:
    app = create_app(service=service, token="test-token")
    transport = httpx.ASGITransport(app=app)
    headers = {"authorization": "Bearer test-token"}
    async with httpx.AsyncClient(transport=transport, base_url="http://runtime") as client:
        await client.post(
            "/v1/sessions",
            headers=headers,
            json={"sessionId": "session-api", "commandId": "open-api", "kernelName": "python3"},
        )
        response = await client.post(
            "/v1/sessions/session-api/execute",
            headers=headers,
            json={
                "commandId": "execute-api",
                "executionId": "execution-api",
                "cellId": "cell-api",
                "code": "ordered",
            },
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert '"type":"stream"' in response.text
    accepted = json.loads(response.text.splitlines()[0])
    assert accepted["cellId"] == "cell-api"
