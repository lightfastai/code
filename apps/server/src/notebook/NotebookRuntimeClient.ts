// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Local HTTP and Docker exec are isolation boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";

import {
  NotebookExecutionEvent,
  type NotebookExecutionEvent as ExecutionEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const JSON_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 130_000;
const decodeEvent = Schema.decodeUnknownSync(NotebookExecutionEvent);

export interface RuntimeSessionOpenRequest {
  readonly sessionId: string;
  readonly commandId: string;
  readonly kernelName: string;
}

export interface RuntimeExecuteRequest {
  readonly sessionId: string;
  readonly commandId: string;
  readonly executionId: string;
  readonly code: string;
}

export interface RuntimeSessionCommandRequest {
  readonly sessionId: string;
  readonly commandId: string;
}

export interface NotebookRuntimeClientLike {
  readonly health: () => Promise<void>;
  readonly open: (input: RuntimeSessionOpenRequest) => Promise<ReadonlyArray<ExecutionEvent>>;
  readonly execute: (input: RuntimeExecuteRequest) => AsyncIterable<ExecutionEvent>;
  readonly interrupt: (
    input: RuntimeSessionCommandRequest,
  ) => Promise<ReadonlyArray<ExecutionEvent>>;
  readonly restart: (input: RuntimeSessionCommandRequest) => Promise<ReadonlyArray<ExecutionEvent>>;
  readonly dispose: (input: RuntimeSessionCommandRequest) => Promise<ReadonlyArray<ExecutionEvent>>;
  readonly eventsAfter: (
    sessionId: string,
    afterSequence: number,
  ) => Promise<ReadonlyArray<ExecutionEvent>>;
}

export class NotebookRuntimeClientError extends Error {
  readonly reason: "transport" | "http" | "protocol";
  readonly statusCode: number | undefined;

  constructor(options: {
    readonly reason: "transport" | "http" | "protocol";
    readonly message: string;
    readonly statusCode?: number;
  }) {
    super(options.message);
    this.name = "NotebookRuntimeClientError";
    this.reason = options.reason;
    this.statusCode = options.statusCode;
  }
}

export interface NotebookRuntimeClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly socketPath?: string;
  readonly requestTimeoutMs?: number;
}

interface RuntimeEventsResponse {
  readonly events: ReadonlyArray<ExecutionEvent>;
}

export class NotebookRuntimeClient implements NotebookRuntimeClientLike {
  readonly #token: string;
  readonly #baseUrl: URL | undefined;
  readonly #socketPath: string | undefined;
  readonly #requestTimeoutMs: number;

  constructor(options: NotebookRuntimeClientOptions) {
    if (!options.token) throw new Error("Notebook runtime authentication token is required.");
    if ((options.baseUrl === undefined) === (options.socketPath === undefined)) {
      throw new Error("Exactly one notebook runtime transport must be configured.");
    }
    this.#token = options.token;
    this.#baseUrl = options.baseUrl === undefined ? undefined : new URL(options.baseUrl);
    this.#socketPath = options.socketPath;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async health(): Promise<void> {
    const response = await this.#request("GET", "/v1/health");
    response.resume();
  }

  open(input: RuntimeSessionOpenRequest): Promise<ReadonlyArray<ExecutionEvent>> {
    return this.#eventRequest("POST", "/v1/sessions", input);
  }

