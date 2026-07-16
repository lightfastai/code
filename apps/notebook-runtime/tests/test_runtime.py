from __future__ import annotations

import asyncio
from collections import deque
from typing import Any

import httpx
import pytest

from runtime import RuntimeService, create_app


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

    def start_channels(self) -> None:
        self.channels_started = True

    def stop_channels(self) -> None:
        self.channels_stopped = True

    async def wait_for_ready(self, timeout: float) -> None:
        assert timeout > 0

    def execute(self, code: str, *, allow_stdin: bool, stop_on_error: bool) -> str:
        assert allow_stdin is False
        assert stop_on_error is True
        self.execute_count += 1
        msg_id = f"execute-{self.execute_count}"
        if code == "ordered":
            self.messages.extend(
                [
                    message("stream", {"name": "stdout", "text": "ignored"}, parent_id="other"),
                    message("status", {"execution_state": "busy"}, parent_id=msg_id),
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
                    message(
                        "error",
                        {"ename": "ValueError", "evalue": "boom", "traceback": ["trace"]},
                        parent_id=msg_id,
                    ),
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
            return self.messages.popleft()
        await asyncio.sleep(min(timeout, 0.01))
        raise TimeoutError


class FakeKernelManager:
    def __init__(self, kernel_name: str) -> None:
        self.kernel_name = kernel_name
        self.client_instance = FakeKernelClient()
        self.started = False
        self.interrupt_count = 0
        self.restart_count = 0
        self.shutdown_count = 0
        self.cwd: str | None = None

    async def start_kernel(self, *, cwd: str) -> None:
        self.started = True
        self.cwd = cwd

    def client(self) -> FakeKernelClient:
        return self.client_instance

    async def interrupt_kernel(self) -> None:
        self.interrupt_count += 1

    async def restart_kernel(self, *, now: bool) -> None:
        assert now is True
        self.restart_count += 1

    async def shutdown_kernel(self, *, now: bool) -> None:
        assert now is True
        self.shutdown_count += 1


@pytest.fixture
def service(tmp_path: Any) -> RuntimeService:
    return RuntimeService(
        kernel_factory=FakeKernelManager,
        workspace_root=tmp_path,
        output_limit_bytes=1024,
        execution_timeout_seconds=0.03,
    )


async def open_session(service: RuntimeService) -> tuple[FakeKernelManager, list[dict[str, Any]]]:
    events = await service.open_session("session-1", "open-1", "python3")
    manager = service.sessions["session-1"].manager
    assert isinstance(manager, FakeKernelManager)
    return manager, events


async def test_orders_matching_iopub_messages_through_idle(service: RuntimeService) -> None:
    _, opened = await open_session(service)
    events = [
        event async for event in service.execute("session-1", "command-1", "execution-1", "ordered")
    ]

    assert [event["type"] for event in opened] == ["accepted", "kernel", "kernel"]
    assert [event["type"] for event in events] == [
        "accepted",
        "kernel",
        "stream",
        "display",
        "result",
        "kernel",
    ]
    assert events[1]["state"] == "busy"
    assert events[2]["text"] == "one\n"
    assert events[3]["data"] == {"image/png": "cG5n"}
    assert events[4]["executionCount"] == 7
    assert events[-1]["state"] == "idle"
    assert [event["sequence"] for event in [*opened, *events]] == list(range(1, 10))


async def test_normalizes_kernel_errors(service: RuntimeService) -> None:
    await open_session(service)
    events = [
        event
        async for event in service.execute("session-1", "command-error", "execution-error", "error")
    ]
    error = next(event for event in events if event["type"] == "error")
    assert error == {
        "type": "error",
        "sessionId": "session-1",
        "commandId": "command-error",
        "executionId": "execution-error",
        "sequence": error["sequence"],
        "ename": "ValueError",
        "evalue": "boom",
        "traceback": ["trace"],
    }


async def test_duplicate_command_replays_without_executing_twice(service: RuntimeService) -> None:
    manager, _ = await open_session(service)
    first = [
        event async for event in service.execute("session-1", "same", "execution-1", "ordered")
    ]
    replay = [
        event async for event in service.execute("session-1", "same", "execution-1", "ordered")
    ]
    assert replay == first
    assert manager.client_instance.execute_count == 1

    rejected = [
        event async for event in service.execute("session-1", "same", "execution-2", "error")
    ]
    assert len(rejected) == 1
    assert rejected[0]["type"] == "rejected"
    assert rejected[0]["reason"] == "command-id-conflict"


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
        event async for event in service.execute("session-1", "large", "execution-large", "large")
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
            "sequence": limits[0]["sequence"],
            "kind": "output",
            "limit": 5,
            "message": "Execution output exceeded 5 bytes and was truncated.",
        }
    ]

    timed_out = [
        event async for event in service.execute("session-1", "wait", "execution-wait", "wait")
    ]
    assert any(event["type"] == "limit" and event["kind"] == "time" for event in timed_out)
    assert manager.interrupt_count == 1


async def test_resume_returns_only_events_after_sequence(service: RuntimeService) -> None:
    await open_session(service)
    await service.interrupt("session-1", "interrupt-resume")
    events = service.events_after("session-1", 3)
    assert [event["sequence"] for event in events] == [4, 5]


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
            json={"commandId": "execute-api", "executionId": "execution-api", "code": "ordered"},
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert '"type":"stream"' in response.text
