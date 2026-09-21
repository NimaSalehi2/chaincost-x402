# chaincost — x402 Seller API

Pay-per-call crypto primitives over HTTP 402 (USDC on Base). No API keys, no accounts — payment is your credential.

## Endpoints

| Route | Price | Description |
|---|---|---|
| `GET /v1/gas` | $0.002 | Cross-chain gas quotes (ETH, Base, Arbitrum, OP, Polygon, BNB, Avalanche) |
| `GET /v1/random` | $0.001 | Verifiable randomness from drand League of Entropy beacon |
| `GET /v1/btc-fees` | $0.002 | Bitcoin fee tiers + segwit spend cost |
| `POST /v1/extract` | $0.01 | URL → clean Markdown extraction |
| `GET /v1/token-risk` | $0.005 | Token safety & risk scoring (honeypot, tax, liquidity, rug-pull flags) |

## Free routes
- `GET /health` — liveness
- `GET /pricing` — price list
- `GET /.well-known/x402` — x402 v2 manifest
- `GET /openapi.json` — OpenAPI 3.1
- `GET /llms.txt` — human/agent docs

## Payment
Sign an EIP-3009 `TransferWithAuthorization` for USDC on Base and retry with `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2) header. No gas for the buyer.

## Run locally
```bash
npm install
node src/server.js
```

Tests:
```bash
X402_TEST_FIXTURES=1 node test/e2e.js
```
