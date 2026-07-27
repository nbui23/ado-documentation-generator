export interface JiraRetryEvent {
  readonly status: number;
  readonly attempt: number;
  readonly delayMs: number;
}

export class JiraError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class JiraClient {
  private readonly baseUrl: URL;

  public constructor(
    cloudId: string,
    private readonly token: string | (() => string | Promise<string>),
    private readonly fetcher: typeof fetch = fetch,
    private readonly maxRetries = 4,
    private readonly onRetry?: (event: JiraRetryEvent) => void,
  ) {
    if (!cloudId.trim() || /[/\\?#]/.test(cloudId)) throw new Error("Invalid Jira cloud ID");
    this.baseUrl = new URL(`https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/`);
  }

  public get<T>(path: string, query: Readonly<Record<string, string>> = {}): Promise<T> {
    return this.request<T>(this.url(path, query), { method: "GET" });
  }

  public post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(this.url(path), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  private url(path: string, query: Readonly<Record<string, string>> = {}): URL {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
      throw new Error("Absolute Jira request paths are forbidden");
    }
    const url = new URL(path.replace(/^\/+/, ""), this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(this.baseUrl.pathname)) {
      throw new Error("Cross-origin Jira request rejected");
    }
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private async request<T>(url: URL, init: RequestInit): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const headers = new Headers(init.headers);
      const token = typeof this.token === "function" ? await this.token() : this.token;
      headers.set("authorization", `Bearer ${token}`);
      headers.set("accept", "application/json");
      const response = await this.fetcher(url, { ...init, headers });
      if (response.ok) return (await response.json()) as T;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === this.maxRetries) {
        throw new JiraError(
          `Jira request failed (${String(response.status)})`,
          response.status,
          retryable,
        );
      }
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      const delayMs = retryAfter > 0 ? retryAfter * 1_000 : Math.min(250 * 2 ** attempt, 4_000);
      this.onRetry?.({ status: response.status, attempt: attempt + 1, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error("unreachable");
  }
}
