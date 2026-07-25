import {
  StudyLiveSceneMessage,
  type StudyLiveSceneMessage as StudyLiveSceneMessageValue,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(StudyLiveSceneMessage));
const textDecoder = new TextDecoder();

export function decodeStudyLiveSceneMessage(
  payload: Uint8Array,
): StudyLiveSceneMessageValue | null {
  return Option.getOrNull(decodeMessage(textDecoder.decode(payload)));
}
