import type { EntraTokenProvider } from "../identity/entra.js";

export interface AzureDevOpsRetryEvent {
  readonly status: number;
  readonly attempt: number;
  readonly delayMs: number;
}

export class AzureDevOpsError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class AzureDevOpsClient {
  public constructor(
    private readonly organizationUrl: string,
    private readonly tokenProvider: Pick<EntraTokenProvider, "getAzureDevOpsToken">,
    private readonly fetcher: typeof fetch = fetch,
    private readonly maxRetries = 4,
    private readonly onRetry?: (event: AzureDevOpsRetryEvent) => void,
  ) {}

  public async get<T>(path: string, query: Readonly<Record<string, string>> = {}): Promise<T> {
    const url = this.url(path, query);
    return this.request<T>(url, { method: "GET" });
  }

  public async send<T>(
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
    query: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    return this.request<T>(this.url(path, query), {
      method,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  public async *pages<T>(
    path: string,
    query: Readonly<Record<string, string>> = {},
  ): AsyncGenerator<readonly T[]> {
    let continuationToken: string | undefined;
    do {
      const response = await this.raw(
        path,
        continuationToken ? { ...query, continuationToken } : query,
      );
      const payload = (await response.json()) as { value: T[] };
      yield payload.value;
      continuationToken =
        response.headers.get("x-ms-continuationtoken") ??
        response.headers.get("x-ms-continuation-token") ??
        undefined;
    } while (continuationToken);
  }

  private async raw(path: string, query: Readonly<Record<string, string>>): Promise<Response> {
    return this.request<Response>(this.url(path, query), { method: "GET" }, true);
  }

  private url(path: string, query: Readonly<Record<string, string>>): URL {
    const base = new URL(this.organizationUrl);
    if (base.protocol !== "https:" || base.hostname !== "dev.azure.com") {
      throw new Error("Azure DevOps URL must use https://dev.azure.com");
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
      throw new Error("Absolute Azure DevOps request paths are forbidden");
    }
    const url = new URL(path.replace(/^\/+/, ""), base.toString().replace(/\/?$/, "/"));
    if (url.origin !== base.origin) throw new Error("Cross-origin Azure DevOps request rejected");
    url.searchParams.set("api-version", "7.1");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private async request<T>(url: URL, init: RequestInit, returnResponse = false): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const token = await this.tokenProvider.getAzureDevOpsToken();
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      headers.set("accept", "application/json");
      const response = await this.fetcher(url, { ...init, headers });
      if (response.ok) return (returnResponse ? response : await response.json()) as T;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === this.maxRetries) {
        throw new AzureDevOpsError(
          `Azure DevOps request failed (${String(response.status)})`,
          response.status,
          retryable,
        );
      }
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      const delay = retryAfter > 0 ? retryAfter * 1_000 : Math.min(250 * 2 ** attempt, 4_000);
      this.onRetry?.({ status: response.status, attempt: attempt + 1, delayMs: delay });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new Error("unreachable");
  }
}
