// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Docker and UDS lifecycle is a Node boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import type { NotebookExecutionEvent, NotebookExecutionReplay } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  DockerExecNotebookRuntimeClient,
  NotebookRuntimeClientError,
  type NotebookRuntimeClientLike,
  type RuntimeExecuteRequest,
} from "./NotebookRuntimeClient.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_EXECUTION_TIMEOUT_SECONDS = 120;
const DEFAULT_TIMEOUT_IDLE_GRACE_SECONDS = 5;
const DEFAULT_EVENT_HISTORY_LIMIT = 4096;
const DEFAULT_COMMAND_CACHE_LIMIT = 512;
const DEFAULT_EVENT_HISTORY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_COMMAND_CACHE_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_DISPOSE_TOMBSTONE_LIMIT = 512;
const DEFAULT_DISPOSE_TOMBSTONE_LIMIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_DISPOSE_TOMBSTONE_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_SESSIONS_PER_PROJECT = 4;
const DEFAULT_MAX_SESSIONS_GLOBAL = 8;
const DOCKER_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface DockerCommandRunner {
  readonly run: (
    args: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ) => Promise<{ readonly stdout: string }>;
}

export class DockerCliCommandRunner implements DockerCommandRunner {
  async run(
    args: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ): Promise<{ readonly stdout: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = NodeChildProcess.spawn("docker", [...args], {
        env: { ...NodeProcess.env, ...options?.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      const append = (target: Buffer[], chunk: Uint8Array) => {
        const buffer = Buffer.from(chunk);
        outputBytes += buffer.length;
        if (outputBytes > DOCKER_OUTPUT_LIMIT_BYTES) {
          child.kill("SIGKILL");
          return;
        }
        target.push(buffer);
      };
      child.stdout.on("data", (chunk) => append(stdout, chunk));
      child.stderr.on("data", (chunk) => append(stderr, chunk));
      child.on("error", () =>
        reject(
          new NotebookRuntimeManagerError({
            reason: "docker-failed",
            message: "Could not launch the Docker CLI.",
          }),
        ),
      );
      child.on("close", (code) => {
        if (outputBytes > DOCKER_OUTPUT_LIMIT_BYTES) {
          reject(
            new NotebookRuntimeManagerError({
              reason: "docker-failed",
              message: "Docker CLI output exceeded the safety limit.",
            }),
          );
          return;
        }
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString().trim().slice(0, 512);
          reject(
            new NotebookRuntimeManagerError({
              reason: "docker-failed",
              message: detail ? `Docker command failed: ${detail}` : "Docker command failed.",
            }),
          );
          return;
        }
        resolvePromise({ stdout: Buffer.concat(stdout).toString() });
      });
    });
  }
}

export class NotebookRuntimeManagerError extends Error {
  readonly reason:
    | "docker-failed"
    | "runtime-unavailable"
    | "session-not-found"
    | "command-id-conflict"
    | "invalid-sequence"
    | "invalid-mount";

  constructor(options: {
    readonly reason: NotebookRuntimeManagerError["reason"];
    readonly message: string;
  }) {
    super(options.message);
    this.name = "NotebookRuntimeManagerError";
    this.reason = options.reason;
  }
}

interface CommandResult {
  readonly events?: ReadonlyArray<NotebookExecutionEvent>;
  readonly error?: unknown;
}

interface CommandCacheEntry {
  readonly fingerprint: string;
  readonly completion: Promise<CommandResult>;
  retainedBytes: number;
  completed: boolean;
}

interface DisposeTombstone {
  readonly fingerprint: string;
  readonly containerId: string;
  readonly events: ReadonlyArray<NotebookExecutionEvent>;
  readonly expiresAt: number;
  readonly retainedBytes: number;
}

interface PendingEvent {
  readonly event: NotebookExecutionEvent;
  readonly bytes: number;
}

interface SessionState {
  readonly sessionId: string;
  readonly events: NotebookExecutionEvent[];
  readonly commands: Map<string, CommandCacheEntry>;
  readonly commandOrder: string[];
  readonly eventSizes: number[];
  readonly pendingEvents: Map<number, PendingEvent>;
  eventHistoryBytes: number;
  commandCacheBytes: number;
  pendingEventBytes: number;
  lastSequence: number;
  disposed: boolean;
}

interface OwnedSessionContainer {
  readonly sessionKey: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly containerId: string;
  readonly controlDirectory: string;
}

interface SessionRuntime extends OwnedSessionContainer {
  readonly client: NotebookRuntimeClientLike;
  readonly session: SessionState;
  opened: boolean;
}

interface ProjectState {
  readonly projectId: string;
  readonly books: ReadonlyArray<string>;
  readonly sessionKeys: Set<string>;
  lastUsedAt: number;
}

interface SessionStart {
  readonly projectId: string;
  readonly promise: Promise<SessionRuntime>;
}

interface SessionDisposal {
  readonly projectId: string;
  readonly containerId: string;
  readonly fingerprint: string;
  readonly promise: Promise<ReadonlyArray<NotebookExecutionEvent>>;
}

class ExecutionEventQueue implements AsyncIterable<NotebookExecutionEvent> {
  readonly #events: NotebookExecutionEvent[] = [];
  #wake: (() => void) | undefined;
  #done = false;
  #error: unknown;

  push(event: NotebookExecutionEvent): void {
    this.#events.push(event);
    this.#wake?.();
    this.#wake = undefined;
  }

  finish(error?: unknown): void {
    this.#done = true;
    this.#error = error;
    this.#wake?.();
    this.#wake = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<NotebookExecutionEvent> {
    while (true) {
      const event = this.#events.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      if (this.#done) {
        if (this.#error !== undefined) throw this.#error;
        return;
      }
      await new Promise<void>((resolvePromise) => {
        this.#wake = resolvePromise;
      });
    }
  }
}

