// @effect-diagnostics nodeBuiltinImport:off - The manager contract owns host temp paths.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { NotebookExecutionEvent, NotebookExecutionReplay } from "@t3tools/contracts";
import { afterEach, expect, it } from "vite-plus/test";

import type {
  NotebookRuntimeClientLike,
  RuntimeExecuteRequest,
  RuntimeSessionCommandRequest,
  RuntimeSessionOpenRequest,
} from "./NotebookRuntimeClient.ts";
import { NotebookRuntimeClientError } from "./NotebookRuntimeClient.ts";
import {
  type DockerCommandRunner,
  type NotebookManagerControlInput,
  NotebookRuntimeManager,
  NotebookRuntimeManagerError,
} from "./NotebookRuntimeManager.ts";

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => NodeFSP.rm(path, { force: true, recursive: true })),
  );
});

class FakeDocker implements DockerCommandRunner {
  readonly calls: Array<{ args: readonly string[]; env?: Readonly<Record<string, string>> }> = [];
  readonly activeContainers = new Set<string>();
  readonly removeStarted: Promise<void>;
  readonly #markRemoveStarted: () => void;
  readonly #removalsReleased: Promise<void>;
  readonly releaseRemovals: () => void;
  holdRemovals = false;
  exitNextContainerBeforeBootstrap = false;
  failMissingContainerRemovals = false;
  missingContainerReplacement: string | undefined;
  removeFailures = 0;
  runCount = 0;
  imageDigests: string[] = [];

  constructor() {
    let markRemoveStarted!: () => void;
    let releaseRemovals!: () => void;
    this.removeStarted = new Promise((resolve) => {
      markRemoveStarted = resolve;
    });
    this.#removalsReleased = new Promise((resolve) => {
      releaseRemovals = resolve;
    });
    this.#markRemoveStarted = markRemoveStarted;
    this.releaseRemovals = releaseRemovals;
  }

  async run(
    args: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ): Promise<{ readonly stdout: string }> {
    this.calls.push({
      args: [...args],
      ...(options?.env === undefined ? {} : { env: options.env }),
    });
    if (args[0] === "rm" && this.removeFailures > 0) {
      this.removeFailures -= 1;
      throw new Error("injected remove failure");
    }
    if (args[0] === "rm") {
      const containerId = args.at(-1);
      if (
        containerId !== undefined &&
        this.failMissingContainerRemovals &&
        !this.activeContainers.has(containerId)
      ) {
        if (this.missingContainerReplacement !== undefined) {
          this.activeContainers.add(this.missingContainerReplacement);
        }
        throw new NotebookRuntimeManagerError({
          reason: "docker-failed",
          message: `Docker command failed: Error response from daemon: No such container: ${containerId}`,
        });
      }
      if (containerId !== undefined) this.activeContainers.delete(containerId);
    }
    if (args[0] === "rm" && this.holdRemovals) {
      this.#markRemoveStarted();
      await this.#removalsReleased;
    }
    if (args[0] === "run") {
      this.runCount += 1;
      const containerId = `container-id-${this.runCount}`;
      this.activeContainers.add(containerId);
      return { stdout: `${containerId}\n` };
    }
    if (args[0] === "exec" && this.exitNextContainerBeforeBootstrap) {
      this.exitNextContainerBeforeBootstrap = false;
      const containerId = args[3];
      if (containerId !== undefined) this.activeContainers.delete(containerId);
      throw new NotebookRuntimeManagerError({
        reason: "docker-failed",
        message: `Docker command failed: Error response from daemon: No such container: ${containerId ?? "unknown"}`,
      });
    }
    if (args[0] === "image") {
      return { stdout: `${this.imageDigests.shift() ?? `sha256:${"a".repeat(64)}`}\n` };
    }
    return {
      stdout: args[0] === "exec" ? "fake-bootstrap-token-with-sufficient-entropy\n" : "",
    };
  }
}

class FakeRuntimeClient implements NotebookRuntimeClientLike {
  disposeCount = 0;
  executeCount = 0;
  healthCount = 0;
  interruptCount = 0;
  interruptFailures = 0;
  restartCount = 0;
  readonly openedSessionIds: string[] = [];
  nextSequence = new Map<string, number>();

  async health(): Promise<void> {
    this.healthCount += 1;
  }

  async open(input: RuntimeSessionOpenRequest): Promise<readonly NotebookExecutionEvent[]> {
    this.openedSessionIds.push(input.sessionId);
    const events = [
      event(input.sessionId, input.commandId, 1, "accepted", { commandType: "open" }),
      event(input.sessionId, input.commandId, 2, "kernel", { state: "starting" }),
      event(input.sessionId, input.commandId, 3, "kernel", { state: "idle" }),
    ];
    this.nextSequence.set(input.sessionId, 4);
    return events;
  }

  async *execute(input: RuntimeExecuteRequest): AsyncIterable<NotebookExecutionEvent> {
    this.executeCount += 1;
    const sequence = this.nextSequence.get(input.sessionId) ?? 1;
    const events = [
      event(input.sessionId, input.commandId, sequence, "accepted", {
        executionId: input.executionId,
        cellId: input.cellId,
        commandType: "execute",
      }),
      event(input.sessionId, input.commandId, sequence + 1, "stream", {
        executionId: input.executionId,
        name: "stdout",
        text: "ok\n",
      }),
      event(input.sessionId, input.commandId, sequence + 2, "kernel", {
        executionId: input.executionId,
        state: "idle",
      }),
    ];
    this.nextSequence.set(input.sessionId, sequence + 3);
    for (const item of events) yield item;
  }

  async interrupt(input: RuntimeSessionCommandRequest): Promise<readonly NotebookExecutionEvent[]> {
    this.interruptCount += 1;
    if (this.interruptFailures > 0) {
      this.interruptFailures -= 1;
      throw new NotebookRuntimeClientError({
        reason: "transport",
        message: "injected interrupt transport failure",
      });
    }
    return this.control(input, "interrupt", "interrupted");
  }

  async restart(input: RuntimeSessionCommandRequest): Promise<readonly NotebookExecutionEvent[]> {
    this.restartCount += 1;
    const restarted = this.control(input, "restart", "restarted");
    const sequence = this.nextSequence.get(input.sessionId) ?? 1;
    this.nextSequence.set(input.sessionId, sequence + 1);
    return [
      ...restarted,
      event(input.sessionId, input.commandId, sequence, "kernel", { state: "idle" }),
    ];
  }

