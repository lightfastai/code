import { describe, expect, it } from "vite-plus/test";

import {
  NOTEBOOK_RUNTIME_CACHE_MAX_ENTRIES,
  NotebookRuntimeCache,
} from "./notebookRuntimeCache.ts";

describe("NotebookRuntimeCache", () => {
  it("bounds retained sessions with LRU eviction and supports explicit disposal", () => {
    const cache = new NotebookRuntimeCache<number>(3);
    cache.set("session-1", 1);
    cache.set("session-2", 2);
    cache.set("session-3", 3);
    expect(cache.get("session-1")).toBe(1);

    cache.set("session-4", 4);

    expect(cache.size).toBe(3);
    expect(cache.get("session-2")).toBeUndefined();
    expect(cache.get("session-1")).toBe(1);
    expect(cache.delete("session-1")).toBe(true);
    expect(cache.get("session-1")).toBeUndefined();
  });

  it("stays bounded while cycling through many runtime sessions", () => {
    const cache = new NotebookRuntimeCache<{ readonly sequence: number }>();
    const sessionCount = NOTEBOOK_RUNTIME_CACHE_MAX_ENTRIES * 100;

    for (let sequence = 0; sequence < sessionCount; sequence += 1) {
      cache.set(`session-${sequence}`, { sequence });
      expect(cache.size).toBeLessThanOrEqual(NOTEBOOK_RUNTIME_CACHE_MAX_ENTRIES);
    }

    expect(cache.size).toBe(NOTEBOOK_RUNTIME_CACHE_MAX_ENTRIES);
    expect(cache.get("session-0")).toBeUndefined();
    expect(cache.get(`session-${sessionCount - 1}`)).toEqual({ sequence: sessionCount - 1 });
  });
});
