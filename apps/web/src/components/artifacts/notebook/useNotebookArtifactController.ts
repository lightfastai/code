import {
  applyNotebookExecutionEvents,
  applyNotebookExecutionReplay,
  clearNotebookRuntimeError,
  createNotebookRuntimeState,
  failNotebookRuntime,
  type NotebookRuntimeState,
} from "@t3tools/client-runtime/state/notebook";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  NotebookArtifactController,
  NotebookProjectScope,
  NotebookRuntimeView,
} from "@t3tools/lightfast-artifact-notebook/web";
import { useMemo } from "react";

import { notebookEnvironment } from "~/state/notebook";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  executeNotebookCellWithState,
  notebookExecutionFailureMessage,
} from "./notebookExecutionController";
import { NotebookRuntimeCache } from "./notebookRuntimeCache";

const runtimeStates = new NotebookRuntimeCache<NotebookRuntimeState>();
const connectionAttempts = new Map<string, Promise<void>>();

let commandSequence = 0;
const commandId = (type: string): string => {
  commandSequence += 1;
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);
  return `${type}-${[...values].map((value) => value.toString(16).padStart(8, "0")).join("")}-${commandSequence}`;
};

const rpcScope = (scope: NotebookProjectScope) => ({
  environmentId: EnvironmentId.make(scope.environmentId),
  projectId: ProjectId.make(scope.projectId),
});

const runtimeKey = (scope: NotebookProjectScope, sessionId: string): string =>
  `${scope.environmentId}\0${scope.projectId}\0${sessionId}`;

const isSessionNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  cause.reason === "session-not-found";

async function unwrapCommand<A>(
  promise: Promise<
    | { readonly _tag: "Success"; readonly value: A }
    | {
        readonly _tag: "Failure";
        readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
      }
  >,
): Promise<A> {
  const result = await promise;
  if (result._tag === "Success") return result.value;
  const cause = squashAtomCommandFailure(result);
  throw cause instanceof Error ? cause : new Error(String(cause));
}

