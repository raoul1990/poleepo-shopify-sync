import * as crypto from 'crypto';
import { config } from '../config';
import { PoleepoTag } from '../clients/poleepo';

export function poleepoTagsToStrings(tags: PoleepoTag[]): string[] {
  return tags.map((t) => t.value);
}

export function shopifyTagsToStrings(tags: string): string[] {
  if (!tags || tags.trim() === '') return [];
  return tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

export function stringsToPoleepoFormat(values: string[]): { value: string }[] {
  return values.map((v) => ({ value: v }));
}

export function stringsToShopifyFormat(values: string[]): string {
  return values.join(', ');
}

export function computeTagHash(tags: string[]): string {
  const normalized = tags
    .map((t) => (config.sync.tagCaseSensitive ? t.trim() : t.trim().toLowerCase()))
    .sort();
  return crypto.createHash('md5').update(normalized.join('|')).digest('hex');
}

/**
 * Merge tags from two sources. Tags are UNITED (merge), never removed.
 * Deduplication is case-insensitive (unless TAG_CASE_SENSITIVE=true).
 */
export function mergeTags(tagsA: string[], tagsB: string[]): string[] {
  const seen = new Map<string, string>(); // normalized -> original

  for (const tag of [...tagsA, ...tagsB]) {
    const key = config.sync.tagCaseSensitive ? tag.trim() : tag.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, tag.trim());
    }
  }

  return Array.from(seen.values());
}
