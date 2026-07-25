import { EnvironmentId, StudyLiveSceneTopic, type StudyDocument } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const voiceMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  createVoiceSession: vi.fn(),
  setMicrophoneEnabled: vi.fn(),
  startAudio: vi.fn(),
  rooms: [] as Array<{
    readonly disconnect: ReturnType<typeof vi.fn>;
    emit(event: string, ...args: ReadonlyArray<unknown>): void;
  }>,
}));

vi.mock("../../state/study", () => ({ studyEnvironment: { createVoiceSession: {} } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => voiceMocks.createVoiceSession,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (failure: unknown) => failure,
}));
vi.mock("livekit-client", () => ({
  Room: class RoomMock {
    readonly disconnect = vi.fn(async () => undefined);
    readonly localParticipant = {
      identity: "local-user",
      setMicrophoneEnabled: voiceMocks.setMicrophoneEnabled,
    };
    readonly handlers = new Map<string, (...args: ReadonlyArray<unknown>) => void>();

    constructor() {
      voiceMocks.rooms.push(this);
    }

    on(event: string, handler: (...args: ReadonlyArray<unknown>) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    emit(event: string, ...args: ReadonlyArray<unknown>) {
      this.handlers.get(event)?.(...args);
    }

    startAudio() {
      return voiceMocks.startAudio();
    }

    connect() {
      return voiceMocks.connect();
    }
  },
  RoomEvent: {
    TrackSubscribed: "TrackSubscribed",
    TrackUnsubscribed: "TrackUnsubscribed",
    ActiveSpeakersChanged: "ActiveSpeakersChanged",
    DataReceived: "DataReceived",
    Reconnecting: "Reconnecting",
    Reconnected: "Reconnected",
    Disconnected: "Disconnected",
  },
  Track: { Kind: { Audio: "audio" } },
}));
vi.mock("lucide-react", () => ({
  AudioLinesIcon: () => <span />,
  LoaderCircleIcon: () => <span />,
  MicIcon: () => <span />,
  MicOffIcon: () => <span />,
  XIcon: () => <span />,
}));
vi.mock("../artifacts/Scene3DArtifact", () => ({
  Scene3DArtifact: ({ artifact }: { readonly artifact: { readonly title: string } }) => (
    <span data-scene-title={artifact.title}>{artifact.title}</span>
  ),
}));
vi.mock("../ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ render }: { readonly render: React.ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("~/lib/utils", () => ({
  cn: (...values: ReadonlyArray<unknown>) => values.filter(Boolean).join(" "),
}));

import { ComposerVoiceControl } from "./ComposerVoiceControl";

const environmentId = EnvironmentId.make("environment-1");

function studyDocument(id: string): StudyDocument {
  return {
    id: id.repeat(64),
    sha256: id.repeat(64),
    format: "pdf",
    title: `Document ${id}`,
    fileName: `${id}.pdf`,
    objectKey: `objects/${id}`,
    sizeBytes: 1,
    tags: [],
    importedAt: "2026-07-17T00:00:00.000Z",
  } as StudyDocument;
}

function renderControl(selectedDocuments: ReadonlyArray<StudyDocument>) {
  return (
    <ComposerVoiceControl
      environmentId={environmentId}
      selectedDocuments={selectedDocuments}
      compact={false}
      disabled={false}
    />
  );
}

async function startVoice(renderer: ReactTestRenderer): Promise<void> {
  const button = renderer.root.findByProps({ "aria-label": "Start voice study" });
  await act(async () => {
    button.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function sceneMessage(sequence: number, title: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: "study.scene.replace",
      version: 1,
      sequence,
      artifact: {
        type: "artifact",
        id: `voice-scene-${sequence}`,
        kind: "3d-scene",
        schemaVersion: 1,
        title,
        payload: {
          objects: [{ type: "vector", id: "v", start: [0, 0, 0], end: [1, 1, 0] }],
        },
      },
    }),
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const successfulSession = {
  _tag: "Success",
  value: { url: "wss://voice.example.test", token: "token" },
} as const;

beforeEach(() => {
  voiceMocks.connect.mockReset().mockResolvedValue(undefined);
  voiceMocks.createVoiceSession.mockReset();
  voiceMocks.setMicrophoneEnabled.mockReset().mockResolvedValue(undefined);
  voiceMocks.startAudio.mockReset().mockResolvedValue(undefined);
  voiceMocks.rooms.length = 0;
});

describe("ComposerVoiceControl document scope", () => {
  it("keeps an active room for a new ID-equivalent selection array", async () => {
    voiceMocks.createVoiceSession.mockResolvedValue({
      _tag: "Success",
      value: { url: "wss://voice.example.test", token: "token" },
    });
    const first = studyDocument("a");
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderControl([first]));
    });
    await startVoice(renderer!);

    await act(async () => {
      renderer!.update(renderControl([{ ...first }]));
    });

    expect(voiceMocks.rooms[0]?.disconnect).not.toHaveBeenCalled();
    await act(async () => renderer!.unmount());
  });

  it("stops a preparing room when selected document IDs change", async () => {
    let resolveSession!: (value: unknown) => void;
    voiceMocks.createVoiceSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderControl([studyDocument("a")]));
    });
    const startPromise = startVoice(renderer!);
    await act(async () => {
      await Promise.resolve();
      renderer!.update(renderControl([studyDocument("b")]));
    });

    expect(voiceMocks.rooms[0]?.disconnect).toHaveBeenCalledWith(true);
    await act(async () => {
      resolveSession(successfulSession);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(voiceMocks.rooms[0]?.disconnect).toHaveBeenCalledTimes(2);
    await startPromise;
    await act(async () => renderer!.unmount());
  });
});

