// @vitest-environment happy-dom

import { cleanup, fireEvent, render, type RenderResult, waitFor } from "@testing-library/react";
import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import { act, Fragment } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { NotebookRevision } from "./contracts.ts";
import { NotebookArtifactEnvelopeRenderer } from "./web-renderer.tsx";
import {
  NotebookWebProvider,
  type NotebookArtifactController,
  type NotebookRuntimeView,
  type NotebookWebBindings,
} from "./web.tsx";

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

const deferred = () => {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve } as const;
};

describe("NotebookArtifactEnvelopeRenderer interactions", () => {
  afterEach(() => cleanup());

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
