import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const ARTIFACT_ID_MAX_CHARS = 128;
export const ARTIFACT_KIND_MAX_CHARS = 128;
export const ARTIFACT_TITLE_MAX_CHARS = 255;
export const ARTIFACT_PAYLOAD_MAX_BYTES = 256 * 1024;
export const ARTIFACT_CAPABILITIES_MAX = 32;
export const ARTIFACT_PROVENANCE_MAX = 32;

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);

export const ArtifactTrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const ArtifactId = ArtifactTrimmedNonEmptyString.check(
  Schema.isMaxLength(ARTIFACT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ArtifactId = typeof ArtifactId.Type;

export const ArtifactKind = ArtifactTrimmedNonEmptyString.check(
  Schema.isMaxLength(ARTIFACT_KIND_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9][a-z0-9._/-]*$/i),
);
export type ArtifactKind = typeof ArtifactKind.Type;

export const ArtifactCapabilityName = ArtifactTrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._:/-]*$/i),
);
export type ArtifactCapabilityName = typeof ArtifactCapabilityName.Type;

export const ArtifactSourceReference = Schema.Struct({
  sourceType: Schema.Literals(["pdf", "epub", "markdown", "canvas", "note", "conversation", "web"]),
  sourceId: ArtifactTrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  title: Schema.optional(
    ArtifactTrimmedNonEmptyString.check(Schema.isMaxLength(ARTIFACT_TITLE_MAX_CHARS)),
  ),
  locator: Schema.optional(ArtifactTrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
});
export type ArtifactSourceReference = typeof ArtifactSourceReference.Type;

const serializedPayloadSize = Schema.makeFilter<Schema.Json>(
  (payload) =>
    utf8ByteLength(JSON.stringify(payload)) <= ARTIFACT_PAYLOAD_MAX_BYTES ||
    `Artifact payload must not exceed ${ARTIFACT_PAYLOAD_MAX_BYTES} bytes.`,
);

export const ArtifactEnvelope = Schema.Struct({
  type: Schema.Literal("artifact"),
  id: ArtifactId,
  kind: ArtifactKind,
  schemaVersion: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  title: ArtifactTrimmedNonEmptyString.check(Schema.isMaxLength(ARTIFACT_TITLE_MAX_CHARS)),
  payload: Schema.Json.check(serializedPayloadSize),
  capabilities: Schema.optional(
    Schema.Array(ArtifactCapabilityName).check(Schema.isMaxLength(ARTIFACT_CAPABILITIES_MAX)),
  ),
  provenance: Schema.optional(
    Schema.Array(ArtifactSourceReference).check(Schema.isMaxLength(ARTIFACT_PROVENANCE_MAX)),
  ),
});
export type ArtifactEnvelope = typeof ArtifactEnvelope.Type;
