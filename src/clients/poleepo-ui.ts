import { chromium, Browser, BrowserContext, Page } from 'playwright';
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

export class PoleepoUIClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async init(): Promise<void> {
    if (!config.poleepoWeb.username || !config.poleepoWeb.password) {
      throw new Error('POLEEPO_WEB_USERNAME and POLEEPO_WEB_PASSWORD must be set');
    }

    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
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

    await this.page.waitForURL('**/app.poleepo.cloud/**', { timeout: 15000 });
    await this.page.waitForLoadState('networkidle');

    // Verify we're logged in (not on login page)
    const url = this.page.url();
    if (url.includes('/login') || url.includes('/accedi')) {
      throw new Error('Poleepo UI: login failed - still on login page');
    }

    logger.info('Poleepo UI: login successful');
  }

  /**
   * Navigate to product index to set up the page context for AJAX calls.
   */
  private async ensureOnProductPage(): Promise<void> {
    if (!this.page) throw new Error('PoleepoUIClient not initialized');

    const url = this.page.url();
    if (!url.includes('/product/index')) {
      await this.page.goto(`${config.poleepoWeb.baseUrl}/product/index`, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    }
  }

  /**
   * Check if a tag exists in Poleepo's tag system.
   */
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

  /**
   * Get all available tags from the Poleepo UI.
   */
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

  /**
   * Bulk assign a tag to a list of Poleepo product IDs.
   * Uses the internal web API endpoint POST /product/bulkAssignTags.
   * The endpoint processes asynchronously and sends email notification on completion.
   */
  async bulkAssignTag(
    tagName: string,
    productIds: number[]
  ): Promise<TagAssignmentResult> {
    if (productIds.length === 0) {
      return {
        tagName,
        productCount: 0,
        success: true,
        message: 'No products to assign',
      };
    }

    await this.ensureOnProductPage();

    // Process in batches to avoid overloading
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
            // Build form data: checkProduct=id1&checkProduct=id2&...&tags=tagName
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

      // Brief pause between batches
      if (i + BATCH_SIZE < productIds.length) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    return {
      tagName,
      productCount: totalAssigned,
      success: true,
      message: `Submitted ${totalAssigned} product(s) for tag "${tagName}" assignment`,
    };
  }

  /**
   * Assign multiple tags to their respective product groups.
   */
  async bulkAssignTags(
    assignments: TagAssignment[]
  ): Promise<TagAssignmentResult[]> {
    const results: TagAssignmentResult[] = [];

    for (let i = 0; i < assignments.length; i++) {
      const assignment = assignments[i];

      // Wait between tag assignments to let Poleepo process each one
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