  async dispose(input: RuntimeSessionCommandRequest): Promise<readonly NotebookExecutionEvent[]> {
    this.disposeCount += 1;
    return this.control(input, "dispose", "terminated");
  }

  async eventsAfter(_sessionId: string, afterSequence: number): Promise<NotebookExecutionReplay> {
    return { baselineSequence: afterSequence, events: [] };
  }

  private control(
    input: RuntimeSessionCommandRequest,
    commandType: "interrupt" | "restart" | "dispose",
    state: "interrupted" | "restarted" | "terminated",
  ): readonly NotebookExecutionEvent[] {
    const sequence = this.nextSequence.get(input.sessionId) ?? 1;
    this.nextSequence.set(input.sessionId, sequence + 2);
    return [
      event(input.sessionId, input.commandId, sequence, "accepted", { commandType }),
      event(input.sessionId, input.commandId, sequence + 1, "kernel", { state }),
    ];
  }
}

class FailingHealthRuntimeClient extends FakeRuntimeClient {
  override async health(): Promise<void> {
    this.healthCount += 1;
    throw new Error("injected readiness failure");
  }
}

class RejectedDisposeRuntimeClient extends FakeRuntimeClient {
  override async dispose(
    input: RuntimeSessionCommandRequest,
  ): Promise<readonly NotebookExecutionEvent[]> {
    this.disposeCount += 1;
    const sequence = this.nextSequence.get(input.sessionId) ?? 1;
    this.nextSequence.set(input.sessionId, sequence + 1);
    return [
      event(input.sessionId, input.commandId, sequence, "rejected", {
        reason: "dispose-rejected",
        message: "The runtime rejected disposal.",
      }),
    ];
  }
}

class IncompleteDisposeRuntimeClient extends FakeRuntimeClient {
  override async dispose(
    input: RuntimeSessionCommandRequest,
  ): Promise<readonly NotebookExecutionEvent[]> {
    this.disposeCount += 1;
    const sequence = this.nextSequence.get(input.sessionId) ?? 1;
    this.nextSequence.set(input.sessionId, sequence + 1);
    return [
      event(input.sessionId, input.commandId, sequence, "accepted", {
        commandType: "dispose",
      }),
    ];
  }
}

class DeferredHealthRuntimeClient extends FakeRuntimeClient {
  readonly healthStarted: Promise<void>;
  readonly #markHealthStarted: () => void;
  readonly #healthReleased: Promise<void>;
  readonly releaseHealth: () => void;

  constructor() {
    super();
    let markHealthStarted!: () => void;
    let releaseHealth!: () => void;
    this.healthStarted = new Promise((resolve) => {
      markHealthStarted = resolve;
    });
    this.#healthReleased = new Promise((resolve) => {
      releaseHealth = resolve;
    });
    this.#markHealthStarted = markHealthStarted;
    this.releaseHealth = releaseHealth;
  }

  override async health(): Promise<void> {
    this.healthCount += 1;
    this.#markHealthStarted();
    await this.#healthReleased;
  }
}

class DeferredDisposeRuntimeClient extends FakeRuntimeClient {
  readonly disposeStarted: Promise<void>;
  readonly #markDisposeStarted: () => void;
  readonly #disposeReleased: Promise<void>;
  readonly releaseDispose: () => void;
  disposeCallStarted = false;

  constructor() {
    super();
    let markDisposeStarted!: () => void;
    let releaseDispose!: () => void;
    this.disposeStarted = new Promise((resolve) => {
      markDisposeStarted = resolve;
    });
    this.#disposeReleased = new Promise((resolve) => {
      releaseDispose = resolve;
    });
    this.#markDisposeStarted = markDisposeStarted;
    this.releaseDispose = releaseDispose;
  }

  override async dispose(
    input: RuntimeSessionCommandRequest,
  ): Promise<readonly NotebookExecutionEvent[]> {
    this.disposeCallStarted = true;
    this.#markDisposeStarted();
    await this.#disposeReleased;
    return super.dispose(input);
  }
}

class QueuedCancellationRuntimeClient extends FakeRuntimeClient {
  readonly activeStarted: Promise<void>;
  readonly queuedStarted: Promise<void>;
  eventsAfterCount = 0;
  readonly #cancelled: Promise<void>;
  readonly #markActiveStarted: () => void;
  readonly #markQueuedStarted: () => void;
  readonly #markQueuedRejected: () => void;
  readonly #queuedRejected: Promise<void>;
  readonly #markActiveTerminated: () => void;
  readonly #activeTerminated: Promise<void>;
  readonly #cancel: () => void;

  constructor() {
    super();
    let markActiveStarted!: () => void;
    let markQueuedStarted!: () => void;
    let markQueuedRejected!: () => void;
    let markActiveTerminated!: () => void;
    let cancel!: () => void;
    this.activeStarted = new Promise((resolve) => {
      markActiveStarted = resolve;
    });
    this.queuedStarted = new Promise((resolve) => {
      markQueuedStarted = resolve;
    });
    this.#queuedRejected = new Promise((resolve) => {
      markQueuedRejected = resolve;
    });
    this.#activeTerminated = new Promise((resolve) => {
      markActiveTerminated = resolve;
    });
    this.#cancelled = new Promise((resolve) => {
      cancel = resolve;
    });
    this.#markActiveStarted = markActiveStarted;
    this.#markQueuedStarted = markQueuedStarted;
    this.#markQueuedRejected = markQueuedRejected;
    this.#markActiveTerminated = markActiveTerminated;
    this.#cancel = cancel;
  }

  override async *execute(input: RuntimeExecuteRequest): AsyncIterable<NotebookExecutionEvent> {
    this.executeCount += 1;
    if (input.cellId === "cell-a") {
      yield this.executionEvent(input, "accepted", { commandType: "execute" });
      yield this.executionEvent(input, "kernel", { state: "busy" });
      this.#markActiveStarted();
      await this.#cancelled;
      await this.#queuedRejected;
      yield this.executionEvent(input, "kernel", { state: "terminated" });
      this.#markActiveTerminated();
      return;
    }

    this.#markQueuedStarted();
    await this.#cancelled;
    yield this.executionEvent(input, "rejected", {
      reason: "execution-cancelled",
      message: "Execution was cancelled before it started.",
    });
    this.#markQueuedRejected();
  }

  override async dispose(
    input: RuntimeSessionCommandRequest,
  ): Promise<readonly NotebookExecutionEvent[]> {
    this.disposeCount += 1;
    this.#cancel();
    await this.#activeTerminated;
    const sequence = this.takeSequence(input.sessionId);
    return [
      event(input.sessionId, input.commandId, sequence, "accepted", { commandType: "dispose" }),
      event(input.sessionId, input.commandId, sequence + 1, "kernel", { state: "terminated" }),
    ];
  }

  override async eventsAfter(
    _sessionId: string,
    afterSequence: number,
  ): Promise<NotebookExecutionReplay> {
    this.eventsAfterCount += 1;
    return { baselineSequence: afterSequence, events: [] };
  }

  private executionEvent(
    input: RuntimeExecuteRequest,
    type: NotebookExecutionEvent["type"],
    fields: Record<string, unknown>,
  ): NotebookExecutionEvent {
    return event(input.sessionId, input.commandId, this.takeSequence(input.sessionId), type, {
      executionId: input.executionId,
      cellId: input.cellId,
      ...fields,
    });
  }

  private takeSequence(sessionId: string): number {
    const sequence = this.nextSequence.get(sessionId) ?? 1;
    this.nextSequence.set(sessionId, sequence + 1);
    return sequence;
  }
}

