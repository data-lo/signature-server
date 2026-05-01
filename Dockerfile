# Etapa 1: Builder
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# Etapa 2: Production
FROM node:18-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/fonts ./fonts

EXPOSE 4000

CMD ["node", "dist/main.js"]