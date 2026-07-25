import type { NotebookExecutionEvent, NotebookExecutionReplay } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createNotebookRuntimeController,
  type NotebookRuntimeControllerTransport,
} from "./notebook-controller.ts";

const scope = { environmentId: "environment-1", projectId: "project-1" };
const sessionId = "notebook-session";
const revisionId = "a".repeat(64);

const event = (
  sequence: number,
  type: "starting" | "idle" | "interrupted" | "restarted",
): NotebookExecutionEvent => ({
  type: "kernel",
  sessionId,
  commandId: `command-${sequence}`,
  sequence,
  state: type,
});

const replay = (...events: ReadonlyArray<NotebookExecutionEvent>): NotebookExecutionReplay => ({
  baselineSequence: 0,
  events: [...events],
});

const transport = (
  overrides: Partial<NotebookRuntimeControllerTransport> = {},
): NotebookRuntimeControllerTransport => ({
  createCommandId: (type) => `${type}-command`,
  isSessionNotFound: (cause) =>
    typeof cause === "object" &&
    cause !== null &&
    "reason" in cause &&
    cause.reason === "session-not-found",
  recover: vi.fn(async () => replay()),
  open: vi.fn(async () => [event(1, "starting")]),
  execute: vi.fn(async () => undefined),
  control: vi.fn(async (_type) => []),
  ...overrides,
});

const runtimeRequest = (
  states: Array<{ readonly kernelStatus: string; readonly lastSequence: number }>,
) => ({
  scope,
  sessionId,
  revisionId,
  onState: (state: { readonly kernelStatus: string; readonly lastSequence: number }) => {
    states.push({ kernelStatus: state.kernelStatus, lastSequence: state.lastSequence });
  },
});

describe("shared notebook runtime controller", () => {
  it("recovers before opening a missing session and publishes exact ordered states", async () => {
    const order: string[] = [];
    const states: Array<{ readonly kernelStatus: string; readonly lastSequence: number }> = [];
    let recoveryCount = 0;
    const bindings = transport({
      recover: vi.fn(async ({ afterSequence }) => {
        order.push(`recover:${afterSequence}`);
        recoveryCount += 1;
        if (recoveryCount === 1) throw { reason: "session-not-found" };
        return replay(event(2, "idle"));
      }),
      open: vi.fn(async (input) => {
        order.push(`open:${input.commandId}:${input.documentIds.join(",")}`);
        return [event(1, "starting")];
      }),
    });
    const controller = createNotebookRuntimeController(bindings);

    await controller.connect({
      ...runtimeRequest(states),
      kernelName: "python3",
      documentIds: ["b".repeat(64)],
    });

    expect(order).toEqual(["recover:0", `open:open-command:${"b".repeat(64)}`, "recover:1"]);
    expect(states).toEqual([
      { kernelStatus: "disconnected", lastSequence: 0 },
      { kernelStatus: "starting", lastSequence: 1 },
      { kernelStatus: "idle", lastSequence: 2 },
    ]);
  });

  it("publishes execution and interrupt/restart transitions through the same state machine", async () => {
    const states: Array<{ readonly kernelStatus: string; readonly lastSequence: number }> = [];
    const controls: string[] = [];
    const bindings = transport({
      recover: vi.fn(async () => replay(event(1, "idle"))),
      execute: vi.fn(async (_input, onEvent) => {
        onEvent({
          type: "accepted",
          commandType: "execute",
          sessionId,
          commandId: "execute-command",
          executionId: "execution-command",
          cellId: "code-1",
          sequence: 2,
        });
        onEvent({
          type: "kernel",
          state: "idle",
          sessionId,
          commandId: "execute-command",
          executionId: "execution-command",
          cellId: "code-1",
          sequence: 3,
        });
      }),
      control: vi.fn(async (type) => {
        controls.push(type);
        return type === "interrupt" ? [event(4, "interrupted")] : [event(5, "restarted")];
      }),
    });
    const controller = createNotebookRuntimeController(bindings);
    const request = runtimeRequest(states);

    await controller.connect({ ...request, kernelName: "python3", documentIds: [] });
    await controller.executeCell({ ...request, cellId: "code-1", code: "print(1)" });
    await controller.interrupt(request);
    await controller.restart(request);

    expect(controls).toEqual(["interrupt", "restart"]);
    expect(states.map((state) => state.kernelStatus)).toEqual([
      "idle",
      "busy",
      "busy",
      "idle",
      "interrupted",
      "restarted",
    ]);
    expect(states.at(-1)).toEqual({ kernelStatus: "restarted", lastSequence: 5 });
  });
});
