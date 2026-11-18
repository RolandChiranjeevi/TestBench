/**
 * A small HTTP client for the TestBench agent-request routes. It holds the request token (tbrq_) and sends it as `Authorization: Bearer`; it never prints it.
 * Every failure becomes a TestBenchError with a message an agent can act on. The message never contains the token, a header or the raw body of an unexpected error:
 * only the `error` text of a refusal TestBench itself wrote (it never holds a token), cut to 500 characters.
 */
export class TestBenchError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Client {
  /** The parsed JSON answer, or null for an empty one. */
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown | null>;
}

export function makeClient(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Client {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async call(method, path, body) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${opts.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
      } catch (e) {
        const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
        throw new TestBenchError(0, timedOut ? `TestBench at ${base} did not answer in time.` : `Could not reach TestBench at ${base}. Is it running, and is TESTBENCH_URL right?`);
      }
      const raw = await res.text();
      let data: unknown = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch { /* not JSON: handled below */ }
      if (res.ok) return data;
      const said = (data as { error?: unknown } | null)?.error;
      const detail = typeof said === "string" ? said.slice(0, 500) : "";
      switch (res.status) {
        case 401: throw new TestBenchError(401, "TestBench refused the token (missing, wrong or revoked). Do not retry with this token and do not look for another one: tell the user, who can make a request token for the project in TestBench and set TESTBENCH_TOKEN.");
        case 403: throw new TestBenchError(403, `TestBench says this token may not do that. ${detail}`.trim());
        case 404: throw new TestBenchError(404, `Not found. ${detail || "There is no such request in this project, or TESTBENCH_PROJECT_ID is wrong."}`.trim());
        case 409: throw new TestBenchError(409, `Conflict: ${detail || "the request is not in the right state."}`);
        case 413: throw new TestBenchError(413, "TestBench refused the input: it is too large (at most 256 kB for a report of results). Send fewer results, or shorter notes, in each call.");
        case 429: throw new TestBenchError(429, `Slow down: ${detail || "too many requests."} Wait and try again.`);
        case 400: throw new TestBenchError(400, `TestBench refused the input: ${detail || "invalid"}`);
        default: throw new TestBenchError(res.status, `TestBench answered ${res.status}.`);
      }
    },
  };
}
