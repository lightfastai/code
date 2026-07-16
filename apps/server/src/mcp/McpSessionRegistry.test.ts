import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      idleTimeoutMs: 100,
      maximumLifetimeMs: 1_000,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials after inactivity", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("defaults notebook execution to denied and updates every credential for one thread", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("thread-notebook-grant");
    const otherThreadId = ThreadId.make("thread-notebook-other");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const other = yield* registry.issue({
      threadId: otherThreadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const otherToken = other.config.authorizationHeader.replace(/^Bearer\s+/, "");

    expect((yield* registry.resolve(token))?.allowNotebookExecution).toBe(false);
    expect(yield* registry.getNotebookExecutionPermission(threadId)).toEqual({
      threadId,
      allowNotebookExecution: false,
    });

    yield* registry.setNotebookExecutionPermission({
      threadId,
      allowNotebookExecution: true,
    });

    expect((yield* registry.resolve(token))?.allowNotebookExecution).toBe(true);
    expect((yield* registry.resolve(otherToken))?.allowNotebookExecution).toBe(false);
    expect(yield* registry.getNotebookExecutionPermission(threadId)).toEqual({
      threadId,
      allowNotebookExecution: true,
    });
  }),
);

it.effect("revalidates the authenticated thread grant atomically at runtime start", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("thread-notebook-race");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    yield* registry.setNotebookExecutionPermission({ threadId, allowNotebookExecution: true });
    const invocation = yield* registry.resolve(token);
    expect(invocation?.allowNotebookExecution).toBe(true);
    if (invocation === undefined) return;

    const lookupFinished = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const runtimeStarts: string[] = [];
    const execution = yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* Deferred.succeed(lookupFinished, undefined);
        yield* Deferred.await(resume);
        return yield* registry.withNotebookExecutionStart(
          invocation,
          Effect.sync(() => runtimeStarts.push(invocation.threadId)),
        );
      }),
    );

    yield* Deferred.await(lookupFinished);
    yield* registry.setNotebookExecutionPermission({ threadId, allowNotebookExecution: false });
    yield* Deferred.succeed(resume, undefined);
    const denied = yield* Fiber.join(execution).pipe(Effect.flip);

    expect(denied).toMatchObject({ reason: "permission-denied" });
    expect(runtimeStarts).toEqual([]);

    yield* registry.setNotebookExecutionPermission({ threadId, allowNotebookExecution: true });
    const swapped = yield* registry
      .withNotebookExecutionStart(
        { ...invocation, threadId: ThreadId.make("thread-notebook-swapped") },
        Effect.sync(() => runtimeStarts.push("swapped")),
      )
      .pipe(Effect.flip);
    expect(swapped).toMatchObject({ reason: "permission-denied" });
    expect(runtimeStarts).toEqual([]);
  }),
);

it.effect("serializes permission revocation with the complete runtime start boundary", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("thread-notebook-start-lock");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    yield* registry.setNotebookExecutionPermission({ threadId, allowNotebookExecution: true });
    const invocation = yield* registry.resolve(token);
    if (invocation === undefined) throw new Error("missing invocation");
    const startEntered = yield* Deferred.make<void>();
    const releaseStart = yield* Deferred.make<void>();
    const execution = yield* Effect.forkChild(
      registry.withNotebookExecutionStart(
        invocation,
        Deferred.succeed(startEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStart)),
        ),
      ),
    );
    yield* Deferred.await(startEntered);
    const revocation = yield* Effect.forkChild(
      registry.setNotebookExecutionPermission({ threadId, allowNotebookExecution: false }),
    );
    yield* Effect.yieldNow;

    expect(revocation.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(releaseStart, undefined);
    yield* Fiber.join(execution);
    yield* Fiber.join(revocation);
    expect(yield* registry.getNotebookExecutionPermission(threadId)).toEqual({
      threadId,
      allowNotebookExecution: false,
    });
  }),
);
