// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Opt-in Docker test measures real process timing.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import type { NotebookExecutionEvent } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { DockerExecNotebookRuntimeClient } from "./NotebookRuntimeClient.ts";
import {
  DockerCliCommandRunner,
  type DockerCommandRunner,
  NotebookRuntimeManager,
} from "./NotebookRuntimeManager.ts";

const execFilePromise = NodeUtil.promisify(NodeChildProcess.execFile);
const liveIt = NodeProcess.env.NOTEBOOK_RUNTIME_LIVE === "1" ? it : it.skip;
const image = NodeProcess.env.NOTEBOOK_RUNTIME_IMAGE ?? "lightfast/notebook-runtime:task5";

const executeUntilSocketTimeout = async (options: {
  readonly containerId: string;
  readonly token: string;
  readonly body: Readonly<Record<string, string>>;
}): Promise<string> => {
  const script = [
    "import ctypes,http.client,json,socket,sys",
    "ctypes.CDLL(None).prctl(4,0,0,0,0)",
    "envelope=json.loads(sys.stdin.buffer.readline())",
    "body=json.dumps(envelope['body'],separators=(',',':')).encode()",
    "connection=http.client.HTTPConnection('127.0.0.1',8080,timeout=0.1)",
    "connection.request('POST','/v1/sessions/live-session/execute',body=body,headers={'Authorization':f\"Bearer {envelope['token']}\",'Content-Type':'application/json'})",
    "response=connection.getresponse()",
    "try:",
    " while line:=response.readline(): sys.stdout.buffer.write(line); sys.stdout.buffer.flush()",
    "except (TimeoutError,socket.timeout): pass",
    "finally: response.close(); connection.close()",
  ].join("\n");
  const child = NodeChildProcess.spawn(
    "docker",
    ["exec", "--interactive", "--user", "10002:10002", options.containerId, "python", "-c", script],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(`${JSON.stringify({ token: options.token, body: options.body })}\n`);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Uint8Array) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Uint8Array) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) throw new Error(Buffer.concat(stderr).toString());
  return Buffer.concat(stdout).toString();
};

class FailFirstRemoveDocker implements DockerCommandRunner {
  readonly #delegate = new DockerCliCommandRunner();
  #failRemove = true;
  removeAttempts = 0;

  run(
    args: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ): Promise<{ readonly stdout: string }> {
    if (args[0] === "rm") {
      this.removeAttempts += 1;
      if (this.#failRemove) {
        this.#failRemove = false;
        return Promise.reject(new Error("injected live remove failure"));
      }
    }
    return this.#delegate.run(args, options);
  }
}

const execute = (
  manager: NotebookRuntimeManager,
  sequence: number,
  code: string,
  commandId = `command-${sequence}`,
  sessionId = "live-session",
) =>
  Array.fromAsync(
    manager.execute({
      projectId: "live-project",
      sessionId,
      commandId,
      executionId: `execution-${sequence}`,
      code,
    }),
  );

const textResult = (events: ReadonlyArray<NotebookExecutionEvent>): string | undefined => {
  const result = events.find((event) => event.type === "result");
  return result?.type === "result" && typeof result.data["text/plain"] === "string"
    ? result.data["text/plain"]
    : undefined;
};

