import { StudyToolError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../../config.ts";
import {
  readStudyLibraryIndex,
  resolveStudyLibraryPaths,
  type StudyLibraryPaths,
} from "../../../study/StudyLibrary.ts";
import { searchStudyLibrary } from "../../../study/StudySearch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { StudyToolkit } from "./tools.ts";

const toToolError = (cause: unknown): StudyToolError =>
  new StudyToolError({
    message: cause instanceof Error ? cause.message : "The local study library request failed.",
  });

const withStudyLibrary = <A, E, R>(
  operation: (paths: StudyLibraryPaths) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* McpInvocationContext.requireStudyCapability();
    const config = yield* ServerConfig.ServerConfig;
    const paths = yield* resolveStudyLibraryPaths(config.studyLibraryDir);
    return yield* operation(paths);
  }).pipe(Effect.mapError(toToolError));

export const StudyToolkitHandlersLive = StudyToolkit.toLayer({
  study_library_list: (input) =>
    withStudyLibrary((paths) =>
      readStudyLibraryIndex(paths).pipe(
        Effect.map((index) => {
          const tags = input.tags?.map((tag) => tag.trim().toLocaleLowerCase()) ?? [];
          return index.documents.filter((document) =>
            tags.every((tag) => document.tags.includes(tag)),
          );
        }),
      ),
    ),
  study_library_search: (input) => withStudyLibrary((paths) => searchStudyLibrary(paths, input)),
});