class PartialFailureRuntimeClient extends FakeRuntimeClient {
  readonly recoveryMode: "events" | "replay";
  eventsAfterCount = 0;
  sideEffectCount = 0;

  constructor(recoveryMode: "events" | "replay") {
    super();
    this.recoveryMode = recoveryMode;
  }

  override async *execute(input: RuntimeExecuteRequest): AsyncIterable<NotebookExecutionEvent> {
    this.executeCount += 1;
    const events = [
      event(input.sessionId, input.commandId, 4, "accepted", {
        executionId: input.executionId,
        cellId: input.cellId,
        commandType: "execute",
      }),
      event(input.sessionId, input.commandId, 5, "stream", {
        executionId: input.executionId,
        name: "stdout",
        text: "once\n",
      }),
      event(input.sessionId, input.commandId, 6, "kernel", {
        executionId: input.executionId,
        state: "idle",
      }),
    ];
    this.nextSequence.set(input.sessionId, 7);
    if (this.executeCount === 1) {
      this.sideEffectCount += 1;
      yield events[0]!;
      yield events[1]!;
      throw new NotebookRuntimeClientError({
        reason: "transport",
        message: "injected partial execution transport failure",
      });
    }
    for (const item of events) yield item;
  }

  override async eventsAfter(
    _sessionId: string,
    afterSequence: number,
  ): Promise<NotebookExecutionReplay> {
    this.eventsAfterCount += 1;
    if (this.recoveryMode === "events") {
      return {
        baselineSequence: afterSequence,
        events: [
          event("session-1", "execute-recover", 6, "kernel", {
            executionId: "execution-recover",
            state: "idle",
          }),
        ],
      };
    }
    return { baselineSequence: afterSequence, events: [] };
  }
}

class TrimmedReplayRuntimeClient extends FakeRuntimeClient {
  eventsAfterCount = 0;
  sideEffectCount = 0;

  override async *execute(input: RuntimeExecuteRequest): AsyncIterable<NotebookExecutionEvent> {
    this.executeCount += 1;
    this.sideEffectCount += 1;
    yield event(input.sessionId, input.commandId, 6, "accepted", {
      executionId: input.executionId,
      cellId: input.cellId,
      commandType: "execute",
    });
    throw new NotebookRuntimeClientError({
      reason: "transport",
      message: "injected transport failure after history trimming",
    });
  }

  override async eventsAfter(
    sessionId: string,
    _afterSequence: number,
  ): Promise<NotebookExecutionReplay> {
    this.eventsAfterCount += 1;
    return {
      baselineSequence: 5,
      events: [
        event(sessionId, "execute-trimmed", 6, "accepted", {
          executionId: "execution-trimmed",
          cellId: "cell-trimmed",
          commandType: "execute",
        }),
        event(sessionId, "execute-trimmed", 7, "kernel", {
          executionId: "execution-trimmed",
          state: "idle",
        }),
      ],
    };
  }
}

const event = (
  sessionId: string,
  commandId: string,
  sequence: number,
  type: NotebookExecutionEvent["type"],
  fields: Record<string, unknown>,
): NotebookExecutionEvent =>
  ({ sessionId, commandId, sequence, type, ...fields }) as NotebookExecutionEvent;

const makeHarness = async (options?: {
  readonly idleTimeoutMs?: number;
  readonly eventHistoryLimit?: number;
  readonly eventHistoryLimitBytes?: number;
  readonly commandCacheLimitBytes?: number;
  readonly disposeTombstoneLimit?: number;
  readonly disposeTombstoneLimitBytes?: number;
  readonly disposeTombstoneTtlMs?: number;
  readonly maxSessionsPerProject?: number;
  readonly maxSessionsGlobal?: number;
  readonly createClient?: () => FakeRuntimeClient;
  readonly now?: () => number;
  readonly readinessTimeoutMs?: number;
}) => {
  const runtimeRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "notebook-manager-test-"),
  );
  tempDirectories.push(runtimeRoot);
  const docker = new FakeDocker();
  const clients: FakeRuntimeClient[] = [];
  let now = 1_000;
  const manager = new NotebookRuntimeManager({
    docker,
    image: "lightfast/notebook-runtime:test",
    runtimeRoot,
    clientFactory: () => {
      const client = options?.createClient?.() ?? new FakeRuntimeClient();
      clients.push(client);
      return client;
    },
    now: options?.now ?? (() => now),
    idleTimeoutMs: options?.idleTimeoutMs ?? 60_000,
    readinessTimeoutMs: options?.readinessTimeoutMs ?? 50,
    ...(options?.eventHistoryLimit === undefined
      ? {}
      : { eventHistoryLimit: options.eventHistoryLimit }),
    ...(options?.eventHistoryLimitBytes === undefined
      ? {}
      : { eventHistoryLimitBytes: options.eventHistoryLimitBytes }),
    ...(options?.commandCacheLimitBytes === undefined
      ? {}
      : { commandCacheLimitBytes: options.commandCacheLimitBytes }),
    ...(options?.disposeTombstoneLimit === undefined
      ? {}
      : { disposeTombstoneLimit: options.disposeTombstoneLimit }),
    ...(options?.disposeTombstoneLimitBytes === undefined
      ? {}
      : { disposeTombstoneLimitBytes: options.disposeTombstoneLimitBytes }),
    ...(options?.disposeTombstoneTtlMs === undefined
      ? {}
      : { disposeTombstoneTtlMs: options.disposeTombstoneTtlMs }),
    ...(options?.maxSessionsPerProject === undefined
      ? {}
      : { maxSessionsPerProject: options.maxSessionsPerProject }),
    ...(options?.maxSessionsGlobal === undefined
      ? {}
      : { maxSessionsGlobal: options.maxSessionsGlobal }),
  });
  return { docker, clients, manager, setNow: (value: number) => (now = value) };
};

