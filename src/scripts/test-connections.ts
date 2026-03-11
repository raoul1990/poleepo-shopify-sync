/**
 * Connection test script for Poleepo and Shopify APIs.
 * Verifies credentials and basic API access.
 *
 * Usage:
 *   npx ts-node src/scripts/test-connections.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { config } from '../config';
import { logger, setLogLevel } from '../utils/logger';
import { PoleepoClient } from '../clients/poleepo';
import { ShopifyClient } from '../clients/shopify';

async function testPoleepo(): Promise<boolean> {
  logger.info('=== Test Poleepo API ===');

  try {
    const client = new PoleepoClient();

    // Test products
    logger.info('Fetching 5 products...');
    const prodResponse = await client.getProducts(0, 5);
    const products = prodResponse.data || [];
    logger.info(`Products fetched: ${products.length}`);
    if (products[0]) {
      logger.info(`Sample: id=${products[0].id}, sku=${products[0].sku}, tags=${(products[0].tags || []).length}`);
    }

    // Test publications
    logger.info('Fetching 5 Shopify publications...');
    const pubResponse = await client.getPublications({ source: 'SHOPIFY', max: 5 });
    const pubs = pubResponse.data || [];
    logger.info(`Publications fetched: ${pubs.length}`);
    if (pubs[0]) {
      logger.info(`Sample: sku=${pubs[0].sku}, source_id=${pubs[0].source_id}, source=${pubs[0].source?.id}`);
    }

    logger.info('=== Poleepo: OK ===\n');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Poleepo FAILED: ${msg}`);
    return false;
  }
}

async function testShopify(): Promise<boolean> {
  logger.info('=== Test Shopify API ===');

  try {
    const client = new ShopifyClient();

    // Test products
    logger.info('Fetching 5 products...');
    const response = await client.getProducts({ limit: 5, fields: 'id,title,tags' });
    const products = response.products || [];
    logger.info(`Products fetched: ${products.length}`);
    if (products[0]) {
      const tagCount = products[0].tags ? products[0].tags.split(',').filter((t: string) => t.trim()).length : 0;
      logger.info(`Sample: id=${products[0].id}, title=${products[0].title}, tags=${tagCount}`);
    }

    logger.info('=== Shopify: OK ===\n');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Shopify FAILED: ${msg}`);
    return false;
  }
}

async function main(): Promise<void> {
  setLogLevel('info');

  const poleepoOk = await testPoleepo();
  const shopifyOk = await testShopify();

  logger.info('========== RISULTATO ==========');
  logger.info(`Poleepo: ${poleepoOk ? 'OK' : 'FALLITO'}`);
  logger.info(`Shopify: ${shopifyOk ? 'OK' : 'FALLITO'}`);

  if (poleepoOk && shopifyOk) {
    logger.info('Tutte le connessioni funzionano. Pronto per la sync.');
  } else {
    logger.error('Alcune connessioni hanno fallito. Verificare le credenziali.');
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
