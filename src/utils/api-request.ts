import { logger } from './logger';

export const REQUEST_TIMEOUT_MS = 30_000;
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

export interface TokenData {
  accessToken: string;
  expiresAt: number; // epoch ms — Infinity for static tokens
}

/**
 * Execute a fetch request with timeout via AbortController.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Execute an API request with automatic 401 retry.
 * On 401: calls reauthenticate(), then retries the request once with the new token.
 */
export async function requestWithAuthRetry<T>(opts: {
  method: string;
  url: string;
  body?: unknown;
  tokenHeaderName: string;
  getToken: () => string;
  reauthenticate: () => Promise<void>;
  rateLimiter?: { acquire: () => Promise<void> };
  label: string;
}): Promise<T> {
  if (opts.rateLimiter) await opts.rateLimiter.acquire();

  const buildOptions = (token: string): RequestInit => {
    const reqOpts: RequestInit = {
      method: opts.method,
      headers: {
        [opts.tokenHeaderName]: token,
        'Content-Type': 'application/json',
      },
    };
    if (opts.body !== undefined) {
      reqOpts.body = JSON.stringify(opts.body);
    }
    return reqOpts;
  };

  logger.debug(`${opts.label} ${opts.method} ${opts.url}`);
  const reqOptions = buildOptions(opts.getToken());
  const res = await fetchWithTimeout(opts.url, reqOptions);

  if (res.status === 401) {
    logger.warn(`${opts.label} token expired, re-authenticating...`);
    await opts.reauthenticate();

    if (opts.rateLimiter) await opts.rateLimiter.acquire();
    const retryOptions = buildOptions(opts.getToken());
    const retryRes = await fetchWithTimeout(opts.url, retryOptions);

    if (!retryRes.ok) {
      const text = await retryRes.text();
      throw new Error(`${opts.label} ${opts.method} failed (${retryRes.status}): ${text}`);
    }
    return retryRes.json() as Promise<T>;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${opts.label} ${opts.method} failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<T>;
}
