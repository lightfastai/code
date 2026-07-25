import {
  NotebookAgentToolError,
  type SelectedStudyDocumentIds,
  type StudyDocumentId,
  type NotebookAgentExecutionPermission,
  type NotebookAgentExecutionPermissionSetInput,
  type MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";
import { narrowStudyDocumentIds, normalizeStudyDocumentIds } from "@t3tools/shared/studyContext";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
  readonly expiresAt: number;
}

export interface NotebookDocumentAuthorityInput {
  readonly threadId: ThreadId;
  readonly documentIds: ReadonlyArray<StudyDocumentId>;
}

export interface NotebookDocumentAuthorityTurnInput extends NotebookDocumentAuthorityInput {
  readonly messageId: MessageId;
}

export interface NotebookDocumentAuthorityTurnKey {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly getNotebookExecutionPermission: (
    threadId: ThreadId,
  ) => Effect.Effect<NotebookAgentExecutionPermission>;
  readonly setNotebookExecutionPermission: (
    input: NotebookAgentExecutionPermissionSetInput,
  ) => Effect.Effect<NotebookAgentExecutionPermission>;
  readonly setNotebookDocumentAuthority: (
    input: NotebookDocumentAuthorityInput,
  ) => Effect.Effect<SelectedStudyDocumentIds>;
  readonly stageNotebookDocumentAuthorityTurn: (
    input: NotebookDocumentAuthorityTurnInput,
  ) => Effect.Effect<boolean>;
  readonly admitNotebookDocumentAuthorityTurn: (
    input: NotebookDocumentAuthorityTurnKey,
  ) => Effect.Effect<boolean>;
  readonly completeNotebookDocumentAuthorityTurn: (
    input: NotebookDocumentAuthorityTurnKey,
  ) => Effect.Effect<boolean>;
  readonly finalizeNotebookDocumentAuthorityTurn: (
    input: NotebookDocumentAuthorityTurnKey,
  ) => Effect.Effect<boolean>;
  readonly rollbackNotebookDocumentAuthorityTurn: (
    input: NotebookDocumentAuthorityTurnKey,
  ) => Effect.Effect<boolean>;
  readonly withNotebookExecutionStart: <A, E, R>(
    invocation: McpInvocationContext.McpInvocationScope,
    documentIds: ReadonlyArray<StudyDocumentId>,
    start: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | NotebookAgentToolError, R>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastUsedAt: number;
}

interface NotebookDocumentAuthorityTurn {
  readonly messageId: MessageId;
  readonly previousDocumentIds: SelectedStudyDocumentIds;
  readonly documentIds: SelectedStudyDocumentIds;
  readonly providerSendCompleted: boolean;
  readonly runtimeAdmitted: boolean;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
  readonly notebookExecutionPermissions: ReadonlyMap<ThreadId, boolean>;
  readonly notebookDocumentAuthorities: ReadonlyMap<ThreadId, SelectedStudyDocumentIds>;
  readonly notebookDocumentAuthorityTurns: ReadonlyMap<ThreadId, NotebookDocumentAuthorityTurn>;
}

export interface McpSessionRegistryOptions {
  readonly idleTimeoutMs?: number;
  readonly maximumLifetimeMs?: number;
  readonly now?: () => number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MAXIMUM_LIFETIME_MS = 8 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({
    records: new Map(),
    notebookExecutionPermissions: new Map(),
    notebookDocumentAuthorities: new Map(),
    notebookDocumentAuthorityTurns: new Map(),
  });
  const threadPermissionLocks = yield* SynchronizedRef.make<
    ReadonlyMap<ThreadId, Semaphore.Semaphore>
  >(new Map());
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maximumLifetimeMs = options.maximumLifetimeMs ?? DEFAULT_MAXIMUM_LIFETIME_MS;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const getThreadPermissionLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadPermissionLocks, (current) => {
      const existing = current.get(threadId);
      if (existing !== undefined) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(threadId, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const withThreadPermissionLock = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(getThreadPermissionLock(threadId), (semaphore) => semaphore.withPermit(effect));

  const pruneExpired = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) =>
          timestamp <= record.scope.expiresAt && timestamp - record.lastUsedAt <= idleTimeoutMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const updateNotebookDocumentAuthority = (
    current: RegistryState,
    threadId: ThreadId,
    documentIds: SelectedStudyDocumentIds,
  ): RegistryState => {
    const nextAuthorities = new Map(current.notebookDocumentAuthorities);
    nextAuthorities.set(threadId, documentIds);
    const nextRecords = new Map(
      Array.from(current.records, ([tokenHash, record]) => [
        tokenHash,
        record.scope.threadId === threadId
          ? {
              ...record,
              scope: { ...record.scope, notebookDocumentIds: documentIds },
            }
          : record,
      ]),
    );
    return {
      ...current,
      records: nextRecords,
      notebookDocumentAuthorities: nextAuthorities,
    };
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const expiresAt = issuedAt + maximumLifetimeMs;
      const threadId = ThreadId.make(request.threadId);
      const providerInstanceId = ProviderInstanceId.make(request.providerInstanceId);
      const scope = yield* SynchronizedRef.modify(
        state,
        ({
          records,
          notebookExecutionPermissions,
          notebookDocumentAuthorities,
          notebookDocumentAuthorityTurns,
        }) => {
          const scope: McpInvocationContext.McpInvocationScope = {
            environmentId,
            threadId,
            providerSessionId,
            providerInstanceId,
            capabilities: new Set(["preview", "artifacts", "study"]),
            allowNotebookExecution: notebookExecutionPermissions.get(threadId) ?? false,
            notebookDocumentIds: notebookDocumentAuthorities.get(threadId) ?? [],
            issuedAt,
            expiresAt,
          };
          const next = new Map(pruneExpired(records, issuedAt));
          next.set(tokenHash, { tokenHash, scope, lastUsedAt: issuedAt });
          return [
            scope,
            {
              records: next,
              notebookExecutionPermissions,
              notebookDocumentAuthorities,
              notebookDocumentAuthorityTurns,
            },
          ] as const;
        },
      );
      return {
        config: {
          environmentId,
          threadId: scope.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
        },
        expiresAt,
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      return yield* SynchronizedRef.modify(
        state,
        ({
          records,
          notebookExecutionPermissions,
          notebookDocumentAuthorities,
          notebookDocumentAuthorityTurns,
        }) => {
          const current = pruneExpired(records, timestamp);
          const record = current.get(tokenHash);
          if (!record) {
            return [
              undefined,
              {
                records: current,
                notebookExecutionPermissions,
                notebookDocumentAuthorities,
                notebookDocumentAuthorityTurns,
              },
            ] as const;
          }
          const next = new Map(current);
          next.set(tokenHash, { ...record, lastUsedAt: timestamp });
          return [
            record.scope,
            {
              records: next,
              notebookExecutionPermissions,
              notebookDocumentAuthorities,
              notebookDocumentAuthorityTurns,
            },
          ] as const;
        },
      );
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(
      state,
      ({
        records,
        notebookExecutionPermissions,
        notebookDocumentAuthorities,
        notebookDocumentAuthorityTurns,
      }) => ({
        records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
        notebookExecutionPermissions,
        notebookDocumentAuthorities,
        notebookDocumentAuthorityTurns,
      }),
    );

  return McpSessionRegistry.of({
    issue,
    resolve,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")((threadId) =>
      withThreadPermissionLock(
        threadId,
        revokeWhere((record) => record.scope.threadId === threadId),
      ),
    ),
    getNotebookExecutionPermission: Effect.fn("McpSessionRegistry.getNotebookExecutionPermission")(
      function* (threadId) {
        const current = yield* SynchronizedRef.get(state);
        return {
          threadId,
          allowNotebookExecution: current.notebookExecutionPermissions.get(threadId) ?? false,
        };
      },
    ),
    setNotebookExecutionPermission: Effect.fn("McpSessionRegistry.setNotebookExecutionPermission")(
      (input) =>
        withThreadPermissionLock(
          input.threadId,
          SynchronizedRef.update(
            state,
            ({
              records,
              notebookExecutionPermissions,
              notebookDocumentAuthorities,
              notebookDocumentAuthorityTurns,
            }) => {
              const nextPermissions = new Map(notebookExecutionPermissions);
              nextPermissions.set(input.threadId, input.allowNotebookExecution);
              const nextRecords = new Map(
                Array.from(records, ([tokenHash, record]) => [
                  tokenHash,
                  record.scope.threadId === input.threadId
                    ? {
                        ...record,
                        scope: {
                          ...record.scope,
                          allowNotebookExecution: input.allowNotebookExecution,
                        },
                      }
                    : record,
                ]),
              );
              return {
                records: nextRecords,
                notebookExecutionPermissions: nextPermissions,
                notebookDocumentAuthorities,
                notebookDocumentAuthorityTurns,
              };
            },
          ).pipe(Effect.as(input)),
        ),
    ),
    setNotebookDocumentAuthority: Effect.fn("McpSessionRegistry.setNotebookDocumentAuthority")(
      (input) => {
        const documentIds = normalizeStudyDocumentIds(input.documentIds);
        return withThreadPermissionLock(
          input.threadId,
          SynchronizedRef.update(state, (current) => {
            const updated = updateNotebookDocumentAuthority(current, input.threadId, documentIds);
            const nextTurns = new Map(updated.notebookDocumentAuthorityTurns);
            nextTurns.delete(input.threadId);
            return { ...updated, notebookDocumentAuthorityTurns: nextTurns };
          }).pipe(Effect.as(documentIds)),
        );
      },
    ),
    stageNotebookDocumentAuthorityTurn: Effect.fn(
      "McpSessionRegistry.stageNotebookDocumentAuthorityTurn",
    )((input) => {
      const documentIds = normalizeStudyDocumentIds(input.documentIds);
      return withThreadPermissionLock(
        input.threadId,
        SynchronizedRef.modify(state, (current) => {
          const existing = current.notebookDocumentAuthorityTurns.get(input.threadId);
          if (existing !== undefined) {
            return [existing.messageId === input.messageId, current] as const;
          }
          const nextTurns = new Map(current.notebookDocumentAuthorityTurns);
          nextTurns.set(input.threadId, {
            messageId: input.messageId,
            previousDocumentIds: current.notebookDocumentAuthorities.get(input.threadId) ?? [],
            documentIds,
            providerSendCompleted: false,
            runtimeAdmitted: false,
          });
          return [true, { ...current, notebookDocumentAuthorityTurns: nextTurns }] as const;
        }),
      );
    }),
    admitNotebookDocumentAuthorityTurn: Effect.fn(
      "McpSessionRegistry.admitNotebookDocumentAuthorityTurn",
    )((input) =>
      withThreadPermissionLock(
        input.threadId,
        SynchronizedRef.modify(state, (current) => {
          const transaction = current.notebookDocumentAuthorityTurns.get(input.threadId);
          if (transaction === undefined || transaction.messageId !== input.messageId) {
            return [false, current] as const;
          }
          if (transaction.runtimeAdmitted) {
            return [true, current] as const;
          }
          const updated = updateNotebookDocumentAuthority(
            current,
            input.threadId,
            transaction.documentIds,
          );
          const nextTurns = new Map(updated.notebookDocumentAuthorityTurns);
          nextTurns.set(input.threadId, { ...transaction, runtimeAdmitted: true });
          return [true, { ...updated, notebookDocumentAuthorityTurns: nextTurns }] as const;
        }),
      ),
    ),
    completeNotebookDocumentAuthorityTurn: Effect.fn(
      "McpSessionRegistry.completeNotebookDocumentAuthorityTurn",
    )((input) =>
      withThreadPermissionLock(
        input.threadId,
        SynchronizedRef.modify(state, (current) => {
          const transaction = current.notebookDocumentAuthorityTurns.get(input.threadId);
          if (transaction === undefined || transaction.messageId !== input.messageId) {
            return [false, current] as const;
          }
          if (transaction.providerSendCompleted) {
            return [true, current] as const;
          }
          const nextTurns = new Map(current.notebookDocumentAuthorityTurns);
          nextTurns.set(input.threadId, { ...transaction, providerSendCompleted: true });
          return [true, { ...current, notebookDocumentAuthorityTurns: nextTurns }] as const;
        }),
      ),
    ),
    finalizeNotebookDocumentAuthorityTurn: Effect.fn(
      "McpSessionRegistry.finalizeNotebookDocumentAuthorityTurn",
    )((input) =>
      withThreadPermissionLock(
        input.threadId,
        SynchronizedRef.modify(state, (current) => {
          const transaction = current.notebookDocumentAuthorityTurns.get(input.threadId);
          if (
            transaction === undefined ||
            transaction.messageId !== input.messageId ||
            !transaction.providerSendCompleted ||
            !transaction.runtimeAdmitted
          ) {
            return [false, current] as const;
          }
          const nextTurns = new Map(current.notebookDocumentAuthorityTurns);
          nextTurns.delete(input.threadId);
          return [true, { ...current, notebookDocumentAuthorityTurns: nextTurns }] as const;
        }),
      ),
    ),
    rollbackNotebookDocumentAuthorityTurn: Effect.fn(
      "McpSessionRegistry.rollbackNotebookDocumentAuthorityTurn",
    )((input) =>
      withThreadPermissionLock(
        input.threadId,
        SynchronizedRef.modify(state, (current) => {
          const transaction = current.notebookDocumentAuthorityTurns.get(input.threadId);
          if (transaction === undefined || transaction.messageId !== input.messageId) {
            return [false, current] as const;
          }
          const updated = transaction.runtimeAdmitted
            ? updateNotebookDocumentAuthority(
                current,
                input.threadId,
                transaction.previousDocumentIds,
              )
            : current;
          const nextTurns = new Map(updated.notebookDocumentAuthorityTurns);
          nextTurns.delete(input.threadId);
          return [true, { ...updated, notebookDocumentAuthorityTurns: nextTurns }] as const;
        }),
      ),
    ),
    withNotebookExecutionStart: Effect.fn("McpSessionRegistry.withNotebookExecutionStart")(
      (invocation, documentIds, start) =>
        withThreadPermissionLock(
          invocation.threadId,
          Effect.gen(function* () {
            const timestamp = yield* currentTimeMillis;
            const authorized = yield* SynchronizedRef.modify(
              state,
              ({
                records,
                notebookExecutionPermissions,
                notebookDocumentAuthorities,
                notebookDocumentAuthorityTurns,
              }) => {
                const current = pruneExpired(records, timestamp);
                const credentialIsCurrent = Array.from(current.values()).some(
                  ({ scope }) =>
                    scope.environmentId === invocation.environmentId &&
                    scope.threadId === invocation.threadId &&
                    scope.providerSessionId === invocation.providerSessionId &&
                    scope.providerInstanceId === invocation.providerInstanceId,
                );
                const permissionGranted =
                  notebookExecutionPermissions.get(invocation.threadId) ?? false;
                const documentScopeGranted =
                  narrowStudyDocumentIds(
                    notebookDocumentAuthorities.get(invocation.threadId) ?? [],
                    documentIds,
                  ) !== null;
                return [
                  { credentialIsCurrent, permissionGranted, documentScopeGranted },
                  {
                    records: current,
                    notebookExecutionPermissions,
                    notebookDocumentAuthorities,
                    notebookDocumentAuthorityTurns,
                  },
                ] as const;
              },
            );
            if (!authorized.credentialIsCurrent || !authorized.permissionGranted) {
              return yield* new NotebookAgentToolError({
                reason: "permission-denied",
                message: "This thread does not grant notebook execution to the agent.",
              });
            }
            if (!authorized.documentScopeGranted) {
              return yield* new NotebookAgentToolError({
                reason: "scope-mismatch",
                message: "The requested study documents exceed this turn's notebook authority.",
              });
            }
            return yield* start;
          }),
        ),
    ),
    revokeAll: SynchronizedRef.update(
      state,
      ({
        notebookExecutionPermissions,
        notebookDocumentAuthorities,
        notebookDocumentAuthorityTurns,
      }) => ({
        records: new Map(),
        notebookExecutionPermissions,
        notebookDocumentAuthorities,
        notebookDocumentAuthorityTurns,
      }),
    ),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

export const getActiveNotebookExecutionPermission = (
  threadId: ThreadId,
): Effect.Effect<NotebookAgentExecutionPermission> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.getNotebookExecutionPermission(threadId)
    : Effect.succeed({ threadId, allowNotebookExecution: false });

export const setActiveNotebookExecutionPermission = (
  input: NotebookAgentExecutionPermissionSetInput,
): Effect.Effect<NotebookAgentExecutionPermission> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.setNotebookExecutionPermission(input)
    : Effect.succeed({ ...input, allowNotebookExecution: false });

export const setActiveNotebookDocumentAuthority = (
  input: NotebookDocumentAuthorityInput,
): Effect.Effect<SelectedStudyDocumentIds> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.setNotebookDocumentAuthority(input)
    : Effect.succeed([]);

export const stageActiveNotebookDocumentAuthorityTurn = (
  input: NotebookDocumentAuthorityTurnInput,
): Effect.Effect<boolean> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.stageNotebookDocumentAuthorityTurn(input)
    : Effect.succeed(true);

export const admitActiveNotebookDocumentAuthorityTurn = (
  input: NotebookDocumentAuthorityTurnKey,
): Effect.Effect<boolean> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.admitNotebookDocumentAuthorityTurn(input)
    : Effect.succeed(false);

export const completeActiveNotebookDocumentAuthorityTurn = (
  input: NotebookDocumentAuthorityTurnKey,
): Effect.Effect<boolean> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.completeNotebookDocumentAuthorityTurn(input)
    : Effect.succeed(false);

export const finalizeActiveNotebookDocumentAuthorityTurn = (
  input: NotebookDocumentAuthorityTurnKey,
): Effect.Effect<boolean> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.finalizeNotebookDocumentAuthorityTurn(input)
    : Effect.succeed(false);

export const rollbackActiveNotebookDocumentAuthorityTurn = (
  input: NotebookDocumentAuthorityTurnKey,
): Effect.Effect<boolean> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.rollbackNotebookDocumentAuthorityTurn(input)
    : Effect.succeed(false);

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
