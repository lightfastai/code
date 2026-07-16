import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ArtifactEnvelope } from "./artifacts.ts";

export interface ArtifactDefinition<Kind extends string, Payload> {
  readonly kind: Kind;
  readonly schemaVersion: number;
  readonly payloadSchema: Schema.Schema<Payload>;
  readonly capabilities: readonly string[];
}

export const defineArtifact = <const Kind extends string, Payload>(
  definition: ArtifactDefinition<Kind, Payload>,
) => definition;

export type ArtifactRegistrationIdentity = {
  readonly kind: string;
  readonly schemaVersion: number;
};

export const artifactRegistrationKey = ({
  kind,
  schemaVersion,
}: ArtifactRegistrationIdentity): string => `${kind}@${schemaVersion}`;

export class ArtifactRegistryError extends Schema.TaggedErrorClass<ArtifactRegistryError>()(
  "ArtifactRegistryError",
  {
    reason: Schema.Literals([
      "invalid-envelope",
      "unknown-kind",
      "unsupported-version",
      "invalid-payload",
      "unsupported-capability",
    ]),
    message: Schema.String,
  },
) {}

type ErasedArtifactDefinition = {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly payloadSchema: Schema.Decoder<unknown>;
  readonly decodePayload: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly capabilities: readonly string[];
};

const decodeArtifactEnvelope = Schema.decodeUnknownEffect(ArtifactEnvelope);
const compilePayloadDecoder = Schema.decodeUnknownEffect;

export type RegisteredArtifactResolution = {
  readonly status: "registered";
  readonly artifact: ArtifactEnvelope;
  readonly definition: ErasedArtifactDefinition;
};

export type UnknownArtifactResolution = {
  readonly status: "unknown";
  readonly artifact: ArtifactEnvelope;
};

export type ClientArtifactResolution = RegisteredArtifactResolution | UnknownArtifactResolution;

type UnknownKindPolicy = "preserve" | "reject";

const registryError = (
  reason: ArtifactRegistryError["reason"],
  message: string,
): ArtifactRegistryError => new ArtifactRegistryError({ reason, message });

const decodeArtifact = Effect.fn("ArtifactRegistry.decodeArtifact")(function* (
  definitions: ReadonlyMap<string, ReadonlyMap<number, ErasedArtifactDefinition>>,
  input: unknown,
  unknownKindPolicy: UnknownKindPolicy,
) {
  const artifact = yield* decodeArtifactEnvelope(input).pipe(
    Effect.mapError(() =>
      registryError("invalid-envelope", "Artifact envelope validation failed."),
    ),
  );
  const versions = definitions.get(artifact.kind);
  if (versions === undefined) {
    if (unknownKindPolicy === "preserve") {
      return {
        status: "unknown",
        artifact,
      } satisfies UnknownArtifactResolution;
    }
    return yield* registryError(
      "unknown-kind",
      `Artifact kind ${artifact.kind} is not registered.`,
    );
  }

  const definition = versions.get(artifact.schemaVersion);
  if (definition === undefined) {
    return yield* registryError(
      "unsupported-version",
      `Artifact kind ${artifact.kind} does not support schema version ${artifact.schemaVersion}.`,
    );
  }

  yield* definition
    .decodePayload(artifact.payload)
    .pipe(
      Effect.mapError(() =>
        registryError(
          "invalid-payload",
          `Artifact payload validation failed for ${artifact.kind} version ${artifact.schemaVersion}.`,
        ),
      ),
    );

  const declaredCapabilities = new Set(definition.capabilities);
  for (const capability of artifact.capabilities ?? []) {
    if (!declaredCapabilities.has(capability)) {
      return yield* registryError(
        "unsupported-capability",
        `Artifact capability ${capability} is not registered for ${artifact.kind}.`,
      );
    }
  }

  return {
    status: "registered",
    artifact,
    definition,
  } satisfies RegisteredArtifactResolution;
});

export class ArtifactRegistry {
  readonly definitions: ReadonlyMap<string, ReadonlyMap<number, ErasedArtifactDefinition>>;

  readonly decodeForClient: (
    input: unknown,
  ) => Effect.Effect<ClientArtifactResolution, ArtifactRegistryError>;

  readonly decodeForPublication: (
    input: unknown,
  ) => Effect.Effect<RegisteredArtifactResolution, ArtifactRegistryError>;

  private constructor(
    definitions: ReadonlyMap<string, ReadonlyMap<number, ErasedArtifactDefinition>>,
  ) {
    this.definitions = definitions;
    this.decodeForClient = (input) => decodeArtifact(definitions, input, "preserve");
    this.decodeForPublication = (input) =>
      decodeArtifact(definitions, input, "reject").pipe(
        Effect.flatMap((resolution) =>
          resolution.status === "registered"
            ? Effect.succeed(resolution)
            : Effect.fail(
                registryError(
                  "unknown-kind",
                  `Artifact kind ${resolution.artifact.kind} is unknown.`,
                ),
              ),
        ),
      );
  }

  static make(definitions: readonly ArtifactDefinition<string, unknown>[]): ArtifactRegistry {
    const byKind = new Map<string, Map<number, ErasedArtifactDefinition>>();
    for (const definition of definitions) {
      const versions = byKind.get(definition.kind) ?? new Map();
      if (versions.has(definition.schemaVersion)) {
        throw new Error(
          `Artifact definition ${definition.kind} version ${definition.schemaVersion} is registered more than once.`,
        );
      }
      versions.set(definition.schemaVersion, {
        ...definition,
        // ArtifactDefinition intentionally exposes the plan's environment-neutral
        // Schema.Schema shape. Registered capability schemas are pure decoders.
        payloadSchema: definition.payloadSchema as Schema.Decoder<unknown>,
        decodePayload: compilePayloadDecoder(definition.payloadSchema as Schema.Decoder<unknown>),
      });
      byKind.set(definition.kind, versions);
    }
    return new ArtifactRegistry(byKind);
  }
}
