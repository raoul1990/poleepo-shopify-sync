import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface ProductSyncState {
  shopifyId: string;
  poleepoTagHash: string;
  shopifyTagHash: string;
  lastSynced: string;
}

export interface SyncState {
  lastSyncTime: string;
  products: Record<string, ProductSyncState>; // key: "poleepo_{id}"
  publicationsMap: Record<string, string>; // poleepoId -> shopifyId
}

function getStatePath(): string {
  return path.resolve(process.cwd(), config.stateFilePath);
}

export function loadState(): SyncState | null {
  const filePath = getStatePath();
  try {
    if (!fs.existsSync(filePath)) {
      logger.info('No sync state file found, will perform full sync');
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const state = JSON.parse(raw) as SyncState;
    logger.info(`Loaded sync state from ${filePath} (last sync: ${state.lastSyncTime})`);
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to load sync state: ${message}. Will perform full sync.`);
    return null;
  }
}

export function saveState(state: SyncState): void {
  const filePath = getStatePath();
  const tmpPath = filePath + '.tmp';
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write to temp file then rename for atomic operation
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
  logger.debug(`Sync state saved to ${filePath}`);
}

export function createEmptyState(): SyncState {
  return {
    lastSyncTime: new Date().toISOString(),
    products: {},
    publicationsMap: {},
  };
}
