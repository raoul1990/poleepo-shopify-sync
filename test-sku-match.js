const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '.env') });

async function test() {
  const baseUrl = process.env.POLEEPO_BASE_URL || 'https://api.poleepo.cloud';

  const authRes = await fetch(baseUrl + '/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.POLEEPO_API_KEY,
      client_secret: process.env.POLEEPO_API_SECRET,
      grant: 'client_credentials',
    }),
  });
  const authData = await authRes.json();
  const token = authData.data.access_token;

  // Publication SKU "5668006" -> find the matching Poleepo product
  // Try searching products by SKU if there's a filter
  console.log('=== Search product by SKU 5668006 ===');
  const prodRes = await fetch(baseUrl + '/products?sku=5668006&max=5', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  const prodData = await prodRes.json();
  if (prodData.data && prodData.data.length > 0) {
    for (const p of prodData.data) {
      console.log('Found:', { id: p.id, sku: p.sku, title: p.title });
    }
  } else {
    console.log('No products found with sku filter. Response:', JSON.stringify(prodData).substring(0, 300));
  }

  // Also try: does publication have a product_id or similar hidden field?
  // Let's check if the product endpoint supports querying by publication
  console.log('\n=== Try product/publications endpoint ===');
  const endpoints = [
    '/products?sku=5668006',
    '/products?search=5668006',
  ];
  for (const ep of endpoints) {
    const r = await fetch(baseUrl + ep + '&max=2', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    });
    const d = await r.json();
    const count = d.data ? d.data.length : 0;
    const total = d.total || 0;
    console.log(`${ep} -> status:${r.status} total:${total} count:${count}`);
    if (d.data && d.data[0]) console.log('  First:', { id: d.data[0].id, sku: d.data[0].sku });
  }

  // Count totals
  console.log('\n=== Totals ===');
  const totalProdRes = await fetch(baseUrl + '/products?max=1&active=true', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  const totalProdData = await totalProdRes.json();
  console.log('Total products:', totalProdData.total);

  const totalPubRes = await fetch(baseUrl + '/channels/publications?source=SHOPIFY&max=1', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  const totalPubData = await totalPubRes.json();
  console.log('Total Shopify publications:', totalPubData.total);
}

test().catch(e => console.error('ERROR:', e.message));
