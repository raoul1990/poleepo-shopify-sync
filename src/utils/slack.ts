import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from './logger';

const MAX_DISPLAY_PRODUCTS = 15;
const MAX_DISPLAY_ERRORS = 10;
const SLACK_BLOCK_CHAR_LIMIT = 3000;
const ERROR_TRUNCATE_LENGTH = 200;

export interface SyncReportData {
  syncType: 'full' | 'incremental';
  analyzed: number;
  modified: number;
  toShopify: number;
  toPoleepo: number;
  errors: number;
  durationSeconds: string;
  totalMappings: number;
  productDetails: ProductSyncDetail[];
  errorDetails: string[];
  browserFallbackSummary?: string;
}

export interface ProductSyncDetail {
  poleepoId: number;
  shopifyId: string;
  productName: string;
  direction: 'shopify' | 'poleepo' | 'both';
  tagsBefore: string[];
  tagsAfter: string[];
  tagsAdded: string[];
  rejectedByPoleepo?: string[];
}

function truncateBlock(text: string): string {
  return text.length > SLACK_BLOCK_CHAR_LIMIT
    ? text.substring(0, SLACK_BLOCK_CHAR_LIMIT - 3) + '...'
    : text;
}

function sanitizeError(error: string): string {
  const clean = error.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > ERROR_TRUNCATE_LENGTH
    ? clean.substring(0, ERROR_TRUNCATE_LENGTH) + '...'
    : clean;
}

function buildHeaderBlocks(report: SyncReportData): object[] {
  const statusEmoji = report.errors > 0 ? ':warning:' : ':white_check_mark:';
  const statusText = report.errors > 0 ? 'Completato con errori' : 'Completato';
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${statusEmoji} Poleepo-Shopify Tag Sync Report`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Stato:*\n${statusText}` },
        { type: 'mrkdwn', text: `*Tipo sync:*\n${report.syncType === 'full' ? 'Full (prima esecuzione)' : 'Incrementale'}` },
        { type: 'mrkdwn', text: `*Durata:*\n${report.durationSeconds}s` },
        { type: 'mrkdwn', text: `*Timestamp:*\n${timestamp}` },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*Riepilogo*\n` +
          `• Prodotti mappati totali: *${report.totalMappings}*\n` +
          `• Prodotti analizzati: *${report.analyzed}*\n` +
          `• Prodotti modificati: *${report.modified}*\n` +
          `  ├ Aggiornati su Shopify: *${report.toShopify}*\n` +
          `  └ Aggiornati su Poleepo: *${report.toPoleepo}*\n` +
          `• Errori: *${report.errors}*`,
      },
    },
  ];
}

function buildProductDetailBlocks(details: ProductSyncDetail[]): object[] {
  if (details.length === 0) return [];

  const blocks: object[] = [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Dettaglio prodotti modificati (${details.length}):*`,
      },
    },
  ];

  const displayProducts = details.slice(0, MAX_DISPLAY_PRODUCTS);
  for (const product of displayProducts) {
    const directionLabel =
      product.direction === 'both'
        ? ':arrows_counterclockwise: Entrambi'
        : product.direction === 'shopify'
        ? ':arrow_right: → Shopify'
        : ':arrow_left: → Poleepo';

    let detail =
      `*${product.productName || `Poleepo #${product.poleepoId}`}*\n` +
      `Poleepo ID: \`${product.poleepoId}\` | Shopify ID: \`${product.shopifyId}\`\n` +
      `Direzione: ${directionLabel}`;

    if (product.tagsAdded.length > 0) {
      const tagsStr = product.tagsAdded.map((t) => `\`${t}\``).join(', ');
      detail += `\nTag aggiunti: ${tagsStr}`;
    }

    if (product.rejectedByPoleepo && product.rejectedByPoleepo.length > 0) {
      const rejStr = product.rejectedByPoleepo.map((t) => `\`${t}\``).join(', ');
      detail += `\n:x: Tag rifiutati da Poleepo (non in libreria): ${rejStr}`;
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncateBlock(detail) },
    });
  }

  if (details.length > MAX_DISPLAY_PRODUCTS) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_...e altri ${details.length - MAX_DISPLAY_PRODUCTS} prodotti non mostrati_`,
        },
      ],
    });
  }

  return blocks;
}

function buildErrorBlocks(errorDetails: string[]): object[] {
  if (errorDetails.length === 0) return [];

  const errorLines = errorDetails
    .slice(0, MAX_DISPLAY_ERRORS)
    .map((e) => `• ${sanitizeError(e)}`)
    .join('\n');
  const errorText = `*:x: Errori (${errorDetails.length}):*\n${errorLines}`;

  return [
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncateBlock(errorText) },
    },
  ];
}

function buildBrowserFallbackBlocks(summary?: string): object[] {
  if (!summary) return [];

  const fbText =
    `*:globe_with_meridians: Browser Fallback (tag rifiutati da API, assegnati via UI):*\n` +
    `\`\`\`${summary}\`\`\``;

  return [
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncateBlock(fbText) },
    },
  ];
}

