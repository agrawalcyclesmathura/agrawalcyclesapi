# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

# ---- Runtime stage ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma
# NOTE: intentionally NO `EXPOSE` — the app listens on $PORT (0.0.0.0:$PORT).
# A hardcoded EXPOSE (e.g. 4000) makes Railway route to that port while the app
# listens on the injected $PORT (e.g. 8080) → "Application failed to respond".
# Start the web process ONLY. Migrations are decoupled from boot (they must never
# hang or fail the web process — a hung `prisma migrate deploy` was blocking the
# container from ever listening). Run migrations as a separate one-off/pre-deploy
# step: `npx prisma migrate deploy` (see docs/DEPLOYMENT_VERCEL_RAILWAY.md).
CMD ["node", "dist/main"]
