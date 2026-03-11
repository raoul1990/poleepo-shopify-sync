import { config } from '../config';
import { PoleepoTag } from '../clients/poleepo';

/**
 * Normalize a single tag value: trim + optional lowercase.
 */
export function normalizeTag(tag: string): string {
  return config.sync.tagCaseSensitive ? tag.trim() : tag.trim().toLowerCase();
}

export function poleepoTagsToStrings(tags: PoleepoTag[]): string[] {
  return tags.map((t) => t.value);
}

export function shopifyTagsToStrings(tags: string): string[] {
  if (!tags || tags.trim() === '') return [];
  return tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * Convert tag strings to Poleepo format using known tag IDs.
 * Tags with known IDs are sent as {id, value} for reliable acceptance.
 * Tags without IDs are sent as {value} only (may be rejected by Poleepo).
 */
export function stringsToPoleepoFormatWithIds(
  values: string[],
  tagIdLookup: Map<string, { id: number; value: string }>
): { id?: number; value: string }[] {
  return values.map((v) => {
    const key = normalizeTag(v);
    const known = tagIdLookup.get(key);
    if (known) {
      return { id: known.id, value: known.value };
    }
    return { value: v };
  });
}

export function stringsToShopifyFormat(values: string[]): string {
  return values.join(', ');
}

/**
 * Fast non-cryptographic hash for tag comparison.
 * Uses FNV-1a 32-bit for speed — only used for change detection, not security.
 */
function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, keep as uint32
  }
  return hash.toString(36);
}

export function computeTagHash(tags: string[]): string {
  const normalized = tags.map(normalizeTag).sort();
  return fnv1aHash(normalized.join('|'));
}

/**
 * Merge tags from two sources. Tags are UNITED (merge), never removed.
 * Deduplication is case-insensitive (unless TAG_CASE_SENSITIVE=true).
 */
export function mergeTags(tagsA: string[], tagsB: string[]): string[] {
  const seen = new Map<string, string>(); // normalized -> original

  for (const tag of [...tagsA, ...tagsB]) {
    const key = normalizeTag(tag);
    if (!seen.has(key)) {
      seen.set(key, tag.trim());
    }
  }

  return Array.from(seen.values());
}
