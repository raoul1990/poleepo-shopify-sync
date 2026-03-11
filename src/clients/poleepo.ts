import { config } from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import {
  TokenData,
  TOKEN_REFRESH_MARGIN_MS,
  fetchWithTimeout,
  requestWithAuthRetry,
} from '../utils/api-request';

export interface PoleepoTag {
  id?: number;
  value: string;
}

export interface PoleepoProduct {
  id: number;
  sku?: string;
  title?: string;
  tags: PoleepoTag[];
  [key: string]: unknown;
}

export interface PoleepoPublication {
  id: number;
  sku: string;
  source_id: string;  // Shopify product ID
  source: { id: string; name: string };
  [key: string]: unknown;
}

export class PoleepoClient {
  private token: TokenData | null = null;
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = config.poleepo.baseUrl;
  }

  private async authenticate(): Promise<void> {
    logger.debug('Authenticating with Poleepo...');

    const res = await fetchWithTimeout(`${this.baseUrl}/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: config.poleepo.apiKey,
        client_secret: config.poleepo.apiSecret,
        grant: 'client_credentials',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Poleepo auth failed (${res.status}): ${text}`);
    }

    const json = await res.json() as { data: { access_token: string; duration: number } };
    this.token = {
      accessToken: json.data.access_token,
      expiresAt: Date.now() + json.data.duration * 1000,
    };
    logger.info('Poleepo authentication successful');
  }

  private isTokenValid(): boolean {
    if (!this.token) return false;
    return Date.now() < this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS;
  }

  private async ensureToken(): Promise<string> {
    if (!this.isTokenValid()) {
      await this.authenticate();
    }
    return this.token!.accessToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureToken();

    return requestWithAuthRetry<T>({
      method,
      url: `${this.baseUrl}${path}`,
      body,
      tokenHeaderName: 'Authorization',
      getToken: () => `Bearer ${this.token!.accessToken}`,
      reauthenticate: () => this.authenticate(),
      label: 'Poleepo',
    });
  }

  async getProducts(offset: number = 0, max: number = 50, active: boolean = true): Promise<{ data: PoleepoProduct[]; total?: number }> {
    return withRetry(() =>
      this.request<{ data: PoleepoProduct[]; total?: number }>(
        'GET',
        `/products?offset=${offset}&max=${max}&active=${active}`
      )
    );
  }

  async getAllProducts(batchSize: number = 50): Promise<PoleepoProduct[]> {
    const allProducts: PoleepoProduct[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getProducts(offset, batchSize);
      const products = response.data || [];
      allProducts.push(...products);

      if (products.length < batchSize) {
        hasMore = false;
      } else {
        offset += batchSize;
      }
      logger.debug(`Poleepo: fetched ${allProducts.length} products so far...`);
    }

    return allProducts;
  }

  async getProduct(id: number): Promise<{ data: PoleepoProduct }> {
    return withRetry(() =>
      this.request<{ data: PoleepoProduct }>('GET', `/products/${id}`)
    );
  }

  async updateProduct(id: number, data: { tags: { id?: number; value: string }[] }): Promise<{ data: PoleepoProduct }> {
    return withRetry(() =>
      this.request<{ data: PoleepoProduct }>('PUT', `/products/${id}`, data)
    );
  }

  async getPublications(params: {
    source?: string;
    product?: number;
    active?: boolean;
    identifier?: string;
    offset?: number;
    max?: number;
  } = {}): Promise<{ data: PoleepoPublication[] }> {
    const query = new URLSearchParams();
    if (params.source) query.set('source', params.source);
    if (params.product !== undefined) query.set('product', String(params.product));
    if (params.active !== undefined) query.set('active', String(params.active));
    if (params.identifier) query.set('identifier', params.identifier);
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.max !== undefined) query.set('max', String(params.max));

    const qs = query.toString();
    return withRetry(() =>
      this.request<{ data: PoleepoPublication[] }>(
        'GET',
        `/channels/publications${qs ? '?' + qs : ''}`
      )
    );
  }

  async getAllPublications(batchSize: number = 50): Promise<PoleepoPublication[]> {
    const all: PoleepoPublication[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getPublications({
        source: 'SHOPIFY',
        offset,
        max: batchSize,
      });
      const pubs = response.data || [];
      all.push(...pubs);

      if (pubs.length < batchSize) {
        hasMore = false;
      } else {
        offset += batchSize;
      }
      logger.debug(`Poleepo: fetched ${all.length} publications so far...`);
    }

    return all;
  }
}
