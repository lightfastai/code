import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createStudyEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const voiceScheduler = createAtomCommandScheduler();
  return {
    library: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:study:library",
      tag: WS_METHODS.studyLibraryList,
      staleTimeMs: 2_000,
    }),
    search: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:study:search",
      tag: WS_METHODS.studyLibrarySearch,
      staleTimeMs: 10_000,
      idleTtlMs: 60_000,
    }),
    createVoiceSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:study:voice-session-create",
      tag: WS_METHODS.studyVoiceSessionCreate,
      scheduler: voiceScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
