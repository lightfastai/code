import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fileSystem = vi.hoisted(() => {
  const files = new Map<string, string>();

  function uriPart(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "uri" in value) return String(value.uri);
    return String(value);
  }

  class Directory {
    readonly uri: string;

    constructor(...parts: ReadonlyArray<unknown>) {
      this.uri = parts.map(uriPart).join("/");
    }

    create() {}
  }

  class File {
    readonly uri: string;

    constructor(...parts: ReadonlyArray<unknown>) {
      this.uri = parts.map(uriPart).join("/");
    }

    get exists() {
      return files.has(this.uri);
    }

    create() {
      files.set(this.uri, "");
    }

    write(value: string) {
      files.set(this.uri, value);
    }

    text() {
      return Promise.resolve(files.get(this.uri) ?? "");
    }

    base64() {
      return Promise.resolve(files.get(this.uri) ?? "");
    }

    moveSync(destination: File) {
      const value = files.get(this.uri);
      if (value === undefined) throw new Error(`Missing source ${this.uri}.`);
      files.set(destination.uri, value);
      files.delete(this.uri);
    }

    delete() {
      files.delete(this.uri);
    }
  }

  return { Directory, File, files };
});

vi.mock("expo-file-system", () => ({
  Directory: fileSystem.Directory,
  File: fileSystem.File,
  Paths: { document: "document" },
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digestStringAsync: async (_algorithm: string, value: string) =>
    value === "drawing-X" ? "a".repeat(64) : "b".repeat(64),
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
}));

import { loadStudyCanvas, saveStudyCanvasSnapshot } from "./studyCanvasStorage";

beforeEach(() => {
  fileSystem.files.clear();
});

describe("study canvas revision persistence", () => {
  it("retains a newer revision when undo returns to identical drawing bytes", async () => {
    await saveStudyCanvasSnapshot({
      canvasId: "canvas-1",
      title: "Study notes",
      revision: 5,
      drawingDataBase64: "drawing-X",
    });

    // Revision 6 changes the in-memory drawing, then revision 7 undoes back to X
    // before the debounce saves. Blob bytes may dedupe, but revision 7 may not.
    const saved = await saveStudyCanvasSnapshot({
      canvasId: "canvas-1",
      title: "Study notes",
      revision: 7,
      drawingDataBase64: "drawing-X",
    });
    const loaded = await loadStudyCanvas({ canvasId: "canvas-1", title: "Study notes" });

    expect(saved.operations.map((operation) => operation.revision)).toEqual([5, 7]);
    expect(saved.operations[1]?.snapshotFileName).toBe(saved.operations[0]?.snapshotFileName);
    expect(loaded.revision).toBe(7);
    expect(loaded.drawingDataBase64).toBe("drawing-X");
    expect([...fileSystem.files.keys()].filter((uri) => uri.endsWith(".drawing"))).toHaveLength(1);

    const replay = await saveStudyCanvasSnapshot({
      canvasId: "canvas-1",
      title: "Study notes",
      revision: 7,
      drawingDataBase64: "drawing-X",
    });
    expect(replay.operations.map((operation) => operation.revision)).toEqual([5, 7]);
  });
});
