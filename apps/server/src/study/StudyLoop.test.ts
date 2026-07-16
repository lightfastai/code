import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type {
  StudyEvalDataset,
  StudySkillArtifactRef,
  StudyTraceEvent,
  StudyTraceRunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveStudyLibraryPaths } from "./StudyLibrary.ts";
import { compareStudyEvalReports, evaluateStudyDataset } from "./StudyEvalRunner.ts";
import {
  buildStudyTraceRecord,
  readStudyTrace,
  readStudyTraceFile,
  resolveStudyLoopPaths,
  studyTracePath,
  writeStudyTraceFile,
} from "./StudyTraceStore.ts";

const skill = {
  name: "study",
  version: "baseline",
  contentHash: "a".repeat(64),
  source: "builtin://study",
} as StudySkillArtifactRef;

function makeRecords(input: {
  runId: StudyTraceRunId;
  includeSearch: boolean;
  skill?: StudySkillArtifactRef;
}) {
  const events: Array<{ timestamp: string; event: StudyTraceEvent }> = [
    {
      timestamp: "2026-07-15T00:00:00.000Z",
      event: {
        type: "run_started",
        skill: input.skill ?? skill,
        runtime: {
          adapter: { id: "study-voice/livekit", version: "1" },
          model: { provider: "groq", name: "test-model" },
          tools: [{ name: "search_study_library", version: "1" }],
        },
        documentIds: [],
      },
    },
    {
      timestamp: "2026-07-15T00:00:01.000Z",
      event: { type: "user_message", text: "Explain eigenvectors", modality: "voice" },
    },
    ...(input.includeSearch
      ? ([
          {
            timestamp: "2026-07-15T00:00:01.200Z",
            event: {
              type: "tool_call",
              callId: "call-1",
              name: "search_study_library",
              arguments: { query: "eigenvectors" },
            },
          },
          {
            timestamp: "2026-07-15T00:00:01.300Z",
            event: {
              type: "tool_result",
              callId: "call-1",
              name: "search_study_library",
              output: "A direction preserved by a linear map.",
              isError: false,
            },
          },
        ] satisfies Array<{ timestamp: string; event: StudyTraceEvent }>)
      : []),
    {
      timestamp: "2026-07-15T00:00:02.000Z",
      event: {
        type: "assistant_message",
        text: "An eigenvector keeps its direction.",
        modality: "voice",
        interrupted: false,
        latencyMs: 1000,
      },
    },
    {
      timestamp: "2026-07-15T00:00:03.000Z",
      event: { type: "run_finished", reason: "completed" },
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

function dataset(): StudyEvalDataset {
  return {
    version: 1,
    id: "grounded-voice-v1",
    title: "Grounded voice behavior",
    cases: [
      {
        id: "search-before-answer",
        title: "Search selected books before answering",
        split: "holdout",
        assertions: [
          {
            type: "event_count",
            matcher: { eventType: "tool_call", toolName: "search_study_library" },
            min: 1,
          },
          {
            type: "event_order",
            before: { eventType: "tool_call", toolName: "search_study_library" },
            after: { eventType: "assistant_message" },
          },
          {
            type: "max_latency",
            from: { eventType: "user_message" },
            to: { eventType: "assistant_message" },
            maxMs: 2_000,
          },
        ],
      },
    ],
  };
}

it.layer(NodeServices.layer)("StudyLoop", (it) => {
  it.effect("verifies traces emitted by the Python LiveKit adapter", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixturePath = yield* path.fromFileUrl(
        new URL("./fixtures/python-voice-trace.jsonl", import.meta.url),
      );

      const trace = yield* readStudyTraceFile(fixturePath);

      assert.strictEqual(trace.runId, "python-voice-fixture");
      assert.strictEqual(trace.records.length, 3);
      assert.isTrue(trace.complete);
    }),
  );

  it.effect("round-trips and verifies immutable hash-chained traces", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "study-loop-trace-" });
        const loopPaths = yield* resolveStudyLoopPaths(yield* resolveStudyLibraryPaths(temp));
        const runId = "voice-run-1" as StudyTraceRunId;
        const tracePath = yield* studyTracePath(loopPaths, runId);
        const records = makeRecords({ runId, includeSearch: true });
        yield* writeStudyTraceFile({ tracePath, records });

        const verified = yield* readStudyTrace(loopPaths, runId);
        assert.isTrue(verified.complete);
        assert.strictEqual(verified.records.length, 6);
        assert.strictEqual(verified.integrityHash, records.at(-1)?.hash);

        const tamperedPath = path.join(temp, "tampered.jsonl");
        const raw = yield* fileSystem.readFileString(tracePath);
        yield* fileSystem.writeFileString(
          tamperedPath,
          raw.replace("Explain eigenvectors", "Explain singular values"),
        );
        const tampered = yield* Effect.result(readStudyTraceFile(tamperedPath));
        assert.strictEqual(tampered._tag, "Failure");
      }),
    ),
  );

  it.effect("grades traces and only promotes candidates without holdout regressions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "study-loop-eval-" });
        const loopPaths = yield* resolveStudyLoopPaths(yield* resolveStudyLibraryPaths(temp));
        const baselineId = "voice-baseline" as StudyTraceRunId;
        const candidateId = "voice-candidate" as StudyTraceRunId;
        yield* writeStudyTraceFile({
          tracePath: yield* studyTracePath(loopPaths, baselineId),
          records: makeRecords({ runId: baselineId, includeSearch: false }),
        });
        yield* writeStudyTraceFile({
          tracePath: yield* studyTracePath(loopPaths, candidateId),
          records: makeRecords({
            runId: candidateId,
            includeSearch: true,
            skill: { ...skill, version: "candidate", contentHash: "b".repeat(64) },
          }),
        });

        const baseline = yield* evaluateStudyDataset({
          paths: loopPaths,
          dataset: dataset(),
          traceBindings: { "search-before-answer": baselineId },
          reportId: "eval-baseline",
          evaluatedAt: "2026-07-15T00:10:00.000Z",
        });
        const candidate = yield* evaluateStudyDataset({
          paths: loopPaths,
          dataset: dataset(),
          traceBindings: { "search-before-answer": candidateId },
          reportId: "eval-candidate",
          evaluatedAt: "2026-07-15T00:11:00.000Z",
        });
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
        const unchangedFailure = yield* compareStudyEvalReports({
          baseline,
          candidate: baseline,
          policy: {
            minimumOverallDelta: 0,
            minimumHoldoutDelta: 0,
            maximumRegressions: 0,
            requireCandidatePass: true,
          },
        });

        assert.strictEqual(baseline.score, 1 / 3);
        assert.strictEqual(candidate.score, 1);
        assert.isTrue(candidate.passed);
        assert.isTrue(comparison.promotable);
        assert.deepStrictEqual(comparison.improvements, ["search-before-answer"]);
        assert.deepStrictEqual(comparison.regressions, []);
        assert.isFalse(unchangedFailure.promotable);
        assert.include(unchangedFailure.reasons[0] ?? "", "does not pass");
      }),
    ),
  );
});
