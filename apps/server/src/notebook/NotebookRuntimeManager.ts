// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Docker and UDS lifecycle is a Node boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import type { NotebookExecutionEvent } from "@t3tools/contracts";
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

interface OwnedProjectContainer {
  readonly projectId: string;
  readonly containerId: string;
  readonly controlDirectory: string;
}

interface ProjectRuntime extends OwnedProjectContainer {
  readonly client: NotebookRuntimeClientLike;
  readonly books: ReadonlyArray<string>;
  readonly sessions: Map<string, SessionState>;
  lastUsedAt: number;
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
  readonly #projects = new Map<string, ProjectRuntime>();
  readonly #containers = new Map<string, OwnedProjectContainer>();
  readonly #projectStarts = new Map<string, Promise<ProjectRuntime>>();
  readonly #projectRemovals = new Map<string, Promise<void>>();
  #closing = false;

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
    if (this.#executionTimeoutSeconds <= 0 || this.#timeoutIdleGraceSeconds <= 0) {
      throw new Error("Notebook runtime timeout settings must be positive.");
    }
  }

  async open(
    input: NotebookManagerSessionOpenInput,
  ): Promise<ReadonlyArray<NotebookExecutionEvent>> {
    const project = await this.#ensureProject(input.projectId, input.bookPaths ?? []);
    project.lastUsedAt = this.#now();
    const existing = project.sessions.get(input.sessionId);
    if (existing !== undefined) {
      if (existing.disposed) {
        throw new NotebookRuntimeManagerError({
          reason: "session-not-found",
          message: "Notebook session has already been disposed.",
        });
      }
      return this.#runCached(
        existing,
        input.commandId,
        this.#fingerprint("open", input),
        "open",
        () => project.client.open(input),
      );
    }
    const session: SessionState = {
      sessionId: input.sessionId,
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
    project.sessions.set(input.sessionId, session);
    try {
      const events = await this.#runCached(
        session,
        input.commandId,
        this.#fingerprint("open", input),
        "open",
        () => project.client.open(input),
      );
      if (this.#commandResultState(events, input.commandId, "open") !== "accepted-terminal") {
        project.sessions.delete(input.sessionId);
      }
      return events;
    } catch (error) {
      project.sessions.delete(input.sessionId);
      throw error;
    }
  }

  execute(input: NotebookManagerExecuteInput): AsyncIterable<NotebookExecutionEvent> {
    const { project, session } = this.#getSession(input);
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
        for await (const event of project.client.execute(input)) {
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
            const resumed = await project.client.eventsAfter(input.sessionId, session.lastSequence);
            for (const event of resumed) recordEvent(event, true);
          } catch (error) {
            failure = error;
          }
          events = [...eventsBySequence.values()].toSorted(
            (left, right) => left.sequence - right.sequence,
          );
          state = this.#commandResultState(events, input.commandId, "execute");
          if (state === "incomplete") {
            for await (const event of project.client.execute(input)) recordEvent(event, true);
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
    const { project, session } = this.#getSession(input, true);
    project.lastUsedAt = this.#now();
    const events = await this.#runCached(
      session,
      input.commandId,
      this.#fingerprint("dispose", input),
      "dispose",
      () => project.client.dispose(input),
    );
    if (this.#commandResultState(events, input.commandId, "dispose") === "accepted-terminal") {
      session.disposed = true;
    }
    return events;
  }

  eventsAfter(
    projectId: string,
    sessionId: string,
    afterSequence: number,
  ): ReadonlyArray<NotebookExecutionEvent> {
    const { session } = this.#getSession({ projectId, sessionId });
    return session.events.filter((event) => event.sequence > afterSequence);
  }

  async reapIdle(): Promise<void> {
    const cutoff = this.#now() - this.#idleTimeoutMs;
    const idle = [...this.#projects.values()].filter((project) => project.lastUsedAt <= cutoff);
    await Promise.all(idle.map((project) => this.#removeProject(project)));
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled(this.#projectStarts.values());
    await Promise.all(
      [...this.#containers.values()].map((container) => this.#removeContainer(container)),
    );
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
    const { project, session } = this.#getSession(input);
    project.lastUsedAt = this.#now();
    return this.#runCached(
      session,
      input.commandId,
      this.#fingerprint(command, input),
      command,
      () =>
        command === "interrupt" ? project.client.interrupt(input) : project.client.restart(input),
    );
  }

  #getSession(
    input: { readonly projectId: string; readonly sessionId: string },
    allowDisposed = false,
  ): { readonly project: ProjectRuntime; readonly session: SessionState } {
    const project = this.#projects.get(input.projectId);
    const session = project?.sessions.get(input.sessionId);
    if (project === undefined || session === undefined || (session.disposed && !allowDisposed)) {
      throw new NotebookRuntimeManagerError({
        reason: "session-not-found",
        message: "Notebook session was not found.",
      });
    }
    return { project, session };
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

  #assertFingerprint(entry: CommandCacheEntry, fingerprint: string): void {
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

  async #ensureProject(
    projectId: string,
    bookPaths: ReadonlyArray<string>,
  ): Promise<ProjectRuntime> {
    this.#assertCanStart();
    const existing = this.#projects.get(projectId);
    if (existing !== undefined) {
      const requestedBooks = this.#normalizeBooks(bookPaths);
      if (requestedBooks.some((book) => !existing.books.includes(book))) {
        throw new NotebookRuntimeManagerError({
          reason: "invalid-mount",
          message: "Books must be selected before the project runtime starts.",
        });
      }
      return existing;
    }
    const starting = this.#projectStarts.get(projectId);
    if (starting !== undefined) return starting;
    const orphaned = this.#containers.get(projectId);
    if (orphaned !== undefined) {
      await this.#removeContainer(orphaned);
      this.#assertCanStart();
      const racedProject = this.#projects.get(projectId);
      if (racedProject !== undefined) return racedProject;
      const racedStart = this.#projectStarts.get(projectId);
      if (racedStart !== undefined) return racedStart;
    }
    const promise = this.#startProject(projectId, bookPaths);
    this.#projectStarts.set(projectId, promise);
    try {
      return await promise;
    } finally {
      this.#projectStarts.delete(projectId);
    }
  }

  async #startProject(
    projectId: string,
    bookPaths: ReadonlyArray<string>,
  ): Promise<ProjectRuntime> {
    const projectHash = NodeCrypto.createHash("sha256")
      .update(projectId)
      .digest("hex")
      .slice(0, 16);
    const controlDirectory = NodePath.join(this.#runtimeRoot, projectHash);
    const containerName = `lightfast-notebook-${projectHash}-${NodeCrypto.randomBytes(4).toString("hex")}`;
    const books = this.#normalizeBooks(bookPaths);
    await NodeFSP.mkdir(controlDirectory, { mode: 0o700, recursive: true });
    const args = [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--label",
      `lightfast.notebook.project=${projectHash}`,
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
    for (const [index, book] of books.entries()) {
      args.push("--mount", `type=bind,src=${book},dst=/books/book-${index},readonly`);
    }
    args.push(this.#image);

    let ownedContainer: OwnedProjectContainer | undefined;
    try {
      const launched = await this.#docker.run(args);
      const containerId = launched.stdout.trim().split(/\s/)[0] || containerName;
      ownedContainer = { projectId, containerId, controlDirectory };
      this.#containers.set(projectId, ownedContainer);
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
      const project: ProjectRuntime = {
        projectId,
        containerId,
        controlDirectory,
        client,
        books,
        sessions: new Map(),
        lastUsedAt: this.#now(),
      };
      this.#projects.set(projectId, project);
      return project;
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

  async #removeProject(project: ProjectRuntime): Promise<void> {
    if (this.#projects.get(project.projectId) !== project) return;
    const ownedContainer = this.#containers.get(project.projectId);
    if (ownedContainer === undefined || ownedContainer.containerId !== project.containerId) return;
    return this.#removeContainer(ownedContainer);
  }

  async #removeContainer(container: OwnedProjectContainer): Promise<void> {
    const ownedContainer = this.#containers.get(container.projectId);
    if (ownedContainer === undefined || ownedContainer.containerId !== container.containerId)
      return;
    const activeRemoval = this.#projectRemovals.get(container.projectId);
    if (activeRemoval !== undefined) return activeRemoval;
    const removal = this.#removeContainerOnce(container);
    this.#projectRemovals.set(container.projectId, removal);
    try {
      await removal;
    } finally {
      if (this.#projectRemovals.get(container.projectId) === removal) {
        this.#projectRemovals.delete(container.projectId);
      }
    }
  }

  async #removeContainerOnce(container: OwnedProjectContainer): Promise<void> {
    await this.#docker.run(["rm", "--force", container.containerId]);
    const project = this.#projects.get(container.projectId);
    if (project?.containerId === container.containerId) {
      this.#projects.delete(container.projectId);
    }
    const ownedContainer = this.#containers.get(container.projectId);
    if (ownedContainer?.containerId === container.containerId) {
      this.#containers.delete(container.projectId);
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
