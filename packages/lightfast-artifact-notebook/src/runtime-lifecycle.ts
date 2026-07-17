import { sha256 } from "@noble/hashes/sha2";

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
  readonly revisionId: string;
  readonly kernelName: string;
  readonly documentIds: ReadonlyArray<string>;
};

const utf8Encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const normalizedStudyDocumentIds = (documentIds: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (
    documentIds.length > 32 ||
    documentIds.some((documentId) => !/^[0-9a-f]{64}$/.test(documentId))
  ) {
    return [];
  }
  return Array.from(new Set(documentIds)).toSorted();
};

const sessionIdFor = (
  documentId: string,
  revisionId: string,
  documentIds: ReadonlyArray<string>,
): string => {
  const base = `notebook-${hex(sha256(utf8Encoder.encode(documentId))).slice(0, 32)}-${revisionId}`;
  return documentIds.length === 0
    ? base
    : `${base}-${hex(sha256(utf8Encoder.encode(JSON.stringify(documentIds)))).slice(0, 16)}`;
};

export const notebookRuntimeTarget = (
  working: Pick<NotebookWorkingCopy, "documentId" | "baseRevision">,
  selectedDocumentIds: ReadonlyArray<string> = [],
): NotebookRuntimeTarget => {
  const documentIds = normalizedStudyDocumentIds(selectedDocumentIds);
  return {
    sessionId: sessionIdFor(working.documentId, working.baseRevision.revisionId, documentIds),
    revisionId: working.baseRevision.revisionId,
    kernelName: working.baseRevision.kernel.name,
    documentIds,
  };
};

export const notebookLifecycleErrorMessage = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : "Notebook action failed.";

export async function runNotebookTrackedAction(request: {
  readonly action: () => Promise<void>;
  readonly onError: (error: string | null) => void;
  readonly onPendingChange: (pending: boolean) => void;
}): Promise<void> {
  request.onPendingChange(true);
  request.onError(null);
  try {
    await request.action();
  } catch (cause) {
    request.onError(notebookLifecycleErrorMessage(cause));
  } finally {
    request.onPendingChange(false);
  }
}

type LifecycleRequest = {
  readonly controller: NotebookArtifactController;
  readonly scope: NotebookProjectScope;
  readonly documentIds?: ReadonlyArray<string>;
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
  _runtimeReady: boolean,
  runningCellIds: ReadonlySet<string>,
): boolean => pendingAction !== null || runningCellIds.size > 0;

export const isNotebookInterruptDisabled = (
  interruptPending: boolean,
  runtimeReady: boolean,
  runningCellIds: ReadonlySet<string>,
): boolean => !runtimeReady || runningCellIds.size === 0 || interruptPending;

export async function loadNotebookRevision(
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
    return isActive() ? working : null;
  } catch (cause) {
    if (isActive()) request.onLoadError(notebookLifecycleErrorMessage(cause));
    throw cause;
  }
}

export async function connectNotebookWorkingCopyRuntime(
  request: LifecycleRequest & { readonly working: NotebookWorkingCopy },
): Promise<NotebookRuntimeTarget | null> {
  const isActive = request.isActive ?? (() => true);
  const target = notebookRuntimeTarget(request.working, request.documentIds);
  await request.controller.connect({
    scope: request.scope,
    ...target,
    onState: guardedRuntimeState(request),
  });
  return isActive() ? target : null;
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
    readonly disposePreviousRuntime?: boolean;
  },
): Promise<NotebookWorkingCopy | null> {
  const isActive = request.isActive ?? (() => true);
  const previousTarget = notebookRuntimeTarget(request.working, request.documentIds);
  const nextTarget = notebookRuntimeTarget(request.nextWorking, request.documentIds);
  const revisionChanged =
    request.working.baseRevision.revisionId !== request.nextWorking.baseRevision.revisionId;
  const runtimeMustBeReplaced = revisionChanged || !targetsEqual(previousTarget, nextTarget);
  const onState = guardedRuntimeState(request);

  if (runtimeMustBeReplaced && request.disposePreviousRuntime !== false) {
    try {
      await request.controller.dispose({
        scope: request.scope,
        sessionId: previousTarget.sessionId,
        revisionId: previousTarget.revisionId,
        onState,
      });
    } catch (cause) {
      if (!isSessionNotFound(cause)) throw cause;
    }
  }
  if (!isActive()) return null;

  request.onWorkingCopy(request.nextWorking);
  return isActive() ? request.nextWorking : null;
}

export async function importNotebookRevisionAndReplaceRuntime(
  request: LifecycleRequest & {
    readonly working: NotebookWorkingCopy;
    readonly ipynbJson: string;
    readonly disposePreviousRuntime?: boolean;
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
