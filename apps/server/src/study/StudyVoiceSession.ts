import * as NodeCrypto from "node:crypto";

import {
  StudyVoiceSessionError,
  type StudyVoiceParticipantMetadata,
  type StudyVoiceSessionInput,
  type StudyVoiceSessionResult,
} from "@t3tools/contracts";
import { createLiveKitParticipantToken } from "@t3tools/shared/liveKitToken";
import * as Effect from "effect/Effect";

import { readStudyLibraryIndex, type StudyLibraryPaths } from "./StudyLibrary.ts";

export interface StudyVoiceEnvironment {
  readonly liveKitUrl?: string;
  readonly liveKitApiKey?: string;
  readonly liveKitApiSecret?: string;
  readonly agentName?: string;
}

const fromProcessEnvironment = (): StudyVoiceEnvironment => {
  const liveKitUrl = process.env.T3_VOICE_LIVEKIT_URL ?? process.env.LIVEKIT_URL;
  const liveKitApiKey = process.env.T3_VOICE_LIVEKIT_API_KEY ?? process.env.LIVEKIT_API_KEY;
  const liveKitApiSecret =
    process.env.T3_VOICE_LIVEKIT_API_SECRET ?? process.env.LIVEKIT_API_SECRET;
  const agentName = process.env.T3_VOICE_AGENT_NAME;
  return {
    ...(liveKitUrl === undefined ? {} : { liveKitUrl }),
    ...(liveKitApiKey === undefined ? {} : { liveKitApiKey }),
    ...(liveKitApiSecret === undefined ? {} : { liveKitApiSecret }),
    ...(agentName === undefined ? {} : { agentName }),
  };
};

function parseLiveKitUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" || url.protocol === "ws:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export const createStudyVoiceSession = Effect.fn("StudyVoiceSession.create")(function* (input: {
  readonly paths: StudyLibraryPaths;
  readonly request: StudyVoiceSessionInput;
  readonly environment?: StudyVoiceEnvironment;
  readonly randomUUID?: () => string;
  readonly nowEpochSeconds?: number;
}) {
  const environment = input.environment ?? fromProcessEnvironment();
  const liveKitUrl = environment.liveKitUrl?.trim();
  const apiKey = environment.liveKitApiKey?.trim();
  const apiSecret = environment.liveKitApiSecret?.trim();
  if (!liveKitUrl || !apiKey || !apiSecret) {
    return yield* new StudyVoiceSessionError({
      reason: "not-configured",
      message: "Voice study is not configured on this environment.",
    });
  }
  const normalizedUrl = parseLiveKitUrl(liveKitUrl);
  if (!normalizedUrl) {
    return yield* new StudyVoiceSessionError({
      reason: "invalid-configuration",
      message: "The configured LiveKit URL must use ws:// or wss://.",
    });
  }

  const index = yield* readStudyLibraryIndex(input.paths).pipe(
    Effect.mapError(
      () =>
        new StudyVoiceSessionError({
          reason: "library",
          message: "Could not resolve the selected study books.",
        }),
    ),
  );
  const requestedIds = Array.from(new Set(input.request.documentIds));
  const selectedDocuments = requestedIds.map((documentId) =>
    index.documents.find((document) => document.id === documentId),
  );
  if (selectedDocuments.some((document) => document === undefined)) {
    return yield* new StudyVoiceSessionError({
      reason: "library",
      message: "One or more selected study books are no longer available.",
    });
  }

  const participantMetadata = {
    version: 1,
    selectedDocuments: selectedDocuments
      .filter((document) => document !== undefined)
      .map((document) => ({
        documentId: document.id,
        title: document.title,
        format: document.format,
        tags: document.tags,
      })),
  } satisfies StudyVoiceParticipantMetadata;

  const id = (input.randomUUID ?? NodeCrypto.randomUUID)();
  const roomName = `study-${id}`;
  const token = yield* Effect.tryPromise({
    try: () =>
      createLiveKitParticipantToken({
        apiKey,
        apiSecret,
        identity: `study-user-${id}`,
        roomName,
        agentName: environment.agentName?.trim() || "t3-study-voice",
        metadata: participantMetadata,
        ttlSeconds: 15 * 60,
        ...(input.nowEpochSeconds === undefined ? {} : { nowEpochSeconds: input.nowEpochSeconds }),
      }),
    catch: () =>
      new StudyVoiceSessionError({
        reason: "token",
        message: "Could not create a voice study session.",
      }),
  });

  return {
    url: normalizedUrl,
    token: token.token,
    roomName,
    expiresAt: token.expiresAt,
  } satisfies StudyVoiceSessionResult;
});
