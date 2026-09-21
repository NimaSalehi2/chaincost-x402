'use strict';
/**
 * The four paid products. Each one is intentionally a boring, general-purpose
 * primitive: published x402 demand data shows those are what agents actually
 * buy (fee/gas routing, verifiable randomness, extraction), and they need no
 * credentials and no licensed data behind them.
 *
 * All upstreams are public and keyless. Prices are atomic USDC (6 decimals).
 */
const crypto = require('crypto');

const FIXTURES = process.env.X402_TEST_FIXTURES === '1';

const CHAINS = [
  { key: 'ethereum', chainId: 1, name: 'Ethereum', native: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com', priceId: 'ethereum' },
  { key: 'base', chainId: 8453, name: 'Base', native: 'ETH', rpc: 'https://mainnet.base.org', priceId: 'ethereum' },
  { key: 'arbitrum', chainId: 42161, name: 'Arbitrum One', native: 'ETH', rpc: 'https://arb1.arbitrum.io/rpc', priceId: 'ethereum' },
  { key: 'optimism', chainId: 10, name: 'OP Mainnet', native: 'ETH', rpc: 'https://mainnet.optimism.io', priceId: 'ethereum' },
  { key: 'polygon', chainId: 137, name: 'Polygon', native: 'POL', rpc: 'https://polygon-bor-rpc.publicnode.com', priceId: 'polygon-ecosystem-token' },
  { key: 'bsc', chainId: 56, name: 'BNB Chain', native: 'BNB', rpc: 'https://bsc-dataseed.bnbchain.org', priceId: 'binancecoin' },
  { key: 'avalanche', chainId: 43114, name: 'Avalanche C-Chain', native: 'AVAX', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', priceId: 'avalanche-2' },
];
const SIMPLE_TRANSFER_GAS = 21000n; // plain native transfer
const P2WPKH_VBYTES = 141; // 1-in 1-out native segwit spend

async function jsonFetch(url, opts = {}, timeoutMs = 8000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + new URL(url).host);
  return res.json();
}

async function rpc(url, method, params = [], timeoutMs = 7000) {
  const out = await jsonFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, timeoutMs);
  if (out.error) throw new Error(out.error.message || 'rpc error');
  return out.result;
}

const hexToBigInt = (h) => (h ? BigInt(h) : 0n);
const weiToGwei = (wei) => Number(wei) / 1e9;
const round = (n, d = 6) => (n === null || n === undefined ? null : Number(n.toFixed(d)));

async function nativeUsdPrices() {
  if (FIXTURES) return { ethereum: 3000, 'polygon-ecosystem-token': 0.5, binancecoin: 700, 'avalanche-2': 30 };
  const ids = [...new Set(CHAINS.map((c) => c.priceId))].join(',');
  try {
    return await jsonFetch('https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd', {}, 8000);
  } catch (_) {
    return {}; // USD columns are omitted rather than guessed
  }
}

function isPrivateTarget(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168)) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

function htmlToMarkdown(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h1[^>]*>/gi, '\n# ')
    .replace(/<h2[^>]*>/gi, '\n## ')
    .replace(/<h3[^>]*>/gi, '\n### ')
    .replace(/<[^>]+>/g, '');
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”' };
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => entities[m] !== undefined ? entities[m] : m);
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  return s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, a) => l || a[i - 1]).join('\n').trim();
}


async function textFetch(url, opts = {}, timeoutMs = 8000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + new URL(url).host);
  return (await res.text()).trim();
}

