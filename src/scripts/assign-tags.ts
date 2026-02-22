/**
 * Standalone script to assign missing tags to Poleepo products via browser automation.
 *
 * The Poleepo API ignores tag additions via PUT /products/{id}. Tags can only be
 * assigned through the web UI's "Operazioni Massive" feature, which internally
 * calls POST /product/bulkAssignTags.
 *
 * This script:
 * 1. Fetches all Poleepo and Shopify products
 * 2. Builds product mappings (SKU-based)
 * 3. Compares tags to find what's missing on Poleepo
 * 4. Groups missing tags by tag name
 * 5. Uses PoleepoUIClient to bulk-assign each tag group
 * 6. Verifies assignments via API re-fetch
 *
 * Usage:
 *   npx ts-node src/scripts/assign-tags.ts [--dry-run] [--tag PE26] [--verify]
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { config } from '../config';
import { logger, setLogLevel } from '../utils/logger';
import { PoleepoClient, PoleepoProduct } from '../clients/poleepo';
import { ShopifyClient } from '../clients/shopify';
import { PoleepoUIClient, TagAssignment } from '../clients/poleepo-ui';
import { buildProductMappings } from '../sync/product-matcher';
import {
  poleepoTagsToStrings,
  shopifyTagsToStrings,
} from '../sync/tag-normalizer';

interface MissingTagInfo {
  tagName: string;
  poleepoProductIds: number[];
  productSkus: string[]; // for logging
}

// Parse CLI arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verifyAfter = args.includes('--verify');
const tagFilterIdx = args.indexOf('--tag');
const tagFilter = tagFilterIdx >= 0 ? args[tagFilterIdx + 1] : null;

async function main(): Promise<void> {
  setLogLevel(config.logLevel);

  logger.info('=== Poleepo Tag Assignment Script ===');
  if (dryRun) logger.info('DRY RUN mode - no changes will be made');
  if (tagFilter) logger.info(`Filtering to tag: ${tagFilter}`);

  const poleepo = new PoleepoClient();
  const shopify = new ShopifyClient();

  // 1. Fetch all Poleepo products
  logger.info('Fetching all Poleepo products...');
  const poleepoProducts = await poleepo.getAllProducts(config.sync.batchSize);
  logger.info(`Fetched ${poleepoProducts.length} Poleepo products`);

  const poleepoMap = new Map<number, PoleepoProduct>();
  for (const p of poleepoProducts) {
    poleepoMap.set(p.id, p);
  }

  // 2. Build product mappings (SKU-based via publications)
  logger.info('Building product mappings...');
  const { mappings, publicationsMap } = await buildProductMappings(poleepo, poleepoProducts);
  logger.info(`Found ${mappings.length} product mappings`);

  // Create reverse map: shopifyId -> poleepoId
  const shopifyToPoleepo = new Map<string, string>();
  for (const [poleepoId, shopifyId] of Object.entries(publicationsMap)) {
    shopifyToPoleepo.set(shopifyId, poleepoId);
  }

  // 3. Fetch all Shopify products
  logger.info('Fetching all Shopify products...');
  const shopifyProducts = await shopify.getAllProducts();
  logger.info(`Fetched ${shopifyProducts.length} Shopify products`);

  // 4. Compare tags and find what's missing on Poleepo
  logger.info('Analyzing tag differences...');
  const missingByTag = new Map<string, { poleepoIds: number[]; skus: string[] }>();
  let totalMissing = 0;

  for (const shopifyProduct of shopifyProducts) {
    const poleepoIdStr = shopifyToPoleepo.get(String(shopifyProduct.id));
    if (!poleepoIdStr) continue;

    const poleepoId = parseInt(poleepoIdStr, 10);
    const poleepoProduct = poleepoMap.get(poleepoId);
    if (!poleepoProduct) continue;

    const shopifyTags = shopifyTagsToStrings(shopifyProduct.tags || '');
    const poleepoTags = poleepoTagsToStrings(poleepoProduct.tags || []);

    // Normalize for comparison
    const poleepoTagsNorm = new Set(
      poleepoTags.map((t) => t.trim().toLowerCase())
    );

    // Find tags on Shopify that are missing from Poleepo
    for (const tag of shopifyTags) {
      const normTag = tag.trim().toLowerCase();
      if (!poleepoTagsNorm.has(normTag)) {
        // Apply filter if specified
        if (tagFilter && normTag !== tagFilter.toLowerCase()) continue;

        if (!missingByTag.has(tag)) {
          missingByTag.set(tag, { poleepoIds: [], skus: [] });
        }
        const entry = missingByTag.get(tag)!;
        entry.poleepoIds.push(poleepoId);
        entry.skus.push(poleepoProduct.sku || String(poleepoId));
        totalMissing++;
      }
    }
  }

  // 5. Sort by product count (most first) and display summary
  const sortedTags = [...missingByTag.entries()]
    .sort((a, b) => b[1].poleepoIds.length - a[1].poleepoIds.length);

  logger.info(`\nFound ${totalMissing} missing tag assignments across ${sortedTags.length} tags:\n`);
  console.log('Tag Name               | Products | Sample SKUs');
  console.log('-----------------------|----------|------------');
  for (const [tag, info] of sortedTags) {
    const name = tag.padEnd(23);
    const count = String(info.poleepoIds.length).padStart(8);
    const skus = info.skus.slice(0, 3).join(', ');
    console.log(`${name}|${count} | ${skus}`);
  }
  console.log('');

  if (dryRun) {
    logger.info('DRY RUN complete. No changes made.');
    return;
  }

  if (sortedTags.length === 0) {
    logger.info('No missing tags found. Nothing to do.');
    return;
  }

  // 6. Use PoleepoUIClient to assign tags
  const uiClient = new PoleepoUIClient();

  try {
    await uiClient.init();
    await uiClient.login();

    // Build assignments - the bulk assign endpoint accepts any tag name,
    // Poleepo will create the tag if it doesn't exist yet
    const assignments: TagAssignment[] = [];

    for (const [tag, info] of sortedTags) {
      assignments.push({
        tagName: tag,
        poleepoProductIds: info.poleepoIds,
      });
    }

    if (assignments.length === 0) {
      logger.info('No assignable tags found.');
      return;
    }

    logger.info(`\nAssigning ${assignments.length} tags to products...`);

    // Execute assignments
    const results = await uiClient.bulkAssignTags(assignments);

    // Report results
    logger.info('\n=== Assignment Results ===\n');
    let successCount = 0;
    let failCount = 0;

    for (const result of results) {
      const status = result.success ? 'OK' : 'FAIL';
      logger.info(
        `[${status}] Tag "${result.tagName}": ${result.productCount} products - ${result.message}`
      );
      if (result.success) successCount++;
      else failCount++;
    }

    logger.info(
      `\nCompleted: ${successCount} succeeded, ${failCount} failed out of ${results.length} tags`
    );

    // 7. Verify if requested
    if (verifyAfter) {
      logger.info('\nVerifying tag assignments (waiting 30s for processing)...');
      await new Promise((r) => setTimeout(r, 30000));
      await verifyAssignments(poleepo, assignments);
    }
  } finally {
    await uiClient.close();
  }
}

async function verifyAssignments(
  poleepo: PoleepoClient,
  assignments: TagAssignment[]
): Promise<void> {
  let verified = 0;
  let missing = 0;

  for (const assignment of assignments) {
    // Sample up to 5 products for verification
    const sampleIds = assignment.poleepoProductIds.slice(0, 5);

    for (const productId of sampleIds) {
      try {
        const response = await poleepo.getProduct(productId);
        const currentTags = poleepoTagsToStrings(response.data.tags || []);
        const currentTagsNorm = new Set(
          currentTags.map((t) => t.trim().toLowerCase())
        );

        if (currentTagsNorm.has(assignment.tagName.toLowerCase())) {
          verified++;
        } else {
          missing++;
          logger.warn(
            `Verification: product ${productId} still missing tag "${assignment.tagName}"`
          );
        }
      } catch (error) {
        logger.error(`Verification: failed to fetch product ${productId}`);
      }
    }
  }

  logger.info(
    `\nVerification: ${verified} confirmed, ${missing} still missing ` +
    `(sampled ${verified + missing} products)`
  );

  if (missing > 0) {
    logger.warn(
      'Some tags may still be processing. Poleepo processes bulk operations asynchronously. ' +
      'Run the script again with --verify after a few minutes.'
    );
  }
}

main()
  .then(() => {
    logger.info('Script completed.');
    process.exit(0);
  })
  .catch((error) => {
    logger.error(`Script failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
