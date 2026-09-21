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

/**
 * Keyless Blockscout instances used to read real wallet token balances
 * (no API key, no wallet ownership proof — everything is public chain data).
 * Chains without a working public Blockscout instance are not offered.
 */
const EXPLORERS = {
  ethereum: 'https://eth.blockscout.com',
  base: 'https://base.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  polygon: 'https://polygon.blockscout.com',
};
const DEX_CHAIN_IDS = { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137 };
const ENRICH_LIMIT = 8; // how many of the largest holdings get a DEX liquidity check

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
  const addr = tokenAddr.startsWith('0x') ? tokenAddr : '0x' + tokenAddr;
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) throw new Error('token must be an EVM contract address');

  // Every field below is either returned by the upstream API or reported as null.
  // Nothing is inferred, so an unknown never masquerades as a clean result.
  const tokenData = await jsonFetch('https://api.dexscreener.com/latest/dex/tokens/' + addr, {}, 8000).catch(() => null);
  const allPairs = tokenData && Array.isArray(tokenData.pairs) ? tokenData.pairs : [];
  const same = (a) => typeof a === 'string' && a.toLowerCase() === addr.toLowerCase();
  // Only pools that actually contain this token (as base OR as quote) count for liquidity.
  const pairs = allPairs.filter((p) => p.chainId === chain
    && ((p.baseToken && same(p.baseToken.address)) || (p.quoteToken && same(p.quoteToken.address))));
  const best = pairs
    .slice()
    .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0] || null;
  const identity = best
    ? (best.baseToken && same(best.baseToken.address) ? best.baseToken : (best.quoteToken && same(best.quoteToken.address) ? best.quoteToken : null))
    : null;

  // Contract facts from a public Blockscout instance, when the chain has one.
  const explorer = EXPLORERS[chain];
  const [tokenMeta, contractMeta] = explorer ? await Promise.all([
    jsonFetch(explorer + '/api/v2/tokens/' + addr, {}, 7000).catch(() => null),
    jsonFetch(explorer + '/api/v2/smart-contracts/' + addr, {}, 7000).catch(() => null),
  ]) : [null, null];

  const liquidityUsd = best && best.liquidity && best.liquidity.usd ? Number(best.liquidity.usd) : null;
  const ageDays = best && best.pairCreatedAt ? Math.floor((Date.now() - best.pairCreatedAt) / 86400000) : null;
  const reputation = tokenMeta && tokenMeta.reputation ? tokenMeta.reputation : null;
  const verified = contractMeta && typeof contractMeta.is_verified === 'boolean' ? contractMeta.is_verified : null;

  const flags = [];
  if (!best) {
    flags.push('no_pool_data');
  } else {
    if (liquidityUsd !== null && liquidityUsd < 1000) flags.push('low_liquidity');
    else if (liquidityUsd !== null && liquidityUsd < 10000) flags.push('thin_liquidity');
    if (pairs.length === 1) flags.push('single_pool');
  }
  if (ageDays !== null && ageDays < 7) flags.push('new_pair');
  if (reputation && reputation !== 'ok') flags.push('explorer_reputation_' + reputation);
  if (verified === false) flags.push('unverified_contract');

  const SOFT_FLAGS = ['single_pool', 'new_pair']; // context, not risk on their own
  const riskScore = flags.filter((f) => !SOFT_FLAGS.includes(f)).length;
  const riskLevel = riskScore === 0 ? 'low' : riskScore === 1 ? 'medium' : riskScore === 2 ? 'high' : 'extreme';

  return {
    asOf: new Date().toISOString(),
    token: addr,
    chain,
    symbol: identity ? identity.symbol : (tokenMeta ? tokenMeta.symbol : null),
    name: identity ? identity.name : (tokenMeta ? tokenMeta.name : null),
    market: {
      pools: pairs.length,
      bestDex: best ? best.dexId : null,
      pairAddress: best ? best.pairAddress : null,
      priceUsd: best && best.priceUsd ? Number(best.priceUsd) : null,
      liquidityUsd,
      fdvUsd: best && best.fdv ? Number(best.fdv) : null,
      marketCapUsd: best && best.marketCap ? Number(best.marketCap) : null,
      volume24hUsd: best && best.volume && best.volume.h24 ? Number(best.volume.h24) : null,
      priceChange24hPct: best && best.priceChange && typeof best.priceChange.h24 === 'number' ? best.priceChange.h24 : null,
      ageDays,
    },
    contract: {
      holdersCount: tokenMeta && tokenMeta.holders_count ? Number(tokenMeta.holders_count) : null,
      verified, // null = not known, never presented as "safe"
      explorerReputation: reputation,
      totalSupply: tokenMeta && tokenMeta.total_supply ? tokenMeta.total_supply : null,
    },
    taxAndHoneypot: {
      buyTax: null,
      sellTax: null,
      honeypot: null,
      simulationPerformed: false,
      reason: 'No tax or trade-simulation data is available from the upstreams used here, so these are reported as null instead of estimated.',
    },
    riskScore,
    riskLevel,
    flags,
    notes: [
      'Liquidity/price/volume/age come from DexScreener pools on the requested chain only.',
      explorer ? 'Holder count, verification status and spam labelling come from ' + explorer + '.' : 'No public Blockscout instance is configured for this chain, so contract facts are null.',
      'Liquidity below $1k is flagged low_liquidity, $1k-$10k thin_liquidity; both are heuristics, not a safety verdict.',
      'DexScreener caps how many pools it returns per token, so the pool count is a floor rather than a total.',
    ],
    sources: explorer ? ['dexscreener', 'blockscout'] : ['dexscreener'],
  };
}

