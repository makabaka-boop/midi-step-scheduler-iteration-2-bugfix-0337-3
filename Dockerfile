# syntax=docker/dockerfile:1

# --- dependencies: reproducible install from the lockfile ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- verify: one-shot typecheck + unit/page tests + production build ---
FROM deps AS verify
COPY . .
CMD ["npm", "run", "verify"]

# --- web: development server (hot reload not needed inside the container) ---
FROM deps AS web
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]
