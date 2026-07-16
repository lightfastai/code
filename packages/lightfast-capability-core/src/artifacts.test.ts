import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ARTIFACT_PAYLOAD_MAX_BYTES, type ArtifactEnvelope } from "./artifacts.ts";
import { ArtifactRegistry, defineArtifact } from "./registry.ts";

const cardDefinition = defineArtifact({
  kind: "example.card",
  schemaVersion: 1,
  payloadSchema: Schema.Struct({ body: Schema.String }),
  capabilities: ["example.card:view"] as const,
});

const registry = ArtifactRegistry.make([cardDefinition]);

const card = (overrides: Partial<ArtifactEnvelope> = {}): ArtifactEnvelope => ({
  type: "artifact",
  id: "artifact-card",
  kind: "example.card",
  schemaVersion: 1,
  title: "Example card",
  payload: { body: "Hello" },
  capabilities: ["example.card:view"],
  ...overrides,
});

describe("ArtifactRegistry", () => {
  it.effect("validates registered payloads and namespaced capabilities", () =>
    Effect.gen(function* () {
      const resolved = yield* registry.decodeForClient(card());

      assert.strictEqual(resolved.status, "registered");
      assert.strictEqual(resolved.artifact.kind, "example.card");
      assert.deepStrictEqual(resolved.artifact.payload, { body: "Hello" });
    }),
  );

  it.effect("rejects invalid registered payloads", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(registry.decodeForClient(card({ payload: { body: 42 } })));

      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("preserves unknown client artifacts without interpreting their payload", () =>
    Effect.gen(function* () {
      const artifact = card({
        kind: "vendor.future",
        schemaVersion: 7,
        payload: { opaque: ["keep", 7, true] },
        capabilities: ["vendor.future:inspect"],
      });
      const resolved = yield* registry.decodeForClient(artifact);

      assert.strictEqual(resolved.status, "unknown");
      assert.deepStrictEqual(resolved.artifact, artifact);
    }),
  );

  it.effect("rejects unknown server publications", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        registry.decodeForPublication(card({ kind: "vendor.future" })),
      );

      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("rejects unsupported versions of registered kinds", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(registry.decodeForClient(card({ schemaVersion: 2 })));

      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("rejects capabilities not declared by the registered definition", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        registry.decodeForPublication(card({ capabilities: ["example.card:edit"] })),
      );

      assert.strictEqual(result._tag, "Failure");
    }),
  );
});

describe("ArtifactEnvelope", () => {
  it.effect("rejects payloads above the serialized size limit", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        registry.decodeForClient(
          card({ payload: { body: "x".repeat(ARTIFACT_PAYLOAD_MAX_BYTES + 1) } }),
        ),
      );

      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("rejects oversized common metadata", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(registry.decodeForClient(card({ title: "x".repeat(256) })));

      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it("keeps the limit explicit for capability packages", () => {
    expect(ARTIFACT_PAYLOAD_MAX_BYTES).toBe(256 * 1024);
  });
});
