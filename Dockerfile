# ✅ Multi-stage: dev dependencies and build separated from the prod image.
FROM node:22-slim AS builder
#    ↑ same Node, without extra build tools

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
#    ↑ manifests FIRST, THEN install. Code changes daily,
#      dependencies — once a week. So this layer stays cached

COPY . .
RUN npm run build
#    ↑ tsc compiles src/*.ts → dist/*.js. TypeScript and sources stay here,
#      in the builder layer, and never reach runner

FROM node:22-slim AS runner
#    ↑ second stage: a clean image without TypeScript or the builder layer's npm cache

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
#    ↑ the same cache trick, but now without any dev dependencies at all
#      (typescript, tsx, @types/* are not installed here)

COPY --from=builder /app/dist ./dist
#    ↑ only the compiled JS moves from builder, not its whole layer

USER node
#    ↑ the node:* image already has a "node" user (uid 1000). Without this line — root (uid 0)

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
#    ↑ exec form: node BECOMES PID 1 and receives SIGTERM directly
