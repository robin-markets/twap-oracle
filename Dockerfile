# Multi-stage build for TypeScript indexer
FROM node:25-alpine AS base

# Set working directory
WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Install dependencies with cache mount
RUN npm install --frozen-lockfile

# Copy source code and configuration files
COPY src ./src
COPY tsconfig.json ./

# Build the indexer application
ENV GENERATE_SOURCEMAP=false
RUN npm run build

# Production stage
FROM node:25-alpine AS production

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Install only production dependencies with cache mount
RUN npm install --frozen-lockfile --prod

# Copy built application from build stage
COPY --from=base /app/dist ./dist

# Set environment variables
ENV NODE_ENV=production

EXPOSE 3000

# Start the application
CMD ["npm", "start"]