'use strict';
/**
 * End-to-end test of the seller server with NO real funds:
 *   - a mock facilitator stands in for https://facilitator.ultravioletadao.xyz and
 *     asserts the /verify and /settle request bodies match the protocol shape
 *     (v1: paymentRequirements with resource/description/mimeType/maxTimeoutSeconds;
 *      v2: accepted.network must be CAIP-2),
 *   - real EIP-3009 TransferWithAuthorization signatures are produced with a
 *     throwaway ethers wallet, so signature recovery, recipient, amount, timing
 *     and nonce-replay checks all run for real,
 *   - products run against deterministic fixtures (X402_TEST_FIXTURES=1).
 * Run: node test/e2e.js
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ethers = require(process.env.ETHERS_PATH || '/home/cryptonix/node_modules/ethers');
const cfg = require(path.join(__dirname, '..', 'config.json'));
const { PRODUCTS } = require(path.join(__dirname, '..', 'src', 'products'));
const CATALOGUE = Object.values(PRODUCTS);

const MOCK_PORT = Number(process.env.MOCK_PORT || 8433);
const SERVER_PORT = Number(process.env.SERVER_PORT || 8432);
const BASE = 'http://127.0.0.1:' + SERVER_PORT;

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
const DOMAIN = {
  name: cfg.assetName,
  version: cfg.assetVersion,
  chainId: 8453,
  verifyingContract: cfg.asset,
};

const seen = { verify: [], settle: [], shapeErrors: [], idempotencyKeys: [] };
const buyer = ethers.Wallet.createRandom();
const impostor = ethers.Wallet.createRandom();

function mockFacilitator() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const endpoint = req.url.replace(/\/+$/, '');
      let body = null;
      try { body = JSON.parse(raw); } catch (_) { /* reported below */ }
      const reply = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (!body || !body.paymentPayload || !body.paymentPayload.payload) {
        seen.shapeErrors.push(endpoint + ': missing paymentPayload.payload');
        return reply(400, { error: 'invalid_request_body', code: 'invalid_request_body' });
      }
      const version = body.x402Version;
      if (version === 1) {
        const r = body.paymentRequirements;
        for (const field of ['scheme', 'network', 'maxAmountRequired', 'resource', 'description', 'mimeType', 'payTo', 'maxTimeoutSeconds', 'asset']) {
          if (r === undefined || r[field] === undefined) seen.shapeErrors.push('v1 paymentRequirements missing ' + field);
        }
        if (r && typeof r.maxAmountRequired !== 'string') seen.shapeErrors.push('v1 maxAmountRequired must be a string');
      } else if (version === 2) {
        for (const field of ['resource', 'accepted']) {
          if (body[field] === undefined) seen.shapeErrors.push('v2 top level missing ' + field);
        }
        for (const field of ['url', 'description', 'mimeType']) {
          if (body.resource === undefined || body.resource[field] === undefined) seen.shapeErrors.push('v2 resource missing ' + field);
        }
        for (const field of ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds']) {
          if (body.accepted === undefined || body.accepted[field] === undefined) seen.shapeErrors.push('v2 accepted missing ' + field);
        }
        if (body.accepted && body.accepted.network !== 'eip155:8453') seen.shapeErrors.push('v2 accepted.network must be CAIP-2, got ' + body.accepted.network);
        if (body.accepted && typeof body.accepted.amount !== 'string') seen.shapeErrors.push('v2 accepted.amount must be a string');
      } else {
        seen.shapeErrors.push('unexpected x402Version ' + version);
      }

      const auth = body.paymentPayload.payload.authorization;
      const signature = body.paymentPayload.payload.signature;
      let recovered = null;
      try {
        recovered = ethers.verifyTypedData(DOMAIN, TRANSFER_TYPES, {
          from: auth.from,
          to: auth.to,
          value: String(auth.value),
          validAfter: String(auth.validAfter),
          validBefore: String(auth.validBefore),
          nonce: auth.nonce,
        }, signature);
      } catch (e) {
        seen.shapeErrors.push('recovery threw: ' + e.message);
      }
      const isValid = recovered && recovered.toLowerCase() === String(auth.from).toLowerCase();

      if (endpoint === '/verify') {
        seen.verify.push({ ...body, __valid: Boolean(isValid) });
        return reply(200, isValid ? { isValid: true } : { isValid: false, invalidReason: 'invalid_signature', payer: auth.from });
      }
      if (endpoint === '/settle') {
        seen.settle.push(body);
        seen.idempotencyKeys.push(req.headers['idempotency-key'] || null);
        if (!isValid) return reply(200, { success: false, errorReason: 'invalid_signature', payer: auth.from, network: 'base' });
        return reply(200, {
          success: true,
          transaction: '0x' + 'ab'.repeat(32),
          transactionHash: '0x' + 'ab'.repeat(32),
          paymentId: '0x' + 'cd'.repeat(32),
          network: 'base',
          payer: auth.from,
        });
      }
      return reply(404, { error: 'not_found' });
    });
  });
}

