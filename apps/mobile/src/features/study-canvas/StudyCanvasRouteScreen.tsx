import {
  EnvironmentId,
  ThreadId,
  type StudyCanvasRegion,
  type StudyContextCapsule,
} from "@t3tools/contracts";
import { appendStudyContextCapsulesToPrompt } from "@t3tools/shared/studyContext";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ComposerToolbarButton } from "../../components/ComposerToolbarTrigger";
import {
  createPngComposerAttachmentFromBase64,
  type DraftComposerImageAttachment,
} from "../../lib/composerImages";
import { uuidv4 } from "../../lib/uuid";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { StudyVoiceToolbarButton } from "../threads/StudyVoiceToolbarButton";
import {
  hasNativeStudyCanvasSurface,
  StudyCanvasSurface,
  type StudyCanvasSurfaceHandle,
} from "./StudyCanvasSurface";
import type {
  StudyCanvasDrawingChangeEvent,
  StudyCanvasSelectionChangeEvent,
} from "./StudyCanvasSurface.types";
import { loadStudyCanvas, saveStudyCanvasSnapshot } from "./studyCanvasStorage";

const SAVE_DEBOUNCE_MS = 750;

type StudyCanvasRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly canvasId: string;
}>;

type CanvasStatus = "loading" | "ready" | "saving" | "saved" | "error";

function StudyCanvasHeaderButton() {
  const navigation = useNavigation();
  return (
    <Pressable accessibilityLabel="Close canvas" onPress={() => navigation.goBack()}>
      <Text className="font-t3-bold text-base">Done</Text>
    </Pressable>
  );
}

function renderStudyCanvasHeaderRight() {
  return <StudyCanvasHeaderButton />;
}