it("uses one hardened container per session and deduplicates concurrent session starts", async () => {
  const { docker, clients, manager } = await makeHarness();
  const firstOpen = {
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
    bookPaths: ["/safe/books/physics.pdf"],
  } as const;
  await Promise.all([manager.open(firstOpen), manager.open(firstOpen)]);
  await manager.open({
    projectId: "project-1",
    sessionId: "session-2",
    commandId: "open-2",
    kernelName: "python3",
  });

  expect(clients).toHaveLength(2);
  expect(clients.map((client) => client.healthCount)).toEqual([1, 1]);
  expect(clients.map((client) => client.openedSessionIds)).toEqual([["session-1"], ["session-2"]]);
  const runs = docker.calls.filter((call) => call.args[0] === "run");
  expect(runs).toHaveLength(2);
  for (const run of runs) {
    expect(run.args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--read-only",
        "--pids-limit",
        "64",
        "--memory",
        "512m",
        "--cpus",
        "1",
      ]),
    );
    expect(run.args).toContain("no-new-privileges:true");
    expect(run.args.some((arg) => arg.startsWith("/workspace:") && arg.includes("size=256m"))).toBe(
      true,
    );
    expect(
      run.args.some(
        (arg) => arg.includes("src=/safe/books/physics.pdf") && arg.includes("readonly"),
      ),
    ).toBe(true);
    expect(run.env?.NOTEBOOK_RUNTIME_TOKEN).toBeUndefined();
    expect(run.args).not.toContain("NOTEBOOK_RUNTIME_TOKEN");
  }
  expect(new Set(runs.map((run) => run.args[run.args.indexOf("--name") + 1])).size).toBe(2);
  const bootstrapContainerIds = docker.calls
    .filter((call) => call.args[0] === "exec")
    .map((call) => call.args[3]);
  expect(bootstrapContainerIds).toEqual(["container-id-1", "container-id-2"]);
  await manager.close();
});

it("launches each session from the freshly resolved immutable runtime image digest", async () => {
  const { docker, manager } = await makeHarness();
  const firstDigest = `sha256:${"a".repeat(64)}`;
  const secondDigest = `sha256:${"b".repeat(64)}`;
  docker.imageDigests.push(firstDigest, secondDigest);

  const resolvedFirst = await manager.resolveRuntimeImageDigest();
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
    runtimeImageDigest: resolvedFirst,
  });
  const resolvedSecond = await manager.resolveRuntimeImageDigest();
  await manager.open({
    projectId: "project-1",
    sessionId: "session-2",
    commandId: "open-2",
    kernelName: "python3",
    runtimeImageDigest: resolvedSecond,
  });

  expect([resolvedFirst, resolvedSecond]).toEqual([firstDigest, secondDigest]);
  expect(
    docker.calls.filter((call) => call.args[0] === "image").map((call) => call.args.at(-1)),
  ).toEqual(["lightfast/notebook-runtime:test", "lightfast/notebook-runtime:test"]);
  expect(
    docker.calls.filter((call) => call.args[0] === "run").map((call) => call.args.at(-1)),
  ).toEqual([firstDigest, secondDigest]);

  await manager.close();
});

it("force-removes a container and fails visibly when dispose resolves rejected", async () => {
  const client = new RejectedDisposeRuntimeClient();
  const { docker, manager } = await makeHarness({ createClient: () => client });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });

  await expect(
    manager.dispose({
      projectId: "project-1",
      sessionId: "session-1",
      commandId: "dispose-rejected",
    }),
  ).rejects.toMatchObject({ reason: "runtime-unavailable" });

  expect(client.disposeCount).toBe(1);
  expect(docker.activeContainers).toEqual(new Set());
  expect(
    docker.calls.filter((call) => call.args.join(" ") === "rm --force container-id-1"),
  ).toHaveLength(1);
  await manager.close();
});

it("force-removes a container and fails visibly when dispose is incomplete", async () => {
  const client = new IncompleteDisposeRuntimeClient();
  const { docker, manager } = await makeHarness({ createClient: () => client });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });

  await expect(
    manager.dispose({
      projectId: "project-1",
      sessionId: "session-1",
      commandId: "dispose-incomplete",
    }),
  ).rejects.toMatchObject({ reason: "runtime-unavailable" });
  expect(docker.activeContainers).toEqual(new Set());
  expect(
    docker.calls.filter((call) => call.args.join(" ") === "rm --force container-id-1"),
  ).toHaveLength(1);
  await manager.close();
});

it("streams in sequence and replays completed command IDs without re-execution", async () => {
  const { clients, manager } = await makeHarness();
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  const request = {
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "execute-1",
    executionId: "execution-1",
    cellId: "cell-1",
    code: "print('ok')",
  } as const;
  const first = await Array.fromAsync(manager.execute(request));
  const replay = await Array.fromAsync(manager.execute(request));

  expect(first.map((item) => item.sequence)).toEqual([4, 5, 6]);
  expect(first[0]).toMatchObject({ type: "accepted", cellId: "cell-1" });
  expect(replay).toEqual(first);
  expect(clients[0]?.executeCount).toBe(1);
  expect(
    manager.eventsAfter("project-1", "session-1", 4).events.map((item) => item.sequence),
  ).toEqual([5, 6]);
  await manager.close();
});

it("classifies a queued pre-accept cancellation as a clean rejected execution", async () => {
  const client = new QueuedCancellationRuntimeClient();
  const { manager } = await makeHarness({ createClient: () => client });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  const active = Array.fromAsync(
    manager.execute({
      projectId: "project-1",
      sessionId: "session-1",
      commandId: "execute-a",
      executionId: "execution-a",
      cellId: "cell-a",
      code: "await_active()",
    }),
  );
  await client.activeStarted;
  const queued = Array.fromAsync(
    manager.execute({
      projectId: "project-1",
      sessionId: "session-1",
      commandId: "execute-b",
      executionId: "execution-b",
      cellId: "cell-b",
      code: "queued()",
    }),
  );
  await client.queuedStarted;

  const [activeEvents, queuedEvents, disposeEvents] = await Promise.all([
    active,
    queued,
    manager.dispose({
      projectId: "project-1",
      sessionId: "session-1",
      commandId: "dispose-queued",
    }),
  ]);

  expect(activeEvents.map((item) => item.type)).toEqual(["accepted", "kernel", "kernel"]);
  expect(queuedEvents).toEqual([
    expect.objectContaining({
      type: "rejected",
      executionId: "execution-b",
      cellId: "cell-b",
      reason: "execution-cancelled",
    }),
  ]);
  expect(disposeEvents.at(-1)).toMatchObject({ type: "kernel", state: "terminated" });
  expect(client.executeCount).toBe(2);
  expect(client.eventsAfterCount).toBe(0);
  await manager.close();
});

