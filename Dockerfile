FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache openssl python3 make g++

COPY package.json ./
COPY package-lock.json* yarn.lock* ./
COPY prisma ./prisma
RUN if [ -f package-lock.json ] && [ -s package-lock.json ]; then \
      npm ci; \
    elif [ -f yarn.lock ]; then \
      corepack enable && yarn install --frozen-lockfile; \
    else \
      npm install; \
    fi

COPY . .
RUN npx prisma generate && npm run build
RUN npm prune --omit=dev && npm install prisma@6.11.0 --no-save

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3002
ENTRYPOINT ["./docker-entrypoint.sh"]
