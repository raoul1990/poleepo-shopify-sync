import { PoleepoClient, PoleepoProduct } from '../clients/poleepo';
import { ShopifyClient, ShopifyProduct } from '../clients/shopify';
import { PoleepoUIClient, TagAssignment, TagAssignmentResult } from '../clients/poleepo-ui';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  normalizeTag,
  poleepoTagsToStrings,
  shopifyTagsToStrings,
  stringsToPoleepoFormatWithIds,
  stringsToShopifyFormat,
  computeTagHash,
  mergeTags,
} from './tag-normalizer';
import {
  SyncState,
  ProductSyncState,
  loadState,
  saveState,
  createEmptyState,
} from './state-manager';
import { buildProductMappings, findNewMappings } from './product-matcher';
import { ProductSyncDetail } from '../utils/slack';

export interface SyncResult {
  syncType: 'full' | 'incremental';
  analyzed: number;
  modified: number;
  toShopify: number;
  toPoleepo: number;
  errors: number;
  totalMappings: number;
  productDetails: ProductSyncDetail[];
  errorDetails: string[];
  browserAssignResults?: TagAssignmentResult[];
}

export class TagSyncEngine {
  private readonly poleepo: PoleepoClient;
  private readonly shopify: ShopifyClient;
  private tagIdLookup: Map<string, { id: number; value: string }> = new Map();

  constructor(poleepo: PoleepoClient, shopify: ShopifyClient) {
    this.poleepo = poleepo;
    this.shopify = shopify;
  }

  /**
   * Build a case-insensitive lookup of tag value -> {id, value} from all Poleepo products.
   * Poleepo requires tag IDs for reliable acceptance when adding tags to products.
   */
  private buildTagIdLookup(poleepoProducts: PoleepoProduct[]): void {
    this.tagIdLookup.clear();
    for (const product of poleepoProducts) {
      for (const tag of product.tags || []) {
        if (tag.id && tag.value) {
          const key = normalizeTag(tag.value);
          if (!this.tagIdLookup.has(key)) {
            this.tagIdLookup.set(key, { id: tag.id, value: tag.value });
          }
        }
      }
    }
    logger.info(`Tag ID lookup built: ${this.tagIdLookup.size} unique tags with IDs`);
  }

  /**
   * Fetch all Poleepo products and prepare lookup structures.
   */
  private async fetchAndPreparePoleepo(): Promise<{
    products: PoleepoProduct[];
    productMap: Map<number, PoleepoProduct>;
  }> {
    const products = await this.poleepo.getAllProducts(config.sync.batchSize);
    const productMap = new Map<number, PoleepoProduct>();
    for (const p of products) productMap.set(p.id, p);
    this.buildTagIdLookup(products);
    return { products, productMap };
  }

