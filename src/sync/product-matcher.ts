import { PoleepoClient, PoleepoProduct, PoleepoPublication } from '../clients/poleepo';
import { logger } from '../utils/logger';

export interface ProductMapping {
  poleepoId: number;
  shopifyId: string;
  sku: string;
}

/**
 * Builds a mapping between Poleepo product IDs and Shopify product IDs
 * using SKU matching between products and Shopify publications.
 */
export async function buildProductMappings(
  poleepoClient: PoleepoClient,
  poleepoProducts: PoleepoProduct[]
): Promise<{ mappings: ProductMapping[]; publicationsMap: Record<string, string> }> {
  logger.info('Fetching Shopify publications from Poleepo...');
  const publications = await poleepoClient.getAllPublications();

  // Build SKU -> Shopify source_id map from publications
  const pubSkuMap = new Map<string, string>();
  for (const pub of publications) {
    if (pub.source.id === 'SHOPIFY' && pub.sku && pub.source_id) {
      pubSkuMap.set(pub.sku, pub.source_id);
    }
  }
  logger.info(`Found ${pubSkuMap.size} Shopify publications with SKU`);

  // Build SKU -> Poleepo product ID map (warn on duplicates)
  const productSkuMap = new Map<string, number>();
  for (const product of poleepoProducts) {
    if (product.sku) {
      const existing = productSkuMap.get(product.sku);
      if (existing) {
        logger.warn(
          `Duplicate SKU "${product.sku}": Poleepo product ${product.id} conflicts with ${existing} — using ${product.id}`
        );
      }
      productSkuMap.set(product.sku, product.id);
    }
  }

  // Join on SKU
  const mappings: ProductMapping[] = [];
  const publicationsMap: Record<string, string> = {};

  for (const [sku, shopifyId] of pubSkuMap) {
    const poleepoId = productSkuMap.get(sku);
    if (poleepoId) {
      mappings.push({ poleepoId, shopifyId, sku });
      publicationsMap[String(poleepoId)] = shopifyId;
    }
  }

  logger.info(`Built ${mappings.length} Poleepo-Shopify product mappings (via SKU match)`);
  return { mappings, publicationsMap };
}

/**
 * Returns only new mappings that don't exist in the previous state.
 */
export function findNewMappings(
  currentMap: Record<string, string>,
  previousMap: Record<string, string>
): ProductMapping[] {
  const newMappings: ProductMapping[] = [];

  for (const [poleepoId, shopifyId] of Object.entries(currentMap)) {
    if (!previousMap[poleepoId]) {
      newMappings.push({
        poleepoId: parseInt(poleepoId, 10),
        shopifyId,
        sku: '',
      });
    }
  }

  return newMappings;
}