liveIt(
  "executes and isolates live Jupyter session containers",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "notebook-runtime-live-"));
    const bookPath = NodePath.join(root, "book.txt");
    await NodeFSP.writeFile(bookPath, "readonly-book", { mode: 0o444 });
    const directClients: Array<{
      readonly client: DockerExecNotebookRuntimeClient;
      readonly options: { readonly containerId: string; readonly token: string };
    }> = [];
    const manager = new NotebookRuntimeManager({
      docker: new FailFirstRemoveDocker(),
      image,
      runtimeRoot: NodePath.join(root, "control"),
      clientFactory: (options) => {
        const client = new DockerExecNotebookRuntimeClient({
          ...options,
          requestTimeoutMs: 130_000,
        });
        directClients.push({ client, options });
        return client;
      },
      readinessTimeoutMs: 30_000,
      executionTimeoutSeconds: 1,
      timeoutIdleGraceSeconds: 2,
    });
    try {
      await manager.open({
        projectId: "live-project",
        sessionId: "live-session",
        commandId: "open-live",
        kernelName: "python3",
        bookPaths: [bookPath],
      });
      const primaryRuntime = directClients[0];
      if (primaryRuntime === undefined) {
        throw new Error("missing direct runtime client");
      }

      const tokenIsolation = await execute(
        manager,
        0,
        "import glob\nimport os\nimport urllib.error\nimport urllib.request\ntoken = os.environ.get('NOTEBOOK_RUNTIME_TOKEN')\nprint(f'token-present={token is not None}')\nproc_tokens = 0\nfor path in glob.glob('/proc/[0-9]*/environ'):\n try:\n  proc_tokens += int(b'NOTEBOOK_RUNTIME_TOKEN=' in open(path, 'rb').read())\n except OSError:\n  pass\nprint(f'proc-token-count={proc_tokens}')\nrequest = urllib.request.Request('http://127.0.0.1:8080/v1/health', headers={'Authorization': f'Bearer {token or \"\"}'})\ntry:\n response = urllib.request.urlopen(request, timeout=1)\n print(f'loopback-status={response.status}')\nexcept urllib.error.HTTPError as error:\n print(f'loopback-status={error.code}')",
        "token-isolation-live",
      );
      const tokenOutput = tokenIsolation
        .filter((event) => event.type === "stream")
        .map((event) => (event.type === "stream" ? event.text : ""))
        .join("");
      expect(tokenOutput).toContain(
        "token-present=False\nproc-token-count=0\nloopback-status=401\n",
      );

      await manager.open({
        projectId: "live-project",
        sessionId: "sibling-session",
        commandId: "open-sibling",
        kernelName: "python3",
      });
      const siblingRuntime = directClients[1];
      if (siblingRuntime === undefined) throw new Error("missing sibling runtime client");
      expect(siblingRuntime.options.containerId).not.toBe(primaryRuntime.options.containerId);

      await execute(
        manager,
        45,
        "import http.server, subprocess, sys, threading\nfrom pathlib import Path\nsibling_secret = 'private'\nPath('/workspace/sibling-workspace-marker').write_text('private')\nPath('/tmp/sibling-tmpfs-marker').write_text('private')\nsibling_process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', 'sibling-process-marker'])\nsibling_server = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), http.server.SimpleHTTPRequestHandler)\nthreading.Thread(target=sibling_server.serve_forever, daemon=True).start()",
        "sibling-state",
        "sibling-session",
      );
      await execFilePromise("docker", [
        "exec",
        "--user",
        "10001:10001",
        siblingRuntime.options.containerId,
        "python",
        "-c",
        "from pathlib import Path; Path('/tmp/notebook-sessions/sibling-runtime-marker').write_text('private')",
      ]);
      expect(textResult(await execute(manager, 46, "'sibling_secret' in globals()"))).toBe("False");
      const connectionIsolation = await execute(
        manager,
        47,
        "import glob, os, socket\npaths=[]\nsibling_processes=0\nfor path in glob.glob('/proc/[0-9]*/cmdline'):\n try:\n  command=open(path,'rb').read()\n  sibling_processes += int(b'sibling-process-marker' in command)\n  parts=command.split(b'\\0')\n  if b'-f' in parts:\n   index=parts.index(b'-f')\n   if index + 1 < len(parts): paths.append(parts[index + 1].decode())\n except OSError:\n  pass\npaths=sorted(set(paths))\nprobe=socket.socket(); probe.settimeout(0.2)\ntry:\n probe.connect(('127.0.0.1',8765)); sibling_loopback=True\nexcept OSError:\n sibling_loopback=False\nfinally:\n probe.close()\nprint(f'connection-count={len(paths)}')\nprint(f'runtime-dir-count={len(set(map(os.path.dirname, paths)))}')\nprint(f'readable-connections={sum(os.path.isfile(path) and os.access(path, os.R_OK) for path in paths)}')\nprint(f'sibling-processes={sibling_processes}')\nprint(f'sibling-workspace={os.path.exists(\"/workspace/sibling-workspace-marker\")}')\nprint(f'sibling-tmpfs={os.path.exists(\"/tmp/sibling-tmpfs-marker\")}')\nprint(f'sibling-runtime={os.path.exists(\"/tmp/notebook-sessions/sibling-runtime-marker\")}')\nprint(f'sibling-loopback={sibling_loopback}')",
        "connection-isolation",
      );
      const connectionOutput = connectionIsolation
        .filter((event) => event.type === "stream")
        .map((event) => (event.type === "stream" ? event.text : ""))
        .join("");
      expect(connectionOutput).toContain(
        "connection-count=1\nruntime-dir-count=1\nreadable-connections=0\nsibling-processes=0\nsibling-workspace=False\nsibling-tmpfs=False\nsibling-runtime=False\nsibling-loopback=False\n",
      );

      const beforeDisconnect = await primaryRuntime.client.eventsAfter("live-session", 0);
      const afterSequence = beforeDisconnect.at(-1)?.sequence ?? 0;
      const disconnectRequest = {
        sessionId: "live-session",
        commandId: "disconnect-live",
        executionId: "disconnect-execution",
        code: "import time\ntime.sleep(0.6)\ndisconnect_counter = globals().get('disconnect_counter', 0) + 1\ndisconnect_counter",
      } as const;
      const disconnectedOutput = await executeUntilSocketTimeout({
        ...primaryRuntime.options,
        body: disconnectRequest,
      });
      expect(disconnectedOutput).toContain('"commandId":"disconnect-live"');
      await NodeTimersPromises.setTimeout(900);
      const recoveredEvents = await primaryRuntime.client.eventsAfter(
        "live-session",
        afterSequence,
      );
      expect(recoveredEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ commandId: "disconnect-live", type: "result" }),
          expect.objectContaining({ commandId: "disconnect-live", type: "kernel", state: "idle" }),
        ]),
      );
      const replayedDisconnect = await Array.fromAsync(
        primaryRuntime.client.execute(disconnectRequest),
      );
      expect(textResult(replayedDisconnect)).toBe("1");

      await execute(manager, 1, "value = 40");
      expect(textResult(await execute(manager, 2, "value + 2"))).toBe("42");

      const png = await execute(
        manager,
        3,
        "from IPython.display import Image, display\nimport base64\ndisplay(Image(data=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')))",
      );
      expect(
        png.some(
          (event) => event.type === "display" && typeof event.data["image/png"] === "string",
        ),
      ).toBe(true);

      const failed = await execute(manager, 4, "raise ValueError('expected-live-error')");
      expect(failed).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "error", ename: "ValueError" })]),
      );

      const hugeMetadata = await execute(
        manager,
        41,
        "from IPython.display import display\ndisplay({'text/plain': 'bounded'}, raw=True, metadata={'attacker': 'x' * (2 * 1024 * 1024)})",
      );
      const hugeError = await execute(manager, 42, "raise ValueError('x' * (2 * 1024 * 1024))");
      for (const item of [...hugeMetadata, ...hugeError]) {
        expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(1024 * 1024);
      }
      expect(hugeMetadata).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "display", metadata: {} })]),
      );
      expect(hugeError).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "error", ename: "ValueError" })]),
      );

      const unwindStartedAt = Date.now();
      const unwind = await execute(
        manager,
        43,
        "import time\ntry:\n time.sleep(2)\nexcept KeyboardInterrupt:\n time.sleep(0.75)\n unwind_marker = 'done'",
      );
      expect(unwind).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "limit", kind: "time" })]),
      );
      expect(Date.now() - unwindStartedAt).toBeGreaterThanOrEqual(1_400);
      expect(textResult(await execute(manager, 44, "unwind_marker"))).toBe("'done'");

      const longExecution = execute(manager, 5, "import time\ntime.sleep(30)");
      await NodeTimersPromises.setTimeout(500);
      const interrupted = await manager.interrupt({
        projectId: "live-project",
        sessionId: "live-session",
        commandId: "interrupt-live",
      });
      expect(interrupted.at(-1)).toMatchObject({ type: "kernel", state: "interrupted" });
      expect(await longExecution).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "kernel", state: "idle" })]),
      );

      const [firstDuplicate, duplicate] = await Promise.all([
        execute(manager, 6, "counter = globals().get('counter', 0) + 1\ncounter", "duplicate-live"),
        execute(manager, 6, "counter = globals().get('counter', 0) + 1\ncounter", "duplicate-live"),
      ]);
      expect(textResult(firstDuplicate)).toBe("1");
      expect(textResult(duplicate)).toBe("1");
      expect(textResult(await execute(manager, 7, "counter"))).toBe("1");

      const network = await execute(
        manager,
        8,
        "import socket\ns=socket.socket()\ns.settimeout(0.2)\ntry:\n s.connect(('1.1.1.1',80)); print('connected')\nexcept OSError:\n print('blocked')\nfinally:\n s.close()",
      );
      expect(network).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "stream", text: "blocked\n" })]),
      );

      const filesystem = await execute(
        manager,
        9,
        "import os\nprint(os.getuid())\nprint(open('/books/book-0').read())\ntry:\n open('/books/book-0','w').write('bad')\nexcept OSError:\n print('book-readonly')\ntry:\n open('/app/forbidden','w').write('bad')\nexcept OSError:\n print('root-readonly')",
      );
      const output = filesystem
        .filter((event) => event.type === "stream")
        .map((event) => (event.type === "stream" ? event.text : ""))
        .join("");
      expect(output).toContain("10001\nreadonly-book\nbook-readonly\nroot-readonly\n");

      await manager.restart({
        projectId: "live-project",
        sessionId: "live-session",
        commandId: "restart-live",
      });
      const restarted = await execute(manager, 10, "print('value' in globals())");
      expect(restarted).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "stream", text: "False\n" })]),
      );

      const { stdout: containerOutput } = await execFilePromise("docker", [
        "ps",
        "-q",
        "--filter",
        "label=lightfast.notebook.project=5b5cd5d2405ffcf3",
      ]);
      const containerIds = containerOutput.trim().split(/\s+/).filter(Boolean);
      expect(containerIds).toHaveLength(2);
      expect(new Set(containerIds)).toEqual(
        new Set([
          primaryRuntime.options.containerId.slice(0, 12),
          siblingRuntime.options.containerId.slice(0, 12),
        ]),
      );
      const containerNames = await Promise.all(
        containerIds.map(async (containerId) => {
          const { stdout } = await execFilePromise("docker", [
            "inspect",
            "--format",
            "{{.Name}}",
            containerId,
          ]);
          return stdout.trim();
        }),
      );
      expect(new Set(containerNames).size).toBe(2);

      for (const containerId of containerIds) {
        const { stdout: inspection } = await execFilePromise("docker", [
          "inspect",
          "--format",
          "{{json .HostConfig}}",
          containerId,
        ]);
        const hostConfig = JSON.parse(inspection) as {
          readonly CapDrop: readonly string[];
          readonly Memory: number;
          readonly NanoCpus: number;
          readonly NetworkMode: string;
          readonly PidsLimit: number;
          readonly ReadonlyRootfs: boolean;
          readonly SecurityOpt: readonly string[];
          readonly Tmpfs: Readonly<Record<string, string>>;
        };
        expect(hostConfig).toMatchObject({
          CapDrop: ["ALL"],
          Memory: 512 * 1024 * 1024,
          NanoCpus: 1_000_000_000,
          NetworkMode: "none",
          PidsLimit: 64,
          ReadonlyRootfs: true,
        });
        expect(hostConfig.SecurityOpt).toContain("no-new-privileges:true");
        expect(Object.keys(hostConfig.Tmpfs).toSorted()).toEqual(["/tmp", "/workspace"]);
        const { stdout: mountsJson } = await execFilePromise("docker", [
          "inspect",
          "--format",
          "{{json .Mounts}}",
          containerId,
        ]);
        const mounts = JSON.parse(mountsJson) as ReadonlyArray<{
          readonly Destination: string;
          readonly RW: boolean;
          readonly Source: string;
          readonly Type: string;
        }>;
        expect(mounts).toEqual([
          expect.objectContaining({ Destination: "/books/book-0", RW: false, Type: "bind" }),
        ]);
        expect(mounts[0]?.Source).toBe(bookPath);
        expect(mounts.some((mount) => /docker\.sock|workspace/i.test(mount.Source))).toBe(false);

        const { stdout: configuredEnvironment } = await execFilePromise("docker", [
          "inspect",
          "--format",
          "{{json .Config.Env}}",
          containerId,
        ]);
        expect(JSON.parse(configuredEnvironment) as string[]).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^NOTEBOOK_RUNTIME_TOKEN=/)]),
        );
        const bootstrapReplay = await execFilePromise("docker", [
          "exec",
          "--user",
          "10002:10002",
          containerId,
          "python",
          "-m",
          "runtime",
          "bootstrap",
        ]).catch((error: unknown) => error);
        expect(bootstrapReplay).toBeInstanceOf(Error);
        expect(String(bootstrapReplay)).toContain("bootstrap unavailable");
        expect(String(bootstrapReplay)).not.toContain("NOTEBOOK_RUNTIME_TOKEN");
      }

      await expect(manager.close()).rejects.toThrow("injected live remove failure");
      const { stdout: retainedAfterFailure } = await execFilePromise("docker", [
        "ps",
        "-q",
        "--filter",
        "label=lightfast.notebook.project=5b5cd5d2405ffcf3",
      ]);
      expect(retainedAfterFailure.trim().split(/\s+/).filter(Boolean)).toHaveLength(1);
      await manager.close();
      const { stdout: remainingContainers } = await execFilePromise("docker", [
        "ps",
        "-aq",
        "--filter",
        "label=lightfast.notebook.project=5b5cd5d2405ffcf3",
      ]);
      expect(remainingContainers.trim()).toBe("");
    } finally {
      await manager.close().catch(() => undefined);
      await manager.close().catch(() => undefined);
      const { stdout: leakedContainers } = await execFilePromise("docker", [
        "ps",
        "-aq",
        "--filter",
        "label=lightfast.notebook.project=5b5cd5d2405ffcf3",
      ]);
      if (leakedContainers.trim()) {
        await execFilePromise("docker", ["rm", "--force", ...leakedContainers.trim().split(/\s+/)]);
      }
      await NodeFSP.rm(root, { force: true, recursive: true });
    }
  },
  60_000,
);

