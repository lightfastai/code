// @effect-diagnostics nodeBuiltinImport:off - The test exercises the Node HTTP transport boundary.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { afterEach, expect, it } from "vite-plus/test";

import { NotebookRuntimeClient, NotebookRuntimeClientError } from "./NotebookRuntimeClient.ts";

const servers: NodeHttp.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

const listen = async (handler: NodeHttp.RequestListener) => {
  const server = NodeHttp.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as NodeNet.AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

it("authenticates every request and parses split NDJSON in order", async () => {
  const authorizations: Array<string | undefined> = [];
  const executeBodies: unknown[] = [];
  const baseUrl = await listen((request, response) => {
    authorizations.push(request.headers.authorization);
    if (request.url?.endsWith("/execute")) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        executeBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(
          '{"type":"accepted","sessionId":"session-1","commandId":"command-1","executionId":"execution-1","cellId":"cell-1","sequence":4,"commandType":"execute"}\n{"type":"stream",',
        );
        setImmediate(() => {
          response.end(
            '"sessionId":"session-1","commandId":"command-1","executionId":"execution-1","sequence":5,"name":"stdout","text":"hello\\n"}\n',
          );
        });
      });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
  });
  const client = new NotebookRuntimeClient({ baseUrl, token: "runtime-secret" });

  await client.health();
  const events = await Array.fromAsync(
    client.execute({
      sessionId: "session-1",
      commandId: "command-1",
      executionId: "execution-1",
      cellId: "cell-1",
      code: "print('hello')",
    }),
  );

  expect(authorizations).toEqual(["Bearer runtime-secret", "Bearer runtime-secret"]);
  expect(events.map((event) => [event.sequence, event.type])).toEqual([
    [4, "accepted"],
    [5, "stream"],
  ]);
  expect(events[1]).toMatchObject({ type: "stream", name: "stdout", text: "hello\n" });
  expect(events[0]).toMatchObject({ type: "accepted", cellId: "cell-1" });
  expect(executeBodies).toEqual([
    expect.objectContaining({ executionId: "execution-1", cellId: "cell-1" }),
  ]);
});

it("supports session lifecycle and resume endpoints", async () => {
  const requests: Array<{ method?: string; url?: string; body: string }> = [];
  const baseUrl = await listen((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.url === undefined ? {} : { url: request.url }),
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"events":[]}');
    });
  });
  const client = new NotebookRuntimeClient({ baseUrl, token: "token" });

  await client.open({ sessionId: "session-1", commandId: "open-1", kernelName: "python3" });
  await client.interrupt({ sessionId: "session-1", commandId: "interrupt-1" });
  await client.restart({ sessionId: "session-1", commandId: "restart-1" });
  await client.eventsAfter("session-1", 12);
  await client.dispose({ sessionId: "session-1", commandId: "dispose-1" });

  expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
    "POST /v1/sessions",
    "POST /v1/sessions/session-1/interrupt",
    "POST /v1/sessions/session-1/restart",
    "GET /v1/sessions/session-1/events?afterSequence=12",
    "POST /v1/sessions/session-1/dispose",
  ]);
});

it("returns bounded protocol errors without response bodies or tokens", async () => {
  const baseUrl = await listen((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(`secret diagnostics ${"x".repeat(10_000)}`);
  });
  const client = new NotebookRuntimeClient({ baseUrl, token: "do-not-leak" });

  const error = await client.health().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(NotebookRuntimeClientError);
  expect(String(error)).toContain("HTTP 500");
  expect(String(error)).not.toMatch(/do-not-leak|secret diagnostics|xxxx/);
});

it("rejects oversized NDJSON lines and aggregate execution bytes", async () => {
  const oversizedLineUrl = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(
      `${JSON.stringify({
        type: "stream",
        sessionId: "session-1",
        commandId: "command-line",
        executionId: "execution-line",
        sequence: 1,
        name: "stdout",
        text: "x".repeat(2 * 1024 * 1024),
      })}\n`,
    );
  });
  const lineClient = new NotebookRuntimeClient({ baseUrl: oversizedLineUrl, token: "token" });
  const lineError = await Array.fromAsync(
    lineClient.execute({
      sessionId: "session-1",
      commandId: "command-line",
      executionId: "execution-line",
      cellId: "cell-line",
      code: "line",
    }),
  ).catch((cause: unknown) => cause);

  expect(lineError).toBeInstanceOf(NotebookRuntimeClientError);
  expect(String(lineError)).toContain("execution frame exceeded");

  const oversizedAggregateUrl = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      response.write(
        `${JSON.stringify({
          type: "stream",
          sessionId: "session-1",
          commandId: "command-aggregate",
          executionId: "execution-aggregate",
          sequence,
          name: "stdout",
          text: "x".repeat(64 * 1024),
        })}\n`,
      );
    }
    response.end();
  });
  const aggregateClient = new NotebookRuntimeClient({
    baseUrl: oversizedAggregateUrl,
    token: "token",
  });
  const aggregateError = await Array.fromAsync(
    aggregateClient.execute({
      sessionId: "session-1",
      commandId: "command-aggregate",
      executionId: "execution-aggregate",
      cellId: "cell-aggregate",
      code: "aggregate",
    }),
  ).catch((cause: unknown) => cause);

  expect(aggregateError).toBeInstanceOf(NotebookRuntimeClientError);
  expect(String(aggregateError)).toContain("execution stream exceeded");
});
