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
EXPOSE 4000
# Apply pending DB migrations on boot, then start the server. Migration failure
# is logged but does NOT block startup (`;`, not `&&`) so a DB/migration hiccup
# can never take the whole web process down — the server still boots and /health
# stays reachable for diagnosis. `prisma` is a runtime dependency (CLI present).
CMD ["sh", "-c", "npx prisma migrate deploy || echo '[boot] prisma migrate deploy failed — starting server anyway'; node dist/main"]
