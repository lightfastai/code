from agent import _is_early_room_disconnect


def test_recognizes_expected_disconnect_while_waiting_for_participant() -> None:
    assert _is_early_room_disconnect(
        RuntimeError("room disconnected while waiting for participant")
    )
    assert not _is_early_room_disconnect(RuntimeError("failed to initialize participant"))
