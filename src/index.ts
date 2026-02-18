import * as cron from 'node-cron';
import { config } from './config';
import { logger, setLogLevel } from './utils/logger';
import { PoleepoClient } from './clients/poleepo';
import { ShopifyClient } from './clients/shopify';
import { TagSyncEngine, SyncResult } from './sync/tag-sync-engine';
import { sendSlackReport } from './utils/slack';

setLogLevel(config.logLevel);

const poleepoClient = new PoleepoClient();
const shopifyClient = new ShopifyClient();
const engine = new TagSyncEngine(poleepoClient, shopifyClient);

let isSyncing = false;
let isShuttingDown = false;

async function runSync(): Promise<void> {
  if (isSyncing) {
    logger.warn('Sync already in progress, skipping this cycle');
    return;
  }

  isSyncing = true;
  const startTime = Date.now();

  try {
    const result: SyncResult = await engine.run();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    logger.info(
      `Sync OK: ${result.analyzed} analizzati, ${result.modified} modificati ` +
      `(${result.toShopify} →Shopify, ${result.toPoleepo} →Poleepo), ` +
      `${result.errors} errori, durata ${duration}s`
    );

    await sendSlackReport({
      syncType: result.syncType,
      analyzed: result.analyzed,
      modified: result.modified,
      toShopify: result.toShopify,
      toPoleepo: result.toPoleepo,
      errors: result.errors,
      durationSeconds: duration,
      totalMappings: result.totalMappings,
      productDetails: result.productDetails,
      errorDetails: result.errorDetails,
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Sync FAILED after ${duration}s: ${message}`);

    await sendSlackReport({
      syncType: 'incremental',
      analyzed: 0,
      modified: 0,
      toShopify: 0,
      toPoleepo: 0,
      errors: 1,
      durationSeconds: duration,
      totalMappings: 0,
      productDetails: [],
      errorDetails: [message],
    });
  } finally {
    isSyncing = false;
  }
}

function shutdown(signal: string): void {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  isShuttingDown = true;

  if (!isSyncing) {
    logger.info('No sync in progress, exiting immediately');
    process.exit(0);
  }

  logger.info('Waiting for current sync to finish...');
  const check = setInterval(() => {
    if (!isSyncing) {
      clearInterval(check);
      logger.info('Sync finished, exiting');
      process.exit(0);
    }
  }, 500);

  // Force exit after 60 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 60_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function main(): Promise<void> {
  logger.info('Poleepo-Shopify Tag Sync Agent started');
  logger.info(`Cron schedule: ${config.sync.cron}`);

  // Run first sync immediately
  await runSync();

  if (isShuttingDown) return;

  // Schedule recurring sync
  cron.schedule(config.sync.cron, () => {
    if (isShuttingDown) return;
    runSync();
  });

  logger.info('Cron scheduler active. Waiting for next cycle...');
}

main().catch((err) => {
  logger.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