  /**
   * Process sync for a list of product pairs, accumulating results.
   */
  private async syncMappedProducts(
    pairs: { poleepoId: number; shopifyId: string; poleepoProduct?: PoleepoProduct; shopifyProduct?: ShopifyProduct }[],
    result: SyncResult,
    state: SyncState
  ): Promise<void> {
    for (const { poleepoId, shopifyId, poleepoProduct, shopifyProduct } of pairs) {
      if (!poleepoProduct || !shopifyProduct) {
        logger.debug(
          `Skipping poleepo:${poleepoId} <-> shopify:${shopifyId}: product not found`
        );
        continue;
      }

      result.analyzed++;
      try {
        const syncOutcome = await this.syncProductPair(
          poleepoProduct, shopifyProduct, poleepoId, shopifyId
        );
        state.products[`poleepo_${poleepoId}`] = syncOutcome.productState;

        if (syncOutcome.updatedShopify) result.toShopify++;
        if (syncOutcome.updatedPoleepo) result.toPoleepo++;
        if (syncOutcome.updatedShopify || syncOutcome.updatedPoleepo) result.modified++;
        if (syncOutcome.detail) result.productDetails.push(syncOutcome.detail);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error syncing poleepo:${poleepoId} <-> shopify:${shopifyId}: ${message}`);
        result.errors++;
        result.errorDetails.push(`poleepo:${poleepoId} <-> shopify:${shopifyId}: ${message}`);
      }
    }
  }

  async run(): Promise<SyncResult> {
    const existingState = loadState();

    if (existingState) {
      return this.incrementalSync(existingState);
    } else {
      return this.fullSync();
    }
  }

  private async fullSync(): Promise<SyncResult> {
    logger.info('Starting FULL sync...');
    const result: SyncResult = {
      syncType: 'full', analyzed: 0, modified: 0, toShopify: 0, toPoleepo: 0,
      errors: 0, totalMappings: 0, productDetails: [], errorDetails: [],
    };
    const state = createEmptyState();

    logger.info('Fetching all Poleepo products...');
    const { products: poleepoProducts, productMap: poleepoMap } = await this.fetchAndPreparePoleepo();

    const { mappings, publicationsMap } = await buildProductMappings(this.poleepo, poleepoProducts);
    state.publicationsMap = publicationsMap;
    result.totalMappings = mappings.length;

    if (mappings.length === 0) {
      logger.warn('No product mappings found. Nothing to sync.');
      state.lastSyncTime = new Date().toISOString();
      saveState(state);
      return result;
    }

    logger.info('Fetching all Shopify products...');
    const shopifyProducts = await this.shopify.getAllProducts();
    const shopifyMap = new Map<number, ShopifyProduct>();
    for (const p of shopifyProducts) shopifyMap.set(p.id, p);

    const pairs = mappings.map((m) => ({
      poleepoId: m.poleepoId,
      shopifyId: m.shopifyId,
      poleepoProduct: poleepoMap.get(m.poleepoId),
      shopifyProduct: shopifyMap.get(parseInt(m.shopifyId, 10)),
    }));

    await this.syncMappedProducts(pairs, result, state);

    state.lastSyncTime = new Date().toISOString();
    saveState(state);
    return result;
  }

  private async incrementalSync(previousState: SyncState): Promise<SyncResult> {
    logger.info(`Starting INCREMENTAL sync (last sync: ${previousState.lastSyncTime})...`);
    const result: SyncResult = {
      syncType: 'incremental', analyzed: 0, modified: 0, toShopify: 0, toPoleepo: 0,
      errors: 0, totalMappings: 0, productDetails: [], errorDetails: [],
    };
    const state: SyncState = {
      lastSyncTime: new Date().toISOString(),
      products: { ...previousState.products },
      publicationsMap: { ...previousState.publicationsMap },
    };

    logger.info('Fetching Poleepo products for hash comparison...');
    const { products: poleepoProducts, productMap: poleepoMap } = await this.fetchAndPreparePoleepo();

    const { publicationsMap: currentPubMap } = await buildProductMappings(this.poleepo, poleepoProducts);
    const newMappings = findNewMappings(currentPubMap, previousState.publicationsMap);
    state.publicationsMap = currentPubMap;
    result.totalMappings = Object.keys(currentPubMap).length;

    if (newMappings.length > 0) {
      logger.info(`Found ${newMappings.length} new product mappings`);
    }

    // Fetch Shopify products updated since last sync
    logger.info('Fetching recently updated Shopify products...');
    const updatedShopifyProducts = await this.shopify.getAllProducts(previousState.lastSyncTime);
    const shopifyChangedIds = new Set(updatedShopifyProducts.map((p) => String(p.id)));
    const shopifyMap = new Map<number, ShopifyProduct>();
    for (const p of updatedShopifyProducts) shopifyMap.set(p.id, p);
    logger.info(`Shopify: ${updatedShopifyProducts.length} products updated since last sync`);

    // Determine which products need syncing
    const productsToSync = new Set<string>();

    // New mappings
    for (const m of newMappings) productsToSync.add(String(m.poleepoId));

    // Shopify changed products (reverse lookup)
    const shopifyToPoleepo = new Map<string, string>();
    for (const [poleepoId, shopifyId] of Object.entries(currentPubMap)) {
      shopifyToPoleepo.set(shopifyId, poleepoId);
    }
    for (const shopifyId of shopifyChangedIds) {
      const poleepoId = shopifyToPoleepo.get(shopifyId);
      if (poleepoId) productsToSync.add(poleepoId);
    }

    // Poleepo products with changed tag hashes
    for (const poleepoProduct of poleepoProducts) {
      const stateKey = `poleepo_${poleepoProduct.id}`;
      const prevProductState = previousState.products[stateKey];
      if (!prevProductState) {
        if (currentPubMap[String(poleepoProduct.id)]) {
          productsToSync.add(String(poleepoProduct.id));
        }
        continue;
      }
      const currentHash = computeTagHash(poleepoTagsToStrings(poleepoProduct.tags || []));
      if (currentHash !== prevProductState.poleepoTagHash) {
        productsToSync.add(String(poleepoProduct.id));
      }
    }

    logger.info(`${productsToSync.size} products need syncing`);

    // Resolve Shopify products and build pairs
    const pairs: { poleepoId: number; shopifyId: string; poleepoProduct?: PoleepoProduct; shopifyProduct?: ShopifyProduct }[] = [];

    for (const poleepoIdStr of productsToSync) {
      const poleepoId = parseInt(poleepoIdStr, 10);
      const shopifyIdStr = currentPubMap[poleepoIdStr];
      if (!shopifyIdStr) continue;

      const shopifyId = parseInt(shopifyIdStr, 10);
      let shopifyProduct = shopifyMap.get(shopifyId);

      if (!shopifyProduct) {
        try {
          const resp = await this.shopify.getProduct(shopifyId);
          shopifyProduct = resp.product;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('(404)')) {
            logger.debug(`Shopify product ${shopifyId} no longer exists (deleted), skipping`);
            delete state.products[`poleepo_${poleepoId}`];
            continue;
          }
          logger.error(`Failed to fetch Shopify product ${shopifyId}: ${message}`);
          result.errors++;
          result.errorDetails.push(`Fetch Shopify product ${shopifyId}: ${message}`);
          continue;
        }
      }

      pairs.push({
        poleepoId,
        shopifyId: shopifyIdStr,
        poleepoProduct: poleepoMap.get(poleepoId),
        shopifyProduct,
      });
    }

    await this.syncMappedProducts(pairs, result, state);

    state.lastSyncTime = new Date().toISOString();
    saveState(state);
    return result;
  }

  private async syncProductPair(
    poleepoProduct: PoleepoProduct,
    shopifyProduct: ShopifyProduct,
    poleepoId: number,
    shopifyId: string
  ): Promise<{
    productState: ProductSyncState;
    updatedShopify: boolean;
    updatedPoleepo: boolean;
    detail: ProductSyncDetail | null;
  }> {
    const poleepoTags = poleepoTagsToStrings(poleepoProduct.tags || []);
    const shopifyTags = shopifyTagsToStrings(shopifyProduct.tags || '');

    const poleepoHash = computeTagHash(poleepoTags);
    const shopifyHash = computeTagHash(shopifyTags);

    let updatedShopify = false;
    let updatedPoleepo = false;

    // Tags are already identical
    if (poleepoHash === shopifyHash) {
      return {
        productState: {
          shopifyId,
          poleepoTagHash: poleepoHash,
          shopifyTagHash: shopifyHash,
          lastSynced: new Date().toISOString(),
        },
        updatedShopify: false,
        updatedPoleepo: false,
        detail: null,
      };
    }

    // Merge tags (union of both sets)
    const merged = mergeTags(poleepoTags, shopifyTags);
    const mergedHash = computeTagHash(merged);

    // Update Shopify if its tags are different from merged
    if (shopifyHash !== mergedHash) {
      logger.info(
        `Updating Shopify product ${shopifyId}: ` +
        `${shopifyTags.length} tags -> ${merged.length} tags`
      );
      await this.shopify.updateProduct(parseInt(shopifyId, 10), stringsToShopifyFormat(merged));
      updatedShopify = true;
    }

    // Update Poleepo if its tags are different from merged
    let actualPoleepoHash = poleepoHash;
    let rejectedTags: string[] = [];
    if (poleepoHash !== mergedHash) {
      const tagsPayload = stringsToPoleepoFormatWithIds(merged, this.tagIdLookup);
      const withId = tagsPayload.filter((t) => t.id !== undefined).length;
      const withoutId = tagsPayload.filter((t) => t.id === undefined).length;
      logger.info(
        `Updating Poleepo product ${poleepoId}: ` +
        `${poleepoTags.length} tags -> ${merged.length} tags (${withId} with ID, ${withoutId} without ID)`
      );
      if (withoutId > 0) {
        const noIdTags = tagsPayload.filter((t) => t.id === undefined).map((t) => t.value);
        logger.warn(`Tags without ID for product ${poleepoId}: [${noIdTags.join(', ')}]`);
      }
      await this.poleepo.updateProduct(poleepoId, { tags: tagsPayload });

      // Verify: re-fetch to check which tags Poleepo actually accepted
      const verifyResponse = await this.poleepo.getProduct(poleepoId);
      const actualTags = poleepoTagsToStrings(verifyResponse.data.tags || []);
      actualPoleepoHash = computeTagHash(actualTags);

      if (actualPoleepoHash !== mergedHash) {
        const actualNorm = new Set(actualTags.map(normalizeTag));
        rejectedTags = merged.filter((t) => !actualNorm.has(normalizeTag(t)));
        if (rejectedTags.length > 0) {
          logger.warn(
            `Poleepo product ${poleepoId}: rejected ${rejectedTags.length} tags: [${rejectedTags.join(', ')}]`
          );
        }
        updatedPoleepo = actualTags.length > poleepoTags.length;
      } else {
        updatedPoleepo = true;
      }
    }

    // Compute tags added for the report
    const poleepoNormalized = new Set(poleepoTags.map(normalizeTag));
    const shopifyNormalized = new Set(shopifyTags.map(normalizeTag));
    const addedToShopify = merged.filter((t) => !shopifyNormalized.has(normalizeTag(t)));
    const addedToPoleepo = merged.filter((t) => !poleepoNormalized.has(normalizeTag(t)));

    const productName = poleepoProduct.title || shopifyProduct.title || '';
    const direction: 'shopify' | 'poleepo' | 'both' =
      updatedShopify && updatedPoleepo ? 'both' :
      updatedShopify ? 'shopify' : 'poleepo';

    const detail: ProductSyncDetail = {
      poleepoId,
      shopifyId,
      productName,
      direction,
      tagsBefore: updatedShopify ? shopifyTags : poleepoTags,
      tagsAfter: merged,
      tagsAdded: [...new Set([...addedToShopify, ...addedToPoleepo])],
      rejectedByPoleepo: rejectedTags.length > 0 ? rejectedTags : undefined,
    };

    return {
      productState: {
        shopifyId,
        poleepoTagHash: actualPoleepoHash,
        shopifyTagHash: mergedHash,
        lastSynced: new Date().toISOString(),
      },
      updatedShopify,
      updatedPoleepo,
      detail,
    };
  }

  /**
   * Collect rejected tags from sync results, grouped by tag name with product IDs.
   * Returns assignments suitable for PoleepoUIClient.bulkAssignTags().
   */
  static collectRejectedTags(result: SyncResult): TagAssignment[] {
    const byTag = new Map<string, number[]>();

    for (const detail of result.productDetails) {
      if (detail.rejectedByPoleepo && detail.rejectedByPoleepo.length > 0) {
        for (const tag of detail.rejectedByPoleepo) {
          if (!byTag.has(tag)) byTag.set(tag, []);
          byTag.get(tag)!.push(detail.poleepoId);
        }
      }
    }

    return [...byTag.entries()].map(([tagName, poleepoProductIds]) => ({
      tagName,
      poleepoProductIds,
    }));
  }

  /**
   * Attempt to assign rejected tags via browser automation (internal web API).
   * Called after API-based sync when tags were rejected.
   */
  static async assignRejectedTagsViaBrowser(
    result: SyncResult
  ): Promise<TagAssignmentResult[]> {
    const assignments = TagSyncEngine.collectRejectedTags(result);

    if (assignments.length === 0) {
      return [];
    }

    const totalProducts = assignments.reduce((sum, a) => sum + a.poleepoProductIds.length, 0);
    logger.info(
      `Browser fallback: ${assignments.length} rejected tags affecting ${totalProducts} products`
    );

    if (!config.poleepoWeb.username || !config.poleepoWeb.password) {
      logger.warn(
        'Browser fallback: POLEEPO_WEB_USERNAME/PASSWORD not configured, skipping'
      );
      return [];
    }

    const uiClient = new PoleepoUIClient();
    try {
      await uiClient.init();
      await uiClient.login();
      const results = await uiClient.bulkAssignTags(assignments);

      for (const r of results) {
        if (r.success) {
          logger.info(`Browser fallback: tag "${r.tagName}" assigned to ${r.productCount} products`);
        } else {
          logger.error(`Browser fallback: tag "${r.tagName}" failed: ${r.message}`);
        }
      }

      return results;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Browser fallback failed: ${msg}`);
      return [{
        tagName: '*',
        productCount: 0,
        success: false,
        message: `Browser fallback initialization failed: ${msg}`,
      }];
    } finally {
      await uiClient.close();
    }
  }
}
