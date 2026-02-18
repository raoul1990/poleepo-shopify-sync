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

  // Try fetching publications for a specific product
  console.log('=== Publication with product param ===');
  const pubRes = await fetch(baseUrl + '/channels/publications?source=SHOPIFY&offset=0&max=3&product=16292716', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  const pubData = await pubRes.json();
  console.log(JSON.stringify(pubData, null, 2));

  // Try product endpoint with publications info
  console.log('\n=== Product 16292716 direct ===');
  const prodRes = await fetch(baseUrl + '/products/16292716', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  const prodData = await prodRes.json();
  // Show only relevant fields
  const d = prodData.data || prodData;
  console.log('Keys:', Object.keys(d));
  console.log('id:', d.id, '| sku:', d.sku, '| title:', d.title);
  if (d.publications) console.log('publications:', JSON.stringify(d.publications, null, 2));
  if (d.channels) console.log('channels:', JSON.stringify(d.channels, null, 2));

  // Check publication fields more closely - the id might link to product
  console.log('\n=== All publication keys (first item) ===');
  const pub2Res = await fetch(baseUrl + '/channels/publications?source=SHOPIFY&offset=0&max=1', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  const pub2Data = await pub2Res.json();
  if (pub2Data.data && pub2Data.data[0]) {
    console.log('All keys:', Object.keys(pub2Data.data[0]));
    console.log('Full object:', JSON.stringify(pub2Data.data[0], null, 2));
  }
}

test().catch(e => console.error('ERROR:', e.message));
