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

  // Full publication structure
  console.log('=== Publications (raw, 3 items) ===');
  const pubRes = await fetch(baseUrl + '/channels/publications?source=SHOPIFY&offset=0&max=3', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  const pubData = await pubRes.json();
  console.log(JSON.stringify(pubData, null, 2));

  // Full product structure (first product)
  console.log('\n=== Product sample (raw) ===');
  const prodRes = await fetch(baseUrl + '/products?offset=0&max=1&active=true', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  const prodData = await prodRes.json();
  console.log(JSON.stringify(prodData, null, 2));
}

test().catch(e => console.error('ERROR:', e.message));