export interface NotebookRuntimeManagerOptions {
  readonly docker?: DockerCommandRunner;
  readonly image: string;
  readonly runtimeRoot?: string;
  readonly clientFactory?: (options: {
    readonly containerId: string;
    readonly token: string;
  }) => NotebookRuntimeClientLike;
  readonly now?: () => number;
  readonly idleTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly eventHistoryLimit?: number;
  readonly commandCacheLimit?: number;
  readonly eventHistoryLimitBytes?: number;
  readonly commandCacheLimitBytes?: number;
  readonly executionTimeoutSeconds?: number;
  readonly timeoutIdleGraceSeconds?: number;
  readonly disposeTombstoneLimit?: number;
  readonly disposeTombstoneLimitBytes?: number;
  readonly disposeTombstoneTtlMs?: number;
  readonly maxSessionsPerProject?: number;
  readonly maxSessionsGlobal?: number;
}

export interface NotebookManagerSessionOpenInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly kernelName: string;
  readonly bookPaths?: ReadonlyArray<string>;
}

export interface NotebookManagerExecuteInput extends RuntimeExecuteRequest {
  readonly projectId: string;
}

export interface NotebookManagerControlInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly commandId: string;
}

export class NotebookRuntimeManager {
  readonly #docker: DockerCommandRunner;
  readonly #image: string;
  readonly #runtimeRoot: string;
  readonly #clientFactory: NonNullable<NotebookRuntimeManagerOptions["clientFactory"]>;
  readonly #now: () => number;
  readonly #idleTimeoutMs: number;
  readonly #readinessTimeoutMs: number;
  readonly #eventHistoryLimit: number;
  readonly #commandCacheLimit: number;
  readonly #eventHistoryLimitBytes: number;
  readonly #commandCacheLimitBytes: number;
  readonly #executionTimeoutSeconds: number;
  readonly #timeoutIdleGraceSeconds: number;
  readonly #disposeTombstoneLimit: number;
  readonly #disposeTombstoneLimitBytes: number;
  readonly #disposeTombstoneTtlMs: number;
  readonly #maxSessionsPerProject: number;
  readonly #maxSessionsGlobal: number;
  readonly #projects = new Map<string, ProjectState>();
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #containers = new Map<string, OwnedSessionContainer>();
  readonly #sessionStarts = new Map<string, SessionStart>();
  readonly #sessionDisposals = new Map<string, SessionDisposal>();
  readonly #sessionRemovals = new Map<string, Promise<void>>();
  readonly #projectRemovals = new Map<string, Promise<void>>();
  readonly #disposeTombstones = new Map<string, DisposeTombstone>();
  #disposeTombstoneBytes = 0;
  #closing = false;
  #runtimeImageDigest: Promise<string> | undefined;

  constructor(options: NotebookRuntimeManagerOptions) {
    this.#docker = options.docker ?? new DockerCliCommandRunner();
    this.#image = options.image;
    this.#runtimeRoot =
      options.runtimeRoot ?? NodePath.join(NodeOS.tmpdir(), "lightfast-notebook-runtime");
    this.#clientFactory =
      options.clientFactory ??
      ((clientOptions) =>
        new DockerExecNotebookRuntimeClient({ ...clientOptions, requestTimeoutMs: 130_000 }));
    this.#now = options.now ?? Date.now;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.#eventHistoryLimit = options.eventHistoryLimit ?? DEFAULT_EVENT_HISTORY_LIMIT;
    this.#commandCacheLimit = options.commandCacheLimit ?? DEFAULT_COMMAND_CACHE_LIMIT;
    this.#eventHistoryLimitBytes =
      options.eventHistoryLimitBytes ?? DEFAULT_EVENT_HISTORY_LIMIT_BYTES;
    this.#commandCacheLimitBytes =
      options.commandCacheLimitBytes ?? DEFAULT_COMMAND_CACHE_LIMIT_BYTES;
    this.#executionTimeoutSeconds =
      options.executionTimeoutSeconds ?? DEFAULT_EXECUTION_TIMEOUT_SECONDS;
    this.#timeoutIdleGraceSeconds =
      options.timeoutIdleGraceSeconds ?? DEFAULT_TIMEOUT_IDLE_GRACE_SECONDS;
    this.#disposeTombstoneLimit = options.disposeTombstoneLimit ?? DEFAULT_DISPOSE_TOMBSTONE_LIMIT;
    this.#disposeTombstoneLimitBytes =
      options.disposeTombstoneLimitBytes ?? DEFAULT_DISPOSE_TOMBSTONE_LIMIT_BYTES;
    this.#disposeTombstoneTtlMs = options.disposeTombstoneTtlMs ?? DEFAULT_DISPOSE_TOMBSTONE_TTL_MS;
    this.#maxSessionsPerProject = options.maxSessionsPerProject ?? DEFAULT_MAX_SESSIONS_PER_PROJECT;
    this.#maxSessionsGlobal = options.maxSessionsGlobal ?? DEFAULT_MAX_SESSIONS_GLOBAL;
    if (this.#executionTimeoutSeconds <= 0 || this.#timeoutIdleGraceSeconds <= 0) {
      throw new Error("Notebook runtime timeout settings must be positive.");
    }
    const positiveIntegerSettings = [
      this.#disposeTombstoneLimit,
      this.#disposeTombstoneLimitBytes,
      this.#disposeTombstoneTtlMs,
      this.#maxSessionsPerProject,
      this.#maxSessionsGlobal,
    ];
    if (positiveIntegerSettings.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(
        "Notebook runtime retention and admission settings must be positive integers.",
      );
    }
    if (this.#maxSessionsPerProject > this.#maxSessionsGlobal) {
      throw new Error("The per-project notebook session limit cannot exceed the global limit.");
    }
  }

