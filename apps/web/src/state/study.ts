import { createStudyEnvironmentAtoms } from "@t3tools/client-runtime/state/study";

import { connectionAtomRuntime } from "../connection/runtime";

export const studyEnvironment = createStudyEnvironmentAtoms(connectionAtomRuntime);
