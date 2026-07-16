import type { ScopedThreadRef } from "@t3tools/contracts";
import type { NotebookAgentExecutionPermission } from "@t3tools/lightfast-artifact-notebook/web";
import { useCallback, useState } from "react";

import { notebookEnvironment } from "~/state/notebook";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

function errorMessage(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim().length > 0
  ) {
    return cause.message;
  }
  return "The thread permission could not be updated.";
}

export function useNotebookAgentExecutionPermission(
  threadRef: ScopedThreadRef | null,
): NotebookAgentExecutionPermission {
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : notebookEnvironment.agentExecutionPermission({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  const setPermission = useAtomCommand(notebookEnvironment.setAgentExecutionPermission, {
    reportFailure: false,
  });
  const [update, setUpdate] = useState<
    | { readonly threadKey: string; readonly status: "pending" }
    | { readonly threadKey: string; readonly status: "failed"; readonly message: string }
    | null
  >(null);
  const threadKey = threadRef === null ? null : `${threadRef.environmentId}:${threadRef.threadId}`;
  const activeUpdate = update?.threadKey === threadKey ? update : null;
  const change = useCallback(async () => {
    if (threadRef === null || query.data === null || threadKey === null) return;
    setUpdate({ threadKey, status: "pending" });
    const result = await setPermission({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        allowNotebookExecution: !query.data.allowNotebookExecution,
      },
    });
    if (result._tag === "Failure") {
      setUpdate({
        threadKey,
        status: "failed",
        message: errorMessage(result.cause),
      });
      return;
    }
    setUpdate(null);
    query.refresh();
  }, [query, setPermission, threadKey, threadRef]);

  if (threadRef === null) {
    return { status: "unavailable", label: "No active thread is available." };
  }
  if (activeUpdate?.status === "failed") {
    return {
      status: "unavailable",
      label: activeUpdate.message,
      ...(query.data === null ? {} : { change }),
    };
  }
  if (query.error !== null) {
    return {
      status: "unavailable",
      label: query.error,
      ...(query.data === null ? {} : { change }),
    };
  }
  if (query.data === null) {
    return {
      status: "unavailable",
      label: query.isPending ? "Loading thread permission…" : "Thread permission is unavailable.",
    };
  }
  if (activeUpdate?.status === "pending") {
    return {
      status: query.data.allowNotebookExecution ? "granted" : "denied",
      label: "Updating thread permission…",
    };
  }
  return query.data.allowNotebookExecution
    ? {
        status: "granted",
        label: "Agent notebook execution is allowed for this thread.",
        change,
      }
    : {
        status: "denied",
        label: "Agent notebook execution is blocked for this thread.",
        change,
      };
}
