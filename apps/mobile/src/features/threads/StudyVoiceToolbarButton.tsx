import type { EnvironmentId, StudyDocument } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AudioSession } from "@livekit/react-native";
import { Room, RoomEvent, type Participant } from "livekit-client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Platform } from "react-native";

import { ComposerToolbarButton } from "../../components/ComposerToolbarTrigger";
import { useThemeColor } from "../../lib/useThemeColor";
import { studyEnvironment } from "../../state/study";
import { useAtomCommand } from "../../state/use-atom-command";

type VoicePhase = "idle" | "requesting" | "connecting" | "listening" | "speaking" | "error";

const ACTIVE_PHASES = new Set<VoicePhase>(["requesting", "connecting", "listening", "speaking"]);

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Could not start the voice study session.";
}

async function startNativeAudio(): Promise<void> {
  if (Platform.OS === "android") await AudioSession.startAudioSession();
}

async function stopNativeAudio(): Promise<void> {
  if (Platform.OS === "android") await AudioSession.stopAudioSession();
}

export const StudyVoiceToolbarButton = memo(function StudyVoiceToolbarButton({
  environmentId,
  selectedDocuments,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly selectedDocuments: ReadonlyArray<StudyDocument>;
  readonly disabled: boolean;
}) {
  const activityColor = useThemeColor("--color-icon");
  const createVoiceSession = useAtomCommand(studyEnvironment.createVoiceSession, {
    reportFailure: false,
  });
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const roomRef = useRef<Room | null>(null);
  const requestVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const documentScopeKey = useMemo(
    () => selectedDocuments.map((document) => document.id).join(":"),
    [selectedDocuments],
  );

  const stop = useCallback(() => {
    requestVersionRef.current += 1;
    const room = roomRef.current;
    roomRef.current = null;
    if (mountedRef.current) setPhase("idle");
    if (room) void room.disconnect(true);
    void stopNativeAudio();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  useEffect(() => {
    stop();
  }, [documentScopeKey, environmentId, stop]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") stop();
    });
    return () => subscription.remove();
  }, [stop]);

  const start = useCallback(async () => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    setPhase("requesting");

    const updatePhase = (next: VoicePhase) => {
      if (mountedRef.current && roomRef.current === room) setPhase(next);
    };
    room
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        const agentIsSpeaking = speakers.some(
          (speaker) => speaker.identity !== room.localParticipant.identity,
        );
        updatePhase(agentIsSpeaking ? "speaking" : "listening");
      })
      .on(RoomEvent.Reconnecting, () => updatePhase("connecting"))
      .on(RoomEvent.Reconnected, () => updatePhase("listening"))
      .on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return;
        roomRef.current = null;
        void stopNativeAudio();
        if (mountedRef.current) setPhase("idle");
      });

    const sessionResult = await createVoiceSession({
      environmentId,
      input: { documentIds: selectedDocuments.map((document) => document.id) },
    });
    if (requestVersionRef.current !== requestVersion || roomRef.current !== room) {
      await room.disconnect(true);
      return;
    }
    if (sessionResult._tag === "Failure") {
      roomRef.current = null;
      await room.disconnect(true);
      if (isAtomCommandInterrupted(sessionResult)) {
        if (mountedRef.current) setPhase("idle");
        return;
      }
      const message = errorMessage(squashAtomCommandFailure(sessionResult));
      if (mountedRef.current) {
        setPhase("error");
        Alert.alert("Voice study unavailable", message);
      }
      return;
    }

    try {
      updatePhase("connecting");
      await startNativeAudio();
      if (requestVersionRef.current !== requestVersion || roomRef.current !== room) {
        await stopNativeAudio();
        await room.disconnect(true);
        return;
      }
      await room.connect(sessionResult.value.url, sessionResult.value.token);
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      updatePhase("listening");
    } catch (cause) {
      if (roomRef.current === room) roomRef.current = null;
      await room.disconnect(true);
      await stopNativeAudio();
      if (requestVersionRef.current !== requestVersion || !mountedRef.current) return;
      setPhase("error");
      Alert.alert("Could not join voice study", errorMessage(cause));
    }
  }, [createVoiceSession, environmentId, selectedDocuments]);

  const active = ACTIVE_PHASES.has(phase);
  const pending = phase === "requesting" || phase === "connecting";
  const label =
    phase === "speaking"
      ? "Speaking"
      : phase === "listening"
        ? "Listening"
        : pending
          ? "Connecting…"
          : "Voice";

  return (
    <ComposerToolbarButton
      accessibilityLabel={active ? "End voice study" : "Start voice study"}
      active={active}
      disabled={disabled && !active}
      icon={pending ? undefined : active ? "stop.fill" : "waveform"}
      iconNode={pending ? <ActivityIndicator color={activityColor} size="small" /> : undefined}
      label={label}
      onPress={active ? stop : () => void start()}
      showChevron={false}
      variant={active ? "danger" : "default"}
    />
  );
});
