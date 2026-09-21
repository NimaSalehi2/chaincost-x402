# chaincost — live x402 seller (DO NOT DELETE)

Public origin: https://mixed-memphis-luke-moses.trycloudflare.com
(this hostname changes every time the cloudflared tunnel restarts)

## Processes (both must be alive)
1. Seller server: `PORT=8402 node src/server.js` (binds 127.0.0.1:8402, serves HTTP with PUBLIC_BASE_URL unset — the tunnel's Host header flows through; resource URLs are built per-request from headers)
   logs: logs/server.log | ledger: data/settlements.jsonl | requests: data/requests.jsonl
2. Cloudflare tunnel: `cloudflared tunnel --url http://127.0.0.1:8402 --no-autoupdate`
   log: /tmp/chaincost_tunnel.log (find the fresh hostname with: grep -aoE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /tmp/chaincost_tunnel.log | head -1)

## Restart recipe
pkill -f 'x402-seller/src/server.js'; pkill -f 'cloudflared tunnel --url http://127.0.0.1:8402'
cd /home/cryptonix/crypto-toolkit/x402-seller
setsid env PATH=/home/cryptonix/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin PORT=8402 FACILITATOR_URL=https://facilitator.ultravioletadao.xyz node src/server.js >>logs/server.log 2>&1 < /dev/null &
setsid nohup cloudflared tunnel --url http://127.0.0.1:8402 --no-autoupdate >>/tmp/chaincost_tunnel.log 2>&1 < /dev/null &
# then update PUBLIC origin everywhere (manifest/pricing are per-request, nothing to edit)

## Sandbox DNS gotcha
This box cannot resolve *.trycloudflare.com via system DNS (code 6). Verify with:
curl --resolve '<host>:443:104.21.84.208' https://<host>/health
(agent402.io also does not resolve from here, so registry submission failed locally)

## Money state (2026-09-21)
- Seller 0x3893…1fd2: 0 ETH / 0 USDC on Base. No funds received (no buyers yet).
- Buyer mm server wallet 0x3893…1fd2: ~0.31 POL (~$0.03) on Polygon only. Cannot self-buy: needs Base USDC + Base ETH gas, and server-wallet signing needs mobile MFA.
- e2e: 27/27 pass (node test/e2e.js). Facilitator ultravioletadao supports base/exact v1.