it("forwards controls, disposes sessions, reaps idle projects, and removes containers", async () => {
  const { docker, clients, manager, setNow } = await makeHarness({ idleTimeoutMs: 10 });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-2",
    commandId: "open-2",
    kernelName: "python3",
  });
  await Array.fromAsync(
    manager.execute({
      projectId: "project-1",
      sessionId: "session-2",
      commandId: "execute-2",
      executionId: "execution-2",
      cellId: "cell-2",
      code: "print('session-2')",
    }),
  );
  await manager.interrupt({ projectId: "project-1", sessionId: "session-1", commandId: "i-1" });
  await manager.restart({ projectId: "project-1", sessionId: "session-1", commandId: "r-1" });
  const disposed = await manager.dispose({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "d-1",
  });
  expect(disposed.at(-1)).toMatchObject({ type: "kernel", state: "terminated" });
  expect(
    clients.map((client) => ({
      dispose: client.disposeCount,
      execute: client.executeCount,
      interrupt: client.interruptCount,
      restart: client.restartCount,
    })),
  ).toEqual([
    { dispose: 1, execute: 0, interrupt: 1, restart: 1 },
    { dispose: 0, execute: 1, interrupt: 0, restart: 0 },
  ]);
  expect(docker.calls.some((call) => call.args.join(" ") === "rm --force container-id-1")).toBe(
    true,
  );

  setNow(2_000);
  await manager.reapIdle();
  expect(docker.calls.some((call) => call.args.join(" ") === "rm --force container-id-2")).toBe(
    true,
  );
});

it("reaps idle sessions independently and admits a replacement under the project limit", async () => {
  const { docker, manager, setNow } = await makeHarness({
    idleTimeoutMs: 10,
    maxSessionsPerProject: 4,
    maxSessionsGlobal: 4,
  });
  for (const sessionId of ["session-a", "session-b", "session-c", "session-d"]) {
    await manager.open({
      projectId: "project-independent-idle",
      sessionId,
      commandId: `open-${sessionId}`,
      kernelName: "python3",
    });
  }

  setNow(1_005);
  await Array.fromAsync(
    manager.execute({
      projectId: "project-independent-idle",
      sessionId: "session-a",
      commandId: "execute-a",
      executionId: "execution-a",
      cellId: "cell-a",
      code: "print('still active')",
    }),
  );
  setNow(1_011);
  await manager.reapIdle();

  expect(docker.activeContainers).toEqual(new Set(["container-id-1"]));
  await expect(
    manager.open({
      projectId: "project-independent-idle",
      sessionId: "session-e",
      commandId: "open-e",
      kernelName: "python3",
    }),
  ).resolves.toBeDefined();
  expect(docker.activeContainers).toEqual(new Set(["container-id-1", "container-id-5"]));
  expect(() => manager.eventsAfter("project-independent-idle", "session-b", 0)).toThrow(
    expect.objectContaining({ reason: "session-not-found" }),
  );
  await manager.close();
});

it("forgets an owned --rm container that exited before bootstrap without removing a replacement", async () => {
  const { docker, manager } = await makeHarness({
    maxSessionsPerProject: 1,
    maxSessionsGlobal: 1,
  });
  docker.exitNextContainerBeforeBootstrap = true;
  docker.failMissingContainerRemovals = true;
  docker.missingContainerReplacement = "external-replacement-container";

  await expect(
    manager.open({
      projectId: "project-immediate-exit",
      sessionId: "session-dead",
      commandId: "open-dead",
      kernelName: "python3",
    }),
  ).rejects.toMatchObject({ reason: "docker-failed" });

  await expect(
    manager.open({
      projectId: "project-immediate-exit",
      sessionId: "session-live",
      commandId: "open-live",
      kernelName: "python3",
    }),
  ).resolves.toBeDefined();
  expect(docker.activeContainers).toContain("external-replacement-container");
  expect(
    docker.calls.filter((call) => call.args.includes("external-replacement-container")),
  ).toHaveLength(0);
  await manager.close();
});

it("replays a completed dispose after teardown and rejects a conflicting fingerprint", async () => {
  const { clients, docker, manager } = await makeHarness();
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  const input = {
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "dispose-1",
  } as const;

  const first = await manager.dispose(input);
  const replay = await manager.dispose(input);
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-2",
    kernelName: "python3",
  });
  const replayAfterReopen = await manager.dispose(input);
  const conflicting = { ...input, unexpectedPayload: "different" } as NotebookManagerControlInput;

  expect(replay).toEqual(first);
  expect(replayAfterReopen).toEqual(first);
  await expect(manager.dispose(conflicting)).rejects.toMatchObject({
    reason: "command-id-conflict",
  });
  expect(clients[0]?.disposeCount).toBe(1);
  expect(clients[1]?.disposeCount).toBe(0);
  expect(
    docker.calls.filter((call) => call.args.join(" ") === "rm --force container-id-1"),
  ).toHaveLength(1);
  await manager.close();
});

it("bounds dispose tombstones by count, serialized bytes, and TTL", async () => {
  const countHarness = await makeHarness({
    disposeTombstoneLimit: 1,
    disposeTombstoneTtlMs: 10,
  });
  const disposeInputs = ["session-1", "session-2"].map((sessionId, index) => ({
    projectId: "project-1",
    sessionId,
    commandId: `dispose-${index}`,
  }));
  const disposeEvents: Array<ReadonlyArray<NotebookExecutionEvent>> = [];
  for (const [index, input] of disposeInputs.entries()) {
    await countHarness.manager.open({
      projectId: "project-1",
      sessionId: input.sessionId,
      commandId: `open-${index}`,
      kernelName: "python3",
    });
    disposeEvents.push(await countHarness.manager.dispose(input));
  }

  await expect(countHarness.manager.dispose(disposeInputs[0]!)).rejects.toMatchObject({
    reason: "session-not-found",
  });
  await expect(countHarness.manager.dispose(disposeInputs[1]!)).resolves.toEqual(disposeEvents[1]);
  countHarness.setNow(1_011);
  await expect(countHarness.manager.dispose(disposeInputs[1]!)).rejects.toMatchObject({
    reason: "session-not-found",
  });
  await countHarness.manager.close();

  const byteHarness = await makeHarness({ disposeTombstoneLimitBytes: 1 });
  const byteInput = {
    projectId: "project-1",
    sessionId: "session-byte",
    commandId: "dispose-byte",
  } as const;
  await byteHarness.manager.open({
    projectId: "project-1",
    sessionId: "session-byte",
    commandId: "open-byte",
    kernelName: "python3",
  });
  await byteHarness.manager.dispose(byteInput);
  await expect(byteHarness.manager.dispose(byteInput)).rejects.toMatchObject({
    reason: "session-not-found",
  });
  await byteHarness.manager.close();
});

