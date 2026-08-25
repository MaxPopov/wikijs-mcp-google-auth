# Build context = repository root:
#   docker build -f packages/mcp-server/Dockerfile -t wikijs-mcp-server .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/wikijs-auth-module/package.json packages/wikijs-auth-module/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/mcp-server/tsconfig.json packages/mcp-server/
COPY packages/mcp-server/src packages/mcp-server/src
RUN npm run build -w @wikijs-mcp/server && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/mcp-server/package.json packages/mcp-server/package.json
COPY --from=build /app/packages/mcp-server/dist packages/mcp-server/dist
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "packages/mcp-server/dist/index.js"]
