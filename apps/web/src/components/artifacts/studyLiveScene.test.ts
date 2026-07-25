import { describe, expect, it } from "vite-plus/test";

import { decodeStudyLiveSceneMessage } from "./studyLiveScene";

const encoder = new TextEncoder();

describe("decodeStudyLiveSceneMessage", () => {
  it("accepts a validated semantic scene snapshot", () => {
    const message = decodeStudyLiveSceneMessage(
      encoder.encode(
        JSON.stringify({
          type: "study.scene.replace",
          version: 1,
          sequence: 2,
          artifact: {
            type: "artifact",
            id: "voice-scene",
            kind: "3d-scene",
            schemaVersion: 1,
            title: "Vector projection",
            payload: {
              objects: [{ type: "vector", id: "v", start: [0, 0, 0], end: [2, 1, 0] }],
            },
          },
        }),
      ),
    );

    expect(message?.type).toBe("study.scene.replace");
    expect(message?.sequence).toBe(2);
  });

  it("rejects executable or malformed scene payloads", () => {
    expect(
      decodeStudyLiveSceneMessage(
        encoder.encode(
          JSON.stringify({
            type: "study.scene.replace",
            version: 1,
            sequence: 0,
            artifact: {
              type: "artifact",
              id: "voice-scene",
              kind: "3d-scene",
              schemaVersion: 1,
              title: "Unsafe",
              payload: { objects: [{ type: "script", source: "alert(1)" }] },
            },
          }),
        ),
      ),
    ).toBeNull();
  });
});
