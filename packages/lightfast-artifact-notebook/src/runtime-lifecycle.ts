import type { NotebookRevision } from "./contracts.ts";
import {
  applyImportedNotebookRevision,
  createNotebookWorkingCopy,
  type NotebookWorkingCopy,
} from "./working-copy.ts";
import type {
  NotebookArtifactController,
  NotebookProjectScope,
  NotebookRuntimeView,
} from "./web.tsx";

export type NotebookRuntimeTarget = {
  readonly sessionId: string;
  readonly kernelName: string;
};

const sessionIdFor = (documentId: string): string =>
  `notebook-${documentId}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);

export const notebookRuntimeTarget = (
  working: Pick<NotebookWorkingCopy, "documentId" | "baseRevision">,
): NotebookRuntimeTarget => ({
  sessionId: sessionIdFor(working.documentId),
  kernelName: working.baseRevision.kernel.name,
});

export const notebookLifecycleErrorMessage = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : "Notebook action failed.";

type LifecycleRequest = {
  readonly controller: NotebookArtifactController;
  readonly scope: NotebookProjectScope;
  readonly onState: (state: NotebookRuntimeView) => void;
  readonly onWorkingCopy: (working: NotebookWorkingCopy) => void;
  readonly isActive?: () => boolean;
};

const guardedRuntimeState = (request: LifecycleRequest) => (state: NotebookRuntimeView) => {
  if (request.isActive?.() ?? true) request.onState(state);
};

export const isNotebookRevisionSwitchDisabled = (
  pendingAction: string | null,
  runningCellIds: ReadonlySet<string>,
): boolean => pendingAction !== null || runningCellIds.size > 0;

export const isNotebookExecutionDisabled = (
  pendingAction: string | null,
  runtimeReady: boolean,
  runningCellIds: ReadonlySet<string>,
): boolean => pendingAction !== null || !runtimeReady || runningCellIds.size > 0;

export async function loadNotebookRevisionAndConnect(
  request: LifecycleRequest & {
    readonly documentId: string;
    readonly revisionId: string;
    readonly onLoadError: (error: string | null) => void;
  },
): Promise<NotebookWorkingCopy | null> {
  const isActive = request.isActive ?? (() => true);
  request.onLoadError(null);
  try {
    const revision = await request.controller.readRevision(
      request.scope,
      request.documentId,
      request.revisionId,
    );
    if (!isActive()) return null;
    const working = createNotebookWorkingCopy(revision);
    request.onWorkingCopy(working);
    const target = notebookRuntimeTarget(working);
    await request.controller.connect({
      scope: request.scope,
      ...target,
      onState: guardedRuntimeState(request),
    });
    return isActive() ? working : null;
  } catch (cause) {
    if (isActive()) request.onLoadError(notebookLifecycleErrorMessage(cause));
    throw cause;
  }
}

const targetsEqual = (left: NotebookRuntimeTarget, right: NotebookRuntimeTarget): boolean =>
  left.sessionId === right.sessionId && left.kernelName === right.kernelName;

const isSessionNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  cause.reason === "session-not-found";

export async function replaceNotebookWorkingCopyRuntime(
  request: LifecycleRequest & {
    readonly working: NotebookWorkingCopy;
    readonly nextWorking: NotebookWorkingCopy;
  },
): Promise<NotebookWorkingCopy | null> {
  const isActive = request.isActive ?? (() => true);
  const previousTarget = notebookRuntimeTarget(request.working);
  const nextTarget = notebookRuntimeTarget(request.nextWorking);
  const identityChanged = !targetsEqual(previousTarget, nextTarget);
  const onState = guardedRuntimeState(request);

  if (identityChanged) {
    try {
      await request.controller.dispose({
        scope: request.scope,
        sessionId: previousTarget.sessionId,
        onState,
      });
    } catch (cause) {
      if (!isSessionNotFound(cause)) throw cause;
    }
  }
  if (!isActive()) return null;

  request.onWorkingCopy(request.nextWorking);
  await request.controller.connect({
    scope: request.scope,
    ...nextTarget,
    onState,
  });
  return isActive() ? request.nextWorking : null;
}

export async function importNotebookRevisionAndReplaceRuntime(
  request: LifecycleRequest & {
    readonly working: NotebookWorkingCopy;
    readonly ipynbJson: string;
  },
): Promise<NotebookWorkingCopy | null> {
  const isActive = request.isActive ?? (() => true);
  const revision: NotebookRevision = await request.controller.importRevision(
    request.scope,
    request.ipynbJson,
  );
  if (!isActive()) return null;

  return replaceNotebookWorkingCopyRuntime({
    ...request,
    nextWorking: applyImportedNotebookRevision(request.working, revision),
  });
}
