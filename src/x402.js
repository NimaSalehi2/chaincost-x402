'use strict';
/**
 * x402 (HTTP 402) seller-side plumbing for the `exact` scheme on EVM (EIP-3009
 * transferWithAuthorization). Protocol references:
 *   - https://docs.x402.org  (v1: body challenge + X-PAYMENT, v2: PAYMENT-REQUIRED
 *     header + PAYMENT-SIGNATURE header + PAYMENT-RESPONSE header)
 *   - https://facilitator.ultravioletadao.xyz/skill.md (facilitator /verify + /settle)
 * We implement v1 and v2 so both older and newer clients can pay.
 */
const path = require('path');

function loadEthers() {
  const candidates = [
    process.env.ETHERS_PATH,
    path.join(__dirname, '..', 'node_modules', 'ethers'),
    '/home/cryptonix/node_modules/ethers',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* try next */ }
  }
  return require('ethers');
}
const ethers = loadEthers();

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const b64encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const b64decode = (str) => JSON.parse(Buffer.from(str, 'base64').toString('utf8'));

function eip712Domain(cfg) {
  return {
    name: cfg.assetName,
    version: cfg.assetVersion,
    chainId: parseInt(cfg.networkCaip2.split(':')[1], 10),
    verifyingContract: cfg.asset,
  };
}

/** The user-visible offer (an entry of accepts[]): one priced product. */
function offer(cfg, product, resourceUrl) {
  return {
    scheme: 'exact',
    network: cfg.network,
    maxAmountRequired: product.price,
    amount: product.price, // v2 spelling; harmless extra for v1 clients
    resource: resourceUrl,
    description: product.description,
    mimeType: product.mimeType || 'application/json',
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    asset: cfg.asset,
    extra: { name: cfg.assetName, version: cfg.assetVersion },
  };
}

/** v1 challenge: JSON body. v2 challenge: base64 PAYMENT-REQUIRED header. */
function challenge(cfg, product, resourceUrl) {
  const o = offer(cfg, product, resourceUrl);
  const v1 = { x402Version: 1, accepts: [o] };
  const v2 = {
    x402Version: 2,
    resource: { url: resourceUrl, description: product.description, mimeType: o.mimeType },
    accepts: [{
      scheme: o.scheme,
      network: cfg.networkCaip2,
      amount: o.amount,
      asset: o.asset,
      payTo: o.payTo,
      maxTimeoutSeconds: o.maxTimeoutSeconds,
      extra: o.extra,
    }],
  };
  return { v1Body: v1, v2Header: b64encode(v2), v2 };
}

/**
 * Read a payment attempt off the request.
 * v2 clients send PAYMENT-SIGNATURE, v1 clients X-PAYMENT; both are base64 JSON.
 * Returns { version, payment } or null when the caller has not paid yet.
 */
function readPayment(headers) {
  const v2 = headers['payment-signature'];
  if (v2) return { version: 2, payment: b64decode(String(v2).trim()) };
  const v1 = headers['x-payment'];
  if (v1) return { version: 1, payment: b64decode(String(v1).trim()) };
  return null;
}

/** Pull the signed authorization out of either envelope shape. */
function authorizationOf(version, payment) {
  const body = payment && payment.payload;
  if (!body || !body.authorization || !body.signature) {
    return { error: 'payment payload is missing payload.authorization/payload.signature' };
  }
  const accepted = version === 2 ? (payment.accepted || {}) : {
    scheme: payment.scheme,
    network: payment.network,
    amount: payment.amount,
  };
  return {
    signature: body.signature,
    authorization: body.authorization,
    accepted,
    resource: payment.resource,
  };
}

const NETWORK_ALIASES = new Set(['base', 'eip155:8453', '8453']);

/**
 * Verify the payment ourselves before spending a facilitator call on it:
 * signature recovery, recipient, asset, amount floor, validity window, network.
 * The facilitator re-verifies; this only rejects what is provably wrong.
 */
