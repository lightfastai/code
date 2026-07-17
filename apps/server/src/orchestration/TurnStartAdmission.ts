import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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
