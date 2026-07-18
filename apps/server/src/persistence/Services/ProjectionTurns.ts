/**
 * ProjectionTurnRepository - Projection repository interface for unified turn state.
 *
 * Owns persistence operations for projected turn intent/lifecycle/checkpoint rows and the
 * separate exact accepted-start admission record used by provider runtime ingestion.
 *
 * @module ProjectionTurnRepository
 */
import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationProposedPlanId,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTurnState = Schema.Literals([
  "pending",
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type ProjectionTurnState = typeof ProjectionTurnState.Type;

export const ProjectionTurn = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  pendingMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  assistantMessageId: Schema.NullOr(MessageId),
  state: ProjectionTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  checkpointTurnCount: Schema.NullOr(NonNegativeInt),
  checkpointRef: Schema.NullOr(CheckpointRef),
  checkpointStatus: Schema.NullOr(OrchestrationCheckpointStatus),
  checkpointFiles: Schema.Array(OrchestrationCheckpointFile),
});
export type ProjectionTurn = typeof ProjectionTurn.Type;

export const ProjectionTurnById = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  pendingMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  assistantMessageId: Schema.NullOr(MessageId),
  state: ProjectionTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  checkpointTurnCount: Schema.NullOr(NonNegativeInt),
  checkpointRef: Schema.NullOr(CheckpointRef),
  checkpointStatus: Schema.NullOr(OrchestrationCheckpointStatus),
  checkpointFiles: Schema.Array(OrchestrationCheckpointFile),
});
export type ProjectionTurnById = typeof ProjectionTurnById.Type;

export const ProjectionPendingTurnStart = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  requestedAt: IsoDateTime,
});
export type ProjectionPendingTurnStart = typeof ProjectionPendingTurnStart.Type;

export const ProjectionAcceptedTurnStart = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  requestedAt: IsoDateTime,
});
export type ProjectionAcceptedTurnStart = typeof ProjectionAcceptedTurnStart.Type;

export const ProjectionAcceptedTurnStartState = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  requestedAt: IsoDateTime,
  providerSendCompleted: Schema.Boolean,
  runtimeAdmitted: Schema.Boolean,
});
export type ProjectionAcceptedTurnStartState = typeof ProjectionAcceptedTurnStartState.Type;

export const ProjectionAcceptedTurnStartPhase = Schema.Literals([
  "provider-send-completed",
  "runtime-admitted",
]);
export type ProjectionAcceptedTurnStartPhase = typeof ProjectionAcceptedTurnStartPhase.Type;

export const CompleteProjectionAcceptedTurnStartPhaseInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  phase: ProjectionAcceptedTurnStartPhase,
});
export type CompleteProjectionAcceptedTurnStartPhaseInput =
  typeof CompleteProjectionAcceptedTurnStartPhaseInput.Type;

export const ProjectionAcceptedTurnStartPhaseResult = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  requestedAt: IsoDateTime,
  providerSendCompleted: Schema.Boolean,
  runtimeAdmitted: Schema.Boolean,
  finalized: Schema.Boolean,
});
export type ProjectionAcceptedTurnStartPhaseResult =
  typeof ProjectionAcceptedTurnStartPhaseResult.Type;

export const ProjectionCancelledTurnStart = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  providerTurnId: TurnId,
  cancelledAt: IsoDateTime,
});
export type ProjectionCancelledTurnStart = typeof ProjectionCancelledTurnStart.Type;

export const GetProjectionCancelledTurnStartInput = Schema.Struct({
  threadId: ThreadId,
  providerTurnId: TurnId,
});
export type GetProjectionCancelledTurnStartInput = typeof GetProjectionCancelledTurnStartInput.Type;

export const ListProjectionTurnsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionTurnsByThreadInput = typeof ListProjectionTurnsByThreadInput.Type;

export const GetProjectionTurnByTurnIdInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type GetProjectionTurnByTurnIdInput = typeof GetProjectionTurnByTurnIdInput.Type;

export const GetProjectionPendingTurnStartInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionPendingTurnStartInput = typeof GetProjectionPendingTurnStartInput.Type;

