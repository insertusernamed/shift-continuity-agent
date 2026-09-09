/**
 * Bounded readiness poll for smoke/scripts that restart the HTTP server and
 * must not race the socket handoff. Used only by tooling: product requests
 * never retry or hide connection failures.
 *
 * Tolerance policy (deliberate): while a server is starting, connection-level
 * errors (refused/reset/aborted) are an expected, transient condition and are
 * retried until the deadline. Any *HTTP* response with an error status is a
 * real failure of the server under test and fails immediately.
 */
export async function awaitReadiness(options: {
  url: string;
  /** Total budget for the server to become ready. */
  timeoutMs?: number;
  /** Delay between probes. */
  pollMs?: number;
  /** Fetch injected for tests. */
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { url, timeoutMs = 5000, pollMs = 100, fetchImpl = fetch } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      // Fresh connection per probe: a pooled socket from the dying instance
      // is exactly the failure this helper exists to avoid.
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { connection: "close" },
        signal: AbortSignal.timeout(Math.min(1000, Math.max(pollMs, 1)) * 10),
      });
      await res.body?.cancel(); // don't block on body consumption
      if (res.ok) return;
      throw new Error(`readiness probe failed: ${url} answered HTTP ${res.status}`);
    } catch (err) {
      if (isConnectionError(err)) {
        // Expected while the server is binding: retry until the deadline.
      } else {
        throw err;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function isConnectionError(err: unknown): boolean {
  const codes = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "EADDRINUSE", "UND_ERR_SOCKET", "ABORT_ERR"]);
  let current: unknown = err;
  while (current instanceof Error) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code !== undefined && codes.has(code)) return true;
    if (code === "ENOTFOUND" || code === "ETIMEDOUT") return true;
    current = (current as any).cause; // undici nests the cause on fetch failures
  }
  return false;
}
