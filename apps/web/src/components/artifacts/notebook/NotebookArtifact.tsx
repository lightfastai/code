import type { ScopedProjectRef } from "@t3tools/contracts";
import {
  NotebookWebProvider,
  type NotebookAgentExecutionPermission,
} from "@t3tools/lightfast-artifact-notebook/web";
import { useMemo, type ReactNode } from "react";

import { useNotebookArtifactController } from "./useNotebookArtifactController";

const UNAVAILABLE_AGENT_PERMISSION: NotebookAgentExecutionPermission = {
  status: "unavailable",
  label: "Thread permission is not connected yet.",
};

export function NotebookArtifactProvider({
  projectRef,
  agentExecutionPermission = UNAVAILABLE_AGENT_PERMISSION,
  children,
}: {
  readonly projectRef: ScopedProjectRef | null;
  readonly agentExecutionPermission?: NotebookAgentExecutionPermission;
  readonly children: ReactNode;
}) {
  const controller = useNotebookArtifactController();
  const bindings = useMemo(
    () =>
      projectRef === null
        ? null
        : {
            scope: projectRef,
            controller,
            agentExecutionPermission,
          },
    [agentExecutionPermission, controller, projectRef],
  );
  return <NotebookWebProvider bindings={bindings}>{children}</NotebookWebProvider>;
}
