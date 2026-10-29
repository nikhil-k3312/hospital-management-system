# MediChain API + bundled frontend (the API serves frontend/ on the same origin).
# Build from the repository root:  docker build -t medichain .
FROM node:20-alpine

WORKDIR /app/backend/services/api
COPY backend/services/api/package.json backend/services/api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/services/api/src ./src
COPY backend/services/api/scripts ./scripts
COPY frontend /app/frontend

# Writable by the unprivileged user: winston logs and the seed's demo-device key file.
RUN mkdir -p /app/backend/logs && chown -R node:node /app/backend/logs ./scripts

ENV NODE_ENV=production PORT=8001
EXPOSE 8001
USER node
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:8001/health || exit 1
CMD ["node", "src/server.js"]
