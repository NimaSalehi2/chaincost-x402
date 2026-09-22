'use strict';
/**
 * chaincost — x402 seller server.
 *
 * Serves four paid, boring, keyless primitives over HTTP 402 with USDC on Base
 * (EIP-3009 `exact` scheme), settling through a public facilitator so this host
 * never holds keys and never pays gas. Also serves free discovery documents
 * (`/`, `/pricing`, `/.well-known/x402`, `/llms.txt`, `/openapi.json`, `/health`)
 * so agent crawlers can find and understand the paid routes.
 *
 * Env: PORT, FACILITATOR_URL, PAYTO, PUBLIC_BASE_URL, X402_TEST_FIXTURES=1
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');
const fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const cfg = {
  ...fileCfg,
  facilitator: process.env.FACILITATOR_URL || fileCfg.facilitator,
  payTo: process.env.PAYTO || fileCfg.payTo,
  port: Number(process.env.PORT || fileCfg.port),
};

const x402 = require('./x402');
const { PRODUCTS } = require('./products');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const LEDGER = path.join(DATA_DIR, 'settlements.jsonl');
const REQUEST_LOG = path.join(DATA_DIR, 'requests.jsonl');

const API_VERSION = '1.0.0';
const NONCE_TTL_MS = 24 * 60 * 60 * 1000;
const usedNonces = new Map();

function seenNonce(nonce) {
  const at = usedNonces.get(nonce);
  if (!at) return false;
  if (Date.now() - at > NONCE_TTL_MS) { usedNonces.delete(nonce); return false; }
  return true;
}
const markNonce = (nonce) => usedNonces.set(nonce, Date.now());

function appendJsonl(file, entry) {
  try { fs.appendFileSync(file, JSON.stringify(entry) + '\n'); } catch (_) { /* logging must never break a sale */ }
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + cfg.port;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return proto + '://' + host;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-payment,payment-signature,x-payment-response,payment-response',
  'access-control-expose-headers': 'x-payment-response,payment-response,x-payment-required,payment-required',
};

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...CORS, ...headers });
  res.end(text);
}

/**
 * Answer HTTP 402 with both protocol generations at once: v1 requirements in the
 * body (with X-PAYMENT as the retry header) and v2 requirements in the
 * PAYMENT-REQUIRED header (with PAYMENT-SIGNATURE as the retry header). Clients
 * pick the one they speak; nothing is negotiated.
 */
function sendChallenge(req, res, product, { error, extraHeaders = {} } = {}) {
  const resourceUrl = baseUrl(req) + product.path;
  const c = x402.challenge(cfg, product, resourceUrl);
  if (error) {
    c.v1Body.error = error;
    c.v2.error = error;
  }
  const headers = {
    'payment-required': Buffer.from(JSON.stringify(c.v2), 'utf8').toString('base64'),
    ...extraHeaders,
  };
  sendJson(res, 402, c.v1Body, headers);
}

function pricingDoc(req) {
  const base = baseUrl(req);
  return Object.values(PRODUCTS).map((p) => ({
    id: p.id,
    url: base + p.path,
    method: p.method,
    price: p.priceUsd,
    priceAtomic: p.price,
    asset: cfg.assetSymbol,
    network: cfg.networkCaip2,
    mimeType: p.mimeType,
    description: p.description,
  }));
}

function manifestDoc(req) {
  const base = baseUrl(req);
  return {
    x402Version: 2,
    facilitator: cfg.facilitator,
    payTo: cfg.payTo,
    resources: pricingDoc(req).map((p) => ({
      resource: p.url,
      url: p.url,
      method: p.method,
      type: 'http',
      description: p.description,
      mimeType: p.mimeType,
      accepts: [{
        scheme: 'exact',
        network: cfg.networkCaip2,
        amount: p.priceAtomic,
        asset: cfg.asset,
        payTo: cfg.payTo,
        maxTimeoutSeconds: cfg.maxTimeoutSeconds,
        extra: { name: cfg.assetName, version: cfg.assetVersion },
      }],
    })),
  };
}

