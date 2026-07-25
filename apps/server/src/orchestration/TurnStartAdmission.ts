import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { MessageId, ThreadId } from "@t3tools/contracts";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type {
  CompleteProjectionAcceptedTurnStartPhaseInput,
  ProjectionTurnRepositoryShape,
} from "../persistence/Services/ProjectionTurns.ts";

export const completeTurnStartAdmissionPhase = Effect.fn("completeTurnStartAdmissionPhase")(
  function* (
    repository: ProjectionTurnRepositoryShape,
    input: CompleteProjectionAcceptedTurnStartPhaseInput,
  ) {
    const completed = yield* repository.completeAcceptedTurnStartPhase(input);
    if (Option.isNone(completed) || !completed.value.finalized) {
      return completed;
    }

    yield* repository
      .deletePendingTurnStart({ threadId: input.threadId, messageId: input.messageId })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("turn-start admission finalized with pending cleanup deferred", {
            threadId: input.threadId,
            messageId: input.messageId,
            phase: input.phase,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    const finalizedAuthority =
      yield* McpSessionRegistry.finalizeActiveNotebookDocumentAuthorityTurn({
        threadId: input.threadId,
        messageId: input.messageId,
      });
    if (!finalizedAuthority) {
      yield* Effect.logWarning(
        "turn-start admission durable state finalized without MCP finalization",
        {
          threadId: input.threadId,
          messageId: input.messageId,
          phase: input.phase,
        },
      );
    }
    return completed;
  },
);

export const reconcileInactiveTurnStartAdmission = Effect.fn("reconcileInactiveTurnStartAdmission")(
  function* (
    repository: ProjectionTurnRepositoryShape,
    input: {
      readonly threadId: ThreadId;
      readonly nextMessageId: MessageId;
      readonly authorityProbeSucceeded?: boolean;
    },
  ) {
    const acceptedOption = yield* repository.getAcceptedTurnStartByThreadId({
      threadId: input.threadId,
    });
    if (Option.isNone(acceptedOption) || acceptedOption.value.messageId === input.nextMessageId) {
      return "ready" as const;
    }

    const accepted = acceptedOption.value;
    const acceptedKey = {
      threadId: input.threadId,
      messageId: accepted.messageId,
    } as const;
    const projectedTurns = yield* repository.listByThreadId({ threadId: input.threadId });
    const hasConcreteRuntimeProjection = projectedTurns.some(
      (turn) => turn.turnId !== null && turn.pendingMessageId === accepted.messageId,
    );

    if (!hasConcreteRuntimeProjection && input.authorityProbeSucceeded !== true) {
      return "authority-probe-required" as const;
    }

    if (hasConcreteRuntimeProjection) {
      yield* McpSessionRegistry.admitActiveNotebookDocumentAuthorityTurn(acceptedKey);
      yield* completeTurnStartAdmissionPhase(repository, {
        ...acceptedKey,
        phase: "runtime-admitted",
      });
    }

    const remainingOption = yield* repository.getAcceptedTurnStartByThreadId({
      threadId: input.threadId,
    });
    if (Option.isNone(remainingOption) || remainingOption.value.messageId !== accepted.messageId) {
      return "ready" as const;
    }

    const acceptedDeleted = yield* repository.deleteAcceptedTurnStart(acceptedKey).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("inactive turn-start admission accepted cleanup deferred", {
          ...acceptedKey,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );
    yield* repository.deletePendingTurnStart(acceptedKey).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("inactive turn-start admission pending cleanup deferred", {
          ...acceptedKey,
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* McpSessionRegistry.rollbackActiveNotebookDocumentAuthorityTurn(acceptedKey);
    return acceptedDeleted ? ("ready" as const) : ("blocked" as const);
  },
);