async function signAuthorization(opts) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: (opts.wallet || buyer).address,
    to: opts.to || cfg.payTo,
    value: String(opts.value),
    validAfter: String(now + (opts.validAfterOffset === undefined ? -600 : opts.validAfterOffset)),
    validBefore: String(now + (opts.validBeforeOffset === undefined ? 60 : opts.validBeforeOffset)),
    nonce: '0x' + require('crypto').randomBytes(32).toString('hex'),
  };
  const signature = await (opts.wallet || buyer).signTypedData(DOMAIN, TRANSFER_TYPES, authorization);
  return { authorization, signature };
}

async function signedPayment(version, price, opts = {}) {
  const { authorization, signature } = await signAuthorization({ value: price, ...opts });
  const inner = { signature, authorization };
  if (version === 2) {
    return {
      header: 'payment-signature',
      value: Buffer.from(JSON.stringify({
        x402Version: 2,
        resource: { url: BASE + (opts.path || '/'), description: 'test', mimeType: 'application/json' },
        accepted: {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: String(opts.acceptedAmount || price),
          asset: cfg.asset,
          payTo: cfg.payTo,
          maxTimeoutSeconds: 60,
          extra: { name: cfg.assetName, version: cfg.assetVersion },
        },
        payload: inner,
      })).toString('base64'),
    };
  }
  return {
    header: 'x-payment',
    value: Buffer.from(JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: inner,
    })).toString('base64'),
  };
}

const results = [];
const serverLogs = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
}

const decode = (b64) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

