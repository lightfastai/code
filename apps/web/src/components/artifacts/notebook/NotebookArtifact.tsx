import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import {
  NotebookWebProvider,
  type NotebookAgentExecutionPermission,
} from "@t3tools/lightfast-artifact-notebook/web";
import { useMemo, type ReactNode } from "react";

import { useNotebookArtifactController } from "./useNotebookArtifactController";
import { useNotebookAgentExecutionPermission } from "./useNotebookAgentExecutionPermission";

export function NotebookArtifactProvider({
  projectRef,
  threadRef,
  agentExecutionPermission,
  children,
}: {
  readonly projectRef: ScopedProjectRef | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly agentExecutionPermission?: NotebookAgentExecutionPermission;
  readonly children: ReactNode;
}) {
  const controller = useNotebookArtifactController();
  const connectedAgentExecutionPermission = useNotebookAgentExecutionPermission(threadRef);
  const resolvedAgentExecutionPermission =
    agentExecutionPermission ?? connectedAgentExecutionPermission;
  const bindings = useMemo(
    () =>
      projectRef === null
        ? null
        : {
            scope: projectRef,
            controller,
            agentExecutionPermission: resolvedAgentExecutionPermission,
          },
    [controller, projectRef, resolvedAgentExecutionPermission],
  );
  return <NotebookWebProvider bindings={bindings}>{children}</NotebookWebProvider>;
}