it("bounds concurrent session admission per project and globally before Docker starts", async () => {
  const projectHarness = await makeHarness();
  const projectResults = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      projectHarness.manager.open({
        projectId: "bounded-project",
        sessionId: `session-${index}`,
        commandId: `open-${index}`,
        kernelName: "python3",
      }),
    ),
  );

  expect(projectResults.filter((result) => result.status === "fulfilled")).toHaveLength(4);
  expect(projectResults.filter((result) => result.status === "rejected")).toEqual([
    expect.objectContaining({ reason: expect.anything() }),
  ]);
  expect(projectHarness.docker.runCount).toBe(4);
  await projectHarness.manager.close();
  expect(projectHarness.docker.calls.filter((call) => call.args[0] === "rm")).toHaveLength(4);

  const globalHarness = await makeHarness();
  const globalResults = await Promise.allSettled(
    Array.from({ length: 9 }, (_, index) =>
      globalHarness.manager.open({
        projectId: `project-${index}`,
        sessionId: `session-${index}`,
        commandId: `open-${index}`,
        kernelName: "python3",
      }),
    ),
  );

  expect(globalResults.filter((result) => result.status === "fulfilled")).toHaveLength(8);
  expect(globalResults.filter((result) => result.status === "rejected")).toEqual([
    expect.objectContaining({ reason: expect.anything() }),
  ]);
  expect(globalHarness.docker.runCount).toBe(8);
  await globalHarness.manager.close();
  expect(globalHarness.docker.calls.filter((call) => call.args[0] === "rm")).toHaveLength(8);
});

it("releases configured admission after a failed start is removed", async () => {
  let created = 0;
  let clock = 0;
  const { docker, manager } = await makeHarness({
    createClient: () => {
      created += 1;
      return created === 1 ? new FailingHealthRuntimeClient() : new FakeRuntimeClient();
    },
    maxSessionsGlobal: 1,
    maxSessionsPerProject: 1,
    now: () => (clock += 100),
  });

  await expect(
    manager.open({
      projectId: "project-1",
      sessionId: "failed-session",
      commandId: "open-failed",
      kernelName: "python3",
    }),
  ).rejects.toMatchObject({ reason: "runtime-unavailable" });
  await expect(
    manager.open({
      projectId: "project-1",
      sessionId: "replacement-session",
      commandId: "open-replacement",
      kernelName: "python3",
    }),
  ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: "accepted" })]));

  expect(docker.runCount).toBe(2);
  expect(docker.calls.filter((call) => call.args[0] === "rm")).toHaveLength(1);
  await manager.close();
});

it("waits for session removal before reopening in a new container", async () => {
  const { clients, docker, manager } = await makeHarness();
  const firstOpen = {
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  } as const;
  await manager.open(firstOpen);
  docker.holdRemovals = true;
  const disposing = manager.dispose({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "dispose-1",
  });
  await docker.removeStarted;
  let reopenSettled = false;
  const reopening = manager.open(firstOpen).then((events) => {
    reopenSettled = true;
    return events;
  });

  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(reopenSettled).toBe(false);
  } finally {
    docker.releaseRemovals();
  }

  await disposing;
  const reopened = await reopening;
  expect(reopened.at(-1)).toMatchObject({ type: "kernel", state: "idle" });
  expect(docker.runCount).toBe(2);
  expect(clients).toHaveLength(2);
  expect(clients.map((client) => client.openedSessionIds)).toEqual([["session-1"], ["session-1"]]);
  await manager.close();
});

it("rejects every session access while idle removal owns the runtime generation", async () => {
  const { clients, docker, manager, setNow } = await makeHarness({ idleTimeoutMs: 10 });
  const executeInput = {
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "execute-1",
    executionId: "execution-1",
    cellId: "cell-1",
    code: "print('first generation')",
  } as const;
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  await Array.fromAsync(manager.execute(executeInput));

  docker.holdRemovals = true;
  setNow(2_000);
  const reaping = manager.reapIdle();
  await docker.removeStarted;

  const capture = async (access: () => unknown): Promise<unknown> => {
    try {
      return await access();
    } catch (error) {
      return error;
    }
  };

  try {
    const accessResults = [
      await capture(() => Array.fromAsync(manager.execute(executeInput))),
      await capture(() =>
        Array.fromAsync(
          manager.execute({
            ...executeInput,
            commandId: "execute-during-removal",
            executionId: "execution-during-removal",
          }),
        ),
      ),
      await capture(() =>
        manager.interrupt({
          projectId: "project-1",
          sessionId: "session-1",
          commandId: "interrupt-during-removal",
        }),
      ),
      await capture(() =>
        manager.restart({
          projectId: "project-1",
          sessionId: "session-1",
          commandId: "restart-during-removal",
        }),
      ),
      await capture(() => manager.eventsAfter("project-1", "session-1", 0)),
    ];

    expect(accessResults).toEqual(
      Array.from({ length: 5 }, () => expect.objectContaining({ reason: "runtime-unavailable" })),
    );
    expect(clients[0]).toMatchObject({
      executeCount: 1,
      interruptCount: 0,
      restartCount: 0,
    });
  } finally {
    docker.releaseRemovals();
    await reaping;
  }

  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-2",
    kernelName: "python3",
  });
  await Array.fromAsync(
    manager.execute({
      ...executeInput,
      commandId: "execute-2",
      executionId: "execution-2",
      code: "print('replacement generation')",
    }),
  );
  await manager.interrupt({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "interrupt-2",
  });
  await manager.restart({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "restart-2",
  });

  expect(manager.eventsAfter("project-1", "session-1", 0).events).not.toHaveLength(0);
  expect(clients).toHaveLength(2);
  expect(clients).toEqual([
    expect.objectContaining({ executeCount: 1, interruptCount: 0, restartCount: 0 }),
    expect.objectContaining({ executeCount: 1, interruptCount: 1, restartCount: 1 }),
  ]);
  await manager.close();
});