function buildNoChangesBlocks(report: SyncReportData): object[] {
  if (report.modified > 0 || report.errors > 0) return [];

  return [
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':zzz: _Nessuna modifica necessaria — tutti i tag sono già sincronizzati._',
        },
      ],
    },
  ];
}

function buildSlackBlocks(report: SyncReportData): object[] {
  return [
    ...buildHeaderBlocks(report),
    ...buildProductDetailBlocks(report.productDetails),
    ...buildErrorBlocks(report.errorDetails),
    ...buildBrowserFallbackBlocks(report.browserFallbackSummary),
    ...buildNoChangesBlocks(report),
  ];
}

export async function sendSlackReport(report: SyncReportData): Promise<void> {
  const webhookUrl = config.slackWebhookUrl;
  if (!webhookUrl) {
    logger.debug('Slack webhook URL not configured, skipping notification');
    return;
  }

  try {
    const blocks = buildSlackBlocks(report);
    const payload = {
      text: `Sync ${report.errors > 0 ? 'con errori' : 'OK'}: ${report.analyzed} analizzati, ${report.modified} modificati, ${report.errors} errori`,
      blocks,
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error(`Slack notification failed (${res.status}): ${text}`);
    } else {
      logger.info('Slack report sent successfully');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to send Slack notification: ${message}`);
  }
}

export async function uploadFileToSlack(
  filePath: string,
  options: { title?: string; message?: string } = {}
): Promise<boolean> {
  const token = config.slackBotToken;
  const channelId = config.slackChannelId;

  if (!token || !channelId) {
    logger.warn('Slack Bot Token or Channel ID not configured, skipping file upload');
    return false;
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    logger.error(`File not found: ${resolvedPath}`);
    return false;
  }

  const fileName = path.basename(resolvedPath);
  const fileContent = fs.readFileSync(resolvedPath);
  const title = options.title || fileName;

  try {
    // Step 1: Get upload URL
    const getUrlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        filename: fileName,
        length: String(fileContent.byteLength),
      }),
    });

    const getUrlData = await getUrlRes.json() as {
      ok: boolean; upload_url?: string; file_id?: string; error?: string;
    };

    if (!getUrlData.ok || !getUrlData.upload_url || !getUrlData.file_id) {
      logger.error(`Slack files.getUploadURLExternal failed: ${getUrlData.error || 'unknown error'}`);
      return false;
    }

    // Step 2: Upload file content to the URL
    const uploadRes = await fetch(getUrlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileContent,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      logger.error(`Slack file upload failed (${uploadRes.status}): ${text}`);
      return false;
    }

    // Step 3: Complete the upload and share to channel
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: [{ id: getUrlData.file_id, title }],
        channel_id: channelId,
        initial_comment: options.message || '',
      }),
    });

    const completeData = await completeRes.json() as { ok: boolean; error?: string };

    if (!completeData.ok) {
      logger.error(`Slack files.completeUploadExternal failed: ${completeData.error || 'unknown error'}`);
      return false;
    }

    logger.info(`File "${title}" uploaded to Slack channel successfully`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to upload file to Slack: ${message}`);
    return false;
  }
}
