import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { awaitReadiness } from "./readiness.ts";

type Stub = { url: string; close: () => Promise<void> };

/** Tiny one-shot HTTP stub so these tests never depend on the app server. */
function stubServerOnPort(port: number, status = 200): Promise<Stub> {
  return new Promise((resolve) => {
    const nodeServer = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("ok");
    });
    nodeServer.listen(port, "127.0.0.1", () => {
      const address = nodeServer.address();
      const resolvedPort = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${resolvedPort}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            nodeServer.closeAllConnections();
            nodeServer.close(() => resolveClose());
          }),
      });
    });
  });
}

/** Reserve a port with a bare listener so a later stub can bind the same one. */
async function reservePort(): Promise<{ port: number; release: () => Promise<void> }> {
  const holder: Server = createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const port = (holder.address() as { port: number }).port;
  return {
    port,
    release: () =>
      new Promise<void>((resolve) => {
        holder.close(() => resolve());
      }),
  };
}

describe("awaitReadiness", () => {
  it("resolves immediately once the endpoint answers", async () => {
    const stub = await stubServerOnPort(0);
    try {
      const started = Date.now();
      await awaitReadiness({ url: stub.url, timeoutMs: 2000, pollMs: 50 });
      assert.ok(Date.now() - started < 1000, "an already-ready server must not be polled for long");
    } finally {
      await stub.close();
    }
  });

  it("tolerates connection-refused during polling and succeeds once the server binds the port", async () => {
    // Simulate a restart: the port is free (refused) when polling begins and
    // the real server binds it shortly after.
    const reserved = await reservePort();
    try {
      await reserved.release();
      const url = `http://127.0.0.1:${reserved.port}`;
      const poll = awaitReadiness({ url, timeoutMs: 4000, pollMs: 40 });
      const stubPromise = new Promise<Stub>((resolve) => setTimeout(() => resolve(stubServerOnPort(reserved.port)), 150));
      await poll; // must ride out the refused window, then succeed
      await stubPromise.then((s) => s.close());
    } finally {
      await reserved.release();
    }
  });

  it("rejects on HTTP error status — only connection-level errors are tolerated while polling", async () => {
    const stub = await stubServerOnPort(0, 500);
    try {
      await assert.rejects(
        awaitReadiness({ url: stub.url, timeoutMs: 1000, pollMs: 50 }),
        (err: Error) => /readiness probe failed/i.test(err.message) && /500/.test(err.message),
      );
    } finally {
      await stub.close();
    }
  });

  it("times out with a clear error when the server never becomes healthy", async () => {
    // A reserved-then-released port gives a real ECONNREFUSED (undici refuses
    // to dial low "bad ports" like 1, which would not exercise this path).
    const reserved = await reservePort();
    await reserved.release();
    const started = Date.now();
    await assert.rejects(
      awaitReadiness({ url: `http://127.0.0.1:${reserved.port}`, timeoutMs: 250, pollMs: 50 }),
      /did not become ready/i,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 200 && elapsed < 2000, `must stop polling at the deadline (took ${elapsed}ms)`);
  });
});
