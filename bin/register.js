'use strict';
// Registers this seller origin with free x402 discovery indexes (no keys, no funds).
const cfg = require('../config.json');
const origin = process.argv[2] || process.env.PUBLIC_BASE_URL;
if (!origin || !/^https:\/\//.test(origin)) { console.error('usage: node bin/register.js https://<public-origin>'); process.exit(2); }
(async () => {
  for (const u of ['https://agent402.io/api/index/register', 'https://api.agent402.io/api/index/register']) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: origin, name: 'chaincost', payTo: cfg.payTo }), signal: AbortSignal.timeout(15000) });
      console.log(new URL(u).host + ':', r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.log(new URL(u).host + ': unreachable (' + (e.cause ? e.cause.message : e.message) + ')'); }
  }
  console.log('done. verify: curl ' + origin + '/health');
})();
