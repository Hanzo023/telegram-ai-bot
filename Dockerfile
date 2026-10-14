FROM node:22-slim

WORKDIR /app

# Install system dependencies: python3, ffmpeg, yt-dlp for media search and download
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp

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
