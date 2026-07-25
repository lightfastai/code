import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type {
  ChatArtifactAttachment,
  EnvironmentId,
  StudyDocument,
  ThreadId,
} from "@t3tools/contracts";
import type {
  NotebookArtifactPayload,
  NotebookOutput,
} from "@t3tools/lightfast-artifact-notebook/contracts";
import {
  connectNotebookWorkingCopyRuntime,
  notebookLifecycleErrorMessage,
  notebookRuntimeTarget,
  replaceNotebookWorkingCopyRuntime,
  type NotebookRuntimeView,
} from "@t3tools/lightfast-artifact-notebook/runtime";
import { planNotebookOutputRendering } from "@t3tools/lightfast-artifact-notebook/mobile";
import {
  applyNotebookRuntimeToWorkingCopy,
  applySavedNotebookRevision,
  createNotebookWorkingCopy,
  isNotebookWorkingCopyDirty,
  openLatestNotebookRevision,
  updateNotebookCellSource,
  viewReferencedNotebookRevision,
  type NotebookWorkingCopy,
} from "@t3tools/lightfast-artifact-notebook/working-copy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, TextInput, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { AppText as Text } from "../../../components/AppText";
import {
  beginNotebookMobileLoad,
  completeNotebookMobileLoad,
  failNotebookMobileLoad,
  notebookBookScopeLabels,
  notebookConnectionPresentation,
  notebookControlAvailability,
  notebookRevisionPresentation,
  presentNotebookOutput,
  type NotebookMobileOutputPresentation,
} from "./notebookMobilePresentation";
import { useNotebookAgentExecutionPermission } from "./useNotebookAgentExecutionPermission";
import { useNotebookArtifactController } from "./useNotebookArtifactController";

const INITIAL_RUNTIME_STATE: NotebookRuntimeView = {
  kernelStatus: "disconnected",
  lastSequence: 0,
  recoveryAfterSequence: null,
  outputsByCell: new Map(),
  outputKeysByCell: new Map(),
  outputRetentionByCell: new Map(),
  executionCountByCell: new Map(),
  runningCellIds: new Set(),
  error: null,
};

function artifactPayload(artifact: ChatArtifactAttachment): NotebookArtifactPayload | null {
  if (artifact.kind !== "notebook" || artifact.schemaVersion !== 1) return null;
  const candidate = artifact.payload;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const payload = candidate as Record<string, unknown>;
  if (
    typeof payload.documentId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(payload.documentId) ||
    typeof payload.revisionId !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.revisionId) ||
    typeof payload.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.contentHash) ||
    typeof payload.kernel !== "object" ||
    payload.kernel === null ||
    Array.isArray(payload.kernel) ||
    typeof payload.initialView !== "object" ||
    payload.initialView === null ||
    Array.isArray(payload.initialView)
  ) {
    return null;
  }
  const kernel = payload.kernel as Record<string, unknown>;
  if (
    typeof kernel.name !== "string" ||
    typeof kernel.displayName !== "string" ||
    typeof kernel.language !== "string"
  ) {
    return null;
  }
  const documentIds = payload.documentIds;
  if (
    documentIds !== undefined &&
    (!Array.isArray(documentIds) ||
      !documentIds.every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)))
  ) {
    return null;
  }
  const initialView = payload.initialView as Record<string, unknown>;
  if (initialView.mode !== "notebook" && initialView.mode !== "cell") return null;
  return payload as NotebookArtifactPayload;
}

type NotebookActionButtonProps = {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
};

