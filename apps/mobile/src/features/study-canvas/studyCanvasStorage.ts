import type { StudyCanvasRegion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { uuidv4 } from "../../lib/uuid";
import {
  appendStudyCanvasSnapshotOperation,
  createStudyCanvasDocument,
  decodeStudyCanvasDocument,
  type StudyCanvasDocument,
} from "./studyCanvasModel";

const STUDY_CANVAS_DIRECTORY = "study-canvases";
const MANIFEST_FILE_NAME = "operations.json";
const SNAPSHOT_DIRECTORY = "snapshots";

export class StudyCanvasPersistenceError extends Schema.TaggedErrorClass<StudyCanvasPersistenceError>()(
  "StudyCanvasPersistenceError",
  {
    operation: Schema.Literals(["open", "read", "decode", "write", "verify", "remove"]),
    canvasId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Study canvas persistence operation ${this.operation} failed for ${this.canvasId}.`;
  }
}

export interface LoadedStudyCanvas {
  readonly document: StudyCanvasDocument;
  readonly drawingDataBase64: string | null;
  readonly revision: number;
}

interface CanvasPaths {
  readonly directory: InstanceType<(typeof import("expo-file-system"))["Directory"]>;
  readonly snapshots: InstanceType<(typeof import("expo-file-system"))["Directory"]>;
  readonly manifest: InstanceType<(typeof import("expo-file-system"))["File"]>;
}

async function resolveCanvasPaths(canvasId: string): Promise<CanvasPaths> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, STUDY_CANVAS_DIRECTORY, canvasId);
  directory.create({ idempotent: true, intermediates: true });
  const snapshots = new Directory(directory, SNAPSHOT_DIRECTORY);
  snapshots.create({ idempotent: true, intermediates: true });
  return {
    directory,
    snapshots,
    manifest: new File(directory, MANIFEST_FILE_NAME),
  };
}

async function readManifest(
  canvasId: string,
  title: string,
  paths: CanvasPaths,
): Promise<StudyCanvasDocument> {
  if (!paths.manifest.exists) {
    return createStudyCanvasDocument({ canvasId, title, now: new Date().toISOString() });
  }
  try {
    return decodeStudyCanvasDocument(JSON.parse(await paths.manifest.text()) as unknown);
  } catch (cause) {
    throw new StudyCanvasPersistenceError({ operation: "decode", canvasId, cause });
  }
}

async function writeManifestAtomically(
  canvasId: string,
  paths: CanvasPaths,
  document: StudyCanvasDocument,
): Promise<void> {
  const { File } = await import("expo-file-system");
  const temporary = new File(paths.directory, `${MANIFEST_FILE_NAME}.${uuidv4()}.tmp`);
  try {
    temporary.create({ intermediates: true, overwrite: true });
    temporary.write(JSON.stringify(document));
    temporary.moveSync(paths.manifest, { overwrite: true });
  } catch (cause) {
    if (temporary.uri.endsWith(".tmp") && temporary.exists) temporary.delete();
    throw new StudyCanvasPersistenceError({ operation: "write", canvasId, cause });
  }
}

async function digestDrawing(drawingDataBase64: string): Promise<string> {
  const Crypto = await import("expo-crypto");
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, drawingDataBase64);
}

export async function loadStudyCanvas(input: {
  readonly canvasId: string;
  readonly title: string;
}): Promise<LoadedStudyCanvas> {
  let paths: CanvasPaths;
  try {
    paths = await resolveCanvasPaths(input.canvasId);
  } catch (cause) {
    throw new StudyCanvasPersistenceError({ operation: "open", canvasId: input.canvasId, cause });
  }
  const document = await readManifest(input.canvasId, input.title, paths);
  const latest = document.operations.at(-1);
  if (!latest) {
    return { document, drawingDataBase64: null, revision: 0 };
  }

  try {
    const { File } = await import("expo-file-system");
    const snapshot = new File(paths.snapshots, latest.snapshotFileName);
    if (!snapshot.exists) {
      throw new Error(`Missing canvas snapshot ${latest.snapshotFileName}.`);
    }
    const drawingDataBase64 = await snapshot.base64();
    const digest = await digestDrawing(drawingDataBase64);
    if (digest !== latest.digest) {
      throw new Error(`Canvas snapshot digest mismatch for ${latest.snapshotFileName}.`);
    }
    return { document, drawingDataBase64, revision: latest.revision };
  } catch (cause) {
    throw new StudyCanvasPersistenceError({
      operation: "verify",
      canvasId: input.canvasId,
      cause,
    });
  }
}

const saveQueues = new Map<string, Promise<unknown>>();

export function saveStudyCanvasSnapshot(input: {
  readonly canvasId: string;
  readonly title: string;
  readonly revision: number;
  readonly drawingDataBase64: string;
  readonly contentBounds?: StudyCanvasRegion;
}): Promise<StudyCanvasDocument> {
  const previous = saveQueues.get(input.canvasId) ?? Promise.resolve();
  const save = previous
    .catch(() => undefined)
    .then(async () => {
      let paths: CanvasPaths;
      try {
        paths = await resolveCanvasPaths(input.canvasId);
      } catch (cause) {
        throw new StudyCanvasPersistenceError({
          operation: "open",
          canvasId: input.canvasId,
          cause,
        });
      }

      const document = await readManifest(input.canvasId, input.title, paths);
      const digest = await digestDrawing(input.drawingDataBase64);
      if (document.operations.at(-1)?.digest === digest) {
        return document;
      }

      const sequence = (document.operations.at(-1)?.sequence ?? 0) + 1;
      const snapshotFileName = `${String(sequence).padStart(8, "0")}-${digest.slice(0, 16)}.drawing`;
      try {
        const { File } = await import("expo-file-system");
        const snapshot = new File(paths.snapshots, snapshotFileName);
        if (!snapshot.exists) snapshot.create({ intermediates: true });
        snapshot.write(input.drawingDataBase64, { encoding: "base64" });
      } catch (cause) {
        throw new StudyCanvasPersistenceError({
          operation: "write",
          canvasId: input.canvasId,
          cause,
        });
      }

      const appended = appendStudyCanvasSnapshotOperation(document, {
        operationId: uuidv4(),
        revision: input.revision,
        digest,
        snapshotFileName,
        ...(input.contentBounds ? { contentBounds: input.contentBounds } : {}),
        now: new Date().toISOString(),
      });
      await writeManifestAtomically(input.canvasId, paths, appended.document);

      if (appended.prunedSnapshotFileNames.length > 0) {
        const { File } = await import("expo-file-system");
        for (const fileName of appended.prunedSnapshotFileNames) {
          try {
            const file = new File(paths.snapshots, fileName);
            if (file.exists) file.delete();
          } catch (cause) {
            console.warn(
              "[study-canvas] could not remove pruned snapshot",
              new StudyCanvasPersistenceError({
                operation: "remove",
                canvasId: input.canvasId,
                cause,
              }),
            );
          }
        }
      }
      return appended.document;
    });

  saveQueues.set(input.canvasId, save);
  const clearQueue = () => {
    if (saveQueues.get(input.canvasId) === save) saveQueues.delete(input.canvasId);
  };
  void save.then(clearQueue, clearQueue);
  return save;
}
