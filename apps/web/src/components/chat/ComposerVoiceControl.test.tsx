import { EnvironmentId, type StudyDocument } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const voiceMocks = vi.hoisted(() => ({
  createVoiceSession: vi.fn(),
  rooms: [] as Array<{
    readonly disconnect: ReturnType<typeof vi.fn>;
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
      setMicrophoneEnabled: vi.fn(async () => undefined),
    };

    constructor() {
      voiceMocks.rooms.push(this);
    }

    on() {
      return this;
    }

    startAudio() {
      return Promise.resolve();
    }

    connect() {
      return Promise.resolve();
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
vi.mock("../artifacts/Scene3DArtifact", () => ({ Scene3DArtifact: () => null }));
vi.mock("../artifacts/studyLiveScene", () => ({ decodeStudyLiveSceneMessage: () => null }));
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
  const button = renderer.root.findByType("button");
  await act(async () => {
    button.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  voiceMocks.createVoiceSession.mockReset();
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
    resolveSession({
      _tag: "Success",
      value: { url: "wss://voice.example.test", token: "token" },
    });
    await startPromise;
    await act(async () => renderer!.unmount());
  });
});
