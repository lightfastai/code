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
      onState: request.onState,
    });
    return isActive() ? working : null;
  } catch (cause) {
    if (isActive()) request.onLoadError(notebookLifecycleErrorMessage(cause));
    throw cause;
  }
}

const targetsEqual = (left: NotebookRuntimeTarget, right: NotebookRuntimeTarget): boolean =>
  left.sessionId === right.sessionId && left.kernelName === right.kernelName;

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

  const next = applyImportedNotebookRevision(request.working, revision);
  const previousTarget = notebookRuntimeTarget(request.working);
  const nextTarget = notebookRuntimeTarget(next);
  if (!targetsEqual(previousTarget, nextTarget)) {
    await request.controller.dispose({
      scope: request.scope,
      sessionId: previousTarget.sessionId,
      onState: request.onState,
    });
  }
  if (!isActive()) return null;

  request.onWorkingCopy(next);
  await request.controller.connect({
    scope: request.scope,
    ...nextTarget,
    onState: request.onState,
  });
  return isActive() ? next : null;
}
