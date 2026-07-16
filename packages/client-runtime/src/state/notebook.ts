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
  pruneNotebookOutputCell,
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

// Keep this aligned with the immutable notebook document's NOTEBOOK_MAX_CELLS.
export const NOTEBOOK_RUNTIME_MAX_CELLS = 1_000;

export interface NotebookRuntimeState extends NotebookOutputState {
  readonly kernelStatus: NotebookKernelStatus;
  readonly lastSequence: number;
  readonly recoveryAfterSequence: number | null;
  readonly pendingEvents: ReadonlyMap<number, NotebookExecutionEvent>;
  readonly runtimeCellRecency: ReadonlyArray<string>;
  readonly activeExecutionIdByCell: ReadonlyMap<string, string>;
  readonly latestExecutionIdByCell: ReadonlyMap<string, string>;
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
    runtimeCellRecency: [],
    activeExecutionIdByCell: new Map(),
    latestExecutionIdByCell: new Map(),
    ...createNotebookOutputState(),
    executionCountByCell: new Map(),
    runningCellIds: new Set(),
    error: null,
  };
}

export function pruneNotebookRuntimeCell(
  state: NotebookRuntimeState,
  cellId: string,
): NotebookRuntimeState {
  const activeExecutionIdByCell = new Map(state.activeExecutionIdByCell);
  const latestExecutionIdByCell = new Map(state.latestExecutionIdByCell);
  const executionCountByCell = new Map(state.executionCountByCell);
  const runningCellIds = new Set(state.runningCellIds);
  activeExecutionIdByCell.delete(cellId);
  latestExecutionIdByCell.delete(cellId);
  executionCountByCell.delete(cellId);
  runningCellIds.delete(cellId);
  return {
    ...state,
    ...pruneNotebookOutputCell(state, cellId),
    activeExecutionIdByCell,
    latestExecutionIdByCell,
    executionCountByCell,
    runningCellIds,
    runtimeCellRecency: state.runtimeCellRecency.filter((candidate) => candidate !== cellId),
  };
}

const retainNotebookRuntimeCell = (
  state: NotebookRuntimeState,
  cellId: string,
): NotebookRuntimeState => {
  let next: NotebookRuntimeState = {
    ...state,
    runtimeCellRecency: [
      ...state.runtimeCellRecency.filter((candidate) => candidate !== cellId),
      cellId,
    ],
  };
  while (next.runtimeCellRecency.length > NOTEBOOK_RUNTIME_MAX_CELLS) {
    const victim = next.runtimeCellRecency.find(
      (candidate) =>
        !next.activeExecutionIdByCell.has(candidate) && !next.runningCellIds.has(candidate),
    );
    if (victim === undefined) break;
    next = pruneNotebookRuntimeCell(next, victim);
  }
  return next;
};

