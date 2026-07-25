import {
  StudyLiveSceneTopic,
  type ChatScene3DArtifact,
  type EnvironmentId,
  type StudyDocument,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Room, RoomEvent, Track, type Participant, type RemoteTrack } from "livekit-client";
import { AudioLinesIcon, LoaderCircleIcon, MicIcon, MicOffIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { studyEnvironment } from "../../state/study";
import { useAtomCommand } from "../../state/use-atom-command";
import { Scene3DArtifact } from "../artifacts/Scene3DArtifact";
import { decodeStudyLiveSceneMessage } from "../artifacts/studyLiveScene";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type VoicePhase = "idle" | "requesting" | "connecting" | "listening" | "speaking" | "error";

interface TeardownVoiceSessionOptions {
  readonly disconnectRoom: boolean;
}

const ACTIVE_PHASES = new Set<VoicePhase>(["requesting", "connecting", "listening", "speaking"]);

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Could not start the voice study session.";
}

function detachTrack(track: RemoteTrack): void {
  for (const element of track.detach()) {
    element.remove();
  }
}

export const ComposerVoiceControl = memo(function ComposerVoiceControl({
  environmentId,
  selectedDocuments,
  compact,
  disabled,
}: {
  environmentId: EnvironmentId;
  selectedDocuments: ReadonlyArray<StudyDocument>;
  compact: boolean;
  disabled: boolean;
}) {
  const createVoiceSession = useAtomCommand(studyEnvironment.createVoiceSession, {
    reportFailure: false,
  });
  const documentIds = useMemo(
    () => [...new Set(selectedDocuments.map((document) => document.id))].sort(),
    [selectedDocuments],
  );
  const scopeKey = JSON.stringify([environmentId, ...documentIds]);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [liveArtifact, setLiveArtifact] = useState<ChatScene3DArtifact | null>(null);
  const roomRef = useRef<Room | null>(null);
  const liveSequenceRef = useRef(-1);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const requestVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const scopeKeyRef = useRef(scopeKey);

  const clearOutput = useCallback(() => {
    outputRef.current?.replaceChildren();
  }, []);

  const teardownVoiceSession = useCallback(
    (room: Room | null, { disconnectRoom }: TeardownVoiceSessionOptions) => {
      if (room !== null && roomRef.current !== room) return;

      requestVersionRef.current += 1;
      roomRef.current = null;
      liveSequenceRef.current = -1;
      clearOutput();
      if (mountedRef.current) {
        setPhase("idle");
        setLiveArtifact(null);
      }
      if (disconnectRoom && room) void room.disconnect(true);
    },
    [clearOutput],
  );

  const stop = useCallback(() => {
    const room = roomRef.current;
    teardownVoiceSession(room, { disconnectRoom: true });
  }, [teardownVoiceSession]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  useEffect(() => {
    if (scopeKeyRef.current === scopeKey) return;
    scopeKeyRef.current = scopeKey;
    stop();
  }, [scopeKey, stop]);

  const start = useCallback(async () => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    setPhase("requesting");

    // Prime browser audio during the click gesture; reconnecting after the RPC would
    // otherwise leave Safari/Chrome waiting for a second user interaction.
    void room.startAudio().catch(() => undefined);

    const updatePhase = (next: VoicePhase) => {
      if (mountedRef.current && roomRef.current === room) setPhase(next);
    };
    room
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const element = track.attach();
        element.dataset.studyVoiceAudio = "true";
        outputRef.current?.append(element);
      })
      .on(RoomEvent.TrackUnsubscribed, detachTrack)
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        const agentIsSpeaking = speakers.some(
          (speaker) => speaker.identity !== room.localParticipant.identity,
        );
        updatePhase(agentIsSpeaking ? "speaking" : "listening");
      })
      .on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
        if (topic !== StudyLiveSceneTopic || payload.byteLength > 256 * 1024) return;
        const message = decodeStudyLiveSceneMessage(payload);
        if (!message || message.sequence <= liveSequenceRef.current) return;
        liveSequenceRef.current = message.sequence;
        if (mountedRef.current && roomRef.current === room) {
          setLiveArtifact(message.type === "study.scene.replace" ? message.artifact : null);
        }
      })
      .on(RoomEvent.Reconnecting, () => updatePhase("connecting"))
      .on(RoomEvent.Reconnected, () => updatePhase("listening"))
      .on(RoomEvent.Disconnected, () => {
        teardownVoiceSession(room, { disconnectRoom: false });
      });

    const sessionResult = await createVoiceSession({
      environmentId,
      input: { documentIds },
    });
    if (requestVersionRef.current !== requestVersion || roomRef.current !== room) {
      await room.disconnect(true);
      return;
    }
    if (sessionResult._tag === "Failure") {
      roomRef.current = null;
      await room.disconnect(true);
      if (isAtomCommandInterrupted(sessionResult)) {
        if (mountedRef.current && requestVersionRef.current === requestVersion) setPhase("idle");
        return;
      }
      const message = errorMessage(squashAtomCommandFailure(sessionResult));
      if (mountedRef.current && requestVersionRef.current === requestVersion) setPhase("error");
      toastManager.add({ type: "error", title: "Voice study unavailable", description: message });
      return;
    }

    try {
      updatePhase("connecting");
      await room.connect(sessionResult.value.url, sessionResult.value.token);
      if (requestVersionRef.current !== requestVersion || roomRef.current !== room) {
        await room.disconnect(true);
        return;
      }
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      await room.startAudio();
      updatePhase("listening");
    } catch (cause) {
      if (roomRef.current === room) roomRef.current = null;
      await room.disconnect(true);
      if (requestVersionRef.current !== requestVersion) return;
      const message = errorMessage(cause);
      if (mountedRef.current) setPhase("error");
      toastManager.add({
        type: "error",
        title: "Could not join voice study",
        description: message,
      });
    }
  }, [createVoiceSession, documentIds, environmentId, teardownVoiceSession]);

  const active = ACTIVE_PHASES.has(phase);
  const pending = phase === "requesting" || phase === "connecting";
  const label =
    phase === "requesting"
      ? "Preparing voice study"
      : phase === "connecting"
        ? "Connecting voice study"
        : phase === "speaking"
          ? "Study agent speaking"
          : phase === "listening"
            ? "Voice study listening"
            : phase === "error"
              ? "Retry voice study"
              : "Start voice study";
  const Icon = pending
    ? LoaderCircleIcon
    : phase === "speaking"
      ? AudioLinesIcon
      : active
        ? MicOffIcon
        : MicIcon;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size={compact ? "icon-sm" : "sm"}
              variant="ghost"
              disabled={disabled && !active}
              aria-label={active ? "End voice study" : label}
              aria-pressed={active}
              className={cn(
                "shrink-0",
                active && "bg-rose-500/10 text-rose-500 hover:bg-rose-500/15 hover:text-rose-400",
              )}
              onClick={() => {
                if (active) stop();
                else void start();
              }}
            />
          }
        >
          <Icon className={cn("size-4", pending && "animate-spin")} />
          {!compact && <span>{phase === "speaking" ? "Speaking" : active ? "Live" : "Voice"}</span>}
        </TooltipTrigger>
        <TooltipPopup side="top">{active ? `${label} — click to end` : label}</TooltipPopup>
      </Tooltip>
      <div ref={outputRef} className="hidden" aria-hidden="true" />
      {liveArtifact ? (
        <aside
          className="fixed right-4 bottom-20 z-50 w-[min(46rem,calc(100vw-2rem))] drop-shadow-2xl"
          aria-label="Live voice study scene"
          aria-live="polite"
        >
          <button
            type="button"
            className="absolute top-5 right-2 z-10 inline-flex size-8 cursor-pointer items-center justify-center rounded-md bg-black/55 text-white/75 backdrop-blur transition-colors hover:bg-black/75 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            aria-label="Hide live 3D scene"
            onClick={() => setLiveArtifact(null)}
          >
            <XIcon className="size-4" />
          </button>
          <Scene3DArtifact artifact={liveArtifact} />
        </aside>
      ) : null}
    </>
  );
});