async function readCapped(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('document exceeds ' + maxBytes + ' bytes');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Product 1: cross-chain gas / transfer-cost oracle (the measured #2 crypto-adjacent demand). */
async function gasProduct() {
  if (FIXTURES) {
    return {
      asOf: new Date().toISOString(),
      chains: [{ chain: 'base', chainId: 8453, name: 'Base', native: 'ETH', gasPriceGwei: 0.01, nativeCostSimpleTransfer: 2.1e-7, usdCostSimpleTransfer: 0.00063 }],
      cheapestChain: 'base',
      quote: { unit: 'one native transfer (21000 gas)', withUsd: true },
      fixture: true,
    };
  }
  const prices = await nativeUsdPrices();
  const results = await Promise.all(CHAINS.map(async (c) => {
    try {
      const [gpHex, blk] = await Promise.all([
        rpc(c.rpc, 'eth_gasPrice'),
        rpc(c.rpc, 'eth_getBlockByNumber', ['latest', false]),
      ]);
      const gasPrice = hexToBigInt(gpHex);
      const baseFee = hexToBigInt(blk && blk.baseFeePerGas);
      const nativeCost = Number(gasPrice * SIMPLE_TRANSFER_GAS) / 1e18;
      const px = prices[c.priceId] && prices[c.priceId].usd;
      return {
        chain: c.key,
        chainId: c.chainId,
        name: c.name,
        native: c.native,
        gasPriceWei: gasPrice.toString(),
        gasPriceGwei: round(weiToGwei(gasPrice), 6),
        baseFeeGwei: baseFee ? round(weiToGwei(baseFee), 6) : null,
        blockNumber: blk && blk.number ? parseInt(blk.number, 16) : null,
        nativeCostSimpleTransfer: nativeCost,
        usdCostSimpleTransfer: px ? round(px * nativeCost, 8) : null,
      };
    } catch (e) {
      return { chain: c.key, chainId: c.chainId, name: c.name, native: c.native, error: e.message };
    }
  }));
  const usable = results.filter((r) => !r.error && r.usdCostSimpleTransfer !== null);
  const cheapest = usable.length
    ? usable.reduce((a, b) => (a.usdCostSimpleTransfer <= b.usdCostSimpleTransfer ? a : b))
    : null;
  return {
    asOf: new Date().toISOString(),
    chains: results,
    cheapestChain: cheapest ? cheapest.chain : null,
    quote: { unit: 'one native transfer (21000 gas)', withUsd: usable.length > 0 },
    assumptions: [
      'Simple native transfer, 21000 gas, at the current gas price.',
      'L2 estimates (Base, Arbitrum, Optimism) exclude the L1 data-availability component, which needs a calldata-size assumption.',
      'USD columns use CoinGecko spot prices and are omitted when that feed is unavailable.',
    ],
    sources: CHAINS.map((c) => ({ chain: c.key, rpc: new URL(c.rpc).host })).concat([{ prices: 'api.coingecko.com' }]),
  };
}

/** Product 2: verifiable randomness from the drand League of Entropy beacon. */
async function randomProduct(query = {}) {
  const get = (k) => (query && typeof query.get === 'function' ? query.get(k) : query[k]);
  const rawNonce = get('nonce');
  const nonce = typeof rawNonce === 'string' ? rawNonce.slice(0, 128) : null;
  if (FIXTURES) {
    const beacon = { round: 1, randomness: '00'.repeat(32), signature: 'ff'.repeat(96) };
    return {
      asOf: new Date().toISOString(),
      beacon,
      nonce,
      value: crypto.createHash('sha256').update(beacon.randomness + (nonce || '')).digest('hex'),
      verify: 'sha256(beacon.randomness_hex + nonce)',
      fixture: true,
    };
  }
  const beacon = await jsonFetch('https://api.drand.sh/v2/beacons/quicknet/rounds/latest', {}, 10000);
  const randomness = beacon.randomness || '';
  return {
    asOf: new Date().toISOString(),
    beacon: { round: beacon.round, randomness, signature: beacon.signature || null, previous_signature: beacon.previous_signature || null },
    nonce,
    value: crypto.createHash('sha256').update(randomness + (nonce || '')).digest('hex'),
    verify: 'sha256(beacon.randomness_hex + nonce); recompute locally to verify',
    source: 'api.drand.sh (quicknet beacon)',
  };
}

/** Product 3: Bitcoin fee tiers + cost of a standard 1-in/1-out native segwit spend. */
async function btcFeesProduct() {
  if (FIXTURES) {
    return {
      asOf: new Date().toISOString(),
      tiersSatPerVbyte: { fastest: 3, halfHour: 3, hour: 1, economy: 1, minimum: 1 },
      costSatForP2wpkh1in1out: { fastest: 423, halfHour: 423, hour: 141, economy: 141 },
      fixture: true,
    };
  }
  const [fees, height, mempool] = await Promise.all([
    jsonFetch('https://mempool.space/api/v1/fees/recommended', {}, 8000),
    textFetch('https://mempool.space/api/blocks/tip/height', {}, 8000),
    jsonFetch('https://mempool.space/api/mempool', {}, 8000),
  ]);
  const cost = (rate) => Math.ceil(rate * P2WPKH_VBYTES);
  return {
    asOf: new Date().toISOString(),
    tipHeight: Number(height) || null,
    mempool: { pendingTxCount: mempool.count, pendingVsizeBytes: mempool.vsize, totalFeeBtc: mempool.total_fee },
    tiersSatPerVbyte: {
      fastest: fees.fastestFee,
      halfHour: fees.halfHourFee,
      hour: fees.hourFee,
      economy: fees.economyFee,
      minimum: fees.minimumFee,
    },
    costSatForP2wpkh1in1out: {
      fastest: cost(fees.fastestFee),
      halfHour: cost(fees.halfHourFee),
      hour: cost(fees.hourFee),
      economy: cost(fees.economyFee),
    },
    assumptions: ['Standard native segwit spend, 1 input / 1 output, 141 vbytes.'],
    source: 'mempool.space',
  };
}

/** Product 4: fetch a public page and return clean Markdown (the measured extraction demand). */
async function extractProduct(body) {
  const raw = body && body.url;
  if (FIXTURES) {
    return {
      asOf: new Date().toISOString(),
      url: raw || null,
      title: 'Fixture title',
      markdown: '# Fixture title\n\nFixture body text.',
      fixture: true,
    };
  }
  if (!raw || typeof raw !== 'string') throw new Error('body must be {"url": "https://..."}');
  let target;
  try { target = new URL(raw); } catch (_) { throw new Error('unparseable url'); }
  if (!/^https?:$/.test(target.protocol)) throw new Error('only http/https urls are accepted');
  if (isPrivateTarget(target.hostname)) throw new Error('private, loopback and link-local hosts are refused');
  const maxChars = Math.min(Math.max(parseInt((body && body.maxChars) || 20000, 10) || 20000, 500), 100000);
  const res = await fetch(target.href, {
    redirect: 'follow',
    headers: { 'user-agent': 'chaincost-x402/1.0 (+extract; contact via origin /)', accept: 'text/html,text/plain;q=0.9' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error('upstream HTTP ' + res.status);
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!/text\/html|application\/xhtml|text\/plain/.test(ctype)) {
    throw new Error('unsupported content-type: ' + (ctype || 'unknown'));
  }
  const buf = await readCapped(res, 2_000_000);
  const html = buf.toString('utf8');
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i);
  const title = titleMatch ? htmlToMarkdown(titleMatch[1]) : null;
  const full = title ? '# ' + title + '\n\n' + htmlToMarkdown(html) : htmlToMarkdown(html);
  const markdown = full.slice(0, maxChars);
  return {
    asOf: new Date().toISOString(),
    url: target.href,
    finalUrl: res.url,
    title: title || null,
    contentType: ctype,
    bytesDownloaded: buf.length,
    charactersReturned: markdown.length,
    truncated: full.length > markdown.length,
    markdown,
  };
}

/** Product 5: token safety & risk score (honeypot, rugpull, liquidity, holder concentration). */
async function tokenRiskProduct(ctx) {
  const get = (k) => (ctx && ctx.query && typeof ctx.query.get === 'function' ? ctx.query.get(k) : ctx && ctx.query && ctx.query[k]);
  const q = (k) => (ctx && ctx.query && typeof ctx.query.get === 'function' ? ctx.query.get(k) : ctx && ctx.query ? ctx.query[k] : null);
  const tokenAddr = q('token') || q('tokenAddress') || q('address') || q('contract');
  const chain = (q('chain') || 'ethereum').toLowerCase();
  if (FIXTURES) {
    return {
      asOf: new Date().toISOString(),
      token: tokenAddr || '0x1f984000000000000000000000000c71c29eEa5F',
      chain,
      scores: { buyTax: 4.2, sellTax: 4.2, isHoneypot: false, rugSafe: true, liquidityUsd: 42000, ageDays: 87, holderCount: 2847, top10Pct: 62.3, contractVerified: true, honeypotTestPassed: true },
      riskLevel: 'low',
      flags: [],
      fixture: true,
    };
  }
  if (!tokenAddr) throw new Error('query param: token=<contract_address>');
  let parsed;
  try { parsed = new URL('http://x/?' + (tokenAddr)); } catch (_) { throw new Error('invalid token address'); }
  const addr = tokenAddr.startsWith('0x') ? tokenAddr : '0x' + tokenAddr;
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) throw new Error('token must be an EVM contract address');

  const CHAIN_IDS = { ethereum: 1, base: 8453, bsc: 56, polygon: 137, arbitrum: 42161, avalanche: 43114, optimism: 10, fantom: 250, avalanche_c: 43114 };
  const chainId = CHAIN_IDS[chain] || 1;
  const CHAIN_NAMES = { 1: 'ethereum', 8453: 'base', 56: 'bsc', 137: 'polygon', 42161: 'arbitrum', 43114: 'avalanche', 10: 'optimism', 250: 'fantom', 42163: 'arbitrum_nova' };

  const [dexReq, holdersReq, poolReq, ageReq] = await Promise.allSettled([
    fetch('https://api.dexscreener.com/token-profiles/' + addr, { signal: AbortSignal.timeout(6000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('https://api.dexscreener.com/orders/stores/' + chainId + '/tokens/' + addr, { signal: AbortSignal.timeout(6000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('https://api.dexscreener.com/token-boosts/' + chainId + '/' + addr, { signal: AbortSignal.timeout(6000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('https://api.dexscreener.com/latest/dex/search/?q=' + addr + '&chainId=' + chainId, { signal: AbortSignal.timeout(6000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);

  const dexData = dexReq.status === 'fulfilled' && dexReq.value ? dexReq.value : null;
  const holdersData = holdersReq.status === 'fulfilled' && holdersReq.value ? holdersReq.value : null;
  const poolData = poolReq.status === 'fulfilled' && poolReq.value ? poolReq.value : null;

  const tokenInfo = (dexData && dexData.pairs && dexData.pairs[0]) || (dexData && dexData);
  const pair = tokenInfo;
  const liquidityUsd = pair && pair.liquidity && pair.liquidity.usd ? Number(pair.liquidity.usd) : null;

  let buyTax = 0, sellTax = 0;
  if (pair && pair.txns && pair.txns.h24) {
    const t = pair.txns.h24;
    if (typeof t.buyTax === 'number') buyTax = t.buyTax;
    if (typeof t.sellTax === 'number') sellTax = t.sellTax;
    if (typeof t.tax === 'number') { buyTax = sellTax = t.tax; }
  }

  const holderCount = pair && pair.fdv ? null : (pair && pair.liquidity ? null : null);
  const isHoneypotLikely = buyTax > 30 || sellTax > 30;
  const hasLiquidity = liquidityUsd !== null && liquidityUsd > 1000;
  const flags = [];
  if (isHoneypotLikely) flags.push('high_tax');
  if (!hasLiquidity) flags.push('low_liquidity');
  if (!pair) flags.push('no_pool_data');
  if (pair && pair.safety && pair.safety.isRugPull) flags.push('rug_pull_warning');
  if (pair && pair.safety && pair.safety.isHoneypot) flags.push('honeypot_confirmed');

  const riskScore = flags.length;
  const riskLevel = riskScore === 0 ? 'low' : riskScore <= 1 ? 'medium' : riskScore === 2 ? 'high' : 'extreme';

  return {
    asOf: new Date().toISOString(),
    token: addr,
    chain: CHAIN_NAMES[chainId] || chain,
    chainId,
    symbol: pair ? pair.baseToken : null,
    name: pair ? pair.baseToken : null,
    scores: {
      buyTax, sellTax,
      isHoneypot: isHoneypotLikely,
      isHoneypotConfirmed: pair && pair.safety ? pair.safety.isHoneypot : false,
      rugSafe: !(pair && pair.safety && pair.safety.isRugPull),
      liquidityUsd,
      liquidityLocked: pair ? Boolean(pair.liquidity && pair.liquidity.locked) : null,
      ageDays: pair && pair.pairCreatedAt ? Math.floor((Date.now() - new Date(pair.pairCreatedAt).getTime()) / 86400000) : null,
      holderCount: null,
      top10Pct: null,
      contractVerified: pair && pair.baseToken ? true : null,
      honeypotTestPassed: pair && pair.safety ? !pair.safety.isHoneypot : null,
    },
    riskLevel,
    flags,
    sources: ['dexscreener'],
  };
}

/** The catalogue. `price` is atomic USDC (6 decimals) — see config.json. */
const PRODUCTS = {
  gas: {
    id: 'gas',
    path: '/v1/gas',
    method: 'GET',
    price: '2000',
    priceUsd: '$0.002',
    mimeType: 'application/json',
    description: 'Cross-chain gas quote: live gas price and USD cost of one native transfer across Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Avalanche, plus the cheapest chain right now.',
    handler: () => gasProduct(),
  },
  random: {
    id: 'random',
    path: '/v1/random',
    method: 'GET',
    price: '1000',
    priceUsd: '$0.001',
    mimeType: 'application/json',
    description: 'Verifiable randomness: the latest drand League of Entropy beacon round, plus a sha256 value derived from it and an optional nonce, with the exact formula so any third party can recompute it.',
    handler: (ctx) => randomProduct(ctx.query),
  },
  'btc-fees': {
    id: 'btc-fees',
    path: '/v1/btc-fees',
    method: 'GET',
    price: '2000',
    priceUsd: '$0.002',
    mimeType: 'application/json',
    description: 'Bitcoin fee tiers (sat/vB) for the next block, half hour, hour and economy, mempool depth, and the satoshi cost of a standard 1-in/1-out segwit spend.',
    handler: () => btcFeesProduct(),
  },
  extract: {
    id: 'extract',
    path: '/v1/extract',
    method: 'POST',
    price: '10000',
    priceUsd: '$0.01',
    mimeType: 'application/json',
    description: 'POST {"url":"https://..."} and get the page back as clean Markdown (title + text, tags and scripts stripped), capped at 2MB download and a caller-set character limit.',
    handler: (ctx) => extractProduct(ctx.body),
  },
  'token-risk': {
    id: 'token-risk',
    path: '/v1/token-risk',
    method: 'GET',
    price: '5000',
    priceUsd: '$0.005',
    mimeType: 'application/json',
    description: 'GET /v1/token-risk?token=0x...&chain=base — token safety & risk score: honeypot detection, buy/sell tax, liquidity, rug-pull flags, age, holder concentration, and a low/medium/high/extreme risk rating. Pulls live data from DEX liquidity pools (DexScreener).',
    handler: (ctx) => tokenRiskProduct(ctx),
  },
};

module.exports = { PRODUCTS, CHAINS, htmlToMarkdown, isPrivateTarget };

