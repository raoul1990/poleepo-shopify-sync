const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '.env') });

async function testPoleepo() {
  console.log('=== Test Poleepo API ===');
  const baseUrl = process.env.POLEEPO_BASE_URL || 'https://api.poleepo.cloud';

  // 1. Auth
  console.log('Authenticating...');
  const authRes = await fetch(baseUrl + '/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.POLEEPO_API_KEY,
      api_secret: process.env.POLEEPO_API_SECRET,
    }),
  });

  if (authRes.status !== 200) {
    const text = await authRes.text();
    console.error('AUTH FAILED:', authRes.status, text);
    return false;
  }

  const authData = await authRes.json();
  const token = authData.data.access_token;
  console.log('Auth OK, token received');

  // 2. Fetch products (just 5)
  console.log('Fetching 5 products...');
  const prodRes = await fetch(baseUrl + '/products?offset=0&max=5&active=true', {
    headers: { 'Authorization': 'Bearer ' + token },
  });

  if (prodRes.status !== 200) {
    const text = await prodRes.text();
    console.error('PRODUCTS FAILED:', prodRes.status, text);
    return false;
  }

  const prodData = await prodRes.json();
  const products = prodData.data || [];
  console.log('Products fetched:', products.length);
  if (products[0]) {
    console.log('Sample:', JSON.stringify({ id: products[0].id, name: products[0].name, tagsCount: (products[0].tags || []).length }, null, 2));
  }

  // 3. Publications
  console.log('Fetching publications (max 5)...');
  const pubRes = await fetch(baseUrl + '/channels/publications?source=SHOPIFY&offset=0&max=5', {
    headers: { 'Authorization': 'Bearer ' + token },
  });

  if (pubRes.status !== 200) {
    const text = await pubRes.text();
    console.error('PUBLICATIONS FAILED:', pubRes.status, text);
    return false;
  }

  const pubData = await pubRes.json();
  const pubs = pubData.data || [];
  console.log('Publications fetched:', pubs.length);
  if (pubs[0]) {
    console.log('Sample:', JSON.stringify({ product: pubs[0].product, identifier: pubs[0].identifier, source: pubs[0].source }));
  }

  console.log('=== Poleepo: OK ===\n');
  return true;
}

async function testShopify() {
  console.log('=== Test Shopify API ===');
  const store = process.env.SHOPIFY_STORE;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-07';

  // 1. Auth (client_credentials)
  console.log('Authenticating...');
  const tokenUrl = 'https://' + store + '/admin/oauth/access_token';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.SHOPIFY_CLIENT_SECRET,
  });

  const authRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (authRes.status !== 200) {
    const text = await authRes.text();
    console.error('AUTH FAILED:', authRes.status, text);
    return false;
  }

  const authData = await authRes.json();
  const token = authData.access_token;
  console.log('Auth OK, token received (expires_in:', authData.expires_in + 's)');

  // 2. Fetch products (just 5)
  console.log('Fetching 5 products...');
  const baseUrl = 'https://' + store + '/admin/api/' + apiVersion;
  const prodRes = await fetch(baseUrl + '/products.json?limit=5&fields=id,title,tags', {
    headers: { 'X-Shopify-Access-Token': token },
  });

  if (prodRes.status !== 200) {
    const text = await prodRes.text();
    console.error('PRODUCTS FAILED:', prodRes.status, text);
    return false;
  }

  const prodData = await prodRes.json();
  const products = prodData.products || [];
  console.log('Products fetched:', products.length);
  if (products[0]) {
    const tagCount = products[0].tags ? products[0].tags.split(',').filter(t => t.trim()).length : 0;
    console.log('Sample:', JSON.stringify({ id: products[0].id, title: products[0].title, tagsCount: tagCount }));
  }

  console.log('=== Shopify: OK ===\n');
  return true;
}

async function main() {
  const poleepoOk = await testPoleepo().catch(e => { console.error('Poleepo ERROR:', e.message); return false; });
  const shopifyOk = await testShopify().catch(e => { console.error('Shopify ERROR:', e.message); return false; });

  console.log('\n========== RISULTATO ==========');
  console.log('Poleepo:', poleepoOk ? 'OK' : 'FALLITO');
  console.log('Shopify:', shopifyOk ? 'OK' : 'FALLITO');

  if (poleepoOk && shopifyOk) {
    console.log('\nTutte le connessioni funzionano. Pronto per la prima sync.');
  } else {
    console.log('\nAlcune connessioni hanno fallito. Verificare le credenziali.');
    process.exit(1);
  }
}

main();
