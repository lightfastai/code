import { SignJWT } from "jose";
import * as DateTime from "effect/DateTime";

export interface LiveKitParticipantTokenInput {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly identity: string;
  readonly roomName: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly agentName?: string;
  readonly ttlSeconds?: number;
  readonly nowEpochSeconds?: number;
}

export interface LiveKitParticipantTokenResult {
  readonly token: string;
  readonly expiresAt: string;
}

export async function createLiveKitParticipantToken(
  input: LiveKitParticipantTokenInput,
): Promise<LiveKitParticipantTokenResult> {
  const apiKey = input.apiKey.trim();
  const apiSecret = input.apiSecret.trim();
  const identity = input.identity.trim();
  const roomName = input.roomName.trim();
  const agentName = input.agentName?.trim();
  if (!apiKey || !apiSecret || !identity || !roomName) {
    throw new Error("LiveKit token configuration is incomplete.");
  }

  const nowSeconds =
    input.nowEpochSeconds ?? Math.floor(DateTime.nowUnsafe().epochMilliseconds / 1_000);
  const ttlSeconds = Math.min(Math.max(input.ttlSeconds ?? 15 * 60, 60), 60 * 60);
  const expiresAtSeconds = nowSeconds + ttlSeconds;
  const token = await new SignJWT({
    video: {
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
    ...(input.metadata === undefined ? {} : { metadata: JSON.stringify(input.metadata) }),
    ...(agentName ? { roomConfig: { agents: [{ agentName }] } } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(apiKey)
    .setSubject(identity)
    .setNotBefore(nowSeconds - 5)
    .setExpirationTime(expiresAtSeconds)
    .sign(new TextEncoder().encode(apiSecret));

  return {
    token,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtSeconds * 1_000)),
  };
}
