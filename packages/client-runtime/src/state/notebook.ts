import {
  type NotebookCellExecuteInput,
  type NotebookExecutionEvent,
  type NotebookExecutionReplay,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import { runStream } from "../rpc/client.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import {
  appendNotebookCellOutput,
  createNotebookOutputState,
  resetNotebookCellOutputs,
  type NotebookOutputState,
  type NotebookRuntimeOutput,
} from "./notebook-output-retention.ts";

export {
  NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL,
  NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_SESSION,
  NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_CELL,
  NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_SESSION,
  type NotebookOutputRetention,
} from "./notebook-output-retention.ts";

export type NotebookKernelStatus =
  | "disconnected"
  | "starting"
  | "busy"
  | "idle"
  | "interrupted"
  | "restarted"
  | "terminated";

export interface NotebookRuntimeState extends NotebookOutputState {
  readonly kernelStatus: NotebookKernelStatus;
  readonly lastSequence: number;
  readonly recoveryAfterSequence: number | null;
  readonly pendingEvents: ReadonlyMap<number, NotebookExecutionEvent>;
  readonly cellIdByExecution: ReadonlyMap<string, string>;
  readonly executionCountByCell: ReadonlyMap<string, number | null>;
  readonly runningCellIds: ReadonlySet<string>;
  readonly error: string | null;
}

export function createNotebookRuntimeState(): NotebookRuntimeState {
  return {
    kernelStatus: "disconnected",
    lastSequence: 0,
    recoveryAfterSequence: null,
    pendingEvents: new Map(),
    cellIdByExecution: new Map(),
    ...createNotebookOutputState(),
    executionCountByCell: new Map(),
    runningCellIds: new Set(),
    error: null,
  };
}

export function beginNotebookCellExecution(
  state: NotebookRuntimeState,
  cellId: string,
  executionId: string,
): NotebookRuntimeState {
  const outputState = resetNotebookCellOutputs(state, cellId);
  const cellIdByExecution = new Map(state.cellIdByExecution);
  cellIdByExecution.set(executionId, cellId);
  const runningCellIds = new Set(state.runningCellIds);
  runningCellIds.add(cellId);
  return {
    ...state,
    ...outputState,
    cellIdByExecution,
    runningCellIds,
    error: null,
  };
}

const appendOutput = (
  state: NotebookRuntimeState,
  cellId: string,
  output: NotebookRuntimeOutput,
  sequence: number,
): NotebookRuntimeState => ({
  ...state,
  ...appendNotebookCellOutput(state, cellId, output, `${cellId}-runtime-output-${sequence}`),
});

const applyOrderedEvent = (
  state: NotebookRuntimeState,
  event: NotebookExecutionEvent,
): NotebookRuntimeState => {
  let mappedState = state;
  if (event.executionId !== undefined && event.cellId !== undefined) {
    const cellIdByExecution = new Map(state.cellIdByExecution);
    cellIdByExecution.set(event.executionId, event.cellId);
    mappedState = { ...state, cellIdByExecution };
  }
  if (event.type === "rejected") {
    const runningCellIds = new Set(mappedState.runningCellIds);
    if (event.executionId !== undefined) {
      runningCellIds.delete(event.cellId);
    }
    return { ...mappedState, runningCellIds, error: event.message };
  }
  if (event.type === "kernel") {
    const runningCellIds = new Set(mappedState.runningCellIds);
    if (event.state === "idle" || event.state === "interrupted" || event.state === "terminated") {
      if (event.executionId) {
        runningCellIds.delete(event.cellId);
      } else if (event.state !== "idle") {
        runningCellIds.clear();
      }
    }
    return { ...mappedState, kernelStatus: event.state, runningCellIds };
  }
  if (event.type === "limit") return { ...mappedState, error: event.message };
  if (event.type === "accepted") {
    if (event.commandType !== "execute") return mappedState;
    const outputState = resetNotebookCellOutputs(mappedState, event.cellId);
    const runningCellIds = new Set(mappedState.runningCellIds);
    runningCellIds.add(event.cellId);
    return {
      ...mappedState,
      ...outputState,
      runningCellIds,
      error: null,
    };
  }

  const cellId = event.cellId;
  if (event.type === "stream") {
    return appendOutput(
      mappedState,
      cellId,
      {
        output_type: "stream",
        name: event.name,
        text: event.text,
      },
      event.sequence,
    );
  }
  if (event.type === "display") {
    return appendOutput(
      mappedState,
      cellId,
      {
        output_type: "display_data",
        data: event.data,
        metadata: {},
      },
      event.sequence,
    );
  }
  if (event.type === "result") {
    const executionCountByCell = new Map(mappedState.executionCountByCell);
    executionCountByCell.set(cellId, event.executionCount);
    return appendOutput(
      { ...mappedState, executionCountByCell },
      cellId,
      {
        output_type: "execute_result",
        execution_count: event.executionCount,
        data: event.data,
        metadata: {},
      },
      event.sequence,
    );
  }
  return appendOutput(
    mappedState,
    cellId,
    {
      output_type: "error",
      ename: event.ename,
      evalue: event.evalue,
      traceback: event.traceback,
    },
    event.sequence,
  );
};