function openapiDoc(req) {
  const base = baseUrl(req);
  const paths = {
    '/health': { get: { summary: 'Liveness probe (free)', security: [{ public: [] }], 'x-payment-info': { protocols: ['x402'], auth: { mode: 'public' } }, responses: { 200: { description: 'ok' } } } },
    '/pricing': { get: { summary: 'Price list (free)', security: [{ public: [] }], 'x-payment-info': { protocols: ['x402'], auth: { mode: 'public' } }, responses: { 200: { description: 'ok' } } } },
  };
  for (const p of Object.values(PRODUCTS)) {
    paths[p.path] = {
      [p.method.toLowerCase()]: {
        summary: p.description,
        description: 'Paid via x402 (HTTP 402, USDC on Base). Price ' + p.priceUsd + ' per call.',
        security: [{ x402Payment: [] }],
        'x-payment-info': {
          protocols: ['x402'],
          auth: { mode: 'payment', scheme: 'x402' },
          price: { mode: 'fixed', currency: 'USD', amount: p.priceUsd.replace('$', '') },
          network: cfg.networkCaip2,
          asset: cfg.asset,
          payTo: cfg.payTo,
        },
        responses: { 200: { description: 'Paid response' }, 402: { description: 'Payment required' } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'chaincost x402 endpoints', version: API_VERSION, description: 'Pay-per-call fee, randomness and extraction primitives. Payment is the API key: sign an EIP-3009 USDC authorization and retry.', contact: { url: 'https://github.com/NimaSalehi2/chaincost-x402' }, 'x-guidance': 'Call a paid route, receive 402 with the exact EIP-3009 USDC offer on Base, sign it, retry with X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2). The response is computed before settlement, so upstream failures are free. Free companions: /health and /pricing.' },
    servers: [{ url: base }],
    components: {
      securitySchemes: {
        public: { type: 'apiKey', in: 'header', name: 'none', description: 'Free route: no auth.' },
        x402Payment: { type: 'apiKey', in: 'header', name: 'X-PAYMENT', description: 'Base64 JSON x402 PaymentPayload (v1), or use the v2 PAYMENT-SIGNATURE header.' },
      },
    },
    paths,
  };
}

function indexText(req) {
  const base = baseUrl(req);
  const rows = Object.values(PRODUCTS)
    .map((p) => `  ${p.priceUsd.padEnd(7)} ${p.method.padEnd(4)} ${base}${p.path}\n            ${p.description}`)
    .join('\n');
  return `chaincost — pay-per-call primitives for agents (x402 / HTTP 402, USDC on Base)

PRICED ROUTES (no account, no API key: the payment is the key)
${rows}

FREE ROUTES
  GET  ${base}/health           liveness
  GET  ${base}/pricing          machine-readable price list
  GET  ${base}/.well-known/x402 x402 discovery manifest (v2)
  GET  ${base}/openapi.json     OpenAPI 3.1 description
  GET  ${base}/llms.txt         this document

HOW TO PAY (any x402 client; curl plus a wallet works)
  1. Call a priced route. You get HTTP 402 with the offer: scheme "exact",
     network ${cfg.networkCaip2}, asset USDC ${cfg.asset}, payTo ${cfg.payTo},
     amount in atomic units (6 decimals), and a maxTimeoutSeconds window.
  2. Sign an EIP-3009 TransferWithAuthorization for that offer. No gas; you
     broadcast nothing.
     EIP-712 domain: name "${cfg.assetName}", version "${cfg.assetVersion}",
     chainId 8453, verifyingContract ${cfg.asset}.
  3. Retry the same request with the signed payload base64-encoded in
     "X-PAYMENT" (protocol v1) or "PAYMENT-SIGNATURE" (protocol v2).
  4. Settlement is submitted by the facilitator ${cfg.facilitator}, the resource
     is returned, and the tx hash comes back in "X-PAYMENT-RESPONSE" (v1) or
     "PAYMENT-RESPONSE" (v2).

SETTLEMENT AND TRUST
  Funds move buyer -> ${cfg.payTo} in one on-chain USDC transfer on Base. This
  server holds no keys, no gas and no custody, and it never serves a paid route
  before the facilitator reports success. A rejected payment gets another 402
  carrying the reason; a facilitator that cannot decide gets you a 503, and you
  are not charged. Answers are computed before settlement, so an upstream
  failure costs the buyer nothing.
`;
}

function llmsText(req) {
  const base = baseUrl(req);
  return `# chaincost
> Paid x402 micro-endpoints over HTTP 402 (USDC on Base): cross-chain gas quotes,
> verifiable randomness, Bitcoin fee tiers, URL-to-Markdown extraction.
> Payment is the identity: no signup, no API key, no invoice.

Discovery:
- ${base}/.well-known/x402 (v2 manifest, machine readable)
- ${base}/pricing
- ${base}/openapi.json
- ${base}/llms.txt

Paid routes (price per call, USDC on ${cfg.networkCaip2}):
${Object.values(PRODUCTS).map((p) => `- ${p.method} ${base}${p.path} - ${p.priceUsd} - ${p.description}`).join('\n')}

Pay: sign an EIP-3009 transferWithAuthorization (asset ${cfg.asset}, payTo ${cfg.payTo},
EIP-712 domain "${cfg.assetName}"/"${cfg.assetVersion}") and retry with X-PAYMENT (v1) or
PAYMENT-SIGNATURE (v2). Settlement is submitted by ${cfg.facilitator}.
`;
}

/** The paywall: verify locally, compute the answer, settle, then serve. */
async function handlePaid(req, res, product, ctx) {
  const resourceUrl = baseUrl(req) + product.path;
  let attempt = null;
  try {
    attempt = x402.readPayment(req.headers);
  } catch (e) {
    return sendChallenge(req, res, product, { error: 'malformed payment header: ' + e.message });
  }
  if (!attempt) return sendChallenge(req, res, product);

  const verdict = x402.localVerify(cfg, attempt.version, attempt.payment, product, resourceUrl, seenNonce);
  if (!verdict.ok) {
    console.log(JSON.stringify({ at: new Date().toISOString(), paid: false, path: product.path, reason: verdict.reason }));
    return sendChallenge(req, res, product, { error: verdict.reason });
  }

  const offerBody = x402.facilitatorBody(cfg, attempt.version, attempt.payment, product, resourceUrl);
  let ver;
  try {
    ver = await x402.facilitatorCall(cfg, '/verify', offerBody);
  } catch (e) {
    return sendJson(res, 503, { error: 'facilitator_unreachable', detail: e.message, retryable: true }, CORS);
  }
  if (!ver.json || ver.json.isValid !== true) {
    const reason = (ver.json && (ver.json.invalidReason || ver.json.error)) || ('facilitator HTTP ' + ver.status);
    console.log(JSON.stringify({ at: new Date().toISOString(), paid: false, path: product.path, reason }));
    return sendChallenge(req, res, product, { error: reason });
  }

  // Compute before settling: a buyer is never charged for a failure on our side.
  let payload;
  try {
    payload = await product.handler(ctx);
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), path: product.path, productError: e.message }));
    return sendJson(res, 502, {
      error: 'upstream_failed',
      detail: e.message,
      charged: false,
      note: 'Nothing was settled: this endpoint only settles once the answer is in hand. Retry for free.',
    }, CORS);
  }

  let settle;
  try {
    settle = await x402.facilitatorCall(cfg, '/settle', offerBody, { 'idempotency-key': verdict.nonce });
  } catch (e) {
    return sendJson(res, 503, { error: 'settlement_unknown', detail: e.message, retryable: true, note: 'The facilitator did not answer. The authorization may or may not have landed; re-check before re-paying.' }, CORS);
  }
  const sj = settle.json || {};
  if (!sj.success) {
    const unconfirmed = sj.error === 'settlement_unconfirmed';
    console.log(JSON.stringify({ at: new Date().toISOString(), paid: false, path: product.path, settle: sj }));
    return sendJson(res, unconfirmed ? 502 : 402, {
      error: unconfirmed ? 'settlement_unconfirmed' : 'settlement_failed',
      errorReason: sj.errorReason || sj.error || null,
      transaction: sj.transaction || null,
      retryable: !unconfirmed,
      note: unconfirmed
        ? 'Broadcast but unconfirmed. Look the hash up on chain; do NOT re-sign and retry.'
        : 'Not settled, not served. Nothing was charged for a resource you did not get.',
    }, CORS);
  }

  markNonce(verdict.nonce);
  const settlement = {
    success: true,
    transaction: sj.transaction || sj.transactionHash || null,
    paymentId: sj.paymentId || null,
    network: sj.network || cfg.network,
    payer: sj.payer || verdict.payer,
    amount: product.price,
    asset: cfg.assetSymbol,
    resource: resourceUrl,
  };
  appendJsonl(LEDGER, { at: new Date().toISOString(), product: product.id, ...settlement });
  console.log(JSON.stringify({ at: new Date().toISOString(), paid: true, path: product.path, payer: verdict.payer, tx: settlement.transaction }));
  sendJson(res, 200, {
    product: product.id,
    price: product.priceUsd,
    settled: settlement,
    asOf: new Date().toISOString(),
    data: payload,
  }, {
    [x402.settlementHeaderName(attempt.version)]: Buffer.from(JSON.stringify(settlement), 'utf8').toString('base64'),
  });
}


