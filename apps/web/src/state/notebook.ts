import { createNotebookEnvironmentAtoms } from "@t3tools/client-runtime/state/notebook";

import { connectionAtomRuntime } from "../connection/runtime";

export const notebookEnvironment = createNotebookEnvironmentAtoms(connectionAtomRuntime);
