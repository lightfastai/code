import { describe, expect, it } from "vite-plus/test";
import { jwtVerify } from "jose";
import * as DateTime from "effect/DateTime";

import { createLiveKitParticipantToken } from "./liveKitToken.js";

describe("createLiveKitParticipantToken", () => {
  it("issues a short-lived room-scoped participant grant", async () => {
    const result = await createLiveKitParticipantToken({
      apiKey: "test-key",
      apiSecret: "test-secret",
      identity: "study-user-1",
      roomName: "study-room-1",
      agentName: "t3-study-voice",
      metadata: { documentIds: ["a".repeat(64)] },
      ttlSeconds: 300,
      nowEpochSeconds: DateTime.makeUnsafe("2026-07-15T00:00:00.000Z").epochMilliseconds / 1_000,
    });
    const verified = await jwtVerify(result.token, new TextEncoder().encode("test-secret"), {
      issuer: "test-key",
      currentDate: DateTime.toDate(DateTime.makeUnsafe("2026-07-15T00:00:01.000Z")),
    });

    expect(verified.payload.sub).toBe("study-user-1");
    expect(verified.payload.video).toEqual({
      roomJoin: true,
      room: "study-room-1",
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    expect(JSON.parse(String(verified.payload.metadata))).toMatchObject({
      documentIds: ["a".repeat(64)],
    });
    expect(verified.payload.roomConfig).toEqual({
      agents: [{ agentName: "t3-study-voice" }],
    });
    expect(result.expiresAt).toBe("2026-07-15T00:05:00.000Z");
  });
});
