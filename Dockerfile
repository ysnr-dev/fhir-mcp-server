# --- build stage -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage -----------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node

# Two entrypoints share this image:
#   - stdio (default): `node dist/index.js` — Claude Desktop/Code 向け。
#   - HTTP  (Web版):   `node dist/http.js`  — スマホ/リモート MCP。Cloud Run 等では
#     この command で起動する(PORT は Cloud Run が注入)。
EXPOSE 8080
CMD ["node", "dist/index.js"]
