import { OrchestrationCheckpointFile } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ClearCheckpointTurnConflictInput,
  CompleteProjectionAcceptedTurnStartPhaseInput,
  DeleteProjectionTurnsByThreadInput,
  GetProjectionPendingTurnStartInput,
  GetProjectionTurnByTurnIdInput,
  ListProjectionTurnsByThreadInput,
  ProjectionAcceptedTurnStart,
  ProjectionAcceptedTurnStartState,
  ProjectionPendingTurnStart,
  ProjectionTurn,
  ProjectionTurnById,
  ProjectionTurnRepository,
  ProjectionTurnStartKey,
  type ProjectionTurnRepositoryShape,
} from "../Services/ProjectionTurns.ts";

const ProjectionTurnDbRowSchema = ProjectionTurn.mapFields(
  Struct.assign({
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

const ProjectionTurnByIdDbRowSchema = ProjectionTurnById.mapFields(
  Struct.assign({
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

const ProjectionAcceptedTurnStartDbRowSchema = ProjectionAcceptedTurnStartState.mapFields(
  Struct.assign({
    providerSendCompleted: Schema.Int,
    runtimeAdmitted: Schema.Int,
  }),
);

const decodeAcceptedTurnStart = (
  row: typeof ProjectionAcceptedTurnStartDbRowSchema.Type,
): ProjectionAcceptedTurnStartState => ({
  ...row,
  providerSendCompleted: row.providerSendCompleted === 1,
  runtimeAdmitted: row.runtimeAdmitted === 1,
});

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTurnById = SqlSchema.void({
    Request: ProjectionTurnByIdDbRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          ${row.threadId},
          ${row.turnId},
          ${row.pendingMessageId},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          ${row.assistantMessageId},
          ${row.state},
          ${row.requestedAt},
          ${row.startedAt},
          ${row.completedAt},
          ${row.checkpointTurnCount},
          ${row.checkpointRef},
          ${row.checkpointStatus},
          ${row.checkpointFiles}
        )
        ON CONFLICT (thread_id, turn_id)
        DO UPDATE SET
          pending_message_id = excluded.pending_message_id,
          source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
          source_proposed_plan_id = excluded.source_proposed_plan_id,
          assistant_message_id = excluded.assistant_message_id,
          state = excluded.state,
          requested_at = excluded.requested_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          checkpoint_turn_count = excluded.checkpoint_turn_count,
          checkpoint_ref = excluded.checkpoint_ref,
          checkpoint_status = excluded.checkpoint_status,
          checkpoint_files_json = excluded.checkpoint_files_json
      `,
  });

  const clearPendingProjectionTurnsByThread = SqlSchema.void({
    Request: DeleteProjectionTurnsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND checkpoint_turn_count IS NULL
      `,
  });

  const insertPendingProjectionTurn = SqlSchema.void({
    Request: ProjectionPendingTurnStart,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          ${row.threadId},
          NULL,
          ${row.messageId},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          NULL,
          'pending',
          ${row.requestedAt},
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `,
  });

  const getPendingProjectionTurn = SqlSchema.findOneOption({
    Request: GetProjectionPendingTurnStartInput,
    Result: ProjectionPendingTurnStart,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
        ORDER BY requested_at DESC
        LIMIT 1
      `,
  });

  const insertAcceptedProjectionTurnStart = SqlSchema.void({
    Request: ProjectionAcceptedTurnStart,
    execute: (row) =>
      sql`
        INSERT INTO projection_turn_start_admissions (
          thread_id,
          message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          requested_at
        )
        VALUES (
          ${row.threadId},
          ${row.messageId},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          ${row.requestedAt}
        )
        ON CONFLICT (thread_id) DO NOTHING
      `,
  });

  const getAcceptedProjectionTurnStart = SqlSchema.findOneOption({
    Request: GetProjectionPendingTurnStartInput,
    Result: ProjectionAcceptedTurnStartDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          requested_at AS "requestedAt",
          provider_send_completed AS "providerSendCompleted",
          runtime_admitted AS "runtimeAdmitted"
        FROM projection_turn_start_admissions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const completeAcceptedProjectionTurnStartPhase = SqlSchema.findOneOption({
    Request: CompleteProjectionAcceptedTurnStartPhaseInput,
    Result: ProjectionAcceptedTurnStartDbRowSchema,
    execute: ({ threadId, messageId, phase }) =>
      sql`
        UPDATE projection_turn_start_admissions
        SET
          provider_send_completed = CASE
            WHEN ${phase} = 'provider-send-completed' THEN 1
            ELSE provider_send_completed
          END,
          runtime_admitted = CASE
            WHEN ${phase} = 'runtime-admitted' THEN 1
            ELSE runtime_admitted
          END
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
        RETURNING
          thread_id AS "threadId",
          message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          requested_at AS "requestedAt",
          provider_send_completed AS "providerSendCompleted",
          runtime_admitted AS "runtimeAdmitted"
      `,
  });

  const deleteAcceptedProjectionTurnStart = SqlSchema.findOneOption({
    Request: ProjectionTurnStartKey,
    Result: ProjectionTurnStartKey,
    execute: ({ threadId, messageId }) =>
      sql`
        DELETE FROM projection_turn_start_admissions
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
        RETURNING
          thread_id AS "threadId",
          message_id AS "messageId"
      `,
  });

  const deletePendingProjectionTurnStart = SqlSchema.findOneOption({
    Request: ProjectionTurnStartKey,
    Result: ProjectionTurnStartKey,
    execute: ({ threadId, messageId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id = ${messageId}
          AND checkpoint_turn_count IS NULL
        RETURNING
          thread_id AS "threadId",
          pending_message_id AS "messageId"
      `,
  });

  const listProjectionTurnsByThread = SqlSchema.findAll({
    Request: ListProjectionTurnsByThreadInput,
    Result: ProjectionTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          pending_message_id AS "pendingMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_files_json AS "checkpointFiles"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC,
          turn_id ASC
      `,
  });

  const getProjectionTurnByTurnId = SqlSchema.findOneOption({
    Request: GetProjectionTurnByTurnIdInput,
    Result: ProjectionTurnByIdDbRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          pending_message_id AS "pendingMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_files_json AS "checkpointFiles"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
        LIMIT 1
      `,
  });

  const clearCheckpointTurnConflictRow = SqlSchema.void({
    Request: ClearCheckpointTurnConflictInput,
    execute: ({ threadId, turnId, checkpointTurnCount }) =>
      sql`
        UPDATE projection_turns
        SET
          checkpoint_turn_count = NULL,
          checkpoint_ref = NULL,
          checkpoint_status = NULL,
          checkpoint_files_json = '[]'
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
          AND (turn_id IS NULL OR turn_id <> ${turnId})
      `,
  });

  const deleteProjectionTurnsByThread = SqlSchema.void({
    Request: DeleteProjectionTurnsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteAcceptedProjectionTurnStartsByThread = SqlSchema.void({
    Request: DeleteProjectionTurnsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_turn_start_admissions
        WHERE thread_id = ${threadId}
      `,
  });

  const upsertByTurnId: ProjectionTurnRepositoryShape["upsertByTurnId"] = (row) =>
    upsertProjectionTurnById(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.upsertByTurnId:query",
          "ProjectionTurnRepository.upsertByTurnId:encodeRequest",
        ),
      ),
    );

  const replacePendingTurnStart: ProjectionTurnRepositoryShape["replacePendingTurnStart"] = (row) =>
    sql
      .withTransaction(
        clearPendingProjectionTurnsByThread({ threadId: row.threadId }).pipe(
          Effect.flatMap(() => insertPendingProjectionTurn(row)),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionTurnRepository.replacePendingTurnStart:query",
            "ProjectionTurnRepository.replacePendingTurnStart:encodeRequest",
          ),
        ),
      );

  const getPendingTurnStartByThreadId: ProjectionTurnRepositoryShape["getPendingTurnStartByThreadId"] =
    (input) =>
      getPendingProjectionTurn(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.getPendingTurnStartByThreadId:query"),
        ),
      );

  const stageAcceptedTurnStart: ProjectionTurnRepositoryShape["stageAcceptedTurnStart"] = (row) =>
    sql
      .withTransaction(
        insertAcceptedProjectionTurnStart(row).pipe(
          Effect.andThen(getAcceptedProjectionTurnStart({ threadId: row.threadId })),
          Effect.map(
            Option.match({
              onNone: () => false,
              onSome: (accepted) => accepted.messageId === row.messageId,
            }),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionTurnRepository.stageAcceptedTurnStart:query",
            "ProjectionTurnRepository.stageAcceptedTurnStart:encodeRequest",
          ),
        ),
      );

  const getAcceptedTurnStartByThreadId: ProjectionTurnRepositoryShape["getAcceptedTurnStartByThreadId"] =
    (input) =>
      getAcceptedProjectionTurnStart(input).pipe(
        Effect.map(Option.map(decodeAcceptedTurnStart)),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionTurnRepository.getAcceptedTurnStartByThreadId:query",
            "ProjectionTurnRepository.getAcceptedTurnStartByThreadId:decodeRow",
          ),
        ),
      );

  const completeAcceptedTurnStartPhase: ProjectionTurnRepositoryShape["completeAcceptedTurnStartPhase"] =
    (input) =>
      sql
        .withTransaction(
          completeAcceptedProjectionTurnStartPhase(input).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none()),
                onSome: (dbRow) => {
                  const accepted = decodeAcceptedTurnStart(dbRow);
                  if (!accepted.providerSendCompleted || !accepted.runtimeAdmitted) {
                    return Effect.succeed(Option.some({ ...accepted, finalized: false }));
                  }
                  return deleteAcceptedProjectionTurnStart(input).pipe(
                    Effect.map(
                      Option.match({
                        onNone: () => Option.none(),
                        onSome: () => Option.some({ ...accepted, finalized: true }),
                      }),
                    ),
                  );
                },
              }),
            ),
          ),
        )
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionTurnRepository.completeAcceptedTurnStartPhase:query",
              "ProjectionTurnRepository.completeAcceptedTurnStartPhase:decodeRow",
            ),
          ),
        );

  const deleteAcceptedTurnStart: ProjectionTurnRepositoryShape["deleteAcceptedTurnStart"] = (
    input,
  ) =>
    deleteAcceptedProjectionTurnStart(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.deleteAcceptedTurnStart:query",
          "ProjectionTurnRepository.deleteAcceptedTurnStart:decodeRow",
        ),
      ),
    );

  const deletePendingTurnStart: ProjectionTurnRepositoryShape["deletePendingTurnStart"] = (input) =>
    deletePendingProjectionTurnStart(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.deletePendingTurnStart:query",
          "ProjectionTurnRepository.deletePendingTurnStart:decodeRow",
        ),
      ),
    );

  const deletePendingTurnStartByThreadId: ProjectionTurnRepositoryShape["deletePendingTurnStartByThreadId"] =
    (input) =>
      clearPendingProjectionTurnsByThread(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.deletePendingTurnStartByThreadId:query"),
        ),
      );

  const listByThreadId: ProjectionTurnRepositoryShape["listByThreadId"] = (input) =>
    listProjectionTurnsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.listByThreadId:query",
          "ProjectionTurnRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionTurn>>),
    );

  const getByTurnId: ProjectionTurnRepositoryShape["getByTurnId"] = (input) =>
    getProjectionTurnByTurnId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.getByTurnId:query",
          "ProjectionTurnRepository.getByTurnId:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionTurnById>)),
        }),
      ),
    );

  const clearCheckpointTurnConflict: ProjectionTurnRepositoryShape["clearCheckpointTurnConflict"] =
    (input) =>
      clearCheckpointTurnConflictRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.clearCheckpointTurnConflict:query"),
        ),
      );

  const deleteByThreadId: ProjectionTurnRepositoryShape["deleteByThreadId"] = (input) =>
    sql
      .withTransaction(
        deleteProjectionTurnsByThread(input).pipe(
          Effect.andThen(deleteAcceptedProjectionTurnStartsByThread(input)),
        ),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionTurnRepository.deleteByThreadId:query")),
      );

  return {
    upsertByTurnId,
    replacePendingTurnStart,
    getPendingTurnStartByThreadId,
    stageAcceptedTurnStart,
    getAcceptedTurnStartByThreadId,
    completeAcceptedTurnStartPhase,
    deleteAcceptedTurnStart,
    deletePendingTurnStart,
    deletePendingTurnStartByThreadId,
    listByThreadId,
    getByTurnId,
    clearCheckpointTurnConflict,
    deleteByThreadId,
  } satisfies ProjectionTurnRepositoryShape;
});

export const ProjectionTurnRepositoryLive = Layer.effect(
  ProjectionTurnRepository,
  makeProjectionTurnRepository,
);