function NotebookActionButton({ label, disabled = false, onPress }: NotebookActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-10 justify-center rounded-xl border px-3 ${
        disabled
          ? "border-neutral-200 bg-neutral-100 opacity-50 dark:border-neutral-800 dark:bg-neutral-900"
          : "border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950"
      }`}
    >
      <Text className="font-t3-medium text-xs">{label}</Text>
    </Pressable>
  );
}

function NotebookOutputView({
  output,
  outputKey,
}: {
  readonly output: NotebookOutput;
  readonly outputKey: string;
}) {
  const presentation = presentNotebookOutput(output);
  if (presentation.kind === "image") {
    return (
      <Image
        accessibilityLabel={`Notebook image output ${outputKey}`}
        source={{ uri: presentation.uri }}
        resizeMode="contain"
        className="h-52 w-full rounded-lg bg-white"
      />
    );
  }
  if (presentation.kind === "svg") {
    return (
      <View
        accessibilityLabel={`Notebook SVG output ${outputKey}`}
        className="h-52 w-full overflow-hidden rounded-lg bg-white"
      >
        <SvgXml xml={presentation.source} width="100%" height="100%" />
      </View>
    );
  }
  if (presentation.kind === "table") {
    return <NotebookTableOutput presentation={presentation} />;
  }
  const tone =
    presentation.kind === "text" && presentation.tone === "error"
      ? "text-red-700 dark:text-red-300"
      : "text-foreground-secondary";
  return (
    <ScrollView horizontal className="max-h-56 rounded-lg bg-neutral-100 p-2 dark:bg-neutral-950">
      <Text selectable className={`font-mono text-xs ${tone}`}>
        {presentation.kind === "unsupported" ? presentation.label : presentation.text}
      </Text>
    </ScrollView>
  );
}

function NotebookTableOutput({
  presentation,
}: {
  readonly presentation: Extract<NotebookMobileOutputPresentation, { readonly kind: "table" }>;
}) {
  const signatureCounts = new Map<string, number>();
  const keyedRows = presentation.rows.map((row) => {
    const signature = JSON.stringify(row);
    const occurrence = signatureCounts.get(signature) ?? 0;
    signatureCounts.set(signature, occurrence + 1);
    return { key: `${signature}:${occurrence}`, row };
  });
  return (
    <ScrollView horizontal className="rounded-lg bg-neutral-100 dark:bg-neutral-950">
      <View>
        <View className="flex-row border-b border-neutral-300 dark:border-neutral-700">
          {presentation.columns.map((column) => (
            <Text key={column} className="w-32 px-2 py-1 font-t3-medium text-xs">
              {column}
            </Text>
          ))}
        </View>
        {keyedRows.map(({ key, row }) => (
          <View key={key} className="flex-row">
            {presentation.columns.map((column) => (
              <Text key={column} className="w-32 px-2 py-1 text-xs text-foreground-secondary">
                {String(row[column] ?? "")}
              </Text>
            ))}
          </View>
        ))}
        {presentation.truncated ? (
          <Text className="px-2 py-1 text-xs text-foreground-muted">Table output truncated</Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

function NotebookCellView({
  cell,
  outputs,
  outputKeys,
  executionCount,
  running,
  runDisabled,
  onChangeSource,
  onRun,
}: {
  readonly cell: NotebookWorkingCopy["document"]["cells"][number];
  readonly outputs: ReadonlyArray<NotebookOutput>;
  readonly outputKeys: ReadonlyArray<string>;
  readonly executionCount: number | null;
  readonly running: boolean;
  readonly runDisabled: boolean;
  readonly onChangeSource: (source: string) => void;
  readonly onRun: () => void;
}) {
  return (
    <View className="gap-2 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <View className="flex-row items-center justify-between">
        <Text className="font-t3-medium text-xs uppercase text-foreground-muted">
          {cell.cell_type === "code" ? `Code [${executionCount ?? " "}]` : "Markdown"}
        </Text>
        {cell.cell_type === "code" ? (
          <NotebookActionButton
            label={running ? `Running cell ${cell.id}` : `Run cell ${cell.id}`}
            disabled={runDisabled}
            onPress={onRun}
          />
        ) : null}
      </View>
      <TextInput
        accessibilityLabel={`Edit ${cell.cell_type} cell ${cell.id}`}
        multiline
        value={cell.source}
        onChangeText={onChangeSource}
        className="min-h-16 rounded-lg bg-neutral-100 px-3 py-2 font-mono text-sm text-foreground dark:bg-neutral-900"
      />
      {outputs.map((output, index) => {
        const outputKey = outputKeys[index] ?? `${cell.id}-output-${index}`;
        return <NotebookOutputView key={outputKey} output={output} outputKey={outputKey} />;
      })}
    </View>
  );
}

export function NotebookArtifactCard({
  artifact,
  environmentId,
  projectId,
  threadId,
  connectionPhase,
  studyDocuments,
}: {
  readonly artifact: ChatArtifactAttachment;
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly threadId: ThreadId;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly studyDocuments: ReadonlyArray<StudyDocument>;
}) {
  const payload = artifactPayload(artifact);
  const controller = useNotebookArtifactController();
  const permission = useNotebookAgentExecutionPermission(environmentId, threadId);
  const scope = useMemo(() => ({ environmentId, projectId }), [environmentId, projectId]);
  const [working, setWorking] = useState<NotebookWorkingCopy | null>(null);
  const [runtime, setRuntime] = useState<NotebookRuntimeView>(INITIAL_RUNTIME_STATE);
  const [loadState, setLoadState] = useState(() => beginNotebookMobileLoad(null));
  const [retrySequence, setRetrySequence] = useState(0);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const targetRef = useRef<ReturnType<typeof notebookRuntimeTarget> | null>(null);
  const connectedRef = useRef(connectionPhase === "connected");
  connectedRef.current = connectionPhase === "connected";
  const documentIds = payload?.documentIds ?? [];

  const onRuntimeState = useCallback((state: NotebookRuntimeView) => {
    setRuntime(state);
    setWorking((current) =>
      current === null ? null : applyNotebookRuntimeToWorkingCopy(current, state),
    );
  }, []);

  useEffect(() => {
    if (payload === null) return;
    let active = true;
    setLoadState((current) => beginNotebookMobileLoad(current.revision));
    void controller
      .readRevision(scope, payload.documentId, payload.revisionId)
      .then((revision) => {
        if (!active) return;
        setWorking(createNotebookWorkingCopy(revision));
        setLoadState((current) => completeNotebookMobileLoad(current, revision));
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLoadState((current) =>
          failNotebookMobileLoad(current, notebookLifecycleErrorMessage(cause)),
        );
      });
    return () => {
      active = false;
    };
  }, [controller, payload?.documentId, payload?.revisionId, retrySequence, scope]);

  useEffect(() => {
    if (working === null || connectionPhase !== "connected") return;
    let active = true;
    const target = notebookRuntimeTarget(working, documentIds);
    targetRef.current = target;
    void connectNotebookWorkingCopyRuntime({
      controller,
      scope,
      working,
      documentIds,
      onState: onRuntimeState,
      onWorkingCopy: setWorking,
      isActive: () => active,
    }).catch((cause: unknown) => {
      if (active) setActionError(notebookLifecycleErrorMessage(cause));
    });
    return () => {
      active = false;
    };
  }, [
    connectionPhase,
    controller,
    documentIds,
    onRuntimeState,
    scope,
    working?.baseRevision.revisionId,
    working?.documentId,
  ]);

  useEffect(
    () => () => {
      const target = targetRef.current;
      if (target === null || !connectedRef.current) return;
      void controller
        .dispose({
          scope,
          sessionId: target.sessionId,
          revisionId: target.revisionId,
          onState: () => {},
        })
        .catch(() => undefined);
    },
    [controller, scope],
  );

  const perform = useCallback(async (label: string, action: () => Promise<void>) => {
    setPendingAction(label);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(notebookLifecycleErrorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }, []);

  if (payload === null) {
    return (
      <View className="mt-1.5 rounded-[18px] border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950">
        <Text className="text-sm text-red-700 dark:text-red-300">
          Invalid notebook artifact payload
        </Text>
      </View>
    );
  }

  const connection = notebookConnectionPresentation(connectionPhase, working !== null);
  const controls = notebookControlAvailability(
    connectionPhase,
    pendingAction !== null,
    runtime.runningCellIds.size,
  );
  const outputPlan =
    working === null
      ? new Map()
      : planNotebookOutputRendering(
          working.document.cells
            .filter((cell) => cell.cell_type === "code")
            .map((cell) => ({
              cellId: cell.id,
              outputs: runtime.outputsByCell.get(cell.id) ?? cell.outputs,
              outputKeys: runtime.outputKeysByCell.get(cell.id),
              retention: runtime.outputRetentionByCell.get(cell.id),
            })),
        );
  const bookLabels = notebookBookScopeLabels(documentIds, studyDocuments);
  const revision =
    working === null
      ? null
      : notebookRevisionPresentation(
          working.baseRevision,
          working.referencedRevision,
          working.latestRevision,
        );
  const currentTarget = working === null ? null : notebookRuntimeTarget(working, documentIds);
  const runtimeRequest =
    currentTarget === null
      ? null
      : {
          scope,
          sessionId: currentTarget.sessionId,
          revisionId: currentTarget.revisionId,
          onState: onRuntimeState,
        };

  return (
    <View className="mt-1.5 gap-3 rounded-[18px] border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-900">
      <View className="gap-1">
        <Text className="font-t3-medium text-sm">{artifact.title}</Text>
        <Text className="text-xs text-foreground-muted">
          {payload.kernel.displayName} · {runtime.kernelStatus}
        </Text>
        <Text className="text-xs text-foreground-secondary">{connection.label}</Text>
        {connection.mutationsDisabled ? (
          <Text className="text-xs text-amber-700 dark:text-amber-300">
            Runtime changes are disabled until the authenticated paired-Mac connection returns.
          </Text>
        ) : null}
      </View>

      <View className="gap-1 rounded-xl bg-neutral-100 p-2 dark:bg-neutral-950">
        <Text className="font-t3-medium text-xs">Mounted book scope (read-only)</Text>
        {bookLabels.map((label, index) => (
          <Text
            key={documentIds[index] ?? "no-books-mounted"}
            className="text-xs text-foreground-secondary"
          >
            {label}
          </Text>
        ))}
      </View>

      {loadState.status === "loading" && working === null ? (
        <View className="flex-row items-center gap-2 py-3">
          <ActivityIndicator />
          <Text className="text-sm text-foreground-secondary">Loading notebook revision…</Text>
        </View>
      ) : null}
      {loadState.status === "error" ? (
        <View className="gap-2 rounded-xl bg-red-50 p-3 dark:bg-red-950">
          <Text className="text-sm text-red-700 dark:text-red-300">
            Could not load notebook: {loadState.error}
          </Text>
          <NotebookActionButton
            label="Retry notebook load"
            onPress={() => setRetrySequence((value) => value + 1)}
          />
        </View>
      ) : null}

      {working !== null ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            <NotebookActionButton
              label={
                runtime.kernelStatus === "disconnected"
                  ? "Reconnect runtime"
                  : "Restart / Reconnect"
              }
              disabled={controls.restartDisabled || runtimeRequest === null}
              onPress={() => {
                if (runtimeRequest === null) return;
                void perform("restart", async () => {
                  if (
                    runtime.kernelStatus === "disconnected" ||
                    runtime.kernelStatus === "terminated"
                  ) {
                    await controller.connect({
                      ...runtimeRequest,
                      kernelName: currentTarget!.kernelName,
                      documentIds,
                    });
                  } else {
                    await controller.restart(runtimeRequest);
                    await controller.recover(runtimeRequest);
                  }
                });
              }}
            />
            <NotebookActionButton
              label="Interrupt execution"
              disabled={controls.interruptDisabled || runtimeRequest === null}
              onPress={() => {
                if (runtimeRequest !== null) {
                  void perform("interrupt", () => controller.interrupt(runtimeRequest));
                }
              }}
            />
            <NotebookActionButton
              label="Save immutable revision"
              disabled={controls.saveDisabled || !isNotebookWorkingCopyDirty(working)}
              onPress={() => {
                void perform("save", async () => {
                  const saved = await controller.saveRevision(
                    scope,
                    working.documentId,
                    working.document,
                  );
                  setWorking((current) =>
                    current === null ? null : applySavedNotebookRevision(current, saved),
                  );
                });
              }}
            />
            {revision?.canViewReferenced ? (
              <NotebookActionButton
                label="View referenced revision"
                disabled={connection.mutationsDisabled}
                onPress={() => {
                  void perform("reference", async () => {
                    await replaceNotebookWorkingCopyRuntime({
                      controller,
                      scope,
                      working,
                      nextWorking: viewReferencedNotebookRevision(working),
                      documentIds,
                      onState: onRuntimeState,
                      onWorkingCopy: setWorking,
                    });
                    setRuntime(INITIAL_RUNTIME_STATE);
                  });
                }}
              />
            ) : null}
            {revision?.canOpenLatest ? (
              <NotebookActionButton
                label="Open latest saved revision"
                disabled={connection.mutationsDisabled}
                onPress={() => {
                  void perform("latest", async () => {
                    await replaceNotebookWorkingCopyRuntime({
                      controller,
                      scope,
                      working,
                      nextWorking: openLatestNotebookRevision(working),
                      documentIds,
                      onState: onRuntimeState,
                      onWorkingCopy: setWorking,
                    });
                    setRuntime(INITIAL_RUNTIME_STATE);
                  });
                }}
              />
            ) : null}
          </View>
          {revision !== null ? (
            <Text className="text-xs text-foreground-muted">{revision.viewing}</Text>
          ) : null}

          <View className="gap-3">
            {working.document.cells.map((cell) => {
              const plan = outputPlan.get(cell.id);
              return (
                <NotebookCellView
                  key={cell.id}
                  cell={cell}
                  outputs={plan?.outputs ?? []}
                  outputKeys={plan?.outputKeys ?? []}
                  executionCount={
                    runtime.executionCountByCell.get(cell.id) ??
                    (cell.cell_type === "code" ? cell.execution_count : null)
                  }
                  running={runtime.runningCellIds.has(cell.id)}
                  runDisabled={
                    cell.cell_type !== "code" || controls.runDisabled || runtimeRequest === null
                  }
                  onChangeSource={(source) =>
                    setWorking((current) =>
                      current === null ? null : updateNotebookCellSource(current, cell.id, source),
                    )
                  }
                  onRun={() => {
                    if (cell.cell_type !== "code" || runtimeRequest === null) return;
                    void perform(`run:${cell.id}`, () =>
                      controller.executeCell({
                        ...runtimeRequest,
                        cellId: cell.id,
                        code: cell.source,
                      }),
                    );
                  }}
                />
              );
            })}
          </View>
        </>
      ) : null}

      <View className="gap-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <Text className="font-t3-medium text-xs">Agent execution permission</Text>
        <Text className="text-xs text-foreground-secondary">{permission.label}</Text>
        {permission.change !== undefined ? (
          <NotebookActionButton
            label={
              permission.status === "granted"
                ? "Block agent notebook execution"
                : "Allow agent notebook execution"
            }
            disabled={connection.mutationsDisabled}
            onPress={permission.change}
          />
        ) : null}
      </View>
      {runtime.error !== null || actionError !== null ? (
        <Text className="text-xs text-red-700 dark:text-red-300">
          {actionError ?? runtime.error}
        </Text>
      ) : null}
    </View>
  );
}
