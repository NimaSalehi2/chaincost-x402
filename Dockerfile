FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production 2>/dev/null || npm install --production 2>/dev/null || true

# ethers is a peer dependency loaded from /home/cryptonix/node_modules/ethers
# In container, install it explicitly
RUN npm install ethers@6

COPY src/ src/
COPY config.json ./
COPY bin/ bin/

EXPOSE 8402

CMD ["node", "src/server.js"]
