FROM node:22-slim

WORKDIR /app

# Install dependencies needed for production
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Expose health-check port
EXPOSE 3000

ENV NODE_ENV=production

CMD ["npm", "start"]
