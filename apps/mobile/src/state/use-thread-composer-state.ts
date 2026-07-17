import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo } from "react";

import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type StudyDocument,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";
import { appendStudyDocumentsToPrompt } from "@t3tools/shared/studyContext";
import * as Option from "effect/Option";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useThreadShell } from "./entities";
import { useThreadDetail } from "../state/use-thread-detail";
import { routeTargetMatchesThread, threadRouteTargetKey } from "./thread-route-target";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { useThreadOutboxMessages } from "./use-thread-outbox";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState(target: ScopedThreadRef) {
  const targetThreadShell = useThreadShell(target);
  const targetThreadDetail = Option.getOrNull(useThreadDetail(target).data);
  const selectedThreadShell =
    targetThreadShell !== null && routeTargetMatchesThread(target, targetThreadShell)
      ? targetThreadShell
      : null;
  const selectedThreadDetail =
    targetThreadDetail?.id === target.threadId ? targetThreadDetail : null;
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = threadRouteTargetKey(target);
  const selectedThreadQueuedMessages = useMemo(
    () => queuedMessagesByThreadKey[selectedThreadKey] ?? [],
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const selectedThreadFeed = useMemo(
    () => (selectedThreadDetail ? buildThreadFeed(selectedThreadDetail) : []),
    [selectedThreadDetail],
  );

  const selectedDraft = composerDrafts[selectedThreadKey];
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const studyDocuments = selectedDraft?.studyDocuments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");

  const onSendMessageContent = useCallback(
    async (input: {
      readonly text: string;
      readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
    }) => {
      if (!selectedThreadShell) {
        return null;
      }

      const draft = getComposerDraftSnapshot(selectedThreadKey);
      const thread = selectedThreadDetail ?? selectedThreadShell;
      const rawText = input.text.trim();
      const attachments = input.attachments ?? [];
      if (rawText.length === 0 && attachments.length === 0) {
        return null;
      }
      const text = appendStudyDocumentsToPrompt(rawText, draft.studyDocuments ?? []);

      const metadata = makeQueuedMessageMetadata();
      const messageId = MessageId.make(metadata.messageId);
      try {
        await enqueueThreadOutboxMessage({
          environmentId: target.environmentId,
          threadId: target.threadId,
          messageId,
          commandId: CommandId.make(metadata.commandId),
          text,
          attachments,
          modelSelection: draft.modelSelection ?? thread.modelSelection,
          runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
          interactionMode: draft.interactionMode ?? thread.interactionMode,
          createdAt: metadata.createdAt,
        });
        return messageId;
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to save the queued message.",
        );
        return null;
      }
    },
    [
      selectedThreadDetail,
      selectedThreadKey,
      selectedThreadShell,
      target.environmentId,
      target.threadId,
    ],
  );

  const onSendMessage = useCallback(async () => {
    const draft = getComposerDraftSnapshot(selectedThreadKey);
    const messageId = await onSendMessageContent({
      text: draft.text,
      attachments: draft.attachments,
    });
    if (messageId !== null) {
      clearComposerDraftContent(selectedThreadKey);
    }
    return messageId;
  }, [onSendMessageContent, selectedThreadKey]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      setComposerDraftText(selectedThreadKey, value);
    },
    [selectedThreadKey],
  );

  const onPickDraftImages = useCallback(async () => {
    const result = await pickComposerImages({
      existingCount: composerDrafts[selectedThreadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(selectedThreadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadKey]);

  const onPasteIntoDraft = useCallback(async () => {
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[selectedThreadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(selectedThreadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(selectedThreadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadKey]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (uris.length === 0) {
        return;
      }

      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[selectedThreadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(selectedThreadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: target.environmentId,
          threadId: target.threadId,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadKey, target.environmentId, target.threadId],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      removeComposerDraftAttachment(selectedThreadKey, imageId);
    },
    [selectedThreadKey],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateStudyDocuments = useCallback(
    (documents: ReadonlyArray<StudyDocument>) => {
      updateComposerDraftSettings(selectedThreadKey, {
        studyDocuments: documents.slice(0, 32),
      });
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    studyDocuments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onSendMessageContent,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
    onUpdateStudyDocuments,
  };
}