it("waits for held sidecar disposal and removal before reopening", async () => {
  const heldClient = new DeferredDisposeRuntimeClient();
  let clientIndex = 0;
  const { clients, docker, manager } = await makeHarness({
    createClient: () => {
      clientIndex += 1;
      return clientIndex === 1 ? heldClient : new FakeRuntimeClient();
    },
  });
  const firstOpen = {
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  } as const;
  const disposeInput = {
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "dispose-1",
  } as const;
  await manager.open(firstOpen);
  const disposing = manager.dispose(disposeInput);
  await heldClient.disposeStarted;
  const duplicateDisposing = manager.dispose(disposeInput);
  let reopenSettled = false;
  const reopening = manager.open(firstOpen).then((events) => {
    reopenSettled = true;
    return events;
  });
  await Promise.resolve();
  await Promise.resolve();
  const settledBeforeDispose = reopenSettled;
  heldClient.releaseDispose();
  const [disposed, duplicateDisposed, reopened] = await Promise.all([
    disposing,
    duplicateDisposing,
    reopening,
  ]);

  try {
    expect(settledBeforeDispose).toBe(false);
    expect(duplicateDisposed).toEqual(disposed);
    expect(heldClient.disposeCount).toBe(1);
    expect(reopened.at(-1)).toMatchObject({ type: "kernel", state: "idle" });
    expect(docker.runCount).toBe(2);
    expect(clients).toHaveLength(2);
    expect(clients.map((client) => client.openedSessionIds)).toEqual([
      ["session-1"],
      ["session-1"],
    ]);
  } finally {
    await manager.close();
  }
});

it("rejects non-monotonic sidecar events", async () => {
  const { clients, manager } = await makeHarness();
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  clients[0]!.nextSequence.set("session-1", 3);

  const error = await Array.fromAsync(
    manager.execute({
      projectId: "project-1",
      sessionId: "session-1",
      commandId: "execute-bad",
      executionId: "execution-bad",
      cellId: "cell-bad",
      code: "bad",
    }),
  ).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(NotebookRuntimeManagerError);
  expect(error).toMatchObject({ reason: "invalid-sequence" });
  await manager.close();
});

it("bounds retained event history and command results by serialized bytes", async () => {
  const eventLimit = 500;
  const { clients, manager } = await makeHarness({
    eventHistoryLimitBytes: eventLimit,
    commandCacheLimitBytes: 300,
  });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  const request = {
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "execute-byte-bound",
    executionId: "execution-byte-bound",
    cellId: "cell-byte-bound",
    code: "print('ok')",
  } as const;

  await Array.fromAsync(manager.execute(request));
  const retained = manager.eventsAfter("project-1", "session-1", 0).events;
  expect(
    retained.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)), 0),
  ).toBeLessThanOrEqual(eventLimit);

  await Array.fromAsync(manager.execute(request));
  expect(clients[0]?.executeCount).toBe(2);
  await manager.close();
});

it("reports the authoritative baseline when event history retained only a suffix", async () => {
  const { manager } = await makeHarness({ eventHistoryLimit: 3 });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  await Array.fromAsync(
    manager.execute({
      projectId: "project-1",
      sessionId: "session-1",
      commandId: "execute-1",
      executionId: "execution-1",
      cellId: "cell-1",
      code: "print('ok')",
    }),
  );

  const replay = manager.eventsAfter("project-1", "session-1", 0);
  expect(replay.baselineSequence).toBe(3);
  expect(replay.events.map((item) => item.sequence)).toEqual([4, 5, 6]);
  await manager.close();
});

it("waits for sibling cleanup and keeps failed container ownership so close can retry", async () => {
  const { docker, manager } = await makeHarness();
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-2",
    commandId: "open-2",
    kernelName: "python3",
  });
  docker.removeFailures = 1;

  await expect(manager.close()).rejects.toThrow("injected remove failure");
  expect(
    docker.calls.filter((call) => call.args.join(" ") === "rm --force container-id-2"),
  ).toHaveLength(1);
  await manager.close();

  expect(
    docker.calls.filter((call) => call.args.join(" ") === "rm --force container-id-1"),
  ).toHaveLength(2);
  expect(
    docker.calls.filter((call) => call.args.join(" ") === "rm --force container-id-2"),
  ).toHaveLength(1);
});

it("retains startup container ownership when readiness and initial removal both fail", async () => {
  let clock = 0;
  const client = new FailingHealthRuntimeClient();
  const { docker, manager } = await makeHarness({
    createClient: () => client,
    now: () => (clock += 100),
  });
  docker.removeFailures = 1;

  await expect(
    manager.open({
      projectId: "project-startup-failure",
      sessionId: "session-1",
      commandId: "open-1",
      kernelName: "python3",
    }),
  ).rejects.toMatchObject({ reason: "runtime-unavailable" });
  await manager.close();

  expect(
    docker.calls.filter((call) => call.args.join(" ") === "rm --force container-id-1"),
  ).toHaveLength(2);
});

it("close waits for a racing project start and prevents it from being published", async () => {
  const client = new DeferredHealthRuntimeClient();
  const { docker, manager } = await makeHarness({ createClient: () => client });
  const opening = manager
    .open({
      projectId: "project-close-race",
      sessionId: "session-1",
      commandId: "open-1",
      kernelName: "python3",
    })
    .catch((error: unknown) => error);
  await client.healthStarted;

  let closeSettled = false;
  const closing = manager.close().then(() => {
    closeSettled = true;
  });
  await Promise.resolve();
  const settledBeforeRelease = closeSettled;
  client.releaseHealth();
  const openResult = await opening;
  await closing;
  await manager.close().catch(() => undefined);

  expect(settledBeforeRelease).toBe(false);
  expect(openResult).toMatchObject({ reason: "runtime-unavailable" });
  expect(
    docker.calls.filter((call) => call.args.join(" ") === "rm --force container-id-1"),
  ).toHaveLength(1);
});

