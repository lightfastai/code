// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import { Fragment } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { NotebookRevision } from "./contracts.ts";
import { notebookRuntimeTarget } from "./runtime-lifecycle.ts";
import { NotebookArtifactEnvelopeRenderer } from "./web-renderer.tsx";
import {
  NotebookWebProvider,
  type NotebookArtifactController,
  type NotebookRuntimeView,
  type NotebookWebBindings,
} from "./web.tsx";
import { createNotebookWorkingCopy } from "./working-copy.ts";

const hash = (character: string) => character.repeat(64);
const scope = { environmentId: "environment-1", projectId: "project-1" } as const;

const revision = (revisionCharacter: string, source: string): NotebookRevision => ({
  documentId: "same-document",
  revisionId: hash(revisionCharacter),
  contentHash: hash(revisionCharacter),
  kernel: { name: "python3", displayName: "Python 3", language: "python" },
  createdAt: "2026-07-17T00:00:00.000Z",
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

const artifact = (id: string, title: string, value: NotebookRevision): ArtifactEnvelope => ({
  type: "artifact",
  id,
  kind: "notebook",
  schemaVersion: 1,
  title,
  payload: {
    documentId: value.documentId,
    revisionId: value.revisionId,
    contentHash: value.contentHash,
    kernel: value.kernel,
    initialView: { mode: "notebook" },
  },
  capabilities: ["execute", "edit", "export"],
});

const runtime = (options?: {
  readonly output?: string;
  readonly running?: boolean;
}): NotebookRuntimeView => ({
  kernelStatus: options?.running ? "busy" : "idle",
  lastSequence: options?.output ? 3 : 1,
  recoveryAfterSequence: null,
  outputsByCell: options?.output
    ? new Map([
        [
          "code-1",
          [{ output_type: "stream" as const, name: "stdout" as const, text: options.output }],
        ],
      ])
    : new Map(),
  outputKeysByCell: new Map(),
  outputRetentionByCell: new Map(),
  executionCountByCell: options?.output ? new Map([["code-1", 1]]) : new Map(),
  runningCellIds: options?.running ? new Set(["code-1"]) : new Set(),
  error: null,
});

const controller = (overrides: Partial<NotebookArtifactController>): NotebookArtifactController =>
  ({
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
    ...overrides,
  }) as NotebookArtifactController;

const bindings = (value: NotebookArtifactController): NotebookWebBindings => ({
  scope,
  controller: value,
  agentExecutionPermission: { status: "denied", label: "Agent execution blocked" },
});

const mount = async (
  value: NotebookWebBindings,
  ...artifacts: ReadonlyArray<ArtifactEnvelope>
): Promise<RenderResult> => {
  const renderer = render(
    <NotebookWebProvider bindings={value}>
      <Fragment>
        {artifacts.map((item) => (
          <NotebookArtifactEnvelopeRenderer key={item.id} artifact={item} />
        ))}
      </Fragment>
    </NotebookWebProvider>,
  );
  await waitFor(() => {
    for (const item of artifacts) {
      expect(renderer.getByRole("article", { name: `Notebook: ${item.title}` })).toBeTruthy();
    }
  });
  return renderer;
};

const article = (renderer: RenderResult, title: string): HTMLElement =>
  renderer.getByRole("article", { name: `Notebook: ${title}` });

const button = (renderer: RenderResult, label: string): HTMLButtonElement =>
  renderer.getByRole("button", { name: label }) as HTMLButtonElement;

const deferred = <Value = void,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve } as const;
};

const expectWorkingCopyMutationControlsDisabled = (
  renderer: RenderResult,
  disabled: boolean,
): void => {
  expect(button(renderer, "Add Markdown cell").disabled).toBe(disabled);
  expect(button(renderer, "Add code cell").disabled).toBe(disabled);
  expect(button(renderer, "Duplicate cell").disabled).toBe(disabled);
  expect(button(renderer, "Remove cell").disabled).toBe(disabled);
  expect(button(renderer, "Import .ipynb").disabled).toBe(disabled);
  expect(
    (renderer.getByRole("textbox", { name: "Code cell 1 source" }) as HTMLTextAreaElement).disabled,
  ).toBe(disabled);
};

