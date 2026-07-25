import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveStudyLibraryPaths } from "./StudyLibrary.ts";
import { createStudyVoiceSession } from "./StudyVoiceSession.ts";

function participantMetadata(token: string): unknown {
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) throw new Error("JWT payload is missing.");
  const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
    metadata?: string;
  };
  return payload.metadata === undefined ? undefined : JSON.parse(payload.metadata);
}

it.layer(NodeServices.layer)("StudyVoiceSession", (it) => {
  it.effect("issues a room-scoped session without exposing provider secrets", () =>
    Effect.gen(function* () {
      const paths = yield* resolveStudyLibraryPaths("/tmp/t3-study-voice-test");
      const session = yield* createStudyVoiceSession({
        paths,
        request: { documentIds: [] },
        environment: {
          liveKitUrl: "wss://voice.example.test",
          liveKitApiKey: "test-key",
          liveKitApiSecret: "test-secret",
          agentName: "t3-study-voice",
        },
        randomUUID: () => "00000000-0000-4000-8000-000000000000",
        nowEpochSeconds: 1_784_073_600,
      });

      expect(session).toMatchObject({
        url: "wss://voice.example.test/",
        roomName: "study-00000000-0000-4000-8000-000000000000",
        expiresAt: "2026-07-15T00:15:00.000Z",
      });
      expect(session.token).not.toContain("test-secret");
      expect(participantMetadata(session.token)).toEqual({
        version: 1,
        selectedDocuments: [],
      });
    }),
  );

  it.effect("fails closed when voice credentials are absent", () =>
    Effect.gen(function* () {
      const paths = yield* resolveStudyLibraryPaths("/tmp/t3-study-voice-test");
      const error = yield* createStudyVoiceSession({
        paths,
        request: { documentIds: [] },
        environment: {},
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "StudyVoiceSessionError",
        reason: "not-configured",
      });
    }),
  );
});
