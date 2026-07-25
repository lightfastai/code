import {
  ARTIFACT_PROVENANCE_MAX,
  ARTIFACT_TITLE_MAX_CHARS,
  ArtifactId,
  ArtifactSourceReference,
  ArtifactTrimmedNonEmptyString,
} from "@t3tools/lightfast-capability-core/artifacts";
import { defineArtifact } from "@t3tools/lightfast-capability-core/registry";
import * as Schema from "effect/Schema";

const SCENE_OBJECTS_MAX = 128;

const SceneObjectId = ArtifactTrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);

export const SceneVec3 = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]);
export type SceneVec3 = typeof SceneVec3.Type;

const SceneColor = ArtifactTrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^(#[0-9a-f]{3,8}|[a-z]+)$/i),
);
const SceneOpacity = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const PositiveSceneNumber = Schema.Number.check(Schema.isGreaterThan(0));
const SceneLabel = ArtifactTrimmedNonEmptyString.check(Schema.isMaxLength(120));

const SceneObjectStyle = {
  color: Schema.optional(SceneColor),
  opacity: Schema.optional(SceneOpacity),
  label: Schema.optional(SceneLabel),
} as const;

export const Scene3DPoint = Schema.Struct({
  type: Schema.Literal("point"),
  id: SceneObjectId,
  position: SceneVec3,
  radius: Schema.optional(PositiveSceneNumber),
  ...SceneObjectStyle,
});

export const Scene3DVector = Schema.Struct({
  type: Schema.Literal("vector"),
  id: SceneObjectId,
  start: SceneVec3,
  end: SceneVec3,
  ...SceneObjectStyle,
});

export const Scene3DSegment = Schema.Struct({
  type: Schema.Literal("segment"),
  id: SceneObjectId,
  start: SceneVec3,
  end: SceneVec3,
  ...SceneObjectStyle,
});

export const Scene3DSphere = Schema.Struct({
  type: Schema.Literal("sphere"),
  id: SceneObjectId,
  center: SceneVec3,
  radius: PositiveSceneNumber,
  wireframe: Schema.optional(Schema.Boolean),
  ...SceneObjectStyle,
});

export const Scene3DCircle = Schema.Struct({
  type: Schema.Literal("circle"),
  id: SceneObjectId,
  center: SceneVec3,
  normal: SceneVec3,
  radius: PositiveSceneNumber,
  ...SceneObjectStyle,
});

export const Scene3DPlane = Schema.Struct({
  type: Schema.Literal("plane"),
  id: SceneObjectId,
  center: SceneVec3,
  normal: SceneVec3,
  width: PositiveSceneNumber,
  height: PositiveSceneNumber,
  ...SceneObjectStyle,
});

export const Scene3DObject = Schema.Union([
  Scene3DPoint,
  Scene3DVector,
  Scene3DSegment,
  Scene3DSphere,
  Scene3DCircle,
  Scene3DPlane,
]);
export type Scene3DObject = typeof Scene3DObject.Type;

export const Scene3DCamera = Schema.Struct({
  position: SceneVec3,
  target: SceneVec3,
  fieldOfView: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 15, maximum: 100 })),
  ),
});
export type Scene3DCamera = typeof Scene3DCamera.Type;

export const Scene3DGrid = Schema.Struct({
  visible: Schema.optional(Schema.Boolean),
  size: Schema.optional(PositiveSceneNumber),
  divisions: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 100 }))),
});
export type Scene3DGrid = typeof Scene3DGrid.Type;

export const Scene3DPayload = Schema.Struct({
  camera: Schema.optional(Scene3DCamera),
  grid: Schema.optional(Scene3DGrid),
  background: Schema.optional(SceneColor),
  objects: Schema.Array(Scene3DObject).check(Schema.isMaxLength(SCENE_OBJECTS_MAX)),
});
export type Scene3DPayload = typeof Scene3DPayload.Type;

export const ChatArtifactCapability = Schema.Literals(["orbit", "pan", "zoom", "reset-camera"]);
export type ChatArtifactCapability = typeof ChatArtifactCapability.Type;

export const scene3DDefaultCapabilities = ["orbit", "pan", "zoom", "reset-camera"] as const;

export const scene3DArtifactDefinition = defineArtifact({
  kind: "3d-scene",
  schemaVersion: 1,
  payloadSchema: Scene3DPayload,
  // These wire values predate the capability registry and remain stable for
  // persisted chat messages and the live voice scene protocol.
  capabilities: scene3DDefaultCapabilities,
});

export const ChatScene3DArtifact = Schema.Struct({
  type: Schema.Literal("artifact"),
  id: ArtifactId,
  kind: Schema.Literal(scene3DArtifactDefinition.kind),
  schemaVersion: Schema.Literal(scene3DArtifactDefinition.schemaVersion),
  title: ArtifactTrimmedNonEmptyString.check(Schema.isMaxLength(ARTIFACT_TITLE_MAX_CHARS)),
  payload: Scene3DPayload,
  provenance: Schema.optional(
    Schema.Array(ArtifactSourceReference).check(Schema.isMaxLength(ARTIFACT_PROVENANCE_MAX)),
  ),
  capabilities: Schema.optional(Schema.Array(ChatArtifactCapability).check(Schema.isMaxLength(8))),
});
export type ChatScene3DArtifact = typeof ChatScene3DArtifact.Type;

export const PublishScene3DArtifactInput = Schema.Struct({
  title: ArtifactTrimmedNonEmptyString.check(Schema.isMaxLength(ARTIFACT_TITLE_MAX_CHARS)),
  payload: Scene3DPayload,
  provenance: Schema.optional(
    Schema.Array(ArtifactSourceReference).check(Schema.isMaxLength(ARTIFACT_PROVENANCE_MAX)),
  ),
  capabilities: Schema.optional(Schema.Array(ChatArtifactCapability).check(Schema.isMaxLength(8))),
});
export type PublishScene3DArtifactInput = typeof PublishScene3DArtifactInput.Type;

export const PublishScene3DArtifactResult = Schema.Struct({
  artifactId: ArtifactId,
  messageId: ArtifactTrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type PublishScene3DArtifactResult = typeof PublishScene3DArtifactResult.Type;

export class ArtifactPublishError extends Schema.TaggedErrorClass<ArtifactPublishError>()(
  "ArtifactPublishError",
  {
    message: Schema.String,
  },
) {}

export { ArtifactId as ChatArtifactId };