liveIt(
  "retains and removes a live container when close races startup cleanup",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "notebook-start-race-"));
    const projectLabel = NodeCrypto.createHash("sha256")
      .update("live-startup-race")
      .digest("hex")
      .slice(0, 16);
    const docker = new FailFirstRemoveDocker();
    let markHealthStarted!: () => void;
    let releaseHealth!: () => void;
    const healthStarted = new Promise<void>((resolve) => {
      markHealthStarted = resolve;
    });
    const healthReleased = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const manager = new NotebookRuntimeManager({
      docker,
      image,
      runtimeRoot: NodePath.join(root, "control"),
      readinessTimeoutMs: 30_000,
      clientFactory: (options) => {
        const client = new DockerExecNotebookRuntimeClient({
          ...options,
          requestTimeoutMs: 130_000,
        });
        return {
          health: async () => {
            markHealthStarted();
            await healthReleased;
            await client.health();
          },
          open: (input) => client.open(input),
          execute: (input) => client.execute(input),
          interrupt: (input) => client.interrupt(input),
          restart: (input) => client.restart(input),
          dispose: (input) => client.dispose(input),
          eventsAfter: (sessionId, afterSequence) => client.eventsAfter(sessionId, afterSequence),
        };
      },
    });
    try {
      const opening = manager
        .open({
          projectId: "live-startup-race",
          sessionId: "live-session",
          commandId: "open-live",
          kernelName: "python3",
        })
        .catch((error: unknown) => error);
      await healthStarted;
      let closeSettled = false;
      const closing = manager.close().then(() => {
        closeSettled = true;
      });
      await NodeTimersPromises.setTimeout(25);
      const settledBeforeRelease = closeSettled;
      releaseHealth();

      expect(await opening).toMatchObject({ reason: "runtime-unavailable" });
      await closing;
      expect(settledBeforeRelease).toBe(false);
      expect(docker.removeAttempts).toBe(2);
      const { stdout: remainingContainers } = await execFilePromise("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=lightfast.notebook.project=${projectLabel}`,
      ]);
      expect(remainingContainers.trim()).toBe("");
    } finally {
      releaseHealth();
      await manager.close().catch(() => undefined);
      await manager.close().catch(() => undefined);
      const { stdout: leakedContainers } = await execFilePromise("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=lightfast.notebook.project=${projectLabel}`,
      ]);
      if (leakedContainers.trim()) {
        await execFilePromise("docker", ["rm", "--force", ...leakedContainers.trim().split(/\s+/)]);
      }
      await NodeFSP.rm(root, { force: true, recursive: true });
    }
  },
  60_000,
);

