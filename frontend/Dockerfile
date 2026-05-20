# =============================================================================
# frontend/Dockerfile — multi-stage build.
#   Stage 1 (builder): install npm deps, run `vite build` to produce /app/dist.
#   Stage 2 (runtime): copy the built static files into a tiny nginx image.
# Multi-stage keeps the final image small (no node_modules, no Node runtime).
# =============================================================================

# ---- Stage 1: build the static bundle with Node ------------------------------
FROM node:24-alpine AS builder
WORKDIR /app

# Copy only package manifests first so `npm install` is cached as a separate
# layer. Source changes won't re-install deps unless package.json changes.
COPY package*.json ./
RUN npm install

# Now copy the rest of the source and produce the production bundle in /app/dist.
COPY . .
RUN npm run build

# ---- Stage 2: serve the bundle with nginx ------------------------------------
FROM nginx:alpine

# Vite's build output goes into nginx's default web root.
COPY --from=builder /app/dist /usr/share/nginx/html

# Custom server config: SPA fallback, reverse proxies, security headers, etc.
# (Replaces nginx's default.conf — same path.)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Document the port we listen on. docker-compose maps this to host port 8082.
EXPOSE 80