  async *execute(input: RuntimeExecuteRequest): AsyncIterable<ExecutionEvent> {
    const response = await this.#request(
      "POST",
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/execute`,
      input,
    );
    let buffered = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response) {
        buffered += decoder.decode(chunk as Uint8Array, { stream: true });
        while (true) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line) yield this.#decodeEventLine(line);
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) yield this.#decodeEventLine(buffered);
    } finally {
      response.destroy();
    }
  }

  interrupt(input: RuntimeSessionCommandRequest): Promise<ReadonlyArray<ExecutionEvent>> {
    return this.#eventRequest(
      "POST",
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/interrupt`,
      input,
    );
  }

  restart(input: RuntimeSessionCommandRequest): Promise<ReadonlyArray<ExecutionEvent>> {
    return this.#eventRequest(
      "POST",
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/restart`,
      input,
    );
  }

  dispose(input: RuntimeSessionCommandRequest): Promise<ReadonlyArray<ExecutionEvent>> {
    return this.#eventRequest(
      "POST",
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/dispose`,
      input,
    );
  }

  eventsAfter(sessionId: string, afterSequence: number): Promise<ReadonlyArray<ExecutionEvent>> {
    return this.#eventRequest(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?afterSequence=${afterSequence}`,
    );
  }

  async #eventRequest(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<ReadonlyArray<ExecutionEvent>> {
    const response = await this.#request(method, path, body);
    const payload = await this.#readJson(response);
    if (typeof payload !== "object" || payload === null || !("events" in payload)) {
      throw new NotebookRuntimeClientError({
        reason: "protocol",
        message: "Notebook runtime returned an invalid events response.",
      });
    }
    const events = (payload as { readonly events: unknown }).events;
    if (!Array.isArray(events)) {
      throw new NotebookRuntimeClientError({
        reason: "protocol",
        message: "Notebook runtime returned an invalid events response.",
      });
    }
    return events.map((event) => this.#decodeEvent(event));
  }

  #decodeEventLine(line: string): ExecutionEvent {
    try {
      return this.#decodeEvent(JSON.parse(line));
    } catch {
      throw new NotebookRuntimeClientError({
        reason: "protocol",
        message: "Notebook runtime returned malformed execution data.",
      });
    }
  }

  #decodeEvent(value: unknown): ExecutionEvent {
    try {
      return decodeEvent(value);
    } catch {
      throw new NotebookRuntimeClientError({
        reason: "protocol",
        message: "Notebook runtime returned an invalid execution event.",
      });
    }
  }

  async #readJson(response: NodeHttp.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > JSON_RESPONSE_LIMIT_BYTES) {
        response.destroy();
        throw new NotebookRuntimeClientError({
          reason: "protocol",
          message: "Notebook runtime response exceeded the client limit.",
        });
      }
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString()) as RuntimeEventsResponse;
    } catch {
      throw new NotebookRuntimeClientError({
        reason: "protocol",
        message: "Notebook runtime returned malformed JSON.",
      });
    }
  }

  #request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<NodeHttp.IncomingMessage> {
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const common: NodeHttp.RequestOptions = {
        method,
        path,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json, application/x-ndjson",
          ...(encodedBody === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(encodedBody),
              }),
        },
      };
      const options: NodeHttp.RequestOptions =
        this.#socketPath === undefined
          ? {
              ...common,
              protocol: this.#baseUrl!.protocol,
              hostname: this.#baseUrl!.hostname,
              port: this.#baseUrl!.port,
            }
          : { ...common, socketPath: this.#socketPath };
      const request = NodeHttp.request(options, (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(
            new NotebookRuntimeClientError({
              reason: "http",
              statusCode,
              message: `Notebook runtime request failed with HTTP ${statusCode}.`,
            }),
          );
          return;
        }
        resolve(response);
      });
      request.setTimeout(this.#requestTimeoutMs, () => {
        request.destroy(new Error("runtime request timeout"));
      });
      request.on("error", () =>
        reject(
          new NotebookRuntimeClientError({
            reason: "transport",
            message: "Could not reach the notebook runtime.",
          }),
        ),
      );
      request.end(encodedBody);
    });
  }
}

export interface DockerExecNotebookRuntimeClientOptions {
  readonly containerId: string;
  readonly token: string;
  readonly requestTimeoutMs?: number;
}

/**
 * Docker Desktop cannot carry a live Unix socket through its VM bind mount.
 * This transport preserves `--network none`: a same-UID `docker exec` helper
 * connects to container loopback and receives the bearer token on stdin only.
 */
export class DockerExecNotebookRuntimeClient implements NotebookRuntimeClientLike {
  readonly #containerId: string;
  readonly #token: string;
  readonly #requestTimeoutMs: number;

  constructor(options: DockerExecNotebookRuntimeClientOptions) {
    this.#containerId = options.containerId;
    this.#token = options.token;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async health(): Promise<void> {
    for await (const _chunk of this.#request("GET", "/v1/health")) {
      // Drain the short response so docker exec exits before readiness succeeds.
    }
  }

  open(input: RuntimeSessionOpenRequest): Promise<ReadonlyArray<ExecutionEvent>> {
    return this.#eventRequest("POST", "/v1/sessions", input);
  }