export function useNotebookArtifactController(): NotebookArtifactController {
  const readRevision = useAtomCommand(notebookEnvironment.readRevision, { reportFailure: false });
  const saveRevision = useAtomCommand(notebookEnvironment.saveRevision, { reportFailure: false });
  const importRevision = useAtomCommand(notebookEnvironment.importRevision, {
    reportFailure: false,
  });
  const exportRevision = useAtomCommand(notebookEnvironment.exportRevision, {
    reportFailure: false,
  });
  const openSession = useAtomCommand(notebookEnvironment.openSession, { reportFailure: false });
  const executeCell = useAtomCommand(notebookEnvironment.executeCell, { reportFailure: false });
  const interrupt = useAtomCommand(notebookEnvironment.interrupt, { reportFailure: false });
  const restart = useAtomCommand(notebookEnvironment.restart, { reportFailure: false });
  const dispose = useAtomCommand(notebookEnvironment.dispose, { reportFailure: false });
  const events = useAtomCommand(notebookEnvironment.events, { reportFailure: false });

  return useMemo(() => {
    type RuntimeRequest = {
      readonly scope: NotebookProjectScope;
      readonly sessionId: string;
      readonly onState: (state: NotebookRuntimeView) => void;
    };
    const current = (request: Pick<RuntimeRequest, "scope" | "sessionId">) =>
      runtimeStates.get(runtimeKey(request.scope, request.sessionId)) ??
      createNotebookRuntimeState();
    const publish = (
      request: RuntimeRequest,
      state: NotebookRuntimeState,
    ): NotebookRuntimeState => {
      runtimeStates.set(runtimeKey(request.scope, request.sessionId), state);
      request.onState(state);
      return state;
    };
    const apply = (
      request: RuntimeRequest,
      nextEvents: Parameters<typeof applyNotebookExecutionEvents>[1],
    ) => publish(request, applyNotebookExecutionEvents(current(request), nextEvents));
    const applyReplay = (
      request: RuntimeRequest,
      replay: Parameters<typeof applyNotebookExecutionReplay>[1],
    ) => publish(request, applyNotebookExecutionReplay(current(request), replay));
    const fail = (request: RuntimeRequest, cause: unknown): never => {
      publish(
        request,
        failNotebookRuntime(current(request), notebookExecutionFailureMessage(cause)),
      );
      throw cause;
    };
    const recoverSession = async (request: RuntimeRequest) => {
      const recovered = await unwrapCommand(
        events({
          environmentId: EnvironmentId.make(request.scope.environmentId),
          input: {
            scope: rpcScope(request.scope),
            sessionId: request.sessionId,
            afterSequence: current(request).lastSequence,
          },
        }),
      );
      applyReplay(request, recovered);
    };
    const control = async (
      request: RuntimeRequest,
      type: "interrupt" | "restart" | "dispose",
      command: typeof interrupt | typeof restart | typeof dispose,
    ) => {
      try {
        apply(
          request,
          await unwrapCommand(
            command({
              environmentId: EnvironmentId.make(request.scope.environmentId),
              input: {
                scope: rpcScope(request.scope),
                sessionId: request.sessionId,
                commandId: commandId(type),
              },
            }),
          ),
        );
      } catch (cause) {
        fail(request, cause);
      }
      if (type === "dispose") {
        const key = runtimeKey(request.scope, request.sessionId);
        runtimeStates.delete(key);
        connectionAttempts.delete(key);
      }
    };

    return {
      readRevision: (scope, documentId, revisionId) =>
        unwrapCommand(
          readRevision({
            environmentId: EnvironmentId.make(scope.environmentId),
            input: { scope: rpcScope(scope), documentId, revisionId },
          }),
        ),
      saveRevision: (scope, documentId, document) =>
        unwrapCommand(
          saveRevision({
            environmentId: EnvironmentId.make(scope.environmentId),
            input: { scope: rpcScope(scope), documentId, document },
          }),
        ),
      importRevision: (scope, ipynbJson) =>
        unwrapCommand(
          importRevision({
            environmentId: EnvironmentId.make(scope.environmentId),
            input: { scope: rpcScope(scope), ipynbJson },
          }),
        ),
      exportRevision: (scope, documentId, revisionId) =>
        unwrapCommand(
          exportRevision({
            environmentId: EnvironmentId.make(scope.environmentId),
            input: { scope: rpcScope(scope), documentId, revisionId },
          }),
        ),
      downloadExport: (file) => {
        const url = URL.createObjectURL(new Blob([file.ipynbJson], { type: file.contentType }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.fileName;
        anchor.click();
        URL.revokeObjectURL(url);
      },
      connect: async (request) => {
        const key = runtimeKey(request.scope, request.sessionId);
        const existing = connectionAttempts.get(key);
        if (existing !== undefined) {
          await existing;
          request.onState(current(request));
          return;
        }
        const attempt = (async () => {
          try {
            if (current(request).kernelStatus !== "terminated") {
              try {
                await recoverSession(request);
                if (current(request).lastSequence > 0) return;
              } catch (cause) {
                if (!isSessionNotFound(cause)) throw cause;
              }
            }
            publish(request, createNotebookRuntimeState());
            apply(
              request,
              await unwrapCommand(
                openSession({
                  environmentId: EnvironmentId.make(request.scope.environmentId),
                  input: {
                    scope: rpcScope(request.scope),
                    sessionId: request.sessionId,
                    commandId: commandId("open"),
                    kernelName: request.kernelName,
                  },
                }),
              ),
            );
            await recoverSession(request);
          } catch (cause) {
            fail(request, cause);
          }
        })();
        connectionAttempts.set(key, attempt);
        try {
          await attempt;
        } finally {
          if (connectionAttempts.get(key) === attempt) connectionAttempts.delete(key);
        }
      },
      recover: async (request) => {
        try {
          await recoverSession(request);
        } catch (cause) {
          fail(request, cause);
        }
      },
      executeCell: async (request) => {
        const executionId = commandId("execution");
        await executeNotebookCellWithState({
          cellId: request.cellId,
          executionId,
          current: () => current(request),
          publish: (state) => publish(request, state),
          execute: (onEvent) =>
            unwrapCommand(
              executeCell({
                environmentId: EnvironmentId.make(request.scope.environmentId),
                input: {
                  request: {
                    scope: rpcScope(request.scope),
                    sessionId: request.sessionId,
                    commandId: commandId("execute"),
                    executionId,
                    cellId: request.cellId,
                    code: request.code,
                  },
                  onEvent,
                },
              }),
            ),
          recover: () => recoverSession(request),
        });
      },
      interrupt: (request) => control(request, "interrupt", interrupt),
      restart: (request) => control(request, "restart", restart),
      dispose: (request) => control(request, "dispose", dispose),
      clearError: (request) => publish(request, clearNotebookRuntimeError(current(request))),
    } satisfies NotebookArtifactController;
  }, [
    dispose,
    events,
    executeCell,
    exportRevision,
    importRevision,
    interrupt,
    openSession,
    readRevision,
    restart,
    saveRevision,
  ]);
}
