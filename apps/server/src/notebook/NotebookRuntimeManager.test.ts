// @effect-diagnostics nodeBuiltinImport:off - The manager contract owns host temp paths.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { NotebookExecutionEvent } from "@t3tools/contracts";
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
  removeFailures = 0;
  runCount = 0;

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
    if (args[0] === "run") {
      this.runCount += 1;
      return { stdout: `container-id-${this.runCount}\n` };
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

  async eventsAfter(
    _sessionId: string,
    _afterSequence: number,
  ): Promise<readonly NotebookExecutionEvent[]> {
    return [];
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
    _afterSequence: number,
  ): Promise<readonly NotebookExecutionEvent[]> {
    this.eventsAfterCount += 1;
    if (this.recoveryMode === "events") {
      return [
        event("session-1", "execute-recover", 6, "kernel", {
          executionId: "execution-recover",
          state: "idle",
        }),
      ];
    }
    return [];
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
  readonly eventHistoryLimitBytes?: number;
  readonly commandCacheLimitBytes?: number;
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
    ...(options?.eventHistoryLimitBytes === undefined
      ? {}
      : { eventHistoryLimitBytes: options.eventHistoryLimitBytes }),
    ...(options?.commandCacheLimitBytes === undefined
      ? {}
      : { commandCacheLimitBytes: options.commandCacheLimitBytes }),
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
    code: "print('ok')",
  } as const;
  const first = await Array.fromAsync(manager.execute(request));
  const replay = await Array.fromAsync(manager.execute(request));

  expect(first.map((item) => item.sequence)).toEqual([4, 5, 6]);
  expect(replay).toEqual(first);
  expect(clients[0]?.executeCount).toBe(1);
  expect(manager.eventsAfter("project-1", "session-1", 4).map((item) => item.sequence)).toEqual([
    5, 6,
  ]);
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
    code: "print('ok')",
  } as const;

  await Array.fromAsync(manager.execute(request));
  const retained = manager.eventsAfter("project-1", "session-1", 0);
  expect(
    retained.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)), 0),
  ).toBeLessThanOrEqual(eventLimit);

  await Array.fromAsync(manager.execute(request));
  expect(clients[0]?.executeCount).toBe(2);
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
      code: "side_effect()",
    }),
  );

  expect(events.map((item) => item.sequence)).toEqual([4, 5, 6]);
  expect(client.eventsAfterCount).toBe(1);
  expect(client.executeCount).toBe(1);
  expect(client.sideEffectCount).toBe(1);
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
