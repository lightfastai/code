// @effect-diagnostics nodeBuiltinImport:off - Opt-in Docker integration test exercises host isolation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import type { NotebookExecutionEvent } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { NotebookRuntimeManager } from "./NotebookRuntimeManager.ts";

const execFilePromise = NodeUtil.promisify(NodeChildProcess.execFile);
const liveIt = NodeProcess.env.NOTEBOOK_RUNTIME_LIVE === "1" ? it : it.skip;
const image = NodeProcess.env.NOTEBOOK_RUNTIME_IMAGE ?? "lightfast/notebook-runtime:task5";

const execute = (
  manager: NotebookRuntimeManager,
  sequence: number,
  code: string,
  commandId = `command-${sequence}`,
) =>
  Array.fromAsync(
    manager.execute({
      projectId: "live-project",
      sessionId: "live-session",
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
  "executes and isolates a live Jupyter project container",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "notebook-runtime-live-"));
    const bookPath = NodePath.join(root, "book.txt");
    await NodeFSP.writeFile(bookPath, "readonly-book", { mode: 0o444 });
    const manager = new NotebookRuntimeManager({
      image,
      runtimeRoot: NodePath.join(root, "control"),
      readinessTimeoutMs: 30_000,
    });
    try {
      await manager.open({
        projectId: "live-project",
        sessionId: "live-session",
        commandId: "open-live",
        kernelName: "python3",
        bookPaths: [bookPath],
      });

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

      await execute(
        manager,
        6,
        "counter = globals().get('counter', 0) + 1\ncounter",
        "duplicate-live",
      );
      const duplicate = await execute(
        manager,
        6,
        "counter = globals().get('counter', 0) + 1\ncounter",
        "duplicate-live",
      );
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

      const { stdout: containerId } = await execFilePromise("docker", [
        "ps",
        "-q",
        "--filter",
        "label=lightfast.notebook.project=5b5cd5d2405ffcf3",
      ]);
      expect(containerId.trim()).not.toBe("");
      const { stdout: inspection } = await execFilePromise("docker", [
        "inspect",
        "--format",
        "{{json .HostConfig}}",
        containerId.trim(),
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
        containerId.trim(),
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

      await manager.close();
      await expect(
        execFilePromise("docker", ["inspect", containerId.trim()]),
      ).rejects.toBeDefined();
    } finally {
      await manager.close();
      await NodeFSP.rm(root, { force: true, recursive: true });
    }
  },
  60_000,
);