  async *execute(input: RuntimeExecuteRequest): AsyncIterable<ExecutionEvent> {
    let buffered = "";
    const decoder = new TextDecoder();
    for await (const chunk of this.#request(
      "POST",
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/execute`,
      input,
    )) {
      buffered += decoder.decode(chunk, { stream: true });
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) yield this.#decodeEvent(line);
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) yield this.#decodeEvent(buffered);
  }

  interrupt(input: RuntimeSessionCommandRequest): Promise<ReadonlyArray<ExecutionEvent>> {
    return this.#eventRequest(
      "POST",
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/interrupt`,
      input,
    );
  }

  restart(input: RuntimeSessionCommandRequest): Promise<ReadonlyArray<ExecutionEvent>> {
    return this.#eventRequest(
      "POST",
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/restart`,
      input,
    );
  }

  dispose(input: RuntimeSessionCommandRequest): Promise<ReadonlyArray<ExecutionEvent>> {
    return this.#eventRequest(
      "POST",
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/dispose`,
      input,
    );
  }

  eventsAfter(sessionId: string, afterSequence: number): Promise<ReadonlyArray<ExecutionEvent>> {
    return this.#eventRequest(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?afterSequence=${afterSequence}`,
    );
  }

  async #eventRequest(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<ReadonlyArray<ExecutionEvent>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of this.#request(method, path, body)) {
      total += chunk.length;
      if (total > JSON_RESPONSE_LIMIT_BYTES) {
        throw new NotebookRuntimeClientError({
          reason: "protocol",
          message: "Notebook runtime response exceeded the client limit.",
        });
      }
      chunks.push(Buffer.from(chunk));
    }
    try {
      const decoded = JSON.parse(Buffer.concat(chunks).toString()) as { readonly events?: unknown };
      if (!Array.isArray(decoded.events)) throw new Error("missing events");
      return decoded.events.map((event) => decodeEvent(event));
    } catch {
      throw new NotebookRuntimeClientError({
        reason: "protocol",
        message: "Notebook runtime returned malformed execution data.",
      });
    }
  }

  #decodeEvent(line: string): ExecutionEvent {
    try {
      return decodeEvent(JSON.parse(line));
    } catch {
      throw new NotebookRuntimeClientError({
        reason: "protocol",
        message: "Notebook runtime returned malformed execution data.",
      });
    }
  }

  async *#request(method: "GET" | "POST", path: string, body?: unknown): AsyncIterable<Buffer> {
    const child = NodeChildProcess.spawn(
      "docker",
      ["exec", "--interactive", this.#containerId, "python", "-m", "runtime", "proxy"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), this.#requestTimeoutMs);
    const close = new Promise<number | null>((resolvePromise, reject) => {
      child.once("error", () =>
        reject(
          new NotebookRuntimeClientError({
            reason: "transport",
            message: "Could not reach the notebook runtime.",
          }),
        ),
      );
      child.once("close", resolvePromise);
    });
    child.stdin.end(`${JSON.stringify({ method, path, token: this.#token, body })}\n`);
    let header = Buffer.alloc(0);
    let statusCode: number | undefined;
    try {
      for await (const rawChunk of child.stdout) {
        const chunk = Buffer.from(rawChunk);
        if (statusCode === undefined) {
          header = Buffer.concat([header, chunk]);
          const newline = header.indexOf(10);
          if (newline < 0) {
            if (header.length > 1024) throw new Error("oversized proxy header");
            continue;
          }
          try {
            const parsed = JSON.parse(header.subarray(0, newline).toString()) as {
              readonly status?: unknown;
            };
            if (typeof parsed.status !== "number") throw new Error("missing proxy status");
            statusCode = parsed.status;
          } catch {
            throw new NotebookRuntimeClientError({
              reason: "protocol",
              message: "Notebook runtime proxy returned an invalid response.",
            });
          }
          if (statusCode < 200 || statusCode >= 300) {
            throw new NotebookRuntimeClientError({
              reason: "http",
              statusCode,
              message: `Notebook runtime request failed with HTTP ${statusCode}.`,
            });
          }
          const remaining = header.subarray(newline + 1);
          if (remaining.length > 0) yield remaining;
          continue;
        }
        yield chunk;
      }
      const exitCode = await close;
      if (exitCode !== 0 || statusCode === undefined) {
        throw new NotebookRuntimeClientError({
          reason: "transport",
          message: "Notebook runtime proxy exited unexpectedly.",
        });
      }
    } catch (error) {
      child.kill("SIGKILL");
      if (error instanceof NotebookRuntimeClientError) throw error;
      throw new NotebookRuntimeClientError({
        reason: "protocol",
        message: "Notebook runtime proxy returned an invalid response.",
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
