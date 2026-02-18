const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '.env') });

async function test() {
  const baseUrl = process.env.POLEEPO_BASE_URL || 'https://api.poleepo.cloud';

  // 1. Auth
  console.log('=== Poleepo Auth ===');
  const authRes = await fetch(baseUrl + '/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.POLEEPO_API_KEY,
      client_secret: process.env.POLEEPO_API_SECRET,
      grant: 'client_credentials',
    }),
  });

  const authText = await authRes.text();
  console.log('Status:', authRes.status);
  console.log('Response:', authText);

  if (authRes.status !== 200) {
    console.error('AUTH FAILED');
    return;
  }

  const authData = JSON.parse(authText);
  const token = authData.data ? authData.data.access_token : authData.access_token;
  if (!token) {
    console.log('Token not found in response. Full response:', authText);
    return;
  }
  console.log('Token OK\n');

  // 2. Products
  console.log('=== Poleepo Products (5) ===');
  const prodRes = await fetch(baseUrl + '/products?offset=0&max=5&active=true', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  console.log('Status:', prodRes.status);
  const prodText = await prodRes.text();
  try {
    const prodData = JSON.parse(prodText);
    const products = prodData.data || [];
    console.log('Products:', products.length);
    if (products[0]) console.log('Sample:', JSON.stringify({ id: products[0].id, name: products[0].name, tags: (products[0].tags || []).length + ' tags' }));
  } catch (e) {
    console.log('Raw response:', prodText.substring(0, 500));
  }

  // 3. Publications
  console.log('\n=== Poleepo Publications (5) ===');
  const pubRes = await fetch(baseUrl + '/channels/publications?source=SHOPIFY&offset=0&max=5', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  console.log('Status:', pubRes.status);
  const pubText = await pubRes.text();
  try {
    const pubData = JSON.parse(pubText);
    const pubs = pubData.data || [];
    console.log('Publications:', pubs.length);
    if (pubs[0]) console.log('Sample:', JSON.stringify({ product: pubs[0].product, identifier: pubs[0].identifier, source: pubs[0].source }));
  } catch (e) {
    console.log('Raw response:', pubText.substring(0, 500));
  }

  console.log('\n=== Poleepo: TUTTO OK ===');
}

test().catch(e => console.error('ERROR:', e.message));
