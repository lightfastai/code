// @vitest-environment happy-dom

import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ChatArtifactAttachment,
  type StudyDocument,
} from "@t3tools/contracts";
import type {
  NotebookArtifactController,
  NotebookRuntimeView,
} from "@t3tools/lightfast-artifact-notebook/runtime";
import type {
  NotebookArtifactPayload,
  NotebookRevision,
} from "@t3tools/lightfast-artifact-notebook/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const controllerMocks = vi.hoisted(() => ({
  controller: {
    readRevision: vi.fn(),
    saveRevision: vi.fn(),
    importRevision: vi.fn(),
    exportRevision: vi.fn(),
    downloadExport: vi.fn(),
    connect: vi.fn(),
    recover: vi.fn(),
    executeCell: vi.fn(),
    removeCell: vi.fn(),
    interrupt: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
    clearError: vi.fn(),
  },
}));

const permissionMocks = vi.hoisted(() => ({
  change: vi.fn(),
  permission: {
    status: "denied" as const,
    label: "Agent execution is blocked for this thread. Your Run controls are always allowed.",
  },
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const container =
    (tag: string) =>
    ({
      accessibilityLabel,
      children,
      ...props
    }: {
      readonly accessibilityLabel?: string;
      readonly children?: React.ReactNode;
      readonly [key: string]: unknown;
    }) =>
      React.createElement(tag, { ...props, "aria-label": accessibilityLabel }, children);
  return {
    ActivityIndicator: () => React.createElement("span", { role: "progressbar" }),
    Image: ({
      accessibilityLabel,
      source,
    }: {
      readonly accessibilityLabel?: string;
      readonly source: { readonly uri: string };
    }) => React.createElement("img", { alt: accessibilityLabel, src: source.uri }),
    Pressable: ({
      accessibilityLabel,
      children,
      disabled,
      onPress,
    }: {
      readonly accessibilityLabel?: string;
      readonly children?: React.ReactNode;
      readonly disabled?: boolean;
      readonly onPress?: () => void;
    }) =>
      React.createElement(
        "button",
        { "aria-label": accessibilityLabel, disabled, onClick: onPress },
        children,
      ),
    ScrollView: container("div"),
    TextInput: ({
      accessibilityLabel,
      editable,
      onChangeText,
      value,
    }: {
      readonly accessibilityLabel?: string;
      readonly editable?: boolean;
      readonly onChangeText?: (value: string) => void;
      readonly value?: string;
    }) =>
      React.createElement("textarea", {
        "aria-label": accessibilityLabel,
        disabled: editable === false,
        onInput: (event: React.FormEvent<HTMLTextAreaElement>) =>
          onChangeText?.(event.currentTarget.value),
        value,
      }),
    View: container("div"),
  };
});

vi.mock("react-native-svg", () => ({ SvgXml: () => null }));
vi.mock("../../../components/AppText", async () => {
  const React = await import("react");
  return {
    AppText: ({ children }: { readonly children?: React.ReactNode }) =>
      React.createElement("span", null, children),
  };
});
vi.mock("./useNotebookArtifactController", () => ({
  useNotebookArtifactController: () =>
    controllerMocks.controller as unknown as NotebookArtifactController,
}));
vi.mock("./useNotebookAgentExecutionPermission", () => ({
  useNotebookAgentExecutionPermission: () => ({
    ...permissionMocks.permission,
    change: permissionMocks.change,
  }),
}));

import { NotebookArtifactCard } from "./NotebookArtifactCard";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const referencedRevisionId = "a".repeat(64);
const latestRevisionId = "b".repeat(64);
const selectedDocumentId = "c".repeat(64);

const runtimeState = (
  kernelStatus: NotebookRuntimeView["kernelStatus"],
  runningCellIds: ReadonlySet<string> = new Set(),
): NotebookRuntimeView => ({
  kernelStatus,
  lastSequence: 1,
  recoveryAfterSequence: null,
  outputsByCell: new Map(),
  outputKeysByCell: new Map(),
  outputRetentionByCell: new Map(),
  executionCountByCell: new Map(),
  runningCellIds,
  error: null,
});

const revision = (
  revisionId = referencedRevisionId,
  source = "print('hello')",
): NotebookRevision => ({
  documentId: "notebook-1",
  revisionId,
  contentHash: revisionId,
  kernel: { name: "python3", displayName: "Python 3", language: "python" },
  createdAt: "2026-07-25T00:00:00.000Z",
  document: {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
    },
    cells: [
      {
        cell_type: "code",
        id: "code-1",
        metadata: {},
        source,
        execution_count: null,
        outputs: [],
      },
    ],
  },
});

function artifact(documentIds?: ReadonlyArray<string>): ChatArtifactAttachment {
  const payload: NotebookArtifactPayload = {
    documentId: "notebook-1",
    revisionId: referencedRevisionId,
    contentHash: "d".repeat(64),
    kernel: { name: "python3", displayName: "Python 3", language: "python" },
    initialView: { mode: "notebook" },
    ...(documentIds === undefined ? {} : { documentIds: [...documentIds] }),
  };
  return {
    type: "artifact",
    id: "artifact-1",
    kind: "notebook",
    schemaVersion: 1,
    title: "Analysis notebook",
    payload,
  };
}

const studyDocument = {
  id: selectedDocumentId,
  title: "Algorithms",
} as StudyDocument;

const roots: Root[] = [];