it("orders close and dispose by whichever lifecycle barrier is registered first", async () => {
  const disposingFirstClient = new DeferredDisposeRuntimeClient();
  const disposingFirst = await makeHarness({ createClient: () => disposingFirstClient });
  await disposingFirst.manager.open({
    projectId: "project-dispose-first",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  const disposeBeforeClose = disposingFirst.manager.dispose({
    projectId: "project-dispose-first",
    sessionId: "session-1",
    commandId: "dispose-1",
  });
  await disposingFirstClient.disposeStarted;
  let closeSettled = false;
  const closeAfterDispose = disposingFirst.manager.close().then(() => {
    closeSettled = true;
  });

  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(closeSettled).toBe(false);
  } finally {
    disposingFirstClient.releaseDispose();
  }
  await Promise.all([disposeBeforeClose, closeAfterDispose]);
  expect(disposingFirstClient.disposeCount).toBe(1);

  const closingFirstClient = new DeferredDisposeRuntimeClient();
  const closingFirst = await makeHarness({ createClient: () => closingFirstClient });
  await closingFirst.manager.open({
    projectId: "project-close-first",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  const closeBeforeDispose = closingFirst.manager.close();
  const disposeAfterClose = closingFirst.manager
    .dispose({
      projectId: "project-close-first",
      sessionId: "session-1",
      commandId: "dispose-1",
    })
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
  await Promise.resolve();
  await Promise.resolve();
  const disposeStartedAfterClose = closingFirstClient.disposeCallStarted;
  closingFirstClient.releaseDispose();
  await expect(disposeAfterClose).resolves.toMatchObject({
    status: "rejected",
    reason: { reason: "runtime-unavailable" },
  });
  expect(disposeStartedAfterClose).toBe(false);
  await closeBeforeDispose;
});

it("orders idle reaping and dispose by whichever lifecycle barrier is registered first", async () => {
  const disposingFirstClient = new DeferredDisposeRuntimeClient();
  const disposingFirst = await makeHarness({
    createClient: () => disposingFirstClient,
    idleTimeoutMs: 10,
  });
  await disposingFirst.manager.open({
    projectId: "project-dispose-first",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  const disposeBeforeReap = disposingFirst.manager.dispose({
    projectId: "project-dispose-first",
    sessionId: "session-1",
    commandId: "dispose-1",
  });
  await disposingFirstClient.disposeStarted;
  disposingFirst.setNow(2_000);
  let reapSettled = false;
  const reapAfterDispose = disposingFirst.manager.reapIdle().then(() => {
    reapSettled = true;
  });

  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(reapSettled).toBe(false);
  } finally {
    disposingFirstClient.releaseDispose();
  }
  await Promise.all([disposeBeforeReap, reapAfterDispose]);
  expect(disposingFirstClient.disposeCount).toBe(1);
  await disposingFirst.manager.close();

  const reapingFirstClient = new DeferredDisposeRuntimeClient();
  const reapingFirst = await makeHarness({
    createClient: () => reapingFirstClient,
    idleTimeoutMs: 10,
  });
  await reapingFirst.manager.open({
    projectId: "project-reap-first",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  reapingFirst.setNow(2_000);
  const reapBeforeDispose = reapingFirst.manager.reapIdle();
  const disposeAfterReap = reapingFirst.manager
    .dispose({
      projectId: "project-reap-first",
      sessionId: "session-1",
      commandId: "dispose-1",
    })
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
  await Promise.resolve();
  await Promise.resolve();
  const disposeStartedAfterReap = reapingFirstClient.disposeCallStarted;
  reapingFirstClient.releaseDispose();
  await expect(disposeAfterReap).resolves.toMatchObject({
    status: "rejected",
    reason: { reason: "runtime-unavailable" },
  });
  expect(disposeStartedAfterReap).toBe(false);
  await reapBeforeDispose;
  await reapingFirst.manager.close();
});

it("reconciles a partial stream once for concurrent duplicates without repeating effects", async () => {
  const client = new PartialFailureRuntimeClient("replay");
  const { manager } = await makeHarness({ createClient: () => client });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  const request = {
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "execute-recover",
    executionId: "execution-recover",
    cellId: "cell-recover",
    code: "side_effect()",
  } as const;

  const first = Array.fromAsync(manager.execute(request));
  const duplicate = Array.fromAsync(manager.execute(request));
  let conflict: unknown;
  try {
    manager.execute({ ...request, code: "different_side_effect()" });
  } catch (error) {
    conflict = error;
  }
  expect(conflict).toBeInstanceOf(NotebookRuntimeManagerError);
  expect(conflict).toMatchObject({ reason: "command-id-conflict" });
  const [firstEvents, duplicateEvents] = await Promise.all([first, duplicate]);

  expect(firstEvents.map((item) => item.sequence)).toEqual([4, 5, 6]);
  expect(duplicateEvents).toEqual(firstEvents);
  expect(client.eventsAfterCount).toBe(1);
  expect(client.executeCount).toBe(2);
  expect(client.sideEffectCount).toBe(1);
  await manager.close();
});

it("finishes a partial execution directly from queried sidecar history", async () => {
  const client = new PartialFailureRuntimeClient("events");
  const { manager } = await makeHarness({ createClient: () => client });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });

  const events = await Array.fromAsync(
    manager.execute({
      projectId: "project-1",
      sessionId: "session-1",
      commandId: "execute-recover",
      executionId: "execution-recover",
      cellId: "cell-recover",
      code: "side_effect()",
    }),
  );

  expect(events.map((item) => item.sequence)).toEqual([4, 5, 6]);
  expect(client.eventsAfterCount).toBe(1);
  expect(client.executeCount).toBe(1);
  expect(client.sideEffectCount).toBe(1);
  await manager.close();
});

it("rebases manager sequence state when sidecar history retained only a suffix", async () => {
  const client = new TrimmedReplayRuntimeClient();
  const { manager } = await makeHarness({ createClient: () => client });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });

  const events = await Array.fromAsync(
    manager.execute({
      projectId: "project-1",
      sessionId: "session-1",
      commandId: "execute-trimmed",
      executionId: "execution-trimmed",
      cellId: "cell-trimmed",
      code: "side_effect()",
    }),
  );

  expect(events.map((item) => item.sequence)).toEqual([6, 7]);
  expect(client.eventsAfterCount).toBe(1);
  expect(client.executeCount).toBe(1);
  expect(client.sideEffectCount).toBe(1);
  expect(manager.eventsAfter("project-1", "session-1", 0)).toMatchObject({
    baselineSequence: 5,
    events: [{ sequence: 6 }, { sequence: 7 }],
  });
  await manager.close();
});

it("does not cache nonterminal transport failures for control retries", async () => {
  const { clients, manager } = await makeHarness();
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  clients[0]!.interruptFailures = 1;
  const input = {
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "interrupt-retry",
  } as const;

  await expect(manager.interrupt(input)).rejects.toThrow("injected interrupt transport failure");
  const retried = await manager.interrupt(input);

  expect(retried.at(-1)).toMatchObject({ type: "kernel", state: "interrupted" });
  await manager.close();
});