  async open(
    input: NotebookManagerSessionOpenInput,
  ): Promise<ReadonlyArray<NotebookExecutionEvent>> {
    const activeRemoval = this.#projectRemovals.get(input.projectId);
    if (activeRemoval !== undefined) await activeRemoval;
    const sessionKey = this.#sessionKey(input.projectId, input.sessionId);
    const activeDisposal = this.#sessionDisposals.get(sessionKey);
    if (activeDisposal !== undefined) await activeDisposal.promise;
    const activeSessionRemoval = this.#sessionRemovals.get(sessionKey);
    if (activeSessionRemoval !== undefined) await activeSessionRemoval;
    this.#assertCanStart();
    this.#assertAdmissionAvailable(input.projectId, sessionKey);
    const project = this.#selectProject(input.projectId, input.bookPaths ?? []);
    const runtime = await this.#ensureSession(project, input.sessionId);
    project.lastUsedAt = this.#now();
    try {
      const events = await this.#runCached(
        runtime.session,
        input.commandId,
        this.#fingerprint("open", input),
        "open",
        () => runtime.client.open(input),
      );
      const state = this.#commandResultState(events, input.commandId, "open");
      if (state === "accepted-terminal") {
        runtime.opened = true;
      } else if (!runtime.opened) {
        await this.#removeContainer(runtime);
      }
      return events;
    } catch (error) {
      if (!runtime.opened) await this.#removeContainer(runtime).catch(() => undefined);
      throw error;
    }
  }

  resolveRuntimeImageDigest(): Promise<string> {
    this.#runtimeImageDigest ??= this.#docker
      .run(["image", "inspect", "--format", "{{.Id}}", this.#image])
      .then(({ stdout }) => {
        const digest = stdout.trim();
        if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
          throw new NotebookRuntimeManagerError({
            reason: "runtime-unavailable",
            message: "Notebook runtime image did not resolve to an exact digest.",
          });
        }
        return digest;
      })
      .catch((cause) => {
        this.#runtimeImageDigest = undefined;
        throw cause;
      });
    return this.#runtimeImageDigest;
  }

  execute(input: NotebookManagerExecuteInput): AsyncIterable<NotebookExecutionEvent> {
    const { project, runtime, session } = this.#getSession(input);
    project.lastUsedAt = this.#now();
    const fingerprint = this.#fingerprint("execute", input);
    const cached = session.commands.get(input.commandId);
    if (cached !== undefined) {
      this.#assertFingerprint(cached, fingerprint);
      return this.#replay(cached);
    }

    let complete!: (result: CommandResult) => void;
    const completion = new Promise<CommandResult>((resolvePromise) => {
      complete = resolvePromise;
    });
    const entry: CommandCacheEntry = {
      fingerprint,
      completion,
      retainedBytes: 0,
      completed: false,
    };
    this.#cacheCommand(session, input.commandId, entry);
    const queue = new ExecutionEventQueue();
    void (async () => {
      const eventsBySequence = new Map<number, NotebookExecutionEvent>();
      const recordEvent = (event: NotebookExecutionEvent, allowReplay: boolean): void => {
        const existing = eventsBySequence.get(event.sequence);
        if (existing !== undefined) {
          if (!allowReplay || JSON.stringify(existing) !== JSON.stringify(event)) {
            throw new NotebookRuntimeManagerError({
              reason: "invalid-sequence",
              message: "Notebook runtime replayed conflicting execution data.",
            });
          }
          return;
        }
        this.#appendEvent(session, event, allowReplay);
        if (event.commandId === input.commandId) {
          eventsBySequence.set(event.sequence, event);
          queue.push(event);
        }
      };
      let failure: unknown;
      try {
        for await (const event of runtime.client.execute(input)) {
          recordEvent(event, true);
        }
      } catch (error) {
        failure = error;
      }

      let events = [...eventsBySequence.values()].toSorted(
        (left, right) => left.sequence - right.sequence,
      );
      let state = this.#commandResultState(events, input.commandId, "execute");
      const recoverableFailure =
        failure === undefined ||
        (failure instanceof NotebookRuntimeClientError &&
          (failure.reason === "transport" || failure.reason === "protocol"));
      if (state === "incomplete" && recoverableFailure) {
        try {
          try {
            const resumed = await runtime.client.eventsAfter(input.sessionId, session.lastSequence);
            this.#applyReplayBaseline(session, resumed);
            for (const event of resumed.events) recordEvent(event, true);
          } catch (error) {
            failure = error;
          }
          events = [...eventsBySequence.values()].toSorted(
            (left, right) => left.sequence - right.sequence,
          );
          state = this.#commandResultState(events, input.commandId, "execute");
          if (state === "incomplete") {
            for await (const event of runtime.client.execute(input)) recordEvent(event, true);
            events = [...eventsBySequence.values()].toSorted(
              (left, right) => left.sequence - right.sequence,
            );
            state = this.#commandResultState(events, input.commandId, "execute");
          }
        } catch (error) {
          failure = error;
        }
        events = [...eventsBySequence.values()].toSorted(
          (left, right) => left.sequence - right.sequence,
        );
        state = this.#commandResultState(events, input.commandId, "execute");
      }

      if (state === "incomplete") {
        const error =
          failure ??
          new NotebookRuntimeManagerError({
            reason: "runtime-unavailable",
            message: "Notebook execution ended before a terminal event.",
          });
        const result = { error } satisfies CommandResult;
        this.#evictCommandCache(session, input.commandId, entry);
        complete(result);
        queue.finish(error);
        return;
      }

      const result = { events } satisfies CommandResult;
      if (state === "accepted-terminal") {
        this.#settleCommandCache(session, entry, result);
      } else {
        this.#evictCommandCache(session, input.commandId, entry);
      }
      complete(result);
      queue.finish();
    })();
    return queue;
  }

  interrupt(input: NotebookManagerControlInput): Promise<ReadonlyArray<NotebookExecutionEvent>> {
    return this.#control("interrupt", input);
  }

  restart(input: NotebookManagerControlInput): Promise<ReadonlyArray<NotebookExecutionEvent>> {
    return this.#control("restart", input);
  }

  async dispose(
    input: NotebookManagerControlInput,
  ): Promise<ReadonlyArray<NotebookExecutionEvent>> {
    this.#assertCanDispose(input.projectId);
    const sessionKey = this.#sessionKey(input.projectId, input.sessionId);
    const fingerprint = this.#fingerprint("dispose", input);
    const tombstone = this.#getDisposeTombstone(sessionKey, input.commandId);
    if (tombstone !== undefined) {
      this.#assertFingerprint(tombstone, fingerprint);
      const disposedRuntime = this.#sessions.get(sessionKey);
      if (
        disposedRuntime?.session.disposed === true &&
        disposedRuntime.containerId === tombstone.containerId
      ) {
        return this.#startSessionDisposal(sessionKey, disposedRuntime, fingerprint, async () => {
          await this.#removeContainer(disposedRuntime);
          return tombstone.events;
        });
      }
      return tombstone.events;
    }
    const { project, runtime, session } = this.#getSession(input, true);
    return this.#startSessionDisposal(sessionKey, runtime, fingerprint, async () => {
      project.lastUsedAt = this.#now();
      const events = await this.#runCached(session, input.commandId, fingerprint, "dispose", () =>
        runtime.client.dispose(input),
      );
      if (this.#commandResultState(events, input.commandId, "dispose") === "accepted-terminal") {
        session.disposed = true;
        this.#cacheDisposeTombstone(
          sessionKey,
          input.commandId,
          fingerprint,
          runtime.containerId,
          events,
        );
        await this.#removeContainer(runtime);
      }
      return events;
    });
  }

  eventsAfter(
    projectId: string,
    sessionId: string,
    afterSequence: number,
  ): NotebookExecutionReplay {
    const { session } = this.#getSession({ projectId, sessionId });
    return {
      baselineSequence:
        session.events[0]?.sequence === undefined
          ? session.lastSequence
          : session.events[0].sequence - 1,
      events: session.events.filter((event) => event.sequence > afterSequence),
    };
  }

  async reapIdle(): Promise<void> {
    const cutoff = this.#now() - this.#idleTimeoutMs;
    const idle = [...this.#projects.values()].filter((project) => project.lastUsedAt <= cutoff);
    await Promise.all(idle.map((project) => this.#removeProject(project)));
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled(
      [...this.#sessionDisposals.values()].map((disposal) => disposal.promise),
    );
    await Promise.allSettled([...this.#sessionStarts.values()].map((start) => start.promise));
    await this.#removeContainers([...this.#containers.values()]);
    this.#disposeTombstones.clear();
    this.#disposeTombstoneBytes = 0;
  }

  startIdleReaper(intervalMs = Math.min(this.#idleTimeoutMs, 60_000)): () => void {
    const timer = setInterval(() => {
      void this.reapIdle().catch(() => undefined);
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #control(
    command: "interrupt" | "restart",
    input: NotebookManagerControlInput,
  ): Promise<ReadonlyArray<NotebookExecutionEvent>> {
    const { project, runtime, session } = this.#getSession(input);
    project.lastUsedAt = this.#now();
    return this.#runCached(
      session,
      input.commandId,
      this.#fingerprint(command, input),
      command,
      () =>
        command === "interrupt" ? runtime.client.interrupt(input) : runtime.client.restart(input),
    );
  }

  #getSession(
    input: { readonly projectId: string; readonly sessionId: string },
    allowDisposed = false,
  ): {
    readonly project: ProjectState;
    readonly runtime: SessionRuntime;
    readonly session: SessionState;
  } {
    const project = this.#projects.get(input.projectId);
    const runtime = this.#sessions.get(this.#sessionKey(input.projectId, input.sessionId));
    const session = runtime?.session;
    if (
      project === undefined ||
      runtime === undefined ||
      runtime.projectId !== input.projectId ||
      runtime.sessionId !== input.sessionId ||
      session === undefined ||
      (session.disposed && !allowDisposed)
    ) {
      throw new NotebookRuntimeManagerError({
        reason: "session-not-found",
        message: "Notebook session was not found.",
      });
    }
    return { project, runtime, session };
  }

  async #runCached(
    session: SessionState,
    commandId: string,
    fingerprint: string,
    command: "open" | "interrupt" | "restart" | "dispose",
    run: () => Promise<ReadonlyArray<NotebookExecutionEvent>>,
  ): Promise<ReadonlyArray<NotebookExecutionEvent>> {
    const cached = session.commands.get(commandId);
    if (cached !== undefined) {
      this.#assertFingerprint(cached, fingerprint);
      const result = await cached.completion;
      if (result.error !== undefined) throw result.error;
      return result.events ?? [];
    }
    let complete!: (result: CommandResult) => void;
    const completion = new Promise<CommandResult>((resolvePromise) => {
      complete = resolvePromise;
    });
    const entry: CommandCacheEntry = {
      fingerprint,
      completion,
      retainedBytes: 0,
      completed: false,
    };
    this.#cacheCommand(session, commandId, entry);
    try {
      const events = await run();
      for (const event of events) this.#appendEvent(session, event);
      const result = { events } satisfies CommandResult;
      const state = this.#commandResultState(events, commandId, command);
      if (state === "incomplete") {
        throw new NotebookRuntimeManagerError({
          reason: "runtime-unavailable",
          message: "Notebook command ended before a terminal event.",
        });
      }
      if (state === "accepted-terminal") {
        this.#settleCommandCache(session, entry, result);
      } else {
        this.#evictCommandCache(session, commandId, entry);
      }
      complete(result);
      return events;
    } catch (error) {
      const result = { error } satisfies CommandResult;
      this.#evictCommandCache(session, commandId, entry);
      complete(result);
      throw error;
    }
  }

  async *#replay(entry: CommandCacheEntry): AsyncIterable<NotebookExecutionEvent> {
    const result = await entry.completion;
    if (result.error !== undefined) throw result.error;
    for (const event of result.events ?? []) yield event;
  }

  #cacheCommand(session: SessionState, commandId: string, entry: CommandCacheEntry): void {
    session.commands.set(commandId, entry);
    session.commandOrder.push(commandId);
    this.#trimCommandCache(session);
  }

  #settleCommandCache(
    session: SessionState,
    entry: CommandCacheEntry,
    result: CommandResult,
  ): void {
    entry.completed = true;
    entry.retainedBytes = (result.events ?? []).reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
      0,
    );
    session.commandCacheBytes += entry.retainedBytes;
    this.#trimCommandCache(session);
  }

  #evictCommandCache(session: SessionState, commandId: string, entry: CommandCacheEntry): void {
    if (session.commands.get(commandId) !== entry) return;
    session.commandCacheBytes -= entry.retainedBytes;
    session.commands.delete(commandId);
    const orderIndex = session.commandOrder.indexOf(commandId);
    if (orderIndex >= 0) session.commandOrder.splice(orderIndex, 1);
  }

  #trimCommandCache(session: SessionState): void {
    while (
      session.commandOrder.length > this.#commandCacheLimit ||
      session.commandCacheBytes > this.#commandCacheLimitBytes
    ) {
      const removableIndex = session.commandOrder.findIndex(
        (commandId) => session.commands.get(commandId)?.completed === true,
      );
      if (removableIndex < 0) return;
      const [commandId] = session.commandOrder.splice(removableIndex, 1);
      if (commandId === undefined) return;
      const entry = session.commands.get(commandId);
      if (entry === undefined) continue;
      session.commandCacheBytes -= entry.retainedBytes;
      session.commands.delete(commandId);
    }
  }

  #appendEvent(session: SessionState, event: NotebookExecutionEvent, allowReplay = false): boolean {
    if (event.sessionId !== session.sessionId) {
      throw new NotebookRuntimeManagerError({
        reason: "invalid-sequence",
        message: "Notebook runtime emitted an invalid event sequence.",
      });
    }
    if (event.sequence <= session.lastSequence) {
      if (allowReplay) {
        const retained = session.events.find((candidate) => candidate.sequence === event.sequence);
        if (retained === undefined || JSON.stringify(retained) === JSON.stringify(event)) {
          return false;
        }
      }
      throw new NotebookRuntimeManagerError({
        reason: "invalid-sequence",
        message: "Notebook runtime emitted an invalid event sequence.",
      });
    }
    const pendingAtSequence = session.pendingEvents.get(event.sequence);
    if (pendingAtSequence !== undefined) {
      if (allowReplay && JSON.stringify(pendingAtSequence.event) === JSON.stringify(event)) {
        return false;
      }
      throw new NotebookRuntimeManagerError({
        reason: "invalid-sequence",
        message: "Notebook runtime emitted an invalid event sequence.",
      });
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    session.pendingEvents.set(event.sequence, { event, bytes });
    session.pendingEventBytes += bytes;
    this.#flushPendingEvents(session);
    if (session.pendingEventBytes > this.#eventHistoryLimitBytes) {
      const pending = session.pendingEvents.get(event.sequence);
      if (pending !== undefined) {
        session.pendingEvents.delete(event.sequence);
        session.pendingEventBytes -= pending.bytes;
      }
      throw new NotebookRuntimeManagerError({
        reason: "invalid-sequence",
        message: "Notebook runtime pending events exceeded the retention limit.",
      });
    }
    return true;
  }

  #applyReplayBaseline(session: SessionState, replay: NotebookExecutionReplay): void {
    if (replay.events.some((event) => event.sequence <= replay.baselineSequence)) {
      throw new NotebookRuntimeManagerError({
        reason: "invalid-sequence",
        message: "Notebook runtime returned an invalid replay baseline.",
      });
    }
    if (replay.baselineSequence <= session.lastSequence) return;

    session.events.length = 0;
    session.eventSizes.length = 0;
    session.eventHistoryBytes = 0;
    for (const [sequence, pending] of session.pendingEvents) {
      if (sequence > replay.baselineSequence) continue;
      session.pendingEvents.delete(sequence);
      session.pendingEventBytes -= pending.bytes;
    }
    session.lastSequence = replay.baselineSequence;
    this.#flushPendingEvents(session);
  }

  #flushPendingEvents(session: SessionState): void {
    while (true) {
      const next = session.pendingEvents.get(session.lastSequence + 1);
      if (next === undefined) break;
      session.pendingEvents.delete(next.event.sequence);
      session.pendingEventBytes -= next.bytes;
      session.lastSequence = next.event.sequence;
      session.events.push(next.event);
      session.eventSizes.push(next.bytes);
      session.eventHistoryBytes += next.bytes;
      while (
        session.events.length > this.#eventHistoryLimit ||
        session.eventHistoryBytes > this.#eventHistoryLimitBytes
      ) {
        session.events.shift();
        session.eventHistoryBytes -= session.eventSizes.shift() ?? 0;
      }
    }
  }

  #commandResultState(
    events: ReadonlyArray<NotebookExecutionEvent>,
    commandId: string,
    command: "open" | "execute" | "interrupt" | "restart" | "dispose",
  ): "accepted-terminal" | "rejected" | "incomplete" {
    const commandEvents = events.filter((event) => event.commandId === commandId);
    if (commandEvents.some((event) => event.type === "rejected")) return "rejected";
    const accepted = commandEvents.some(
      (event) => event.type === "accepted" && event.commandType === command,
    );
    if (!accepted) return "incomplete";
    const terminal = commandEvents.some((event) => {
      if (event.type !== "kernel") return false;
      switch (command) {
        case "open":
        case "restart":
          return event.state === "idle";
        case "execute":
          return event.state === "idle" || event.state === "terminated";
        case "interrupt":
          return event.state === "interrupted";
        case "dispose":
          return event.state === "terminated";
      }
    });
    return terminal ? "accepted-terminal" : "incomplete";
  }

  #assertFingerprint(entry: { readonly fingerprint: string }, fingerprint: string): void {
    if (entry.fingerprint !== fingerprint) {
      throw new NotebookRuntimeManagerError({
        reason: "command-id-conflict",
        message: "Notebook command ID was reused with a different payload.",
      });
    }
  }

  #fingerprint(command: string, input: unknown): string {
    return NodeCrypto.createHash("sha256").update(JSON.stringify({ command, input })).digest("hex");
  }

  async #startSessionDisposal(
    sessionKey: string,
    runtime: SessionRuntime,
    fingerprint: string,
    run: () => Promise<ReadonlyArray<NotebookExecutionEvent>>,
  ): Promise<ReadonlyArray<NotebookExecutionEvent>> {
    const activeDisposal = this.#sessionDisposals.get(sessionKey);
    if (activeDisposal !== undefined) {
      if (activeDisposal.containerId !== runtime.containerId) {
        throw new NotebookRuntimeManagerError({
          reason: "runtime-unavailable",
          message: "A different notebook session generation is being disposed.",
        });
      }
      this.#assertFingerprint(activeDisposal, fingerprint);
      return activeDisposal.promise;
    }
    const promise = Promise.resolve().then(run);
    this.#sessionDisposals.set(sessionKey, {
      projectId: runtime.projectId,
      containerId: runtime.containerId,
      fingerprint,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (this.#sessionDisposals.get(sessionKey)?.promise === promise) {
        this.#sessionDisposals.delete(sessionKey);
      }
    }
  }

  #disposeTombstoneKey(sessionKey: string, commandId: string): string {
    return JSON.stringify([sessionKey, commandId]);
  }

  #getDisposeTombstone(sessionKey: string, commandId: string): DisposeTombstone | undefined {
    this.#pruneDisposeTombstones();
    return this.#disposeTombstones.get(this.#disposeTombstoneKey(sessionKey, commandId));
  }

  #cacheDisposeTombstone(
    sessionKey: string,
    commandId: string,
    fingerprint: string,
    containerId: string,
    events: ReadonlyArray<NotebookExecutionEvent>,
  ): void {
    this.#pruneDisposeTombstones();
    const key = this.#disposeTombstoneKey(sessionKey, commandId);
    this.#deleteDisposeTombstone(key);
    const retainedEvents = [...events];
    const retainedBytes = Buffer.byteLength(
      JSON.stringify({ key, fingerprint, containerId, events: retainedEvents }),
    );
    this.#disposeTombstones.set(key, {
      fingerprint,
      containerId,
      events: retainedEvents,
      expiresAt: this.#now() + this.#disposeTombstoneTtlMs,
      retainedBytes,
    });
    this.#disposeTombstoneBytes += retainedBytes;
    while (
      this.#disposeTombstones.size > this.#disposeTombstoneLimit ||
      this.#disposeTombstoneBytes > this.#disposeTombstoneLimitBytes
    ) {
      const oldestKey = this.#disposeTombstones.keys().next().value;
      if (oldestKey === undefined) break;
      this.#deleteDisposeTombstone(oldestKey);
    }
  }

  #pruneDisposeTombstones(): void {
    const now = this.#now();
    for (const [key, tombstone] of this.#disposeTombstones) {
      if (tombstone.expiresAt <= now) this.#deleteDisposeTombstone(key);
    }
  }

  #deleteDisposeTombstone(key: string): void {
    const tombstone = this.#disposeTombstones.get(key);
    if (tombstone === undefined) return;
    this.#disposeTombstoneBytes -= tombstone.retainedBytes;
    this.#disposeTombstones.delete(key);
  }

  #selectProject(projectId: string, bookPaths: ReadonlyArray<string>): ProjectState {
    const requestedBooks = this.#normalizeBooks(bookPaths);
    const existing = this.#projects.get(projectId);
    if (existing !== undefined) {
      if (requestedBooks.some((book) => !existing.books.includes(book))) {
        throw new NotebookRuntimeManagerError({
          reason: "invalid-mount",
          message: "Books must be selected before the project runtime starts.",
        });
      }
      return existing;
    }
    const project: ProjectState = {
      projectId,
      books: requestedBooks,
      sessionKeys: new Set(),
      lastUsedAt: this.#now(),
    };
    this.#projects.set(projectId, project);
    return project;
  }

  #sessionKey(projectId: string, sessionId: string): string {
    return NodeCrypto.createHash("sha256")
      .update(JSON.stringify({ projectId, sessionId }))
      .digest("hex");
  }

  #assertAdmissionAvailable(projectId: string, sessionKey: string): void {
    const admittedSessionKeys = new Set([
      ...this.#containers.keys(),
      ...this.#sessionStarts.keys(),
    ]);
    if (admittedSessionKeys.has(sessionKey)) return;
    const projectSessionKeys = new Set<string>();
    for (const [key, container] of this.#containers) {
      if (container.projectId === projectId) projectSessionKeys.add(key);
    }
    for (const [key, start] of this.#sessionStarts) {
      if (start.projectId === projectId) projectSessionKeys.add(key);
    }
    if (projectSessionKeys.size >= this.#maxSessionsPerProject) {
      throw new NotebookRuntimeManagerError({
        reason: "runtime-unavailable",
        message: "Notebook project reached its active session limit.",
      });
    }
    if (admittedSessionKeys.size >= this.#maxSessionsGlobal) {
      throw new NotebookRuntimeManagerError({
        reason: "runtime-unavailable",
        message: "Notebook runtime reached its global active session limit.",
      });
    }
  }

  async #ensureSession(project: ProjectState, sessionId: string): Promise<SessionRuntime> {
    this.#assertCanStart();
    const sessionKey = this.#sessionKey(project.projectId, sessionId);
    const existing = this.#sessions.get(sessionKey);
    if (existing !== undefined) return existing;
    const starting = this.#sessionStarts.get(sessionKey);
    if (starting !== undefined) return starting.promise;
    this.#assertAdmissionAvailable(project.projectId, sessionKey);
    const promise = Promise.resolve().then(async () => {
      const orphaned = this.#containers.get(sessionKey);
      if (orphaned !== undefined) {
        await this.#removeContainer(orphaned);
        this.#assertCanStart();
        const racedSession = this.#sessions.get(sessionKey);
        if (racedSession !== undefined) return racedSession;
      }
      return this.#startSession(project, sessionId, sessionKey);
    });
    this.#sessionStarts.set(sessionKey, { projectId: project.projectId, promise });
    try {
      return await promise;
    } finally {
      const current = this.#sessionStarts.get(sessionKey);
      if (current?.promise === promise) this.#sessionStarts.delete(sessionKey);
    }
  }

  async #startSession(
    project: ProjectState,
    sessionId: string,
    sessionKey: string,
  ): Promise<SessionRuntime> {
    const projectId = project.projectId;
    const projectHash = NodeCrypto.createHash("sha256")
      .update(projectId)
      .digest("hex")
      .slice(0, 16);
    const sessionHash = NodeCrypto.createHash("sha256")
      .update(sessionKey)
      .digest("hex")
      .slice(0, 16);
    const controlDirectory = NodePath.join(this.#runtimeRoot, `${projectHash}-${sessionHash}`);
    const containerName = `lightfast-notebook-${projectHash}-${sessionHash}-${NodeCrypto.randomBytes(4).toString("hex")}`;
    await NodeFSP.mkdir(controlDirectory, { mode: 0o700, recursive: true });
    const args = [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--label",
      `lightfast.notebook.project=${projectHash}`,
      "--label",
      `lightfast.notebook.session=${sessionHash}`,
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--read-only",
      "--pids-limit",
      "64",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--stop-timeout",
      "5",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=64m,uid=10001,gid=10001,mode=0700",
      "--tmpfs",
      "/workspace:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700",
      "--env",
      "NOTEBOOK_OUTPUT_LIMIT_BYTES=10485760",
      "--env",
      `NOTEBOOK_EXECUTION_TIMEOUT_SECONDS=${this.#executionTimeoutSeconds}`,
      "--env",
      `NOTEBOOK_TIMEOUT_IDLE_GRACE_SECONDS=${this.#timeoutIdleGraceSeconds}`,
    ];
    for (const [index, book] of project.books.entries()) {
      args.push("--mount", `type=bind,src=${book},dst=/books/book-${index},readonly`);
    }
    args.push(this.#image);

    let ownedContainer: OwnedSessionContainer | undefined;
    try {
      const launched = await this.#docker.run(args);
      const containerId = launched.stdout.trim().split(/\s/)[0] || containerName;
      ownedContainer = {
        sessionKey,
        projectId,
        sessionId,
        containerId,
        controlDirectory,
      };
      this.#containers.set(sessionKey, ownedContainer);
      const bootstrapped = await this.#docker.run([
        "exec",
        "--user",
        "10002:10002",
        containerId,
        "python",
        "-m",
        "runtime",
        "bootstrap",
      ]);
      const token = bootstrapped.stdout.trim();
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
        throw new NotebookRuntimeManagerError({
          reason: "runtime-unavailable",
          message: "Notebook runtime bootstrap returned invalid credentials.",
        });
      }
      const client = this.#clientFactory({ containerId, token });
      await this.#waitUntilReady(client);
      this.#assertCanStart();
      if (this.#projects.get(projectId) !== project) {
        throw new NotebookRuntimeManagerError({
          reason: "runtime-unavailable",
          message: "Notebook project runtime was removed during startup.",
        });
      }
      const session: SessionState = {
        sessionId,
        events: [],
        commands: new Map(),
        commandOrder: [],
        eventSizes: [],
        pendingEvents: new Map(),
        eventHistoryBytes: 0,
        commandCacheBytes: 0,
        pendingEventBytes: 0,
        lastSequence: 0,
        disposed: false,
      };
      const runtime: SessionRuntime = {
        sessionKey,
        projectId,
        sessionId,
        containerId,
        controlDirectory,
        client,
        session,
        opened: false,
      };
      this.#sessions.set(sessionKey, runtime);
      project.sessionKeys.add(sessionKey);
      return runtime;
    } catch (error) {
      if (ownedContainer !== undefined) {
        await this.#removeContainer(ownedContainer).catch(() => undefined);
      } else {
        await NodeFSP.rm(controlDirectory, { force: true, recursive: true });
      }
      throw error;
    }
  }

  async #waitUntilReady(client: NotebookRuntimeClientLike): Promise<void> {
    const deadline = this.#now() + this.#readinessTimeoutMs;
    let lastError: unknown;
    do {
      try {
        await client.health();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    } while (this.#now() < deadline);
    throw new NotebookRuntimeManagerError({
      reason: "runtime-unavailable",
      message:
        lastError === undefined
          ? "Notebook runtime did not start."
          : "Notebook runtime was not ready.",
    });
  }

  #normalizeBooks(bookPaths: ReadonlyArray<string>): ReadonlyArray<string> {
    return bookPaths.map((bookPath) => {
      if (!NodePath.isAbsolute(bookPath) || /[,\n\r]/.test(bookPath)) {
        throw new NotebookRuntimeManagerError({
          reason: "invalid-mount",
          message: "Notebook book mount path is invalid.",
        });
      }
      return NodePath.resolve(bookPath);
    });
  }

  #assertCanStart(): void {
    if (!this.#closing) return;
    throw new NotebookRuntimeManagerError({
      reason: "runtime-unavailable",
      message: "Notebook runtime manager is closing.",
    });
  }

  #assertCanDispose(projectId: string): void {
    if (this.#closing) {
      throw new NotebookRuntimeManagerError({
        reason: "runtime-unavailable",
        message: "Notebook runtime manager is closing.",
      });
    }
    if (this.#projectRemovals.has(projectId)) {
      throw new NotebookRuntimeManagerError({
        reason: "runtime-unavailable",
        message: "Notebook project runtime is being removed.",
      });
    }
  }

  async #removeProject(project: ProjectState): Promise<void> {
    if (this.#projects.get(project.projectId) !== project) return;
    const activeRemoval = this.#projectRemovals.get(project.projectId);
    if (activeRemoval !== undefined) return activeRemoval;
    const removal = Promise.resolve().then(() => this.#removeProjectOnce(project));
    this.#projectRemovals.set(project.projectId, removal);
    try {
      await removal;
    } finally {
      if (this.#projectRemovals.get(project.projectId) === removal) {
        this.#projectRemovals.delete(project.projectId);
      }
    }
  }

  async #removeProjectOnce(project: ProjectState): Promise<void> {
    const disposals = [...this.#sessionDisposals.values()]
      .filter((disposal) => disposal.projectId === project.projectId)
      .map((disposal) => disposal.promise);
    await Promise.allSettled(disposals);
    const starts = [...this.#sessionStarts.values()]
      .filter((start) => start.projectId === project.projectId)
      .map((start) => start.promise);
    await Promise.allSettled(starts);
    const containers = [...this.#containers.values()].filter(
      (container) => container.projectId === project.projectId,
    );
    await this.#removeContainers(containers);
    if (
      this.#projects.get(project.projectId) === project &&
      ![...this.#containers.values()].some((container) => container.projectId === project.projectId)
    ) {
      this.#projects.delete(project.projectId);
    }
  }

  async #removeContainers(containers: ReadonlyArray<OwnedSessionContainer>): Promise<void> {
    const results = await Promise.allSettled(
      containers.map((container) => this.#removeContainer(container)),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }

  async #removeContainer(container: OwnedSessionContainer): Promise<void> {
    const ownedContainer = this.#containers.get(container.sessionKey);
    if (ownedContainer === undefined || ownedContainer.containerId !== container.containerId)
      return;
    const activeRemoval = this.#sessionRemovals.get(container.sessionKey);
    if (activeRemoval !== undefined) return activeRemoval;
    const removal = this.#removeContainerOnce(container);
    this.#sessionRemovals.set(container.sessionKey, removal);
    try {
      await removal;
    } finally {
      if (this.#sessionRemovals.get(container.sessionKey) === removal) {
        this.#sessionRemovals.delete(container.sessionKey);
      }
    }
  }

  async #removeContainerOnce(container: OwnedSessionContainer): Promise<void> {
    await this.#docker.run(["rm", "--force", container.containerId]);
    const runtime = this.#sessions.get(container.sessionKey);
    if (runtime?.containerId === container.containerId) {
      this.#sessions.delete(container.sessionKey);
      this.#projects.get(container.projectId)?.sessionKeys.delete(container.sessionKey);
    }
    const ownedContainer = this.#containers.get(container.sessionKey);
    if (ownedContainer?.containerId === container.containerId) {
      this.#containers.delete(container.sessionKey);
    }
    await NodeFSP.rm(container.controlDirectory, { force: true, recursive: true }).catch(
      () => undefined,
    );
  }
}

export class NotebookRuntimeManagerService extends Context.Service<
  NotebookRuntimeManagerService,
  NotebookRuntimeManager
>()("t3/notebook/NotebookRuntimeManager/NotebookRuntimeManagerService") {}

export const layer = Layer.effect(
  NotebookRuntimeManagerService,
  Effect.acquireRelease(
    Effect.sync(() => {
      const manager = new NotebookRuntimeManager({
        image:
          NodeProcess.env.LIGHTFAST_NOTEBOOK_RUNTIME_IMAGE ?? "lightfast/notebook-runtime:0.1.0",
      });
      const stopReaper = manager.startIdleReaper();
      return { manager, stopReaper };
    }),
    ({ manager, stopReaper }) =>
      Effect.promise(async () => {
        stopReaper();
        await manager.close();
      }),
  ).pipe(Effect.map(({ manager }) => manager)),
);
