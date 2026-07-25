import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  resolveThreadRouteTarget,
  routeTargetMatchesThread,
  threadRouteTargetKey,
} from "./thread-route-target";

const staleSelection = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};

describe("thread route authority", () => {
  it("prefers the route thread over a stale selected-thread fallback", () => {
    const target = resolveThreadRouteTarget(
      { environmentId: "environment-b", threadId: "thread-b" },
      staleSelection,
    );

    expect(target).toEqual({
      environmentId: EnvironmentId.make("environment-b"),
      threadId: ThreadId.make("thread-b"),
    });
    expect(threadRouteTargetKey(target!)).toBe("environment-b:thread-b");
    expect(
      routeTargetMatchesThread(target!, {
        environmentId: staleSelection.environmentId,
        id: staleSelection.threadId,
      }),
    ).toBe(false);
  });

  it("resolves a cold deep link without any selected-thread fallback", () => {
    expect(
      resolveThreadRouteTarget(
        { environmentId: ["environment-deep"], threadId: ["thread-deep"] },
        null,
      ),
    ).toEqual({
      environmentId: EnvironmentId.make("environment-deep"),
      threadId: ThreadId.make("thread-deep"),
    });
  });
});
