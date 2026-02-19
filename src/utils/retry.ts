import { logger } from './logger';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  onRetry?: (error: unknown, attempt: number) => void;
}

/** Check if an error is transient and worth retrying */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    // Network / timeout errors are always retryable
    if (
      error.name === 'AbortError' ||
      msg.includes('ECONNRESET') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('fetch failed')
    ) {
      return true;
    }
    // HTTP status-based errors: only retry 429 and 5xx
    const statusMatch = msg.match(/\((\d{3})\)/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      return status === 429 || status >= 500;
    }
  }
  // Unknown errors: assume retryable
  return true;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, onRetry } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableError(error) || attempt === maxRetries) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Attempt ${attempt}/${maxRetries} failed: ${message}. Retrying in ${delay}ms...`);
      onRetry?.(error, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unreachable');
}
