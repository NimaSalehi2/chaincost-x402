FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# Deterministic install from the committed lockfile (ethers comes from here).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY config.json ./
COPY src/ src/

EXPOSE 8402

CMD ["node", "src/server.js"]