export function beginNotebookCellExecution(
  state: NotebookRuntimeState,
  cellId: string,
  executionId: string,
): NotebookRuntimeState {
  const activeExecutionIdByCell = new Map(state.activeExecutionIdByCell);
  activeExecutionIdByCell.set(cellId, executionId);
  const latestExecutionIdByCell = new Map(state.latestExecutionIdByCell);
  latestExecutionIdByCell.set(cellId, executionId);
  const runningCellIds = new Set(state.runningCellIds);
  runningCellIds.add(cellId);
  return retainNotebookRuntimeCell(
    {
      ...state,
      activeExecutionIdByCell,
      latestExecutionIdByCell,
      kernelStatus: "busy",
      runningCellIds,
      error: null,
    },
    cellId,
  );
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

type ExecutionIdentity = {
  readonly executionId: string;
  readonly cellId: string;
};

const activateExecution = (
  state: NotebookRuntimeState,
  identity: ExecutionIdentity,
  kernelStatus: NotebookKernelStatus = "busy",
): NotebookRuntimeState => {
  const activeExecutionIdByCell = new Map(state.activeExecutionIdByCell);
  activeExecutionIdByCell.set(identity.cellId, identity.executionId);
  const latestExecutionIdByCell = new Map(state.latestExecutionIdByCell);
  latestExecutionIdByCell.set(identity.cellId, identity.executionId);
  const runningCellIds = new Set(state.runningCellIds);
  runningCellIds.add(identity.cellId);
  return {
    ...state,
    activeExecutionIdByCell,
    latestExecutionIdByCell,
    kernelStatus,
    runningCellIds,
  };
};

const finishExecution = (
  state: NotebookRuntimeState,
  identity: ExecutionIdentity,
  kernelStatus: NotebookKernelStatus,
): NotebookRuntimeState => {
  const activeExecutionIdByCell = new Map(state.activeExecutionIdByCell);
  const activeExecutionId = activeExecutionIdByCell.get(identity.cellId);
  if (activeExecutionId !== undefined && activeExecutionId !== identity.executionId) {
    return state;
  }
  activeExecutionIdByCell.delete(identity.cellId);
  const latestExecutionIdByCell = new Map(state.latestExecutionIdByCell);
  latestExecutionIdByCell.set(identity.cellId, identity.executionId);
  const runningCellIds = new Set(state.runningCellIds);
  runningCellIds.delete(identity.cellId);
  return {
    ...state,
    activeExecutionIdByCell,
    latestExecutionIdByCell,
    kernelStatus: runningCellIds.size > 0 ? "busy" : kernelStatus,
    runningCellIds,
  };
};

const finishAllExecutions = (
  state: NotebookRuntimeState,
  kernelStatus: NotebookKernelStatus,
): NotebookRuntimeState => ({
  ...state,
  activeExecutionIdByCell: new Map(),
  kernelStatus,
  runningCellIds: new Set(),
});

const applyOrderedEventWithoutCellBounds = (
  state: NotebookRuntimeState,
  event: NotebookExecutionEvent,
): NotebookRuntimeState => {
  if (
    event.type !== "accepted" &&
    event.executionId !== undefined &&
    state.latestExecutionIdByCell.has(event.cellId) &&
    state.latestExecutionIdByCell.get(event.cellId) !== event.executionId
  ) {
    return state;
  }
  if (event.type === "rejected") {
    if (event.executionId !== undefined) {
      return {
        ...finishExecution(state, event, "idle"),
        error: event.message,
      };
    }
    return { ...state, error: event.message };
  }
  if (event.type === "kernel") {
    if (event.executionId !== undefined) {
      return event.state === "idle" || event.state === "interrupted" || event.state === "terminated"
        ? finishExecution(state, event, event.state)
        : activateExecution(state, event, event.state);
    }
    return event.state === "idle" || event.state === "interrupted" || event.state === "terminated"
      ? finishAllExecutions(state, event.state)
      : { ...state, kernelStatus: event.state };
  }
  if (event.type === "limit") {
    return { ...activateExecution(state, event), error: event.message };
  }
  if (event.type === "accepted") {
    if (event.commandType !== "execute") return state;
    const activeState = activateExecution(state, event);
    const outputState = resetNotebookCellOutputs(activeState, event.cellId);
    return {
      ...activeState,
      ...outputState,
      error: null,
    };
  }

  const cellId = event.cellId;
  if (event.type === "execution") {
    const activeState = activateExecution(state, event);
    const executionCountByCell = new Map(activeState.executionCountByCell);
    executionCountByCell.set(cellId, event.executionCount);
    return { ...activeState, executionCountByCell };
  }
  if (event.type === "stream") {
    return appendOutput(
      activateExecution(state, event),
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
      activateExecution(state, event),
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
    const activeState = activateExecution(state, event);
    const executionCountByCell = new Map(activeState.executionCountByCell);
    executionCountByCell.set(cellId, event.executionCount);
    return appendOutput(
      { ...activeState, executionCountByCell },
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
  const erroredState = appendOutput(
    activateExecution(state, event),
    cellId,
    {
      output_type: "error",
      ename: event.ename,
      evalue: event.evalue,
      traceback: event.traceback,
    },
    event.sequence,
  );
  return finishExecution(erroredState, event, "idle");
};

const applyOrderedEvent = (
  state: NotebookRuntimeState,
  event: NotebookExecutionEvent,
): NotebookRuntimeState => {
  const next = applyOrderedEventWithoutCellBounds(state, event);
  return next === state || event.executionId === undefined
    ? next
    : retainNotebookRuntimeCell(next, event.cellId);
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
      activeExecutionIdByCell: new Map(),
      kernelStatus: "disconnected",
      latestExecutionIdByCell: new Map(),
      lastSequence: replay.baselineSequence,
      pendingEvents,
      recoveryAfterSequence: pendingEvents.size > 0 ? replay.baselineSequence : null,
      runningCellIds: new Set(),
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

export function failNotebookCellExecution(
  state: NotebookRuntimeState,
  cellId: string,
  executionId: string,
  message: string,
): NotebookRuntimeState {
  if (state.activeExecutionIdByCell.get(cellId) !== executionId) {
    return { ...state, error: message };
  }
  const finished = finishExecution(state, { cellId, executionId }, "idle");
  return { ...finished, error: message };
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