/** Product 6: wallet portfolio risk profile — aggregate risk across all holdings. */
async function portfolioRiskProduct(ctx) {
  const get = (k) => (ctx && ctx.query && typeof ctx.query.get === 'function' ? ctx.query.get(k) : ctx && ctx.query && ctx.query[k]);
  const q = (k) => (ctx && ctx.query && typeof ctx.query.get === 'function' ? ctx.query.get(k) : ctx && ctx.query ? ctx.query[k] : null);
  const walletAddr = q('wallet') || q('walletAddress') || q('address') || q('account');
  const chains = (q('chains') || 'ethereum,base,arbitrum,optimism,polygon').toLowerCase().split(',').map(c => c.trim());
  const limit = Math.min(Math.max(Number(q('limit')) || 100, 1), 500);
  if (FIXTURES) {
    return {
      asOf: new Date().toISOString(),
      wallet: walletAddr || '0x1f984000000000000000000000000c71c29eEa5F',
      chainsAnalyzed: chains,
      totalPositions: 6,
      positions: [
        { token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', chain: 'ethereum', balanceUsd: 1240.50, riskScore: 1, riskLevel: 'low', flags: [], priceUsd: 3100.25, honeypot: false, liquidityUsd: 1200000000, ageDays: 1400, contractVerified: true },
        { token: '0x1f984000000000000000000000000c71c29eEa5F', symbol: 'UNI', chain: 'ethereum', balanceUsd: 85.20, riskScore: 2, riskLevel: 'medium', flags: ['low_liquidity'], priceUsd: 8.52, honeypot: false, liquidityUsd: 420, ageDays: 87 },
        { token: '0x4200000000000000000000000000000000000006', symbol: 'WETH', chain: 'base', balanceUsd: 310.00, riskScore: 1, riskLevel: 'low', flags: [], priceUsd: 3100.00, honeypot: false, liquidityUsd: 800000000, ageDays: 400 },
        { token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', chain: 'base', balanceUsd: 1500.00, riskScore: 0, riskLevel: 'low', flags: [], priceUsd: 1.00, honeypot: false, liquidityUsd: 2500000000, ageDays: 900 },
        { token: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'LINK', chain: 'arbitrum', balanceUsd: 42.15, riskScore: 1, riskLevel: 'medium', flags: ['unpriced'], priceUsd: null, honeypot: false, liquidityUsd: 18000000, ageDays: 700 },
        { token: '0xB595108378871AAe6D48D563580C1a53405B41F6', symbol: 'FAKE', chain: 'ethereum', balanceUsd: 12000.00, riskScore: 4, riskLevel: 'extreme', flags: ['low_liquidity', 'no_pool_data', 'explorer_reputation_spam', 'unpriced'], priceUsd: 0.001, honeypot: true, liquidityUsd: 84, ageDays: 3 },
      ],
      riskSummary: {
        totalBalanceUsd: 2737.85,
        totalBalanceCoversOnlyPriced: true,
        positionsInExtremeRisk: 1,
        positionsInHighRisk: 0,
        positionsInMediumRisk: 2,
        positionsInLowRisk: 3,
        unpricedPositions: 1,
        spamReputationTokens: 1,
        lowLiquidityTokens: 2,
        tokensWithoutPoolData: 1,
        honeypotTokens: 1,
        topPosition: { symbol: 'USDC', chain: 'base', pctOfPricedValue: 54.8 },
        overallRiskLevel: 'high',
        advice: '1 position flagged as extreme risk. Consider exiting immediately.',
      },
      fixture: true,
    };
  }
  if (!walletAddr) throw new Error('query param: wallet=<address>');
  const addr = walletAddr.startsWith('0x') ? walletAddr : '0x' + walletAddr;
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) throw new Error('wallet must be an EVM address');
  const requested = chains.filter((c) => EXPLORERS[c]);
  const unsupportedChains = chains.filter((c) => !EXPLORERS[c]);
  if (requested.length === 0) {
    throw new Error('no supported chains specified (supported: ' + Object.keys(EXPLORERS).join(', ') + ')');
  }

  // 1) Real holdings: every ERC-20 balance the address holds, per chain, from public Blockscout.
  const settled = await Promise.allSettled(requested.map((chain) => fetch(
    EXPLORERS[chain] + '/api/v2/addresses/' + addr + '/token-balances',
    { signal: AbortSignal.timeout(8000) },
  ).then((r) => (r.ok ? r.json() : null))));

  const allPositions = [];
  const chainsWithBalances = [];
  const chainErrors = [];
  settled.forEach((result, i) => {
    const chain = requested[i];
    const rows = result.status === 'fulfilled' ? result.value : null;
    if (!Array.isArray(rows)) { chainErrors.push(chain); return; }
    let found = 0;
    for (const row of rows) {
      const t = row && row.token;
      if (!t || !t.address_hash) continue;
      const decimals = Number(t.decimals || 0);
      const amount = decimals > 0 ? Number(row.value || '0') / Math.pow(10, decimals) : Number(row.value || '0');
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const priceUsd = t.exchange_rate === null || t.exchange_rate === undefined ? null : Number(t.exchange_rate);
      allPositions.push({
        token: t.address_hash,
        symbol: t.symbol || null,
        name: t.name || null,
        chain,
        amount,
        priceUsd,
        balanceUsd: priceUsd ? Math.round(amount * priceUsd * 100) / 100 : null,
        holdersCount: t.holders_count ? Number(t.holders_count) : null,
        reputation: t.reputation || null,
        riskScore: 0,
        riskLevel: 'low',
        flags: [],
      });
      found += 1;
    }
    if (found > 0) chainsWithBalances.push(chain);
  });

  // 2) Risk pass: explorer reputation flags, plus a DEX liquidity check on the largest
  //    holdings — a token with no tradable pool is the practical rug-pull signal here.
  allPositions.sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0));
  const enrichTargets = allPositions.filter((p) => p.balanceUsd).slice(0, ENRICH_LIMIT);
  const dexResults = await Promise.allSettled(enrichTargets.map((p) => jsonFetch(
    'https://api.dexscreener.com/latest/dex/tokens/' + p.token, {}, 6000,
  ).catch(() => null)));
  const dexByToken = new Map();
  enrichTargets.forEach((p, i) => {
    const value = dexResults[i].status === 'fulfilled' ? dexResults[i].value : null;
    const pairs = value && Array.isArray(value.pairs) ? value.pairs : [];
    const best = pairs
      .filter((pr) => pr.chainId === p.chain)
      .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0] || null;
    dexByToken.set(p.token, best);
  });

  for (const p of allPositions) {
    const flags = [];
    const pair = dexByToken.get(p.token);
    const liquidityUsd = pair && pair.liquidity && pair.liquidity.usd ? Number(pair.liquidity.usd) : null;
    if (p.priceUsd === null) flags.push('unpriced');
    if (p.reputation && p.reputation !== 'ok') flags.push('explorer_reputation_' + p.reputation);
    if (pair) {
      if (liquidityUsd !== null && liquidityUsd < 1000) flags.push('low_liquidity');
    } else if (p.balanceUsd) {
      flags.push('no_pool_data');
    }
    const riskFlags = flags.filter((f) => f !== 'unpriced'); // 'unpriced' is a data gap, not a risk
    p.flags = flags;
    p.riskScore = riskFlags.length;
    p.riskLevel = riskFlags.length === 0 ? 'low' : riskFlags.length === 1 ? 'medium' : riskFlags.length === 2 ? 'high' : 'extreme';
    p.liquidityUsd = liquidityUsd;
    p.ageDays = pair && pair.pairCreatedAt ? Math.floor((Date.now() - new Date(pair.pairCreatedAt).getTime()) / 86400000) : null;
    p.honeypot = Boolean(pair && pair.safety && pair.safety.isHoneypot);
    p.contractVerified = null; // not exposed by this endpoint — stated rather than guessed
  }
  const extreme = allPositions.filter((p) => p.riskLevel === 'extreme').length;
  const high = allPositions.filter((p) => p.riskLevel === 'high').length;
  const medium = allPositions.filter((p) => p.riskLevel === 'medium').length;
  const low = allPositions.filter((p) => p.riskLevel === 'low').length;
  const priced = allPositions.filter((p) => p.balanceUsd);
  const totalBalance = priced.reduce((s, p) => s + p.balanceUsd, 0);
  const largest = priced.length > 0 ? priced.reduce((a, b) => (a.balanceUsd >= b.balanceUsd ? a : b)) : null;
  let overall = 'low';
  if (extreme > 0 || high > 0) overall = 'high';
  else if (medium >= 2) overall = 'medium';
  const spam = allPositions.filter((p) => p.reputation && p.reputation !== 'ok').length;
  const unpriced = allPositions.length - priced.length;
  const lowLiq = allPositions.filter((p) => p.flags.includes('low_liquidity')).length;
  const noPool = allPositions.filter((p) => p.flags.includes('no_pool_data')).length;
  const honeypots = allPositions.filter((p) => p.honeypot).length;
  const riskSummary = {
    totalBalanceUsd: Math.round(totalBalance * 100) / 100,
    totalBalanceCoversOnlyPriced: true,
    positionsInExtremeRisk: extreme,
    positionsInHighRisk: high,
    positionsInMediumRisk: medium,
    positionsInLowRisk: low,
    unpricedPositions: unpriced,
    spamReputationTokens: spam,
    lowLiquidityTokens: lowLiq,
    tokensWithoutPoolData: noPool,
    honeypotTokens: honeypots,
    topPosition: largest ? { symbol: largest.symbol, chain: largest.chain, pctOfPricedValue: Math.round((largest.balanceUsd / totalBalance) * 1000) / 10 } : null,
    overallRiskLevel: overall,
    advice: extreme > 0
      ? `${extreme} position(s) flagged as extreme risk. Consider exiting immediately.`
      : high > 0 ? `${high} position(s) flagged as high risk (no tradable pool or spam-labelled token).`
        : medium > 0 ? `${medium} position(s) in medium risk. Review before adding more exposure.`
          : 'No risk flags raised on the priced holdings.',
  };
  return {
    asOf: new Date().toISOString(),
    wallet: addr,
    chainsAnalyzed: requested,
    chainsWithBalances,
    chainErrors,
    unsupportedChains,
    totalPositions: allPositions.length,
    positions: allPositions.slice(0, limit),
    truncated: allPositions.length > limit,
    riskSummary,
    notes: [
      'Balances come from public Blockscout token-balance indexes and cover ERC-20 tokens only (no native ETH/POL, no NFTs).',
      'Prices are the explorer USD rates when available; tokens without a rate are listed with balanceUsd null and flagged unpriced.',
      'DEX liquidity checks run on the largest ' + ENRICH_LIMIT + ' priced holdings only (DexScreener).',
      'This is public chain data, not financial advice.',
    ],
    sources: ['blockscout', 'dexscreener'],
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
    description: 'GET /v1/token-risk?token=0x...&chain=base — token market & contract risk facts: live DEX liquidity, price, FDV, 24h volume, pool count and pair age (DexScreener) plus holder count, verification status and spam labelling (Blockscout), with a low/medium/high/extreme risk rating. Tax and honeypot simulation are deliberately not performed — those fields are returned as null rather than guessed.',
    handler: (ctx) => tokenRiskProduct(ctx),
  },
  'portfolio-risk': {
    id: 'portfolio-risk',
    path: '/v1/portfolio-risk',
    method: 'GET',
    price: '3000',
    priceUsd: '$0.003',
    mimeType: 'application/json',
    description: 'GET /v1/portfolio-risk?wallet=0x... — wallet holdings & risk profile: real ERC-20 balances per chain from public Blockscout indexes, USD values from explorer rates, DEX liquidity checks on the largest holdings, concentration, and an overall risk level (low/medium/high/extreme). Covers Ethereum, Base, Arbitrum, Optimism and Polygon.',
    handler: (ctx) => portfolioRiskProduct(ctx),
  },
};

module.exports = { PRODUCTS, CHAINS, htmlToMarkdown, isPrivateTarget };

