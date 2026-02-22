import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  poleepo: {
    apiKey: required('POLEEPO_API_KEY'),
    apiSecret: required('POLEEPO_API_SECRET'),
    baseUrl: process.env.POLEEPO_BASE_URL || 'https://api.poleepo.cloud',
  },
  shopify: {
    store: required('SHOPIFY_STORE'),
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2025-07',
  },
  sync: {
    cron: process.env.SYNC_CRON || '*/15 * * * *',
    batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '50', 10),
    tagCaseSensitive: process.env.TAG_CASE_SENSITIVE === 'true',
  },
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
  stateFilePath: process.env.STATE_FILE_PATH || './data/sync-state.json',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  slackChannelId: process.env.SLACK_CHANNEL_ID || '',
  poleepoWeb: {
    username: process.env.POLEEPO_WEB_USERNAME || '',
    password: process.env.POLEEPO_WEB_PASSWORD || '',
    baseUrl: 'https://app.poleepo.cloud',
  },
};
