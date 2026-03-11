import { config } from '../config';
import { logger } from '../utils/logger';
import { RateLimiter } from '../utils/rate-limiter';
import { withRetry } from '../utils/retry';
import {
  TokenData,
  TOKEN_REFRESH_MARGIN_MS,
  fetchWithTimeout,
  requestWithAuthRetry,
} from '../utils/api-request';

export interface ShopifyProduct {
  id: number;
  title?: string;
  tags: string;
  updated_at?: string;
  [key: string]: unknown;
}

export class ShopifyClient {
  private token: TokenData | null = null;
  private readonly baseUrl: string;
  private readonly rateLimiter: RateLimiter;

  constructor() {
    this.baseUrl = `https://${config.shopify.store}/admin/api/${config.shopify.apiVersion}`;
    // Shopify bucket leak: 2 req/sec, bucket size 40
    this.rateLimiter = new RateLimiter(40, 2);

    // If a static access token is provided, use it immediately
    if (config.shopify.accessToken) {
      this.token = {
        accessToken: config.shopify.accessToken,
        expiresAt: Infinity,
      };
      logger.info('Shopify: using static access token from SHOPIFY_ACCESS_TOKEN');
    }
  }

  private async authenticateClientCredentials(): Promise<void> {
    if (!config.shopify.clientId || !config.shopify.clientSecret) {
      throw new Error(
        'Shopify auth failed: neither SHOPIFY_ACCESS_TOKEN nor SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET are configured'
      );
    }

    logger.debug('Authenticating with Shopify via client_credentials...');
    const tokenUrl = `https://${config.shopify.store}/admin/oauth/access_token`;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.shopify.clientId,
      client_secret: config.shopify.clientSecret,
    });

    const res = await fetchWithTimeout(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      const clean = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      throw new Error(`Shopify auth failed (${res.status}): ${clean.substring(0, 300)}`);
    }

    const json = await res.json() as { access_token: string; expires_in: number };
    this.token = {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    logger.info(`Shopify authentication successful (expires in ${json.expires_in}s)`);
  }

  private isTokenValid(): boolean {
    if (!this.token) return false;
    // Static tokens (Infinity) are always valid until a 401 proves otherwise
    if (this.token.expiresAt === Infinity) return true;
    return Date.now() < this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS;
  }

  private async ensureToken(): Promise<string> {
    if (!this.isTokenValid()) {
      await this.authenticateClientCredentials();
    }
    return this.token!.accessToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureToken();

    return requestWithAuthRetry<T>({
      method,
      url: `${this.baseUrl}${path}`,
      body,
      tokenHeaderName: 'X-Shopify-Access-Token',
      getToken: () => this.token!.accessToken,
      reauthenticate: async () => {
        this.token = null;
        await this.authenticateClientCredentials();
      },
      rateLimiter: this.rateLimiter,
      label: 'Shopify',
    });
  }

  async getProducts(params: {
    updatedAtMin?: string;
    sinceId?: number;
    limit?: number;
    fields?: string;
  } = {}): Promise<{ products: ShopifyProduct[] }> {
    const query = new URLSearchParams();
    if (params.updatedAtMin) query.set('updated_at_min', params.updatedAtMin);
    if (params.sinceId) query.set('since_id', String(params.sinceId));
    query.set('limit', String(params.limit || 250));
    if (params.fields) query.set('fields', params.fields);

    const qs = query.toString();
    return withRetry(() =>
      this.request<{ products: ShopifyProduct[] }>('GET', `/products.json?${qs}`)
    );
  }

  async getAllProducts(updatedAtMin?: string): Promise<ShopifyProduct[]> {
    const allProducts: ShopifyProduct[] = [];
    let sinceId: number | undefined;

    while (true) {
      const response = await this.getProducts({
        updatedAtMin,
        sinceId,
        limit: 250,
        fields: 'id,tags,updated_at,title',
      });
      const products = response.products || [];
      if (products.length === 0) break;

      allProducts.push(...products);
      sinceId = products[products.length - 1].id;
      logger.debug(`Shopify: fetched ${allProducts.length} products so far...`);

      if (products.length < 250) break;
    }

    return allProducts;
  }

  async getProduct(id: number): Promise<{ product: ShopifyProduct }> {
    return withRetry(() =>
      this.request<{ product: ShopifyProduct }>('GET', `/products/${id}.json`)
    );
  }

  async updateProduct(id: number, tags: string): Promise<{ product: ShopifyProduct }> {
    return withRetry(() =>
      this.request<{ product: ShopifyProduct }>('PUT', `/products/${id}.json`, {
        product: { id, tags },
      })
    );
  }
}
