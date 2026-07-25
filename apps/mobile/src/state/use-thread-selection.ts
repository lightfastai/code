import { useRoute, type RouteProp } from "@react-navigation/native";
import { useMemo, useRef } from "react";
import {
  type EnvironmentId,
  type OrchestrationThread,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";

import { useProject, useThreadShell } from "../state/entities";
import { useEnvironmentThread } from "../state/threads";
import {
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnection,
} from "./use-remote-environment-registry";
import { resolveThreadRouteTarget } from "./thread-route-target";
type ThreadSelectionRouteParams = {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
};

function latestUserMessageAt(thread: OrchestrationThread): OrchestrationThread["updatedAt"] | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "user") {
      return message.createdAt;
    }
  }

  return null;
}

function threadDetailToShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThread,
): EnvironmentThreadShell {
  return {
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    session: thread.session,
    latestUserMessageAt: latestUserMessageAt(thread),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function useResolvedThreadSelection(params: ThreadSelectionRouteParams | undefined) {
  const routeThreadRef = useMemo<ScopedThreadRef | null>(
    () => resolveThreadRouteTarget(params, null),
    [params?.environmentId, params?.threadId],
  );
  const lastRouteThreadRef = useRef<ScopedThreadRef | null>(null);
  if (routeThreadRef !== null) {
    lastRouteThreadRef.current = routeThreadRef;
  }
  const selectedThreadRef = routeThreadRef ?? lastRouteThreadRef.current;
  const selectedThreadShell = useThreadShell(selectedThreadRef);
  const selectedThreadDetailState = useEnvironmentThread(
    selectedThreadRef?.environmentId ?? null,
    selectedThreadRef?.threadId ?? null,
  );
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const selectedThread = useMemo(
    () =>
      selectedThreadShell ??
      (selectedThreadRef !== null && selectedThreadDetail !== null
        ? threadDetailToShell(selectedThreadRef.environmentId, selectedThreadDetail)
        : null),
    [selectedThreadDetail, selectedThreadRef, selectedThreadShell],
  );
  const selectedProjectRef = useMemo<ScopedProjectRef | null>(
    () =>
      selectedThread === null
        ? null
        : {
            environmentId: selectedThread.environmentId,
            projectId: selectedThread.projectId,
          },
    [selectedThread],
  );
  const selectedThreadProject = useProject(selectedProjectRef);
  const selectedEnvironmentId = selectedThread?.environmentId ?? null;
  const selectedEnvironmentConnection = useSavedRemoteConnection(selectedEnvironmentId);
  const selectedEnvironmentRuntime = useRemoteEnvironmentRuntime(selectedEnvironmentId);

  return useMemo(
    () => ({
      selectedThreadRef,
      selectedThread,
      selectedThreadProject,
      selectedEnvironmentConnection,
      selectedEnvironmentRuntime,
    }),
    [
      selectedEnvironmentConnection,
      selectedEnvironmentRuntime,
      selectedThread,
      selectedThreadProject,
      selectedThreadRef,
    ],
  );
}

type ThreadSelectionState = ReturnType<typeof useResolvedThreadSelection>;

export function useThreadSelection(): ThreadSelectionState {
  const route = useRoute<RouteProp<Record<string, ThreadSelectionRouteParams | undefined>>>();
  return useResolvedThreadSelection(route.params);
}