function localVerify(cfg, version, payment, product, resourceUrl, seenNonce) {
  const { error, signature, authorization, accepted } = authorizationOf(version, payment);
  if (error) return { ok: false, reason: error };
  const scheme = version === 2 ? accepted.scheme : payment.scheme;
  const network = version === 2 ? accepted.network : payment.network;
  if (scheme !== 'exact') return { ok: false, reason: 'invalid_scheme: ' + scheme };
  if (!NETWORK_ALIASES.has(String(network))) return { ok: false, reason: 'invalid_network: ' + network };
  const asset = version === 2 ? accepted.asset : payment.asset;
  if (asset && String(asset).toLowerCase() !== cfg.asset.toLowerCase()) {
    return { ok: false, reason: 'invalid_asset: ' + asset };
  }
  if (String(authorization.to).toLowerCase() !== cfg.payTo.toLowerCase()) {
    return { ok: false, reason: 'receiver_mismatch' };
  }
  let value;
  try { value = BigInt(authorization.value); } catch (_) { return { ok: false, reason: 'invalid_value' }; }
  if (value < BigInt(product.price)) {
    return { ok: false, reason: 'insufficient_value: got ' + value + ' need ' + product.price };
  }
  const now = Math.floor(Date.now() / 1000);
  const after = Number(authorization.validAfter);
  const before = Number(authorization.validBefore);
  if (!Number.isFinite(after) || !Number.isFinite(before) || now < after || now > before) {
    return { ok: false, reason: 'invalid_timing' };
  }
  if (seenNonce(authorization.nonce)) return { ok: false, reason: 'nonce_already_used' };
  let recovered;
  try {
    recovered = ethers.verifyTypedData(
      eip712Domain(cfg),
      TRANSFER_TYPES,
      {
        from: authorization.from,
        to: authorization.to,
        value: value.toString(),
        validAfter: after.toString(),
        validBefore: before.toString(),
        nonce: authorization.nonce,
      },
      signature,
    );
  } catch (e) {
    return { ok: false, reason: 'invalid_signature: ' + e.message };
  }
  if (recovered.toLowerCase() !== String(authorization.from).toLowerCase()) {
    return { ok: false, reason: 'invalid_signature: recovered ' + recovered };
  }
  return { ok: true, payer: recovered, nonce: authorization.nonce };
}

/** The /verify and /settle request body, in the shape the declared version needs. */
function facilitatorBody(cfg, version, payment, product, resourceUrl) {
  const o = offer(cfg, product, resourceUrl);
  if (version === 2) {
    return {
      x402Version: 2,
      paymentPayload: payment,
      resource: { url: resourceUrl, description: product.description, mimeType: o.mimeType },
      accepted: {
        scheme: 'exact',
        network: cfg.networkCaip2,
        amount: product.price,
        asset: cfg.asset,
        payTo: cfg.payTo,
        maxTimeoutSeconds: cfg.maxTimeoutSeconds,
        extra: { name: cfg.assetName, version: cfg.assetVersion },
      },
    };
  }
  return {
    x402Version: 1,
    paymentPayload: payment,
    paymentRequirements: {
      scheme: 'exact',
      network: cfg.network,
      maxAmountRequired: product.price,
      resource: resourceUrl,
      description: product.description,
      mimeType: o.mimeType,
      payTo: cfg.payTo,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds,
      asset: cfg.asset,
      extra: { name: cfg.assetName, version: cfg.assetVersion },
    },
  };
}

async function facilitatorCall(cfg, endpoint, body, extraHeaders = {}) {
  const url = cfg.facilitator.replace(/\/$/, '') + endpoint;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep text */ }
  return { status: res.status, json, text };
}

const settlementHeaderName = (version) => (version === 2 ? 'PAYMENT-RESPONSE' : 'X-PAYMENT-RESPONSE');

module.exports = {
  ethers,
  TRANSFER_TYPES,
  b64encode,
  b64decode,
  eip712Domain,
  offer,
  challenge,
  readPayment,
  authorizationOf,
  localVerify,
  facilitatorBody,
  facilitatorCall,
  settlementHeaderName,
};

