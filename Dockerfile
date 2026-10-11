FROM node:22-slim

WORKDIR /app

# Install dependencies needed for production
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Expose health-check port (Render default is 10000)
EXPOSE 10000

ENV NODE_ENV=production

# Run node directly so it runs as PID 1 and receives termination signals cleanly
CMD ["node", "bot.js"]
