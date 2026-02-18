import { PoleepoClient, PoleepoProduct } from '../clients/poleepo';
import { ShopifyClient, ShopifyProduct } from '../clients/shopify';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  poleepoTagsToStrings,
  shopifyTagsToStrings,
  stringsToPoleepoFormat,
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
}

export class TagSyncEngine {
  private readonly poleepo: PoleepoClient;
  private readonly shopify: ShopifyClient;

  constructor(poleepo: PoleepoClient, shopify: ShopifyClient) {
    this.poleepo = poleepo;
    this.shopify = shopify;
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

    // 1. Fetch all Poleepo products
    logger.info('Fetching all Poleepo products...');
    const poleepoProducts = await this.poleepo.getAllProducts(config.sync.batchSize);
    const poleepoMap = new Map<number, PoleepoProduct>();
    for (const p of poleepoProducts) {
      poleepoMap.set(p.id, p);
    }

    // 2. Build product mappings (SKU-based)
    const { mappings, publicationsMap } = await buildProductMappings(this.poleepo, poleepoProducts);
    state.publicationsMap = publicationsMap;

    result.totalMappings = mappings.length;

    if (mappings.length === 0) {
      logger.warn('No product mappings found. Nothing to sync.');
      state.lastSyncTime = new Date().toISOString();
      saveState(state);
      return result;
    }

    // 3. Fetch all Shopify products
    logger.info('Fetching all Shopify products...');
    const shopifyProducts = await this.shopify.getAllProducts();
    const shopifyMap = new Map<number, ShopifyProduct>();
    for (const p of shopifyProducts) {
      shopifyMap.set(p.id, p);
    }

    // 4. Sync each mapped pair
    for (const mapping of mappings) {
      result.analyzed++;
      const poleepoProduct = poleepoMap.get(mapping.poleepoId);
      const shopifyProduct = shopifyMap.get(parseInt(mapping.shopifyId, 10));

      if (!poleepoProduct || !shopifyProduct) {
        logger.debug(
          `Skipping mapping poleepo:${mapping.poleepoId} <-> shopify:${mapping.shopifyId}: ` +
          `product not found (poleepo: ${!!poleepoProduct}, shopify: ${!!shopifyProduct})`
        );
        continue;
      }

      try {
        const syncOutcome = await this.syncProductPair(
          poleepoProduct,
          shopifyProduct,
          mapping.poleepoId,
          mapping.shopifyId
        );

        state.products[`poleepo_${mapping.poleepoId}`] = syncOutcome.productState;

        if (syncOutcome.updatedShopify) {
          result.toShopify++;
          result.modified++;
        }
        if (syncOutcome.updatedPoleepo) {
          result.toPoleepo++;
          result.modified++;
        }
        if (syncOutcome.detail) {
          result.productDetails.push(syncOutcome.detail);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error syncing poleepo:${mapping.poleepoId} <-> shopify:${mapping.shopifyId}: ${message}`);
        result.errors++;
        result.errorDetails.push(`poleepo:${mapping.poleepoId} <-> shopify:${mapping.shopifyId}: ${message}`);
      }
    }

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

    // 1. Fetch all Poleepo products and check for new publications
    logger.info('Fetching Poleepo products for hash comparison...');
    const poleepoProducts = await this.poleepo.getAllProducts(config.sync.batchSize);
    const poleepoMap = new Map<number, PoleepoProduct>();
    for (const p of poleepoProducts) {
      poleepoMap.set(p.id, p);
    }

    const { publicationsMap: currentPubMap } = await buildProductMappings(this.poleepo, poleepoProducts);
    const newMappings = findNewMappings(currentPubMap, previousState.publicationsMap);
    state.publicationsMap = currentPubMap;
    result.totalMappings = Object.keys(currentPubMap).length;

    if (newMappings.length > 0) {
      logger.info(`Found ${newMappings.length} new product mappings`);
    }

    // 2. Fetch Shopify products updated since last sync
    logger.info('Fetching recently updated Shopify products...');
    const updatedShopifyProducts = await this.shopify.getAllProducts(previousState.lastSyncTime);
    const shopifyChangedIds = new Set(updatedShopifyProducts.map((p) => String(p.id)));
    const shopifyMap = new Map<number, ShopifyProduct>();
    for (const p of updatedShopifyProducts) {
      shopifyMap.set(p.id, p);
    }
    logger.info(`Shopify: ${updatedShopifyProducts.length} products updated since last sync`);

    // 3. Determine which products need syncing
    const productsToSync = new Set<string>(); // poleepoId as string

    // 4a. New mappings
    for (const m of newMappings) {
      productsToSync.add(String(m.poleepoId));
    }

    // 4b. Shopify changed products (reverse lookup)
    const shopifyToPoleepo = new Map<string, string>();
    for (const [poleepoId, shopifyId] of Object.entries(currentPubMap)) {
      shopifyToPoleepo.set(shopifyId, poleepoId);
    }
    for (const shopifyId of shopifyChangedIds) {
      const poleepoId = shopifyToPoleepo.get(shopifyId);
      if (poleepoId) {
        productsToSync.add(poleepoId);
      }
    }

    // 4c. Poleepo products with changed tag hashes
    for (const poleepoProduct of poleepoProducts) {
      const stateKey = `poleepo_${poleepoProduct.id}`;
      const prevProductState = previousState.products[stateKey];
      if (!prevProductState) {
        // New product or not previously tracked — sync if it has a mapping
        if (currentPubMap[String(poleepoProduct.id)]) {
          productsToSync.add(String(poleepoProduct.id));
        }
        continue;
      }

      const currentPoleepoTags = poleepoTagsToStrings(poleepoProduct.tags || []);
      const currentHash = computeTagHash(currentPoleepoTags);
      if (currentHash !== prevProductState.poleepoTagHash) {
        productsToSync.add(String(poleepoProduct.id));
      }
    }

    logger.info(`${productsToSync.size} products need syncing`);

    // 5. Sync each product
    for (const poleepoIdStr of productsToSync) {
      result.analyzed++;
      const poleepoId = parseInt(poleepoIdStr, 10);
      const shopifyIdStr = currentPubMap[poleepoIdStr];
      if (!shopifyIdStr) continue;

      const shopifyId = parseInt(shopifyIdStr, 10);
      const poleepoProduct = poleepoMap.get(poleepoId);

      // Fetch Shopify product if not already fetched
      let shopifyProduct = shopifyMap.get(shopifyId);
      if (!shopifyProduct) {
        try {
          const resp = await this.shopify.getProduct(shopifyId);
          shopifyProduct = resp.product;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to fetch Shopify product ${shopifyId}: ${message}`);
          result.errors++;
          result.errorDetails.push(`Fetch Shopify product ${shopifyId}: ${message}`);
          continue;
        }
      }

      if (!poleepoProduct || !shopifyProduct) {
        logger.debug(`Skipping poleepo:${poleepoId} <-> shopify:${shopifyIdStr}: product not found`);
        continue;
      }

      try {
        const syncOutcome = await this.syncProductPair(
          poleepoProduct,
          shopifyProduct,
          poleepoId,
          shopifyIdStr
        );

        state.products[`poleepo_${poleepoId}`] = syncOutcome.productState;

        if (syncOutcome.updatedShopify) {
          result.toShopify++;
          result.modified++;
        }
        if (syncOutcome.updatedPoleepo) {
          result.toPoleepo++;
          result.modified++;
        }
        if (syncOutcome.detail) {
          result.productDetails.push(syncOutcome.detail);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error syncing poleepo:${poleepoId} <-> shopify:${shopifyIdStr}: ${message}`);
        result.errors++;
        result.errorDetails.push(`poleepo:${poleepoId} <-> shopify:${shopifyIdStr}: ${message}`);
      }
    }

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
    const allTagsBefore = [...new Set([...poleepoTags, ...shopifyTags])];
    const merged = mergeTags(poleepoTags, shopifyTags);
    const mergedPoleepoHash = computeTagHash(merged);

    // Update Shopify if its tags are different from merged
    if (computeTagHash(shopifyTags) !== mergedPoleepoHash) {
      logger.info(
        `Updating Shopify product ${shopifyId}: ` +
        `${shopifyTags.length} tags -> ${merged.length} tags`
      );
      await this.shopify.updateProduct(parseInt(shopifyId, 10), stringsToShopifyFormat(merged));
      updatedShopify = true;
    }

    // Update Poleepo if its tags are different from merged
    if (computeTagHash(poleepoTags) !== mergedPoleepoHash) {
      logger.info(
        `Updating Poleepo product ${poleepoId}: ` +
        `${poleepoTags.length} tags -> ${merged.length} tags`
      );
      await this.poleepo.updateProduct(poleepoId, { tags: stringsToPoleepoFormat(merged) });
      updatedPoleepo = true;
    }

    // Compute tags added for the report
    const existingNormalized = new Set(
      allTagsBefore.map((t) => config.sync.tagCaseSensitive ? t.trim() : t.trim().toLowerCase())
    );
    const poleepoNormalized = new Set(
      poleepoTags.map((t) => config.sync.tagCaseSensitive ? t.trim() : t.trim().toLowerCase())
    );
    const shopifyNormalized = new Set(
      shopifyTags.map((t) => config.sync.tagCaseSensitive ? t.trim() : t.trim().toLowerCase())
    );

    // Tags that were added to Shopify = tags in merged but not in original Shopify
    const addedToShopify = merged.filter((t) => {
      const key = config.sync.tagCaseSensitive ? t.trim() : t.trim().toLowerCase();
      return !shopifyNormalized.has(key);
    });
    // Tags that were added to Poleepo = tags in merged but not in original Poleepo
    const addedToPoleepo = merged.filter((t) => {
      const key = config.sync.tagCaseSensitive ? t.trim() : t.trim().toLowerCase();
      return !poleepoNormalized.has(key);
    });

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
    };

    return {
      productState: {
        shopifyId,
        poleepoTagHash: mergedPoleepoHash,
        shopifyTagHash: mergedPoleepoHash,
        lastSynced: new Date().toISOString(),
      },
      updatedShopify,
      updatedPoleepo,
      detail,
    };
  }
}