describe("ComposerVoiceControl live scene lifecycle", () => {
  it("resets the scene sequence when a room disconnects naturally", async () => {
    voiceMocks.createVoiceSession.mockResolvedValue({
      _tag: "Success",
      value: { url: "wss://voice.example.test", token: "token" },
    });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderControl([studyDocument("a")]));
    });
    await startVoice(renderer!);

    const roomA = voiceMocks.rooms[0]!;
    await act(async () => {
      roomA.emit(
        "DataReceived",
        sceneMessage(5, "Room A scene"),
        undefined,
        undefined,
        StudyLiveSceneTopic,
      );
    });
    expect(renderer!.root.findByProps({ "aria-label": "Live voice study scene" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-scene-title": "Room A scene" })).toBeDefined();

    await act(async () => {
      roomA.emit("Disconnected");
    });
    expect(renderer!.root.findAllByProps({ "aria-label": "Live voice study scene" })).toHaveLength(
      0,
    );
    expect(roomA.disconnect).not.toHaveBeenCalled();

    await startVoice(renderer!);
    const roomB = voiceMocks.rooms[1]!;
    await act(async () => {
      roomB.emit(
        "DataReceived",
        sceneMessage(0, "Room B scene"),
        undefined,
        undefined,
        StudyLiveSceneTopic,
      );
    });

    expect(renderer!.root.findByProps({ "aria-label": "Live voice study scene" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-scene-title": "Room B scene" })).toBeDefined();
    await act(async () => renderer!.unmount());
  });
});

describe("ComposerVoiceControl startup teardown ownership", () => {
  it("does not disconnect again when natural disconnect settles session creation", async () => {
    const session = deferred<typeof successfulSession>();
    voiceMocks.createVoiceSession.mockReturnValue(session.promise);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderControl([studyDocument("a")]));
    });
    await startVoice(renderer!);

    const room = voiceMocks.rooms[0]!;
    await act(async () => {
      room.emit("Disconnected");
      session.resolve(successfulSession);
      await session.promise;
      await Promise.resolve();
    });

    expect(room.disconnect).not.toHaveBeenCalled();
    await act(async () => renderer!.unmount());
  });

  it("does not disconnect again when natural disconnect settles room connection", async () => {
    const connection = deferred<void>();
    voiceMocks.createVoiceSession.mockResolvedValue(successfulSession);
    voiceMocks.connect.mockReturnValue(connection.promise);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderControl([studyDocument("a")]));
    });
    await startVoice(renderer!);
    expect(voiceMocks.connect).toHaveBeenCalledOnce();

    const room = voiceMocks.rooms[0]!;
    await act(async () => {
      room.emit("Disconnected");
      connection.resolve();
      await connection.promise;
      await Promise.resolve();
    });

    expect(room.disconnect).not.toHaveBeenCalled();
    await act(async () => renderer!.unmount());
  });

  it("does not disconnect again when microphone startup rejects after natural disconnect", async () => {
    const microphone = deferred<void>();
    voiceMocks.createVoiceSession.mockResolvedValue(successfulSession);
    voiceMocks.setMicrophoneEnabled.mockReturnValue(microphone.promise);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderControl([studyDocument("a")]));
    });
    await startVoice(renderer!);
    expect(voiceMocks.setMicrophoneEnabled).toHaveBeenCalledOnce();

    const room = voiceMocks.rooms[0]!;
    await act(async () => {
      room.emit("Disconnected");
      microphone.reject(new Error("room closed"));
      await microphone.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(room.disconnect).not.toHaveBeenCalled();
    await act(async () => renderer!.unmount());
  });

  it("does not disconnect again when final audio startup rejects after natural disconnect", async () => {
    const audio = deferred<void>();
    voiceMocks.createVoiceSession.mockResolvedValue(successfulSession);
    voiceMocks.startAudio.mockResolvedValueOnce(undefined).mockReturnValueOnce(audio.promise);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderControl([studyDocument("a")]));
    });
    await startVoice(renderer!);
    expect(voiceMocks.startAudio).toHaveBeenCalledTimes(2);

    const room = voiceMocks.rooms[0]!;
    await act(async () => {
      room.emit("Disconnected");
      audio.reject(new Error("room closed"));
      await audio.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(room.disconnect).not.toHaveBeenCalled();
    await act(async () => renderer!.unmount());
  });
});