export function StudyCanvasRouteScreen(props: StudyCanvasRouteProps) {
  const routeThreadRef = useMemo(
    () => ({
      environmentId: EnvironmentId.make(props.route.params.environmentId),
      threadId: ThreadId.make(props.route.params.threadId),
    }),
    [props.route.params.environmentId, props.route.params.threadId],
  );
  const composer = useThreadComposerState(routeThreadRef);
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const canvasRef = useRef<StudyCanvasSurfaceHandle>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDrawingRef = useRef<{ revision: number; contentBounds?: StudyCanvasRegion }>({
    revision: 0,
  });
  const loadedDrawingRef = useRef(false);
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<CanvasStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<StudyCanvasRegion | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const nativeAvailable = hasNativeStudyCanvasSurface();
  const foreground = useThemeColor("--color-foreground");
  const placeholder = useThemeColor("--color-placeholder");
  const card = useThemeColor("--color-card-translucent");
  const border = useThemeColor("--color-border");
  const canvasId = props.route.params.canvasId;
  const environmentId = routeThreadRef.environmentId;
  const canvasTitle = "Study notes";

  const latestAssistantMessage = useMemo(() => {
    for (let index = composer.selectedThreadFeed.length - 1; index >= 0; index -= 1) {
      const entry = composer.selectedThreadFeed[index];
      if (entry?.type === "message" && entry.message.role === "assistant") {
        return entry.message;
      }
    }
    return null;
  }, [composer.selectedThreadFeed]);

  const persistLatestDrawing = useCallback(async () => {
    if (!nativeAvailable || !canvasRef.current || !loadedDrawingRef.current) return;
    try {
      if (mountedRef.current) setStatus("saving");
      const drawingDataBase64 = await canvasRef.current.exportDrawing();
      const latest = latestDrawingRef.current;
      await saveStudyCanvasSnapshot({
        canvasId,
        title: canvasTitle,
        revision: latest.revision,
        drawingDataBase64,
        ...(latest.contentBounds ? { contentBounds: latest.contentBounds } : {}),
      });
      if (mountedRef.current) {
        setStatus("saved");
        setError(null);
      }
    } catch (cause) {
      if (mountedRef.current) {
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "Could not save the canvas.");
      }
    }
  }, [canvasId, nativeAvailable]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    void persistLatestDrawing();
  }, [persistLatestDrawing]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flushSave();
    };
  }, [flushSave]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") flushSave();
    });
    return () => subscription.remove();
  }, [flushSave]);

  useEffect(() => {
    if (!nativeAvailable) {
      setStatus("ready");
      return;
    }
    let cancelled = false;
    void loadStudyCanvas({ canvasId, title: canvasTitle })
      .then(async (loaded) => {
        if (cancelled) return;
        if (loaded.drawingDataBase64) {
          await canvasRef.current?.loadDrawing(loaded.drawingDataBase64);
        }
        latestDrawingRef.current = {
          revision: loaded.revision,
          ...(loaded.document.operations.at(-1)?.contentBounds
            ? { contentBounds: loaded.document.operations.at(-1)!.contentBounds }
            : {}),
        };
        loadedDrawingRef.current = true;
        if (!cancelled) setStatus("ready");
      })
      .catch((cause) => {
        loadedDrawingRef.current = true;
        if (!cancelled) {
          setStatus("error");
          setError(cause instanceof Error ? cause.message : "Could not load the canvas.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canvasId, nativeAvailable]);

  const handleDrawingChange = useCallback(
    (event: { readonly nativeEvent: StudyCanvasDrawingChangeEvent }) => {
      latestDrawingRef.current = {
        revision: event.nativeEvent.revision,
        ...(event.nativeEvent.contentBounds
          ? { contentBounds: event.nativeEvent.contentBounds }
          : {}),
      };
      setStatus("saving");
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void persistLatestDrawing();
      }, SAVE_DEBOUNCE_MS);
    },
    [persistLatestDrawing],
  );

  const handleSelectionChange = useCallback(
    (event: { readonly nativeEvent: StudyCanvasSelectionChangeEvent }) => {
      setSelectedRegion(event.nativeEvent.selected ? (event.nativeEvent.rect ?? null) : null);
    },
    [],
  );

  const handleSend = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || sending) return;
    setSending(true);
    setError(null);
    try {
      let text = trimmedPrompt;
      const attachments: DraftComposerImageAttachment[] = [];
      if (selectedRegion && canvasRef.current) {
        const exported = await canvasRef.current.exportRegion();
        if (exported.pngBase64 && exported.rect) {
          const attachment = createPngComposerAttachmentFromBase64(exported.pngBase64);
          if (!attachment) throw new Error("The selected canvas region is too large to attach.");
          attachments.push(attachment);
          const capsule: StudyContextCapsule = {
            id: `capsule-${uuidv4()}`,
            selections: [
              {
                canvasId,
                anchor: {
                  type: "canvas-region",
                  rect: exported.rect,
                  revision: exported.revision ?? latestDrawingRef.current.revision,
                },
                snapshotName: attachment.name,
              },
            ],
            note: trimmedPrompt,
            createdAt: new Date().toISOString(),
          };
          text = appendStudyContextCapsulesToPrompt(trimmedPrompt, [capsule]);
        }
      }

      const messageId = await composer.onSendMessageContent({ text, attachments });
      if (!messageId) throw new Error("Could not queue the study question.");
      setPrompt("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the study question.");
    } finally {
      setSending(false);
    }
  }, [canvasId, composer, prompt, selectedRegion, sending]);

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions
        options={{
          title: "Study Canvas",
          headerRight: renderStudyCanvasHeaderRight,
        }}
      />

      <StudyCanvasSurface
        ref={canvasRef}
        selectionMode={selectionMode}
        onDrawingChange={handleDrawingChange}
        onSelectionChange={handleSelectionChange}
        style={{ flex: 1 }}
      />

      {!nativeAvailable ? (
        <View className="absolute inset-0 items-center justify-center px-8">
          <Text className="text-center font-t3-bold text-xl">PencilKit canvas unavailable</Text>
          <Text className="mt-2 text-center text-foreground-muted">
            Build the iOS development client to load the native study canvas. Chat and voice remain
            available below.
          </Text>
        </View>
      ) : status === "loading" ? (
        <View className="absolute inset-0 items-center justify-center bg-screen/70">
          <ActivityIndicator />
          <Text className="mt-2 text-sm text-foreground-muted">Opening local canvas…</Text>
        </View>
      ) : null}

      <View
        className="absolute top-3 left-3 flex-row items-center gap-2 rounded-full border px-3 py-1.5"
        style={{
          backgroundColor: card,
          borderColor: border,
          marginTop: Platform.OS === "android" ? insets.top : 0,
        }}
      >
        <View
          className={`size-2 rounded-full ${status === "error" ? "bg-red-500" : status === "saving" ? "bg-amber-500" : "bg-green-500"}`}
        />
        <Text className="text-xs font-t3-bold text-foreground-muted">
          {status === "saving"
            ? "Saving locally"
            : status === "error"
              ? "Local save issue"
              : "Local"}
        </Text>
      </View>

      <View
        className="absolute right-3 left-3 gap-2 rounded-[24px] border p-3 shadow-lg"
        style={{
          backgroundColor: card,
          borderColor: border,
          bottom: Math.max(insets.bottom, 12),
        }}
      >
        <View className="flex-row items-center gap-2">
          <ComposerToolbarButton
            accessibilityLabel={selectionMode ? "Return to drawing" : "Select a canvas region"}
            active={selectionMode}
            icon={selectionMode ? "pencil.tip" : "crop"}
            label={selectionMode ? "Draw" : "Select"}
            onPress={() => setSelectionMode((current) => !current)}
          />
          <ComposerToolbarButton
            accessibilityLabel="Undo drawing"
            icon="arrow.uturn.backward"
            onPress={() => void canvasRef.current?.undo()}
            showChevron={false}
          />
          <ComposerToolbarButton
            accessibilityLabel="Redo drawing"
            icon="arrow.clockwise"
            onPress={() => void canvasRef.current?.redo()}
            showChevron={false}
          />
          <ComposerToolbarButton
            accessibilityLabel="Clear drawing"
            icon="trash"
            onPress={() => void canvasRef.current?.clear()}
            showChevron={false}
          />
          <View className="flex-1" />
          <StudyVoiceToolbarButton
            environmentId={environmentId}
            selectedDocuments={composer.studyDocuments}
            disabled={false}
          />
        </View>

        {latestAssistantMessage?.text.trim() ? (
          <View className="max-h-28 rounded-2xl bg-subtle px-3 py-2.5">
            <Text className="mb-1 text-xs font-t3-bold tracking-wide text-foreground-muted uppercase">
              Study agent
            </Text>
            <Text className="text-sm leading-5" numberOfLines={4}>
              {latestAssistantMessage.text}
            </Text>
          </View>
        ) : null}

        <View className="flex-row items-end gap-2">
          <TextInput
            accessibilityLabel="Ask about the canvas"
            multiline
            onChangeText={setPrompt}
            placeholder={
              selectedRegion
                ? `Ask about the selected region · ${composer.studyDocuments.length} pinned`
                : `Ask about your notes · ${composer.studyDocuments.length} pinned`
            }
            placeholderTextColor={placeholder}
            style={{ color: foreground, maxHeight: 120 }}
            className="min-h-12 flex-1 rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base"
            value={prompt}
          />
          <Pressable
            accessibilityLabel="Send study question"
            accessibilityRole="button"
            disabled={!prompt.trim() || sending}
            onPress={() => void handleSend()}
            className="size-12 items-center justify-center rounded-full bg-primary disabled:opacity-40"
          >
            {sending ? (
              <ActivityIndicator color={colorScheme === "dark" ? "#111111" : "#ffffff"} />
            ) : (
              <Text className="text-lg font-t3-bold text-primary-foreground">↑</Text>
            )}
          </Pressable>
        </View>

        {error ? (
          <Text className="px-1 text-xs text-danger-foreground" numberOfLines={2}>
            {error}
          </Text>
        ) : selectedRegion ? (
          <Text className="px-1 text-xs text-foreground-muted">
            Selected region will be attached with its canvas coordinates.
          </Text>
        ) : null}
      </View>
    </View>
  );
}
