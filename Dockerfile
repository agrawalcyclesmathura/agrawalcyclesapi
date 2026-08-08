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
# Apply pending DB migrations on boot, then start the server. (Railway/Nixpacks
# use `npm start` which is also `node dist/main`; migrations run here for the
# Dockerfile path.) `prisma` is a runtime dependency so the CLI is present.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
