import {
  createNotebookRuntimeController,
  type NotebookRuntimeControllerTransport,
} from "@t3tools/client-runtime/state/notebook-controller";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  NotebookArtifactController,
  NotebookProjectScope,
} from "@t3tools/lightfast-artifact-notebook/runtime";
import { useMemo } from "react";

import { notebookEnvironment } from "../../../state/notebook";
import { useAtomCommand } from "../../../state/use-atom-command";

let commandSequence = 0;
const commandId = (type: string): string => {
  commandSequence += 1;
  const random = Math.random().toString(36).slice(2);
  return `${type}-mobile-${Date.now().toString(36)}-${random}-${commandSequence}`;
};

const rpcScope = (scope: NotebookProjectScope) => ({
  environmentId: EnvironmentId.make(scope.environmentId),
  projectId: ProjectId.make(scope.projectId),
});

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
    const transport: NotebookRuntimeControllerTransport = {
      createCommandId: commandId,
      isSessionNotFound: (cause) =>
        typeof cause === "object" &&
        cause !== null &&
        "reason" in cause &&
        cause.reason === "session-not-found",
      recover: (request) =>
        unwrapCommand(
          events({
            environmentId: EnvironmentId.make(request.scope.environmentId),
            input: {
              scope: rpcScope(request.scope),
              sessionId: request.sessionId,
              afterSequence: request.afterSequence,
            },
          }),
        ),
      open: (request) =>
        unwrapCommand(
          openSession({
            environmentId: EnvironmentId.make(request.scope.environmentId),
            input: {
              scope: rpcScope(request.scope),
              sessionId: request.sessionId,
              commandId: request.commandId,
              kernelName: request.kernelName,
              documentIds: [...request.documentIds],
            },
          }),
        ),
      execute: (request, onEvent) =>
        unwrapCommand(
          executeCell({
            environmentId: EnvironmentId.make(request.scope.environmentId),
            input: {
              request: {
                scope: rpcScope(request.scope),
                sessionId: request.sessionId,
                commandId: request.commandId,
                executionId: request.executionId,
                cellId: request.cellId,
                code: request.code,
              },
              onEvent,
            },
          }),
        ),
      control: (type, request) => {
        const command = type === "interrupt" ? interrupt : type === "restart" ? restart : dispose;
        return unwrapCommand(
          command({
            environmentId: EnvironmentId.make(request.scope.environmentId),
            input: {
              scope: rpcScope(request.scope),
              sessionId: request.sessionId,
              commandId: request.commandId,
            },
          }),
        );
      },
    };
    const runtime = createNotebookRuntimeController(transport);
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
      downloadExport: () => undefined,
      ...runtime,
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
