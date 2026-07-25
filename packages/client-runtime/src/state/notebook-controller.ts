import type { NotebookExecutionEvent, NotebookExecutionReplay } from "@t3tools/contracts";

import {
  applyNotebookExecutionEvents,
  applyNotebookExecutionReplay,
  beginNotebookCellExecution,
  clearNotebookRuntimeError,
  createNotebookRuntimeState,
  failNotebookCellExecution,
  failNotebookRuntime,
  pruneNotebookRuntimeCell,
  type NotebookRuntimeState,
} from "./notebook.ts";

export const NOTEBOOK_RUNTIME_CACHE_MAX_ENTRIES = 32;

export type NotebookRuntimeScope = {
  readonly environmentId: string;
  readonly projectId: string;
};

export type NotebookRuntimeRequest = {
  readonly scope: NotebookRuntimeScope;
  readonly sessionId: string;
  readonly revisionId: string;
  readonly onState: (state: NotebookRuntimeState) => void;
};

export type NotebookRuntimeConnectRequest = NotebookRuntimeRequest & {
  readonly kernelName: string;
  readonly documentIds: ReadonlyArray<string>;
};

type NotebookRuntimeTransportRequest = {
  readonly scope: NotebookRuntimeScope;
  readonly sessionId: string;
};

export interface NotebookRuntimeControllerTransport {
  readonly createCommandId: (type: string) => string;
  readonly isSessionNotFound: (cause: unknown) => boolean;
  readonly recover: (
    request: NotebookRuntimeTransportRequest & { readonly afterSequence: number },
  ) => Promise<NotebookExecutionReplay>;
  readonly open: (
    request: NotebookRuntimeTransportRequest & {
      readonly commandId: string;
      readonly kernelName: string;
      readonly documentIds: ReadonlyArray<string>;
    },
  ) => Promise<ReadonlyArray<NotebookExecutionEvent>>;
  readonly execute: (
    request: NotebookRuntimeTransportRequest & {
      readonly commandId: string;
      readonly executionId: string;
      readonly cellId: string;
      readonly code: string;
    },
    onEvent: (event: NotebookExecutionEvent) => void,
  ) => Promise<void>;
  readonly control: (
    type: "interrupt" | "restart" | "dispose",
    request: NotebookRuntimeTransportRequest & { readonly commandId: string },
  ) => Promise<ReadonlyArray<NotebookExecutionEvent>>;
}

export interface NotebookRuntimeController {
  readonly connect: (request: NotebookRuntimeConnectRequest) => Promise<void>;
  readonly recover: (request: NotebookRuntimeRequest) => Promise<void>;
  readonly executeCell: (
    request: NotebookRuntimeRequest & { readonly cellId: string; readonly code: string },
  ) => Promise<void>;
  readonly removeCell: (request: NotebookRuntimeRequest & { readonly cellId: string }) => void;
  readonly interrupt: (request: NotebookRuntimeRequest) => Promise<void>;
  readonly restart: (request: NotebookRuntimeRequest) => Promise<void>;
  readonly dispose: (request: NotebookRuntimeRequest) => Promise<void>;
  readonly clearError: (request: NotebookRuntimeRequest) => void;
}

const runtimeCacheKey = (
  scope: NotebookRuntimeScope,
  sessionId: string,
  revisionId: string,
): string => `${scope.environmentId}\0${scope.projectId}\0${revisionId}\0${sessionId}`;

class RuntimeStateCache {
  readonly #entries = new Map<string, NotebookRuntimeState>();

