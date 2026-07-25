import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { NotebookAgentExecutionPermission } from "@t3tools/lightfast-artifact-notebook/runtime";
import { useCallback, useState } from "react";

import { notebookEnvironment } from "../../../state/notebook";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";

export function useNotebookAgentExecutionPermission(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): NotebookAgentExecutionPermission {
  const query = useEnvironmentQuery(
    notebookEnvironment.agentExecutionPermission({
      environmentId,
      input: { threadId },
    }),
  );
  const setPermission = useAtomCommand(notebookEnvironment.setAgentExecutionPermission, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const change = useCallback(async () => {
    if (query.data === null || pending) return;
    setPending(true);
    setFailure(null);
    const result = await setPermission({
      environmentId,
      input: { threadId, allowNotebookExecution: !query.data.allowNotebookExecution },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setFailure("The agent execution permission could not be updated.");
      return;
    }
    query.refresh();
  }, [environmentId, pending, query, setPermission, threadId]);

  if (failure !== null) return { status: "unavailable", label: failure, change };
  if (query.error !== null) return { status: "unavailable", label: query.error };
  if (query.data === null) {
    return {
      status: "unavailable",
      label: query.isPending ? "Loading agent execution permission…" : "Permission unavailable.",
    };
  }
  return {
    status: query.data.allowNotebookExecution ? "granted" : "denied",
    label: pending
      ? "Updating agent execution permission…"
      : query.data.allowNotebookExecution
        ? "Agent execution is allowed for this thread. Your Run controls are always allowed."
        : "Agent execution is blocked for this thread. Your Run controls are always allowed.",
    ...(pending ? {} : { change }),
  };
}