function renderCard(
  connectionPhase: EnvironmentConnectionPhase,
  notebookArtifact = artifact([selectedDocumentId]),
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (phase = connectionPhase, nextArtifact = notebookArtifact) => {
    act(() => {
      root.render(
        <NotebookArtifactCard
          artifact={nextArtifact}
          environmentId={environmentId}
          projectId={projectId}
          threadId={threadId}
          connectionPhase={phase}
          studyDocuments={[studyDocument]}
        />,
      );
    });
  };
  render();
  return { container, render };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (match === null) throw new Error(`Missing button: ${label}`);
  return match;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
  await flushEffects();
}

async function changeSource(target: HTMLTextAreaElement, source: string): Promise<void> {
  await act(async () => {
    target.value = source;
    target.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  controllerMocks.controller.readRevision.mockResolvedValue(revision());
  controllerMocks.controller.saveRevision.mockResolvedValue(
    revision(latestRevisionId, "print('changed')"),
  );
  controllerMocks.controller.connect.mockImplementation(async (request) => {
    request.onState(runtimeState("idle"));
  });
  controllerMocks.controller.executeCell.mockImplementation(async (request) => {
    request.onState(runtimeState("busy", new Set([request.cellId])));
  });
  controllerMocks.controller.interrupt.mockImplementation(async (request) => {
    request.onState(runtimeState("idle"));
  });
  controllerMocks.controller.restart.mockResolvedValue(undefined);
  controllerMocks.controller.recover.mockResolvedValue(undefined);
  controllerMocks.controller.dispose.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

describe("NotebookArtifactCard interactions", () => {
  it("shows loading and load failure, then retries through the public Retry control", async () => {
    let rejectInitial!: (cause: Error) => void;
    controllerMocks.controller.readRevision
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectInitial = reject;
          }),
      )
      .mockResolvedValueOnce(revision());
    const { container } = renderCard("connected");

    expect(container.textContent).toContain("Loading notebook revision");
    await act(async () => rejectInitial(new Error("Paired Mac unavailable")));

    expect(container.textContent).toContain("Could not load notebook: Paired Mac unavailable");
    await click(button(container, "Retry notebook load"));

    expect(controllerMocks.controller.readRevision).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Code [");
  });

  it("keeps cached content visible but locks every mutation offline and while reconnecting", async () => {
    const { container, render } = renderCard("offline");
    await flushEffects();

    expect(container.textContent).toContain("Paired Mac offline");
    expect(container.textContent).toContain("Algorithms");
    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit code cell code-1"]',
    );
    expect(editor?.disabled).toBe(true);
    expect(button(container, "Run cell code-1").disabled).toBe(true);
    expect(button(container, "Reconnect runtime").disabled).toBe(true);
    expect(button(container, "Save immutable revision").disabled).toBe(true);
    expect(button(container, "Allow agent notebook execution").disabled).toBe(true);

    render("reconnecting");
    await flushEffects();
    expect(container.textContent).toContain("Reconnecting to paired Mac");
    expect(editor?.disabled).toBe(true);
  });

  it("keeps omitted selected-book IDs stable instead of reconnecting after state publication", async () => {
    let published = false;
    controllerMocks.controller.connect.mockImplementation(async (request) => {
      if (!published) {
        published = true;
        request.onState(runtimeState("idle"));
      }
    });
    const { container } = renderCard("connected", artifact());
    await flushEffects();
    await flushEffects();

    expect(container.textContent).toContain("No books mounted");
    expect(controllerMocks.controller.connect).toHaveBeenCalledTimes(1);
  });

  it("drives Run, Interrupt, Restart, Save, Reference/Latest, and agent permission controls", async () => {
    const { container } = renderCard("connected");
    await flushEffects();

    expect(container.textContent).toContain("Algorithms");
    await click(button(container, "Run cell code-1"));
    expect(controllerMocks.controller.executeCell).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: "code-1", code: "print('hello')" }),
    );

    await click(button(container, "Interrupt execution"));
    expect(controllerMocks.controller.interrupt).toHaveBeenCalledTimes(1);

    await click(button(container, "Restart / Reconnect"));
    expect(controllerMocks.controller.restart).toHaveBeenCalledTimes(1);
    expect(controllerMocks.controller.recover).toHaveBeenCalledTimes(1);

    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit code cell code-1"]',
    );
    if (editor === null) throw new Error("Missing code editor");
    await changeSource(editor, "print('changed')");
    await click(button(container, "Save immutable revision"));
    expect(controllerMocks.controller.saveRevision).toHaveBeenCalledTimes(1);

    await click(button(container, "View referenced revision"));
    expect(container.textContent).toContain("Referenced revision");
    await click(button(container, "Open latest saved revision"));
    expect(container.textContent).toContain("Latest saved revision");

    await click(button(container, "Allow agent notebook execution"));
    expect(permissionMocks.change).toHaveBeenCalledTimes(1);
  });

  it("reconnects a disconnected runtime through the public Reconnect control", async () => {
    controllerMocks.controller.connect.mockResolvedValue(undefined);
    const { container } = renderCard("connected");
    await flushEffects();
    const initialConnectCount = controllerMocks.controller.connect.mock.calls.length;

    await click(button(container, "Reconnect runtime"));

    expect(controllerMocks.controller.connect).toHaveBeenCalledTimes(initialConnectCount + 1);
  });
});