  get(key: string): NotebookRuntimeState | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: NotebookRuntimeState): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > NOTEBOOK_RUNTIME_CACHE_MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) return;
      this.#entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function createNotebookRuntimeController(
  transport: NotebookRuntimeControllerTransport,
): NotebookRuntimeController {
  const states = new RuntimeStateCache();
  const connectionAttempts = new Map<string, Promise<void>>();
  const key = (request: NotebookRuntimeRequest) =>
    runtimeCacheKey(request.scope, request.sessionId, request.revisionId);
  const current = (request: NotebookRuntimeRequest) =>
    states.get(key(request)) ?? createNotebookRuntimeState();
  const publish = (
    request: NotebookRuntimeRequest,
    state: NotebookRuntimeState,
  ): NotebookRuntimeState => {
    states.set(key(request), state);
    request.onState(state);
    return state;
  };
  const apply = (request: NotebookRuntimeRequest, events: ReadonlyArray<NotebookExecutionEvent>) =>
    publish(request, applyNotebookExecutionEvents(current(request), events));
  const applyReplay = (request: NotebookRuntimeRequest, replay: NotebookExecutionReplay) =>
    publish(request, applyNotebookExecutionReplay(current(request), replay));
  const fail = (request: NotebookRuntimeRequest, cause: unknown): never => {
    publish(request, failNotebookRuntime(current(request), failureMessage(cause)));
    throw cause;
  };
  const recover = async (request: NotebookRuntimeRequest) => {
    const replay = await transport.recover({
      scope: request.scope,
      sessionId: request.sessionId,
      afterSequence: current(request).lastSequence,
    });
    applyReplay(request, replay);
  };
  const control = async (
    request: NotebookRuntimeRequest,
    type: "interrupt" | "restart" | "dispose",
  ) => {
    try {
      apply(
        request,
        await transport.control(type, {
          scope: request.scope,
          sessionId: request.sessionId,
          commandId: transport.createCommandId(type),
        }),
      );
    } catch (cause) {
      fail(request, cause);
    }
    if (type === "dispose") {
      states.delete(key(request));
      connectionAttempts.delete(key(request));
    }
  };

  return {
    connect: async (request) => {
      const requestKey = key(request);
      const existing = connectionAttempts.get(requestKey);
      if (existing !== undefined) {
        await existing;
        request.onState(current(request));
        return;
      }
      const attempt = (async () => {
        try {
          if (current(request).kernelStatus !== "terminated") {
            try {
              await recover(request);
              if (current(request).lastSequence > 0) return;
            } catch (cause) {
              if (!transport.isSessionNotFound(cause)) throw cause;
            }
          }
          publish(request, createNotebookRuntimeState());
          apply(
            request,
            await transport.open({
              scope: request.scope,
              sessionId: request.sessionId,
              commandId: transport.createCommandId("open"),
              kernelName: request.kernelName,
              documentIds: request.documentIds,
            }),
          );
          await recover(request);
        } catch (cause) {
          fail(request, cause);
        }
      })();
      connectionAttempts.set(requestKey, attempt);
      try {
        await attempt;
      } finally {
        if (connectionAttempts.get(requestKey) === attempt) connectionAttempts.delete(requestKey);
      }
    },
    recover: async (request) => {
      try {
        await recover(request);
      } catch (cause) {
        fail(request, cause);
      }
    },
    executeCell: async (request) => {
      if (current(request).runningCellIds.size > 0) return;
      const executionId = transport.createCommandId("execution");
      publish(request, beginNotebookCellExecution(current(request), request.cellId, executionId));
      let receivedEvent = false;
      try {
        await transport.execute(
          {
            scope: request.scope,
            sessionId: request.sessionId,
            commandId: transport.createCommandId("execute"),
            executionId,
            cellId: request.cellId,
            code: request.code,
          },
          (event) => {
            receivedEvent = true;
            apply(request, [event]);
          },
        );
        if (current(request).recoveryAfterSequence !== null) await recover(request);
      } catch (cause) {
        const message = failureMessage(cause);
        publish(
          request,
          receivedEvent
            ? failNotebookRuntime(current(request), message)
            : failNotebookCellExecution(current(request), request.cellId, executionId, message),
        );
        throw cause;
      }
    },
    removeCell: (request) =>
      publish(request, pruneNotebookRuntimeCell(current(request), request.cellId)),
    interrupt: (request) => control(request, "interrupt"),
    restart: (request) => control(request, "restart"),
    dispose: (request) => control(request, "dispose"),
    clearError: (request) => publish(request, clearNotebookRuntimeError(current(request))),
  };
}
