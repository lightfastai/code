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

  async run(
    args: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ): Promise<{ readonly stdout: string }> {
    this.calls.push({
      args: [...args],
      ...(options?.env === undefined ? {} : { env: options.env }),
    });
    return { stdout: args[0] === "run" ? "container-id\n" : "" };
  }
}

class FakeRuntimeClient implements NotebookRuntimeClientLike {
  executeCount = 0;
  healthCount = 0;
  nextSequence = new Map<string, number>();

  async health(): Promise<void> {
    this.healthCount += 1;
  }

  async open(input: RuntimeSessionOpenRequest): Promise<readonly NotebookExecutionEvent[]> {
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
    return this.control(input, "interrupt", "interrupted");
  }

  async restart(input: RuntimeSessionCommandRequest): Promise<readonly NotebookExecutionEvent[]> {
    return this.control(input, "restart", "restarted");
  }

  async dispose(input: RuntimeSessionCommandRequest): Promise<readonly NotebookExecutionEvent[]> {
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

const event = (
  sessionId: string,
  commandId: string,
  sequence: number,
  type: NotebookExecutionEvent["type"],
  fields: Record<string, unknown>,
): NotebookExecutionEvent =>
  ({ sessionId, commandId, sequence, type, ...fields }) as NotebookExecutionEvent;

const makeHarness = async (options?: { readonly idleTimeoutMs?: number }) => {
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
      const client = new FakeRuntimeClient();
      clients.push(client);
      return client;
    },
    now: () => now,
    idleTimeoutMs: options?.idleTimeoutMs ?? 60_000,
    readinessTimeoutMs: 50,
  });
  return { docker, clients, manager, setNow: (value: number) => (now = value) };
};

it("uses one hardened project container for separate notebook sessions", async () => {
  const { docker, clients, manager } = await makeHarness();
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
    bookPaths: ["/safe/books/physics.pdf"],
  });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-2",
    commandId: "open-2",
    kernelName: "python3",
  });

  expect(clients).toHaveLength(1);
  expect(clients[0]?.healthCount).toBe(1);
  const run = docker.calls.find((call) => call.args[0] === "run");
  expect(run).toBeDefined();
  expect(run?.args).toEqual(
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
  expect(run?.args).toContain("no-new-privileges:true");
  expect(run?.args.some((arg) => arg.startsWith("/workspace:") && arg.includes("size=256m"))).toBe(
    true,
  );
  expect(
    run?.args.some(
      (arg) => arg.includes("src=/safe/books/physics.pdf") && arg.includes("readonly"),
    ),
  ).toBe(true);
  expect(run?.env?.NOTEBOOK_RUNTIME_TOKEN).toBeTruthy();
  expect(run?.args.join(" ")).not.toContain(String(run?.env?.NOTEBOOK_RUNTIME_TOKEN));
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
  const { docker, manager, setNow } = await makeHarness({ idleTimeoutMs: 10 });
  await manager.open({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "open-1",
    kernelName: "python3",
  });
  await manager.interrupt({ projectId: "project-1", sessionId: "session-1", commandId: "i-1" });
  await manager.restart({ projectId: "project-1", sessionId: "session-1", commandId: "r-1" });
  const disposed = await manager.dispose({
    projectId: "project-1",
    sessionId: "session-1",
    commandId: "d-1",
  });
  expect(disposed.at(-1)).toMatchObject({ type: "kernel", state: "terminated" });

  setNow(2_000);
  await manager.reapIdle();
  expect(docker.calls.some((call) => call.args.join(" ") === "rm --force container-id")).toBe(true);
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