function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body larger than ' + limit + ' bytes')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, baseUrl(req));
  const route = url.pathname.replace(/\/+$/, '') || '/';
  appendJsonl(REQUEST_LOG, { at: new Date().toISOString(), method: req.method, path: route, ua: req.headers['user-agent'] || null, paid: Boolean(req.headers['x-payment'] || req.headers['payment-signature']) });
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  try {
    if (req.method === 'GET' && route === '/') return sendText(res, 200, indexText(req));
    if (req.method === 'GET' && route === '/llms.txt') return sendText(res, 200, llmsText(req));
    if (req.method === 'GET' && route === '/health') return sendJson(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()), version: API_VERSION });
    if (req.method === 'GET' && route === '/pricing') return sendJson(res, 200, { payTo: cfg.payTo, network: cfg.networkCaip2, asset: cfg.assetSymbol, facilitator: cfg.facilitator, products: pricingDoc(req) });
    if (req.method === 'GET' && route === '/.well-known/x402') return sendJson(res, 200, manifestDoc(req));
    if (req.method === 'GET' && route === '/openapi.json') return sendJson(res, 200, openapiDoc(req));
    if (req.method === 'GET' && route === '/robots.txt') return sendText(res, 200, 'User-agent: *\nAllow: /\n');
    if (req.method === 'GET' && route === '/favicon.ico') { res.writeHead(204, CORS); return res.end(); }

    const product = Object.values(PRODUCTS).find((p) => p.path === route);
    if (!product) return sendJson(res, 404, { error: 'not_found', see: baseUrl(req) + '/' }, CORS);
    if (req.method !== product.method) return sendJson(res, 405, { error: 'method_not_allowed', allow: product.method }, CORS);
    const body = req.method === 'POST' ? await readBody(req) : null;
    return await handlePaid(req, res, product, { query: url.searchParams, body, req });
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: e.message, path: route }));
    return sendJson(res, 500, { error: 'internal_error', detail: e.message }, CORS);
  }
});

server.listen(cfg.port, process.env.HOST || '0.0.0.0', () => {
  console.log(JSON.stringify({ at: new Date().toISOString(), listening: cfg.port, payTo: cfg.payTo, facilitator: cfg.facilitator, products: Object.values(PRODUCTS).map((p) => p.path) }));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