describe("NotebookArtifactEnvelopeRenderer interactions", () => {
  afterEach(() => cleanup());

  it("blocks working-copy mutations while save persistence is pending", async () => {
    const original = revision("f", "print('original')");
    const saved = revision("g", "print('edited')");
    const persistence = deferred<NotebookRevision>();
    const executeCell = vi.fn<NotebookArtifactController["executeCell"]>(async (request) => {
      request.onState(runtime({ output: "should-not-run" }));
    });
    const saveRevision = vi.fn<NotebookArtifactController["saveRevision"]>(
      async (_scope, _documentId, document) => {
        expect(document.cells).toHaveLength(1);
        expect(document.cells[0]?.source).toBe("print('edited')");
        return persistence.promise;
      },
    );
    const bindingsValue = bindings(
      controller({
        readRevision: vi.fn(async () => original),
        saveRevision,
        connect: vi.fn(async (request) => request.onState(runtime())),
        dispose: vi.fn(async () => undefined),
        executeCell,
      }),
    );
    const renderer = await mount(
      bindingsValue,
      artifact("artifact-pending-save", "Pending save", original),
    );
    const source = renderer.getByRole("textbox", {
      name: "Code cell 1 source",
    }) as HTMLTextAreaElement;

    fireEvent.change(source, { target: { value: "print('edited')" } });
    await waitFor(() => expect(button(renderer, "Run all").disabled).toBe(false));
    await act(async () => {
      fireEvent.click(button(renderer, "Save new revision"));
      fireEvent.click(button(renderer, "Run all"));
      await Promise.resolve();
    });

    expect(executeCell).toHaveBeenCalledTimes(0);
    expect(button(renderer, "Save new revision").disabled).toBe(true);
    expect(button(renderer, "Run all").disabled).toBe(true);

    fireEvent.click(button(renderer, "Add code cell"));
    fireEvent.change(source, { target: { value: "print('late edit')" } });

    expectWorkingCopyMutationControlsDisabled(renderer, true);
    expect(source.value).toBe("print('edited')");
    expect(renderer.queryByRole("textbox", { name: "Code cell 2 source" })).toBeNull();

    await act(async () => {
      persistence.resolve(saved);
      await persistence.promise;
    });

    await waitFor(() => expectWorkingCopyMutationControlsDisabled(renderer, false));
    expect(saveRevision).toHaveBeenCalledTimes(1);
    expect(executeCell).toHaveBeenCalledTimes(0);
    expect(button(renderer, "Run all").disabled).toBe(false);
    expect(source.value).toBe("print('edited')");
    expect(renderer.queryByRole("textbox", { name: "Code cell 2 source" })).toBeNull();
    expect(article(renderer, "Pending save").textContent).toContain(
      `Latest ${hash("g").slice(0, 8)}`,
    );
    renderer.unmount();
  });

  it("moves edit and save controls onto the newly opened immutable revision runtime", async () => {
    const original = revision("a", "print('original')");
    const saved = revision("b", "print('edited')");
    const originalTarget = notebookRuntimeTarget(createNotebookWorkingCopy(original));
    const savedTarget = notebookRuntimeTarget(createNotebookWorkingCopy(saved));
    const openSessions = new Set<string>();
    const order: string[] = [];
    const savedConnection = deferred();
    const requireOpen = (sessionId: string) => {
      if (!openSessions.has(sessionId)) throw new Error(`session-not-found: ${sessionId}`);
    };
    const bindingsValue = bindings(
      controller({
        readRevision: vi.fn(async () => original),
        saveRevision: vi.fn(async (_scope, _documentId, document) => {
          order.push("save");
          expect(document.cells[0]?.source).toBe("print('edited')");
          return saved;
        }),
        connect: vi.fn(async (request) => {
          order.push(`connect:${request.sessionId}`);
          if (request.sessionId === savedTarget.sessionId) await savedConnection.promise;
          openSessions.add(request.sessionId);
          request.onState(runtime());
        }),
        executeCell: vi.fn(async (request) => {
          order.push(`execute:${request.sessionId}`);
          requireOpen(request.sessionId);
          request.onState(runtime({ output: "edited-output" }));
        }),
        restart: vi.fn(async (request) => {
          order.push(`restart:${request.sessionId}`);
          requireOpen(request.sessionId);
          request.onState(runtime());
        }),
        dispose: vi.fn(async (request) => {
          order.push(`dispose:${request.sessionId}`);
          requireOpen(request.sessionId);
          openSessions.delete(request.sessionId);
        }),
      }),
    );
    const renderer = await mount(bindingsValue, artifact("artifact-save", "Save", original));

    await waitFor(() => expect(button(renderer, "Run all").disabled).toBe(false));
    fireEvent.change(renderer.getByRole("textbox", { name: "Code cell 1 source" }), {
      target: { value: "print('edited')" },
    });
    await waitFor(() => expect(button(renderer, "Save new revision").disabled).toBe(false));
    fireEvent.click(button(renderer, "Save new revision"));

    await waitFor(() =>
      expect(article(renderer, "Save").textContent).toContain(`Latest ${hash("b").slice(0, 8)}`),
    );
    expect(openSessions.has(originalTarget.sessionId)).toBe(false);
    expect(openSessions.has(savedTarget.sessionId)).toBe(false);
    expect(button(renderer, "Run all").disabled).toBe(true);

    await act(async () => {
      savedConnection.resolve();
      await savedConnection.promise;
    });
    await waitFor(() => expect(button(renderer, "Run all").disabled).toBe(false));
    expect(openSessions.has(savedTarget.sessionId)).toBe(true);

    fireEvent.click(button(renderer, "Run all"));
    await waitFor(() => expect(order).toContain(`execute:${savedTarget.sessionId}`));
    fireEvent.click(button(renderer, "Restart kernel"));
    await waitFor(() => expect(order).toContain(`restart:${savedTarget.sessionId}`));
    fireEvent.click(button(renderer, "Dispose runtime"));
    await waitFor(() => expect(openSessions.size).toBe(0));

    expect(order).toEqual([
      `connect:${originalTarget.sessionId}`,
      "save",
      `dispose:${originalTarget.sessionId}`,
      `connect:${savedTarget.sessionId}`,
      `execute:${savedTarget.sessionId}`,
      `restart:${savedTarget.sessionId}`,
      `dispose:${savedTarget.sessionId}`,
    ]);
    expect(article(renderer, "Save").textContent).not.toContain("session-not-found");
    renderer.unmount();
  });

  it("keeps the old revision runtime ready when persistence fails before transition", async () => {
    const original = revision("c", "print('original')");
    const originalTarget = notebookRuntimeTarget(createNotebookWorkingCopy(original));
    const openSessions = new Set<string>();
    const order: string[] = [];
    const persistence = deferred<NotebookRevision>();
    const bindingsValue = bindings(
      controller({
        readRevision: vi.fn(async () => original),
        saveRevision: vi.fn(() => {
          order.push("save");
          return persistence.promise;
        }),
        connect: vi.fn(async (request) => {
          order.push(`connect:${request.sessionId}`);
          openSessions.add(request.sessionId);
          request.onState(runtime());
        }),
        executeCell: vi.fn(async (request) => {
          order.push(`execute:${request.sessionId}`);
          if (!openSessions.has(request.sessionId))
            throw new Error(`session-not-found: ${request.sessionId}`);
          request.onState(runtime());
        }),
        dispose: vi.fn(async (request) => {
          order.push(`dispose:${request.sessionId}`);
          openSessions.delete(request.sessionId);
        }),
      }),
    );
    const renderer = await mount(
      bindingsValue,
      artifact("artifact-save-failure", "Save failure", original),
    );

    await waitFor(() => expect(button(renderer, "Run all").disabled).toBe(false));
    fireEvent.change(renderer.getByRole("textbox", { name: "Code cell 1 source" }), {
      target: { value: "print('unsaved')" },
    });
    fireEvent.click(button(renderer, "Save new revision"));
    await waitFor(() => expect(button(renderer, "Save new revision").disabled).toBe(true));

    const source = renderer.getByRole("textbox", {
      name: "Code cell 1 source",
    }) as HTMLTextAreaElement;
    fireEvent.click(button(renderer, "Add code cell"));
    fireEvent.change(source, { target: { value: "print('late edit')" } });

    expectWorkingCopyMutationControlsDisabled(renderer, true);
    expect(source.value).toBe("print('unsaved')");
    expect(renderer.queryByRole("textbox", { name: "Code cell 2 source" })).toBeNull();

    await act(async () => {
      persistence.reject(new Error("save unavailable"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(renderer.getByRole("alert").textContent).toContain("save unavailable"),
    );
    expect(order).toEqual([`connect:${originalTarget.sessionId}`, "save"]);
    expect(article(renderer, "Save failure").textContent).toContain("Unsaved changes");
    expect(button(renderer, "Run all").disabled).toBe(false);
    expectWorkingCopyMutationControlsDisabled(renderer, false);
    expect(source.value).toBe("print('unsaved')");
    expect(renderer.queryByRole("textbox", { name: "Code cell 2 source" })).toBeNull();

    fireEvent.click(button(renderer, "Run all"));
    await waitFor(() => expect(order).toContain(`execute:${originalTarget.sessionId}`));
    expect(order.filter((entry) => entry.startsWith("execute:"))).toHaveLength(1);
    expect(article(renderer, "Save failure").textContent).not.toContain("session-not-found");
    renderer.unmount();
  });

  it("does not recover an earlier revision after a fresh renderer reload", async () => {
    const first = revision("a", "print('first')");
    const second = revision("b", "print('second')");
    const revisions = new Map([
      [first.revisionId, first],
      [second.revisionId, second],
    ]);
    const retained = new Map<string, NotebookRuntimeView>();
    const connected: string[] = [];
    const firstState = runtime({ output: "first-revision-output" });
    const bindingsValue = bindings(
      controller({
        readRevision: vi.fn(async (_scope, _documentId, revisionId) => {
          const value = revisions.get(revisionId);
          if (!value) throw new Error("missing revision");
          return value;
        }),
        connect: vi.fn(async (request) => {
          connected.push(request.sessionId);
          if (connected.length === 1) retained.set(request.sessionId, firstState);
          request.onState(retained.get(request.sessionId) ?? runtime());
        }),
      }),
    );

    const firstRenderer = await mount(bindingsValue, artifact("artifact-a", "First", first));
    expect(article(firstRenderer, "First").textContent).toContain("first-revision-output");
    firstRenderer.unmount();

    const secondRenderer = await mount(bindingsValue, artifact("artifact-b", "Second", second));

    expect(connected[0]).not.toBe(connected[1]);
    expect(article(secondRenderer, "Second").textContent).not.toContain("first-revision-output");
    expect(article(secondRenderer, "Second").textContent).toContain("Execution –");
    secondRenderer.unmount();
  });

  it("keeps two simultaneous immutable revisions in independent runtime sessions", async () => {
    const first = revision("c", "print('first')");
    const second = revision("d", "print('second')");
    const revisions = new Map([
      [first.revisionId, first],
      [second.revisionId, second],
    ]);
    const connected: string[] = [];
    const retained = new Map<string, NotebookRuntimeView>();
    const bindingsValue = bindings(
      controller({
        readRevision: vi.fn(async (_scope, _documentId, revisionId) => {
          const value = revisions.get(revisionId);
          if (!value) throw new Error("missing revision");
          return value;
        }),
        connect: vi.fn(async (request) => {
          connected.push(request.sessionId);
          const existing = retained.get(request.sessionId);
          if (existing) {
            request.onState(existing);
            return;
          }
          const state = connected.length === 1 ? runtime({ output: "first-only" }) : runtime();
          retained.set(request.sessionId, state);
          request.onState(state);
        }),
      }),
    );

    const renderer = await mount(
      bindingsValue,
      artifact("artifact-c", "Concurrent first", first),
      artifact("artifact-d", "Concurrent second", second),
    );

    expect(connected).toHaveLength(2);
    expect(connected[0]).not.toBe(connected[1]);
    expect(article(renderer, "Concurrent first").textContent).toContain("first-only");
    expect(article(renderer, "Concurrent second").textContent).not.toContain("first-only");
    expect(article(renderer, "Concurrent second").textContent).toContain("Execution –");
    renderer.unmount();
  });

  it.each(["completion", "failure"] as const)(
    "keeps the actual Interrupt button pending after execution %s",
    async (outcome) => {
      const value = revision("e", "print('running')");
      const execution = deferred();
      const interruption = deferred();
      const interrupt = vi.fn<NotebookArtifactController["interrupt"]>(async (request) => {
        await interruption.promise;
        request.onState(runtime());
      });
      const bindingsValue = bindings(
        controller({
          readRevision: vi.fn(async () => value),
          connect: vi.fn(async (request) => request.onState(runtime())),
          executeCell: vi.fn(async (request) => {
            request.onState(runtime({ running: true }));
            await execution.promise;
          }),
          interrupt,
        }),
      );
      const renderer = await mount(bindingsValue, artifact("artifact-e", "Interrupt", value));

      fireEvent.click(button(renderer, "Run all"));
      await waitFor(() => expect(button(renderer, "Interrupt").disabled).toBe(false));

      fireEvent.click(button(renderer, "Interrupt"));
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(button(renderer, "Interrupt").disabled).toBe(true);

      await act(async () => {
        if (outcome === "completion") execution.resolve();
        else execution.reject(new Error("execution failed"));
        await Promise.resolve();
      });

      expect(button(renderer, "Interrupt").disabled).toBe(true);
      await act(async () => {
        interruption.resolve();
        await Promise.resolve();
      });
      expect(button(renderer, "Interrupt").disabled).toBe(true);
      renderer.unmount();
    },
  );
});
