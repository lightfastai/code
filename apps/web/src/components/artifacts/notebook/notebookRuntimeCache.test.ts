import { describe, expect, it } from "vite-plus/test";

import { NotebookRuntimeCache } from "./notebookRuntimeCache.ts";

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
});