export function applyNotebookExecutionEvents(
  state: NotebookRuntimeState,
  events: ReadonlyArray<NotebookExecutionEvent>,
): NotebookRuntimeState {
  const pending = new Map(state.pendingEvents);
  for (const event of events) {
    if (event.sequence > state.lastSequence && !pending.has(event.sequence)) {
      pending.set(event.sequence, event);
    }
  }

  let next = state;
  let sequence = state.lastSequence + 1;
  while (pending.has(sequence)) {
    const event = pending.get(sequence);
    pending.delete(sequence);
    if (event !== undefined) next = applyOrderedEvent(next, event);
    sequence += 1;
  }
  const lastSequence = sequence - 1;
  return {
    ...next,
    lastSequence,
    pendingEvents: pending,
    recoveryAfterSequence: pending.size > 0 ? lastSequence : null,
  };
}

export function applyNotebookExecutionReplay(
  state: NotebookRuntimeState,
  replay: NotebookExecutionReplay,
): NotebookRuntimeState {
  if (replay.baselineSequence <= state.lastSequence) {
    return applyNotebookExecutionEvents(state, replay.events);
  }

  const pendingEvents = new Map(
    [...state.pendingEvents].filter(([sequence]) => sequence > replay.baselineSequence),
  );
  return applyNotebookExecutionEvents(
    {
      ...state,
      lastSequence: replay.baselineSequence,
      pendingEvents,
      recoveryAfterSequence: pendingEvents.size > 0 ? replay.baselineSequence : null,
    },
    replay.events,
  );
}

export function failNotebookRuntime(
  state: NotebookRuntimeState,
  message: string,
): NotebookRuntimeState {
  return { ...state, error: message };
}

export function clearNotebookRuntimeError(state: NotebookRuntimeState): NotebookRuntimeState {
  return state.error === null ? state : { ...state, error: null };
}

export interface NotebookExecutionCommandInput {
  readonly request: NotebookCellExecuteInput;
  readonly onEvent: (event: NotebookExecutionEvent) => void;
}

export function createNotebookEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const revisionScheduler = createAtomCommandScheduler();
  const executionScheduler = createAtomCommandScheduler();
  return {
    revision: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:notebook:revision",
      tag: WS_METHODS.notebookRevisionRead,
      staleTimeMs: Number.POSITIVE_INFINITY,
      idleTtlMs: 10 * 60_000,
    }),
    readRevision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notebook:revision-read",
      tag: WS_METHODS.notebookRevisionRead,
    }),
    saveRevision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notebook:revision-save",
      tag: WS_METHODS.notebookRevisionSave,
      scheduler: revisionScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.documentId}`,
      },
    }),
    importRevision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notebook:revision-import",
      tag: WS_METHODS.notebookRevisionImport,
      scheduler: revisionScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    exportRevision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notebook:revision-export",
      tag: WS_METHODS.notebookRevisionExport,
    }),
    openSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notebook:session-open",
      tag: WS_METHODS.notebookSessionOpen,
    }),
    executeCell: createEnvironmentCommand(runtime, {
      label: "environment-data:notebook:cell-execute",
      scheduler: executionScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.request.sessionId}`,
      },
      execute: (input: NotebookExecutionCommandInput) =>
        runStream(WS_METHODS.notebookCellExecute, input.request).pipe(
          Stream.runForEach((event) => Effect.sync(() => input.onEvent(event))),
        ),
    }),
    interrupt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notebook:execution-interrupt",
      tag: WS_METHODS.notebookExecutionInterrupt,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notebook:kernel-restart",
      tag: WS_METHODS.notebookKernelRestart,
    }),
    dispose: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notebook:session-dispose",
      tag: WS_METHODS.notebookSessionDispose,
    }),
    events: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notebook:session-events",
      tag: WS_METHODS.notebookSessionEvents,
    }),
  };
}
