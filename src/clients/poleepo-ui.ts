import { config } from '../config';
import { logger } from '../utils/logger';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const $: any; // jQuery in browser context

export interface TagAssignment {
  tagName: string;
  poleepoProductIds: number[];
}

export interface TagAssignmentResult {
  tagName: string;
  productCount: number;
  success: boolean;
  message: string;
}

const BATCH_SIZE = 200; // Max products per bulk assign request
const INTER_TAG_DELAY_MS = 30_000; // Wait between tag assignments for async processing
const BROWSER_TIMEOUT_MS = 5 * 60 * 1000; // 5 min global timeout for browser operations
const INTER_BATCH_DELAY_MS = 2_000; // Pause between batches within same tag
const LOGIN_TIMEOUT_MS = 15_000;
const PAGE_LOAD_TIMEOUT_MS = 30_000;

// Lazy-loaded Playwright types (avoids loading ~100MB when browser fallback isn't needed)
type Browser = import('playwright').Browser;
type BrowserContext = import('playwright').BrowserContext;
type Page = import('playwright').Page;

export class PoleepoUIClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async init(): Promise<void> {
    if (!config.poleepoWeb.username || !config.poleepoWeb.password) {
      throw new Error('POLEEPO_WEB_USERNAME and POLEEPO_WEB_PASSWORD must be set');
    }

    // Lazy import: Playwright is only loaded when browser fallback is actually needed
    const { chromium } = await import('playwright');

    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      timeout: BROWSER_TIMEOUT_MS,
    });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
  }

  async login(): Promise<void> {
    if (!this.page) throw new Error('PoleepoUIClient not initialized');

    logger.info('Poleepo UI: logging in...');
    await this.page.goto(`${config.poleepoWeb.baseUrl}/login`, {
      waitUntil: 'networkidle',
    });

    await this.page.fill('input[name="username"]', config.poleepoWeb.username);
    await this.page.fill('input[name="password"]', config.poleepoWeb.password);
    await this.page.click('button[type="submit"]');

    await this.page.waitForURL('**/app.poleepo.cloud/**', { timeout: LOGIN_TIMEOUT_MS });
    await this.page.waitForLoadState('networkidle');

    // Verify we're logged in (not on login page)
    const url = this.page.url();
    if (url.includes('/login') || url.includes('/accedi')) {
      throw new Error('Poleepo UI: login failed - still on login page');
    }

    logger.info('Poleepo UI: login successful');
  }

  private async ensureOnProductPage(): Promise<void> {
    if (!this.page) throw new Error('PoleepoUIClient not initialized');

    const url = this.page.url();
    if (!url.includes('/product/index')) {
      await this.page.goto(`${config.poleepoWeb.baseUrl}/product/index`, {
        waitUntil: 'networkidle',
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });
    }
  }

  async tagExists(tagName: string): Promise<boolean> {
    await this.ensureOnProductPage();
    const results = await this.page!.evaluate(async (term: string) => {
      return new Promise<{ results: { id: string; text: string }[] }>((resolve) => {
        ((globalThis as any).$ || (globalThis as any).jQuery).ajax({
          url: '/product/getTags.json',
          data: { term, insert: 'on' },
          dataType: 'json',
          success: (data: any) => resolve(data),
          error: () => resolve({ results: [] }),
        });
      });
    }, tagName);

    return results.results.some(
      (r) => r.text.toLowerCase() === tagName.toLowerCase()
    );
  }

  async getAvailableTags(): Promise<{ id: string; text: string }[]> {
    await this.ensureOnProductPage();
    const results = await this.page!.evaluate(async () => {
      return new Promise<{ results: { id: string; text: string }[] }>((resolve) => {
        ((globalThis as any).$ || (globalThis as any).jQuery).ajax({
          url: '/product/getTags.json',
          data: { term: '', insert: 'on' },
          dataType: 'json',
          success: (data: any) => resolve(data),
          error: () => resolve({ results: [] }),
        });
      });
    });
    return results.results;
  }

  async bulkAssignTag(
    tagName: string,
    productIds: number[]
  ): Promise<TagAssignmentResult> {
    if (productIds.length === 0) {
      return { tagName, productCount: 0, success: true, message: 'No products to assign' };
    }

    await this.ensureOnProductPage();

    let totalAssigned = 0;
    const batchCount = Math.ceil(productIds.length / BATCH_SIZE);

    for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
      const batch = productIds.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      logger.info(
        `Poleepo UI: assigning tag "${tagName}" - batch ${batchNum}/${batchCount} (${batch.length} products)`
      );

      const result = await this.page!.evaluate(
        async (params: { tag: string; ids: number[] }) => {
          return new Promise<{ status: number; body: string }>((resolve) => {
            const formData = params.ids
              .map((id) => `checkProduct=${id}`)
              .join('&');
            const data = `${formData}&tags=${encodeURIComponent(params.tag)}`;

            ((globalThis as any).$ || (globalThis as any).jQuery).ajax({
              url: '/product/bulkAssignTags',
              type: 'POST',
              data,
              success: (responseData: any) => {
                const body =
                  typeof responseData === 'string'
                    ? responseData
                    : JSON.stringify(responseData);
                resolve({ status: 200, body });
              },
              error: (xhr: any) => {
                resolve({
                  status: xhr.status || 500,
                  body: xhr.responseText || 'Unknown error',
                });
              },
            });
          });
        },
        { tag: tagName, ids: batch }
      );

      if (result.status !== 200) {
        logger.error(
          `Poleepo UI: bulk assign tag "${tagName}" batch ${batchNum} failed (${result.status}): ${result.body}`
        );
        return {
          tagName,
          productCount: totalAssigned,
          success: false,
          message: `Batch ${batchNum} failed (${result.status}): ${result.body}`,
        };
      }

      totalAssigned += batch.length;
      logger.info(
        `Poleepo UI: tag "${tagName}" batch ${batchNum} submitted (${totalAssigned}/${productIds.length})`
      );

      if (i + BATCH_SIZE < productIds.length) {
        await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
      }
    }

    return {
      tagName,
      productCount: totalAssigned,
      success: true,
      message: `Submitted ${totalAssigned} product(s) for tag "${tagName}" assignment`,
    };
  }

  async bulkAssignTags(
    assignments: TagAssignment[]
  ): Promise<TagAssignmentResult[]> {
    const results: TagAssignmentResult[] = [];

    for (let i = 0; i < assignments.length; i++) {
      const assignment = assignments[i];

      if (i > 0) {
        logger.info(
          `Poleepo UI: waiting ${INTER_TAG_DELAY_MS / 1000}s before next tag assignment...`
        );
        await new Promise((r) => setTimeout(r, INTER_TAG_DELAY_MS));
      }

      try {
        const result = await this.bulkAssignTag(
          assignment.tagName,
          assignment.poleepoProductIds
        );
        results.push(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Poleepo UI: error assigning tag "${assignment.tagName}": ${msg}`);
        results.push({
          tagName: assignment.tagName,
          productCount: 0,
          success: false,
          message: msg,
        });
      }
    }

    return results;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
