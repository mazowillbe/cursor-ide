# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production: serve static files
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g serve
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["sh", "-c", "serve dist -s -l ${PORT:-3000}"]
