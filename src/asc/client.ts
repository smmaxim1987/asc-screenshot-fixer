import { getToken, invalidateToken } from './auth.js';
import type { Credentials } from '../types.js';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** A single network request with a timeout: bare fetch can hang indefinitely. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface JsonApiDocument {
  data?: unknown;
  included?: unknown[];
  errors?: { status?: string; title?: string; detail?: string }[];
  links?: { next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

const MAX_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Node collapses every network problem into "fetch failed" — useless for
 * diagnostics. Pull the real reason out of `cause` and explain it in English.
 */
function explainNetworkError(error: unknown): string {
  const parts: string[] = [];

  const current = error as { cause?: unknown; message?: string };
  parts.push(current.message ?? String(error));

  const cause = current.cause as { code?: string; message?: string } | undefined;
  if (cause?.code) {
    parts.push(`(${cause.code})`);
  }

  const text = parts.join(' ').toLowerCase();

  if (text.includes('enotfound') || text.includes('getaddrinfo')) {
    return (
      'Could not resolve the DNS name api.appstoreconnect.apple.com. ' +
      'The internet works, but the macOS system resolver is not responding. ' +
      'Switching to another DNS server helps: System Settings → Network → ' +
      'your network → Details → DNS (e.g. 1.1.1.1 or 8.8.8.8).'
    );
  }
  if (text.includes('econnrefused')) {
    return 'Connection refused — a firewall or proxy is most likely blocking it.';
  }
  if (text.includes('econnreset') || text.includes('socket hang up')) {
    return 'Connection dropped. Check any VPN or corporate proxy — they often break TLS connections to Apple.';
  }
  if (text.includes('etimedout') || text.includes('aborted')) {
    return 'Timed out waiting for a response from Apple. Check your connection and try again.';
  }
  if (text.includes('certificate') || text.includes('tls') || text.includes('ssl')) {
    return 'TLS error: the system does not trust the certificate. Check the system clock and any corporate MITM proxy.';
  }

  return `Network error while contacting App Store Connect: ${parts.join(' ')}`;
}

function describe(body: JsonApiDocument | undefined, status: number): string {
  const first = body?.errors?.[0];
  if (first) {
    return `${first.title ?? 'API error'}${first.detail ? `: ${first.detail}` : ''}`;
  }
  return `App Store Connect returned HTTP ${status}`;
}

export { explainNetworkError };

/**
 * A thin wrapper over the ASC API: JWT auth, retries on 401/429/5xx,
 * and automatic traversal of every pagination page.
 */
export class AscClient {
  constructor(
    private readonly credentials: Credentials,
    private readonly baseUrl = process.env.ASC_API_BASE_URL ?? 'https://api.appstoreconnect.apple.com',
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<JsonApiDocument> {
    let lastError: Error | undefined;
    /** Retry a 401 exactly once: reissuing the token a second time will not help. */
    let retriedUnauthorized = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const token = await getToken(this.credentials);

      let response: Response;
      try {
        response = await fetchWithTimeout(
          path.startsWith('http') ? path : `${this.baseUrl}${path}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
        );
      } catch (error) {
        // Network failure: drop, DNS, timeout. Retried — these are transient.
        if (attempt < MAX_RETRIES) {
          await sleep(2 ** attempt * 500);
          continue;
        }
        throw new ApiError(explainNetworkError(error), 0);
      }

      if (response.status === 204 || response.status === 202) {
        return {};
      }

      const text = await response.text();
      let parsed: JsonApiDocument | undefined;
      if (text) {
        try {
          parsed = JSON.parse(text) as JsonApiDocument;
        } catch {
          parsed = undefined;
        }
      }

      if (response.ok) {
        return parsed ?? {};
      }

      lastError = new ApiError(describe(parsed, response.status), response.status, parsed?.errors);

      // Token expired — reissue it and retry once.
      if (response.status === 401 && !retriedUnauthorized) {
        retriedUnauthorized = true;
        invalidateToken();
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      throw lastError;
    }

    throw lastError ?? new ApiError('Request was not performed', 0);
  }

  /** GET with automatic traversal of `links.next`. */
  async getAll<T = unknown>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;

    while (next) {
      const document: JsonApiDocument = await this.request('GET', next);
      const page = Array.isArray(document.data) ? (document.data as T[]) : [];
      items.push(...page);
      next = document.links?.next;
    }

    return items;
  }

  /** GET returning the whole JSON document — needed when `included` matters. */
  async getDocument<T = JsonApiDocument>(path: string): Promise<T> {
    return (await this.request('GET', path)) as T;
  }

async get<T = unknown>(path: string): Promise<T> {
    const document = await this.request('GET', path);
    return document.data as T;
  }

  async delete(path: string): Promise<void> {
    await this.request('DELETE', path);
  }
}