export const ProjectionTurnStartKey = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type ProjectionTurnStartKey = typeof ProjectionTurnStartKey.Type;

export const DeleteProjectionTurnsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionTurnsByThreadInput = typeof DeleteProjectionTurnsByThreadInput.Type;

export const ClearCheckpointTurnConflictInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
});
export type ClearCheckpointTurnConflictInput = typeof ClearCheckpointTurnConflictInput.Type;

export interface ProjectionTurnRepositoryShape {
  /**
   * Inserts or updates the canonical row for a concrete `{threadId, turnId}` turn lifecycle state.
   */
  readonly upsertByTurnId: (
    row: ProjectionTurnById,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Replaces any existing pending-start placeholder rows for a thread with exactly one latest pending-start row.
   */
  readonly replacePendingTurnStart: (
    row: ProjectionPendingTurnStart,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Returns the newest pending-start placeholder for a thread; this is expected to be at most one row after replacement writes.
   */
  readonly getPendingTurnStartByThreadId: (
    input: GetProjectionPendingTurnStartInput,
  ) => Effect.Effect<Option.Option<ProjectionPendingTurnStart>, ProjectionRepositoryError>;

  /**
   * Persists the exact turn start admitted by the reactor without replacing a different admission.
   * Replaying the same `{threadId, messageId}` is idempotent.
   */
  readonly stageAcceptedTurnStart: (
    row: ProjectionAcceptedTurnStart,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /** Returns the reactor-admitted turn start independently of the latest projected intent. */
  readonly getAcceptedTurnStartByThreadId: (
    input: GetProjectionPendingTurnStartInput,
  ) => Effect.Effect<Option.Option<ProjectionAcceptedTurnStartState>, ProjectionRepositoryError>;

  /** Records one exact completion phase and atomically finalizes the row when both phases exist. */
  readonly completeAcceptedTurnStartPhase: (
    input: CompleteProjectionAcceptedTurnStartPhaseInput,
  ) => Effect.Effect<
    Option.Option<ProjectionAcceptedTurnStartPhaseResult>,
    ProjectionRepositoryError
  >;

  /** Atomically records an exact failed provider generation and removes its accepted start. */
  readonly cancelAcceptedTurnStart: (
    input: ProjectionCancelledTurnStart,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /** Returns an exact failed provider generation tombstone when present. */
  readonly getCancelledTurnStartByProviderTurn: (
    input: GetProjectionCancelledTurnStartInput,
  ) => Effect.Effect<Option.Option<ProjectionCancelledTurnStart>, ProjectionRepositoryError>;

  /** Deletes an accepted turn start only when both its thread and message identity match. */
  readonly deleteAcceptedTurnStart: (
    input: ProjectionTurnStartKey,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /** Deletes a projected pending intent only when both its thread and message identity match. */
  readonly deletePendingTurnStart: (
    input: ProjectionTurnStartKey,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Deletes only pending-start placeholder rows (`turnId = null`) for a thread and leaves concrete turn rows untouched.
   */
  readonly deletePendingTurnStartByThreadId: (
    input: GetProjectionPendingTurnStartInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Lists all projection rows for a thread, including pending placeholders, with checkpoint rows ordered before non-checkpoint rows.
   */
  readonly listByThreadId: (
    input: ListProjectionTurnsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurn>, ProjectionRepositoryError>;

  /**
   * Looks up a concrete turn row by `{threadId, turnId}` and never returns pending placeholder rows.
   */
  readonly getByTurnId: (
    input: GetProjectionTurnByTurnIdInput,
  ) => Effect.Effect<Option.Option<ProjectionTurnById>, ProjectionRepositoryError>;

  /**
   * Clears checkpoint fields on conflicting rows that reuse the same checkpoint turn count in a thread, excluding the provided turn.
   */
  readonly clearCheckpointTurnConflict: (
    input: ClearCheckpointTurnConflictInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Hard-deletes all projection rows for a thread, including pending-start placeholders and checkpoint metadata rows.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionTurnsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionTurnRepository extends Context.Service<
  ProjectionTurnRepository,
  ProjectionTurnRepositoryShape
>()("t3/persistence/Services/ProjectionTurns/ProjectionTurnRepository") {}
