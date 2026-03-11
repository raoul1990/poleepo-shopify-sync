/**
 * Standalone script to assign missing tags to Poleepo products via browser automation.
 *
 * The Poleepo API ignores tag additions via PUT /products/{id}. Tags can only be
 * assigned through the web UI's "Operazioni Massive" feature, which internally
 * calls POST /product/bulkAssignTags.
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
  normalizeTag,
  poleepoTagsToStrings,
  shopifyTagsToStrings,
} from '../sync/tag-normalizer';

const VERIFY_DELAY_MS = 30_000;
const VERIFY_SAMPLE_SIZE = 5;

interface MissingTagEntry {
  poleepoIds: number[];
  skus: string[];
}

// Parse CLI arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verifyAfter = args.includes('--verify');
const tagFilterIdx = args.indexOf('--tag');
const tagFilter = tagFilterIdx >= 0 ? args[tagFilterIdx + 1] : null;

/**
 * Find tags present on Shopify but missing from Poleepo.
 */
function findMissingTags(
  shopifyProducts: { id: number; tags: string }[],
  poleepoMap: Map<number, PoleepoProduct>,
  shopifyToPoleepo: Map<string, string>,
  filterTag: string | null
): Map<string, MissingTagEntry> {
  const missingByTag = new Map<string, MissingTagEntry>();

  for (const shopifyProduct of shopifyProducts) {
    const poleepoIdStr = shopifyToPoleepo.get(String(shopifyProduct.id));
    if (!poleepoIdStr) continue;

    const poleepoId = parseInt(poleepoIdStr, 10);
    const poleepoProduct = poleepoMap.get(poleepoId);
    if (!poleepoProduct) continue;

    const shopifyTags = shopifyTagsToStrings(shopifyProduct.tags || '');
    const poleepoTags = poleepoTagsToStrings(poleepoProduct.tags || []);
    const poleepoTagsNorm = new Set(poleepoTags.map(normalizeTag));

    for (const tag of shopifyTags) {
      if (poleepoTagsNorm.has(normalizeTag(tag))) continue;
      if (filterTag && normalizeTag(tag) !== normalizeTag(filterTag)) continue;

      if (!missingByTag.has(tag)) {
        missingByTag.set(tag, { poleepoIds: [], skus: [] });
      }
      const entry = missingByTag.get(tag)!;
      entry.poleepoIds.push(poleepoId);
      entry.skus.push(poleepoProduct.sku || String(poleepoId));
    }
  }

  return missingByTag;
}

/**
 * Print a summary table of missing tags.
 */
function printSummary(sortedTags: [string, MissingTagEntry][]): void {
  const totalMissing = sortedTags.reduce((sum, [, info]) => sum + info.poleepoIds.length, 0);
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
}

/**
 * Execute tag assignments via browser automation.
 */
async function executeAssignments(
  sortedTags: [string, MissingTagEntry][]
): Promise<void> {
  const uiClient = new PoleepoUIClient();

  try {
    await uiClient.init();
    await uiClient.login();

    const assignments: TagAssignment[] = sortedTags.map(([tag, info]) => ({
      tagName: tag,
      poleepoProductIds: info.poleepoIds,
    }));

    logger.info(`\nAssigning ${assignments.length} tags to products...`);
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

    // Verify if requested
    if (verifyAfter) {
      logger.info(`\nVerifying tag assignments (waiting ${VERIFY_DELAY_MS / 1000}s for processing)...`);
      await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
      const poleepo = new PoleepoClient();
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
    const sampleIds = assignment.poleepoProductIds.slice(0, VERIFY_SAMPLE_SIZE);

    for (const productId of sampleIds) {
      try {
        const response = await poleepo.getProduct(productId);
        const currentTags = poleepoTagsToStrings(response.data.tags || []);
        const currentTagsNorm = new Set(currentTags.map(normalizeTag));

        if (currentTagsNorm.has(normalizeTag(assignment.tagName))) {
          verified++;
        } else {
          missing++;
          logger.warn(
            `Verification: product ${productId} still missing tag "${assignment.tagName}"`
          );
        }
      } catch {
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
  for (const p of poleepoProducts) poleepoMap.set(p.id, p);

  // 2. Build product mappings
  logger.info('Building product mappings...');
  const { mappings, publicationsMap } = await buildProductMappings(poleepo, poleepoProducts);
  logger.info(`Found ${mappings.length} product mappings`);

  const shopifyToPoleepo = new Map<string, string>();
  for (const [poleepoId, shopifyId] of Object.entries(publicationsMap)) {
    shopifyToPoleepo.set(shopifyId, poleepoId);
  }

  // 3. Fetch all Shopify products
  logger.info('Fetching all Shopify products...');
  const shopifyProducts = await shopify.getAllProducts();
  logger.info(`Fetched ${shopifyProducts.length} Shopify products`);

  // 4. Find missing tags
  logger.info('Analyzing tag differences...');
  const missingByTag = findMissingTags(shopifyProducts, poleepoMap, shopifyToPoleepo, tagFilter);

  const sortedTags = [...missingByTag.entries()]
    .sort((a, b) => b[1].poleepoIds.length - a[1].poleepoIds.length);

  printSummary(sortedTags);

  if (dryRun) {
    logger.info('DRY RUN complete. No changes made.');
    return;
  }

  if (sortedTags.length === 0) {
    logger.info('No missing tags found. Nothing to do.');
    return;
  }

  // 5. Execute assignments via browser
  await executeAssignments(sortedTags);
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
