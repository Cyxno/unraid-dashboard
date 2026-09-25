import { getEnv } from "@/server/env";

/**
 * Thin typed client for the Unraid GraphQL API.
 *
 * All requests run server-side only (BFF). The API key never leaves the
 * Node process — the browser only talks to this app's own route handlers.
 */
export class UnraidApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UnraidApiError";
    this.status = status;
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export class UnraidClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(
    options: Partial<{
      url: string;
      apiKey: string;
      timeoutMs: number;
    }> = {},
  ) {
    const env = getEnv();
    this.url = `${options.url ?? env.UNRAID_URL}${env.UNRAID_GRAPHQL_PATH}`;
    this.apiKey = options.apiKey ?? env.UNRAID_API_KEY;
    this.timeoutMs = options.timeoutMs ?? env.UNRAID_TIMEOUT_MS;
  }

  /** Full GraphQL endpoint URL — safe to expose (contains no credentials). */
  get targetUrl(): string {
    return this.url;
  }

  async request<TData, TVariables = Record<string, never>>(
    query: string,
    variables?: TVariables,
  ): Promise<TData> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new UnraidApiError(
          `Unraid API request timed out after ${this.timeoutMs}ms`,
          504,
        );
      }
      throw new UnraidApiError(
        `Cannot reach Unraid API: ${error instanceof Error ? error.message : "unknown error"}`,
        502,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new UnraidApiError(
        `Unraid API responded with HTTP ${response.status}`,
        response.status,
      );
    }

    const body = (await response.json()) as GraphQLResponse<TData>;
    if (body.errors?.length) {
      throw new UnraidApiError(
        `Unraid API GraphQL error: ${body.errors.map((error) => error.message).join("; ")}`,
        502,
      );
    }
    if (body.data === undefined) {
      throw new UnraidApiError("Unraid API returned no data", 502);
    }
    return body.data;
  }
}

/** Shared singleton for route handlers. */
let client: UnraidClient | null = null;
export function getUnraidClient(): UnraidClient {
  if (!client) client = new UnraidClient();
  return client;
}
