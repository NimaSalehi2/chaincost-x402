# chaincost — x402 Seller API

Pay-per-call crypto primitives over HTTP 402 (USDC on Base). No API keys, no accounts — payment is your credential.

## Endpoints

| Route | Price | Description |
|---|---|---|
| `GET /v1/gas` | $0.002 | Cross-chain gas quotes (ETH, Base, Arbitrum, OP, Polygon, BNB, Avalanche) |
| `GET /v1/random` | $0.001 | Verifiable randomness from drand League of Entropy beacon |
| `GET /v1/btc-fees` | $0.002 | Bitcoin fee tiers + segwit spend cost |
| `POST /v1/extract` | $0.01 | URL → clean Markdown extraction |
| `GET /v1/token-risk` | $0.005 | Token market + contract risk facts (liquidity, price, volume, holders, verification); tax/honeypot returned as null, never guessed |
| `GET /v1/portfolio-risk` | $0.003 | Wallet holdings & risk profile from real ERC-20 balances (Blockscout) + DEX liquidity checks |

## Free routes
- `GET /health` — liveness
- `GET /pricing` — price list
- `GET /.well-known/x402` — x402 v2 manifest
- `GET /openapi.json` — OpenAPI 3.1
- `GET /llms.txt` — human/agent docs

## Payment
Sign an EIP-3009 `TransferWithAuthorization` for USDC on Base and retry with `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2) header. No gas for the buyer.

## Deployment

Primary public origin: **https://chaincost-x402-production.up.railway.app** (Railway project
`chaincost-x402`, service `chaincost-x402`, GitHub-connected to
`NimaSalehi2/chaincost-x402@main` — push to `main` and Railway rebuilds/redeploys the Dockerfile).

Service variables that matter:

| Variable | Value | Why |
|---|---|---|
| `PORT` | `8402` | **Required.** Railway's edge has nothing to route to without it — the app's own default alone yields a 502 `Application failed to respond` while the deployment still shows SUCCESS. |
| `HOST` | `0.0.0.0` | bind all interfaces |
| `PAYTO` / `FACILITATOR_URL` | see `config.json` | overrides (optional; identical to file defaults) |
| `PUBLIC_BASE_URL` | the Railway origin | makes payment `resource` URLs absolute and stable |

Local fallback (ephemeral, used before the Railway deploy):
`cloudflared tunnel --url http://127.0.0.1:8402` — the `*.trycloudflare.com` hostname changes on every restart.

## Run locally
```bash
npm install
node src/server.js
```

Tests:
```bash
X402_TEST_FIXTURES=1 node test/e2e.js
```