async function waitForHealth(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1200) });
      if (r.ok) return true;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const mock = mockFacilitator();
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      FACILITATOR_URL: 'http://127.0.0.1:' + MOCK_PORT,
      PUBLIC_BASE_URL: BASE,
      X402_TEST_FIXTURES: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLogsPush = (d) => serverLogs.push(String(d));
  child.stdout.on('data', serverLogsPush);
  child.stderr.on('data', serverLogsPush);

  const cleanup = () => { child.kill('SIGKILL'); mock.close(); };
  try {
    check('server boots and /health answers', await waitForHealth());

    const root = await fetch(BASE + '/');
    const rootText = await root.text();
    check('GET / is free prose listing /v1/gas', root.status === 200 && rootText.includes('/v1/gas'));

    const pricing = await (await fetch(BASE + '/pricing')).json();
    check('GET /pricing lists every catalogue product with atomic prices',
      pricing.products.length === CATALOGUE.length && pricing.products.every((p) => /^[0-9]+$/.test(p.priceAtomic)));

    const manifest = await (await fetch(BASE + '/.well-known/x402')).json();
    check('manifest is x402 v2 with CAIP-2 network', manifest.x402Version === 2 && manifest.resources[0].accepts[0].network === 'eip155:8453');

    const openapi = await (await fetch(BASE + '/openapi.json')).json();
    check('openapi.json documents every paid route',
      CATALOGUE.every((p) => openapi.paths[p.path] && openapi.paths[p.path][p.method.toLowerCase()]));

    const junk = await fetch(BASE + '/nope');
    check('unknown route answers 404 without charging', junk.status === 404);

    // --- challenge shape ------------------------------------------------
    const chal = await fetch(BASE + '/v1/gas');
    const chalBody = await chal.json();
    const offer = chalBody.accepts[0];
    check('unpaid GET /v1/gas answers 402', chal.status === 402);
    check('v1 offer carries scheme/network/amount/asset/payTo/EIP-712 domain',
      offer.scheme === 'exact' && offer.network === 'base' && offer.maxAmountRequired === '2000'
      && offer.asset.toLowerCase() === cfg.asset.toLowerCase()
      && offer.payTo.toLowerCase() === cfg.payTo.toLowerCase()
      && offer.extra.name === cfg.assetName && offer.extra.version === cfg.assetVersion);
    const v2 = decode(chal.headers.get('payment-required'));
    check('v2 PAYMENT-REQUIRED header is a valid v2 offer',
      v2.x402Version === 2 && v2.accepts[0].network === 'eip155:8453'
      && v2.accepts[0].amount === '2000' && v2.resource.url.endsWith('/v1/gas'));

    // --- v1 paid call ---------------------------------------------------
    const v1pay = await signedPayment(1, '1000', { path: '/v1/random' });
    const paid1 = await fetch(BASE + '/v1/random?nonce=t1', { headers: { [v1pay.header]: v1pay.value } });
    const paid1Body = await paid1.json();
    const pay1Resp = paid1.headers.get('x-payment-response');
    check('v1 paid GET /v1/random returns 200 with the product payload',
      paid1.status === 200 && paid1Body.data && typeof paid1Body.data.value === 'string');
    check('v1 settlement header carries the tx hash',
      Boolean(pay1Resp) && decode(pay1Resp).transaction === '0x' + 'ab'.repeat(32));

    // --- v1 paid call without payment header (token-risk, GET) ----------------
    const trChal = await fetch(BASE + '/v1/token-risk?token=0x1f984000000000000000000000000c71c29eEa5F');
    check('unpaid GET /v1/token-risk answers 402', trChal.status === 402);
    const trPay = await signedPayment(1, '5000', { path: '/v1/token-risk?token=0x1234' });
    const trRes = await fetch(BASE + '/v1/token-risk?token=0x1f984000000000000000000000000c71c29eEa5F', { headers: { [trPay.header]: trPay.value } });
    const trBody = await trRes.json();
    check('paid GET /v1/token-risk returns 200 with risk data (fixture mode)',
      trRes.status === 200 && trBody.data && trBody.data.riskLevel === 'low' && trBody.data.fixture === true);

    // --- replay defence ------------------------------------------------
    const replay = await fetch(BASE + '/v1/random?nonce=t1', { headers: { [v1pay.header]: v1pay.value } });
    const replayBody = await replay.json();
    check('replaying the same signed authorization is refused',
      replay.status === 402 && /nonce_already_used/.test(JSON.stringify(replayBody.error)));
    check('replay never reached the facilitator again', seen.settle.length === 2);

    // --- v2 paid call ---------------------------------------------------
    const v2pay = await signedPayment(2, '2000', { path: '/v1/btc-fees' });
    const paid2 = await fetch(BASE + '/v1/btc-fees', { headers: { [v2pay.header]: v2pay.value } });
    const paid2Body = await paid2.json();
    check('v2 paid GET /v1/btc-fees returns 200 with data',
      paid2.status === 200 && paid2Body.data.tiersSatPerVbyte.fastest === 3);
    check('v2 settlement header (PAYMENT-RESPONSE) present', Boolean(paid2.headers.get('payment-response')));

    // --- rejected payments ----------------------------------------------
    const forged = await signedPayment(1, '2000', { path: '/v1/gas' });
    const forgedObj = decode(forged.value);
    forgedObj.payload.signature = '0x' + '11'.repeat(65);
    const forgedRes = await fetch(BASE + '/v1/gas', {
      headers: { 'x-payment': Buffer.from(JSON.stringify(forgedObj)).toString('base64') },
    });
    check('forged signature is refused', forgedRes.status === 402
      && /invalid_signature|invalid_value/.test(JSON.stringify(await forgedRes.json())));

    const under = await signedPayment(1, '1', { path: '/v1/gas' });
    const underRes = await fetch(BASE + '/v1/gas', { headers: { [under.header]: under.value } });
    check('underpayment (1 atomic unit) is refused',
      underRes.status === 402 && /insufficient_value/.test(JSON.stringify(await underRes.json())));

    const wrongTo = await signedPayment(1, '2000', { path: '/v1/gas', to: impostor.address });
    const wrongToRes = await fetch(BASE + '/v1/gas', { headers: { [wrongTo.header]: wrongTo.value } });
    check('payment addressed elsewhere is refused',
      wrongToRes.status === 402 && /receiver_mismatch/.test(JSON.stringify(await wrongToRes.json())));

    const stale = await signedPayment(1, '2000', { path: '/v1/gas', validAfterOffset: 3600, validBeforeOffset: 7200 });
    const staleRes = await fetch(BASE + '/v1/gas', { headers: { [stale.header]: stale.value } });
    check('authorization outside its validity window is refused',
      staleRes.status === 402 && /invalid_timing/.test(JSON.stringify(await staleRes.json())));

    // --- POST product ---------------------------------------------------
    const extractPay = await signedPayment(1, '10000', { path: '/v1/extract' });
    const extractRes = await fetch(BASE + '/v1/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [extractPay.header]: extractPay.value },
      body: JSON.stringify({ url: 'https://example.com/article' }),
    });
    const extractBody = await extractRes.json();
    check('paid POST /v1/extract returns markdown',
      extractRes.status === 200 && typeof extractBody.data.markdown === 'string');
    const wrongMethod = await fetch(BASE + '/v1/extract');
    check('GET on a POST-only product answers 405', wrongMethod.status === 405);

    // --- v1 paid call on the portfolio product (GET ?wallet=) ----------------
    const prChal = await fetch(BASE + '/v1/portfolio-risk?wallet=0x1f984000000000000000000000000c71c29eEa5F');
    check('unpaid GET /v1/portfolio-risk answers 402', prChal.status === 402);
    const prPay = await signedPayment(1, '3000', { path: '/v1/portfolio-risk?wallet=0x1234' });
    const prRes = await fetch(BASE + '/v1/portfolio-risk?wallet=0x1f984000000000000000000000000c71c29eEa5F', { headers: { [prPay.header]: prPay.value } });
    const prBody = await prRes.json();
    check('paid GET /v1/portfolio-risk returns 200 with a portfolio summary (fixture mode)',
      prRes.status === 200 && Boolean(prBody.data && prBody.data.riskSummary)
      && prBody.data.riskSummary.overallRiskLevel === 'high' && prBody.data.fixture === true);

    // --- protocol hygiene ------------------------------------------------
    check('all facilitator request bodies matched the documented shape',
      seen.shapeErrors.length === 0, seen.shapeErrors.join('; '));
    check('five settlements reached the facilitator (random v1, token-risk v1, btc-fees v2, extract v1, portfolio-risk v1)',
      seen.settle.length === 5);
    check('settle sent Idempotency-Key equal to the authorization nonce',
      seen.idempotencyKeys[0] === seen.settle[0].paymentPayload.payload.authorization.nonce);
    const negChecks = seen.verify.length;
    check('only validly signed payments addressed to us ever reached /verify',
      negChecks === 5 && seen.verify.every((v) => v.__valid === true
        && String(v.paymentPayload.payload.authorization.to).toLowerCase() === cfg.payTo.toLowerCase()),
      'verify calls: ' + negChecks);

    const ledgerPath = path.join(__dirname, '..', 'data', 'settlements.jsonl');
    const ledgerLines = require('fs').readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    check('settlement ledger recorded every paid call',
      ledgerLines.length >= 5 && ledgerLines.every((l) => l.success === true),
      'lines: ' + ledgerLines.length);



  } finally {
    cleanup();
  }
}

main().then(() => {
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log('\nserver output:\n' + serverLogs.join(''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error('harness error: ' + e.stack + '\nserver output:\n' + serverLogs.join('')); process.exit(1); });
