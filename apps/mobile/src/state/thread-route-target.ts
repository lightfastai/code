import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

import { scopedThreadKey } from "../lib/scopedEntities";

export interface ThreadRouteTargetParams {
  readonly environmentId?: string | ReadonlyArray<string>;
  readonly threadId?: string | ReadonlyArray<string>;
}

function firstRouteParam(value: string | ReadonlyArray<string> | undefined): string | null {
  return typeof value === "string" ? value : (value?.[0] ?? null);
}

export function resolveThreadRouteTarget(
  params: ThreadRouteTargetParams | undefined,
  fallback: ScopedThreadRef | null,
): ScopedThreadRef | null {
  const environmentId = firstRouteParam(params?.environmentId);
  const threadId = firstRouteParam(params?.threadId);
  if (!environmentId || !threadId) {
    return fallback;
  }
  return {
    environmentId: EnvironmentId.make(environmentId),
    threadId: ThreadId.make(threadId),
  };
}

export function threadRouteTargetKey(target: ScopedThreadRef): string {
  return scopedThreadKey(target.environmentId, target.threadId);
}

export function routeTargetMatchesThread(
  target: ScopedThreadRef,
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
): boolean {
  return target.environmentId === thread.environmentId && target.threadId === thread.id;
}