liveIt(
  "enforces admission and replays dispose across a new-container reopen",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "notebook-lifecycle-live-"));
    const projectId = "live-lifecycle-project";
    const projectLabel = NodeCrypto.createHash("sha256")
      .update(projectId)
      .digest("hex")
      .slice(0, 16);
    const clients: Array<{
      readonly client: DockerExecNotebookRuntimeClient;
      readonly containerId: string;
    }> = [];
    const manager = new NotebookRuntimeManager({
      docker: new DockerCliCommandRunner(),
      image,
      runtimeRoot: NodePath.join(root, "control"),
      readinessTimeoutMs: 30_000,
      maxSessionsGlobal: 1,
      maxSessionsPerProject: 1,
      clientFactory: (options) => {
        const client = new DockerExecNotebookRuntimeClient({
          ...options,
          requestTimeoutMs: 130_000,
        });
        clients.push({ client, containerId: options.containerId });
        return client;
      },
    });
    try {
      await manager.open({
        projectId,
        sessionId: "live-session",
        commandId: "open-first",
        kernelName: "python3",
      });
      const firstContainerId = clients[0]?.containerId;
      if (firstContainerId === undefined) throw new Error("missing first lifecycle container");

      await expect(
        manager.open({
          projectId,
          sessionId: "excess-session",
          commandId: "open-excess",
          kernelName: "python3",
        }),
      ).rejects.toMatchObject({ reason: "runtime-unavailable" });
      expect(clients).toHaveLength(1);
      const { stdout: admittedContainers } = await execFilePromise("docker", [
        "ps",
        "-q",
        "--filter",
        `label=lightfast.notebook.project=${projectLabel}`,
      ]);
      expect(admittedContainers.trim().split(/\s+/).filter(Boolean)).toHaveLength(1);

      const firstDisposeInput = {
        projectId,
        sessionId: "live-session",
        commandId: "dispose-first",
      } as const;
      const firstDispose = await manager.dispose(firstDisposeInput);
      await expect(manager.dispose(firstDisposeInput)).resolves.toEqual(firstDispose);
      await expect(execFilePromise("docker", ["inspect", firstContainerId])).rejects.toBeDefined();

      await manager.open({
        projectId,
        sessionId: "live-session",
        commandId: "open-reopened",
        kernelName: "python3",
      });
      const reopenedContainerId = clients[1]?.containerId;
      if (reopenedContainerId === undefined)
        throw new Error("missing reopened lifecycle container");
      expect(reopenedContainerId).not.toBe(firstContainerId);
      await expect(manager.dispose(firstDisposeInput)).resolves.toEqual(firstDispose);
      await expect(
        execFilePromise("docker", ["inspect", reopenedContainerId]),
      ).resolves.toBeDefined();

      await manager.dispose({
        projectId,
        sessionId: "live-session",
        commandId: "dispose-reopened",
      });
      const { stdout: remainingContainers } = await execFilePromise("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=lightfast.notebook.project=${projectLabel}`,
      ]);
      expect(remainingContainers.trim()).toBe("");
    } finally {
      await manager.close().catch(() => undefined);
      const { stdout: leakedContainers } = await execFilePromise("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=lightfast.notebook.project=${projectLabel}`,
      ]);
      if (leakedContainers.trim()) {
        await execFilePromise("docker", ["rm", "--force", ...leakedContainers.trim().split(/\s+/)]);
      }
      await NodeFSP.rm(root, { force: true, recursive: true });
    }
  },
  60_000,
);
