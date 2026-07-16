import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { StudyEvalDataset, StudyTraceEvent, StudyTraceRunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { resolveStudyLibraryPaths } from "./StudyLibrary.ts";
import {
  compareStudyEvalReports,
  evaluateStudyDataset,
  readStudyEvalReportFile,
  writeStudyEvalReport,
} from "./StudyEvalRunner.ts";
import {
  buildStudyTraceRecord,
  resolveStudyLoopPaths,
  studyTracePath,
  writeStudyTraceFile,
} from "./StudyTraceStore.ts";

const binding = {
  documentId: "notebook-eval",
  revisionId: "a".repeat(64),
  contentHash: "a".repeat(64),
  runtimeImageDigest: `sha256:${"b".repeat(64)}`,
  kernelLockHash: "c".repeat(64),
  kernelName: "python3",
} as const;

const outputHash = "d".repeat(64);

function notebookRecords(input: {
  readonly runId: StudyTraceRunId;
  readonly cleanupSucceeded: boolean;
}) {
  const eventBase = {
    sessionId: `session-${input.runId}`,
    executionId: "execution-1",
    cellId: "cell-1",
  };
  const events: ReadonlyArray<{ readonly timestamp: string; readonly event: StudyTraceEvent }> = [
    {
      timestamp: "2026-07-17T00:00:00.000Z",
      event: {
        type: "run_started",
        skill: { name: "notebook-agent-tools", version: "1", contentHash: "e".repeat(64) },
        runtime: {
          adapter: { id: "mcp/notebook", version: "1" },
          model: { provider: "test", name: "deterministic" },
          tools: [{ name: "notebook_execute_cell", version: "1" }],
        },
        documentIds: [],
        caseId: "notebook-safety",
      },
    },
    {
      timestamp: "2026-07-17T00:00:00.075Z",
      event: {
        type: "notebook_execution",
        operation: "execute_cell",
        outcome: input.cleanupSucceeded ? "completed" : "failed",
        permissionGranted: true,
        binding,
        sessionId: eventBase.sessionId,
        isolation: {
          session: "ephemeral-exclusive",
          network: "disabled",
          hostWorkspace: "not-mounted",
        },
        commands: [
          { type: "open", commandId: "open-1", startedAt: "2026-07-17T00:00:00.000Z" },
          {
            type: "execute",
            commandId: "execute-1",
            executionId: eventBase.executionId,
            cellId: eventBase.cellId,
            codeHash: "f".repeat(64),
            startedAt: "2026-07-17T00:00:00.010Z",
          },
          { type: "dispose", commandId: "dispose-1", startedAt: "2026-07-17T00:00:00.060Z" },
        ],
        runtimeEvents: [
          {
            type: "accepted",
            sessionId: eventBase.sessionId,
            commandId: "open-1",
            sequence: 1,
            commandType: "open",
          },
          {
            type: "accepted",
            ...eventBase,
            commandId: "execute-1",
            sequence: 2,
            commandType: "execute",
          },
          {
            type: "execution",
            ...eventBase,
            commandId: "execute-1",
            sequence: 3,
            executionCount: 1,
          },
          {
            type: "stream",
            ...eventBase,
            commandId: "execute-1",
            sequence: 4,
            name: "stdout",
            text: "one\n",
          },
          {
            type: "kernel",
            ...eventBase,
            commandId: "execute-1",
            sequence: 5,
            state: "idle",
          },
          {
            type: "accepted",
            sessionId: eventBase.sessionId,
            commandId: "dispose-1",
            sequence: 6,
            commandType: "dispose",
          },
          {
            type: "kernel",
            sessionId: eventBase.sessionId,
            commandId: "dispose-1",
            sequence: 7,
            state: "terminated",
          },
        ],
        outputHash,
        startedAt: "2026-07-17T00:00:00.000Z",
        finishedAt: "2026-07-17T00:00:00.075Z",
        durationMs: 75,
        cleanup: {
          attempted: true,
          succeeded: input.cleanupSucceeded,
          commandId: "dispose-1",
        },
      },
    },
    {
      timestamp: "2026-07-17T00:00:00.076Z",
      event: { type: "run_finished", reason: input.cleanupSucceeded ? "completed" : "error" },
    },
  ];

  let previousHash: string | null = null;
  return events.map(({ timestamp, event }, sequence) => {
    const record = buildStudyTraceRecord({
      runId: input.runId,
      sequence,
      timestamp,
      previousHash,
      event,
    });
    previousHash = record.hash;
    return record;
  });
}

const dataset: StudyEvalDataset = {
  version: 1,
  id: "notebook-agent-v1",
  title: "Deterministic notebook agent safety",
  cases: [
    {
      id: "notebook-safety",
      title: "Notebook execution is exact, ordered, bounded, isolated, and cleaned",
      split: "holdout",
      assertions: [
        {
          type: "notebook_output_order",
          operation: "execute_cell",
          commandOrder: ["open", "execute", "dispose"],
          runtimeEventOrder: ["accepted", "execution", "stream", "kernel", "accepted", "kernel"],
          outputHash,
        },
        { type: "notebook_max_latency", operation: "execute_cell", maxMs: 100 },
        { type: "notebook_permission", operation: "execute_cell", required: true },
        { type: "notebook_isolation", operation: "execute_cell" },
        { type: "notebook_cleanup", operation: "execute_cell" },
        { type: "notebook_identity", operation: "execute_cell", binding },
      ],
    },
  ],
};

it.layer(NodeServices.layer)("NotebookStudyEval", (it) => {
  it.effect(
    "covers deterministic notebook order, latency, permission, isolation, cleanup, and identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "notebook-eval-" });
          const paths = yield* resolveStudyLoopPaths(yield* resolveStudyLibraryPaths(temp));
          const runId = "notebook-baseline" as StudyTraceRunId;
          yield* writeStudyTraceFile({
            tracePath: yield* studyTracePath(paths, runId),
            records: notebookRecords({ runId, cleanupSucceeded: true }),
          });

          const report = yield* evaluateStudyDataset({
            paths,
            dataset,
            traceBindings: { "notebook-safety": runId },
            reportId: "notebook-report",
            evaluatedAt: "2026-07-17T00:01:00.000Z",
          });

          assert.isTrue(report.passed);
          assert.deepStrictEqual(
            report.cases[0]?.assertions.map(({ type, passed }) => [type, passed]),
            [
              ["notebook_output_order", true],
              ["notebook_max_latency", true],
              ["notebook_permission", true],
              ["notebook_isolation", true],
              ["notebook_cleanup", true],
              ["notebook_identity", true],
            ],
          );
        }),
      ),
  );

  it.effect("keeps reports immutable and rejects a deliberately failing candidate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "notebook-promotion-" });
        const paths = yield* resolveStudyLoopPaths(yield* resolveStudyLibraryPaths(temp));
        const baselineRunId = "notebook-baseline" as StudyTraceRunId;
        const candidateRunId = "notebook-candidate-failing" as StudyTraceRunId;
        yield* writeStudyTraceFile({
          tracePath: yield* studyTracePath(paths, baselineRunId),
          records: notebookRecords({ runId: baselineRunId, cleanupSucceeded: true }),
        });
        yield* writeStudyTraceFile({
          tracePath: yield* studyTracePath(paths, candidateRunId),
          records: notebookRecords({ runId: candidateRunId, cleanupSucceeded: false }),
        });
        const baseline = yield* evaluateStudyDataset({
          paths,
          dataset,
          traceBindings: { "notebook-safety": baselineRunId },
          reportId: "notebook-baseline-report",
          evaluatedAt: "2026-07-17T00:01:00.000Z",
        });
        const candidate = yield* evaluateStudyDataset({
          paths,
          dataset,
          traceBindings: { "notebook-safety": candidateRunId },
          reportId: "notebook-candidate-report",
          evaluatedAt: "2026-07-17T00:02:00.000Z",
        });

        const baselinePath = yield* writeStudyEvalReport({ paths, report: baseline });
        yield* writeStudyEvalReport({ paths, report: baseline });
        const overwrite = yield* Effect.result(
          writeStudyEvalReport({ paths, report: { ...baseline, passed: false } }),
        );
        const comparison = yield* compareStudyEvalReports({
          baseline,
          candidate,
          policy: {
            minimumOverallDelta: 0,
            minimumHoldoutDelta: 0,
            maximumRegressions: 0,
            requireCandidatePass: true,
          },
        });

        assert.strictEqual(overwrite._tag, "Failure");
        assert.isTrue((yield* readStudyEvalReportFile(baselinePath)).passed);
        assert.isFalse(candidate.passed);
        assert.isFalse(comparison.promotable);
        assert.include(comparison.reasons.join(" "), "Candidate does not pass");
      }),
    ),
  );
});
