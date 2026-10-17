# 24/7 Deployment Guide for Telegram AI Bot

To run your bot 24/7 without needing your laptop open, you need to host it on a cloud server. Here are the best deployment options, ranked by cost and ease of setup.

---

## ⚡ Option 1: Render.com (Recommended for 100% Free)

Render provides a free Web Service tier. Because free services sleep after 15 minutes of inactivity, we added an HTTP `/health` server in `bot.js`. Pinging it keeps the bot awake 24/7.

### Step 1: Push your latest code to GitHub
Make sure your changes are pushed to your GitHub repository:
```bash
git add .
git commit -m "feat: add cloud health check and docker setup"
git push origin main
```

### Step 2: Create a Web Service on Render
1. Go to [render.com](https://render.com) and sign in with GitHub.
2. Click **New +** -> **Web Service**.
3. Select your repository (`telegram-ai-bot`).
4. Configure the settings:
   - **Name:** `telegram-ai-bot` (or any name you like)
   - **Region:** Pick the closest region to you (e.g., Singapore, Frankfurt, Oregon)
   - **Branch:** `main`
   - **Runtime:** `Docker` *(Recommended — automatically installs `ffmpeg` & `yt-dlp` for video downloading)* OR `Node`
   - **Build Command (if using Node):** `npm install && pip install yt-dlp || npm install`
   - **Start Command (if using Node):** `npm start`
   - **Instance Type:** `Free`

### Step 3: Add Environment Variables
In the **Environment Variables** section on Render, add the variables from your `.env` file:
- `TELEGRAM_BOT_TOKEN`: `your_telegram_bot_token`
- `ALLOWED_USER_ID`: `your_telegram_user_id`
- `ANTHROPIC_API_KEY`: `your_anthropic_api_key`
- `ANTHROPIC_BASE_URL`: `https://api.anthropic.com` (or your custom proxy URL)
- `GEMINI_API_KEY`: `your_gemini_api_key`
- `YOUTUBE_COOKIES`: *(Optional)* Netscape format cookies text from the *Get cookies.txt LOCALLY* browser extension to bypass YouTube datacenter bot checks on Render.

Click **Deploy Web Service**.

### Step 4: Keep It Awake 24/7 (Prevent Sleeping)
Once deployed, Render gives you a public URL (e.g., `https://telegram-ai-bot-xxxx.onrender.com`).
1. Go to [cron-job.org](https://cron-job.org) or [uptimerobot.com](https://uptimerobot.com) (both 100% free).
2. Create a new monitor/job:
   - **URL:** `https://telegram-ai-bot-xxxx.onrender.com/health`
   - **Interval:** Every 10 minutes
3. Save. This pings your bot regularly so Render never puts it into sleep mode.

---

## 🚀 Option 2: Railway.app (Simplest & Most Reliable, ~$1-2/month)

Railway is designed for background workers and doesn't sleep or require external pings.

### Step 1: Sign up and Deploy
1. Go to [railway.app](https://railway.app) and sign in with GitHub.
2. Click **New Project** -> **Deploy from GitHub repo**.
3. Choose `telegram-ai-bot`.

### Step 2: Add Variables
1. Go to your project service -> **Variables** tab.
2. Click **Raw Editor** or add each variable:
   - `TELEGRAM_BOT_TOKEN`
   - `ALLOWED_USER_ID`
   - `ANTHROPIC_API_KEY`
   - `ANTHROPIC_BASE_URL`
3. Railway will automatically build and start your bot.

---

## 🐧 Option 3: Linux VPS (Oracle Cloud Always-Free or Hetzner / DigitalOcean)

If you have a Linux VPS (or an Oracle Cloud Always-Free instance):

```bash
# 1. Clone repository
git clone https://github.com/Hanzo023/telegram-ai-bot.git
cd telegram-ai-bot

# 2. Install dependencies
npm install

# 3. Create .env file with your credentials
nano .env

# 4. Install PM2 (Process Manager) to keep it running 24/7
npm install -g pm2

# 5. Start the bot
pm2 start bot.js --name "telegram-bot"

# 6. Save process list and enable on system boot
pm2 save
pm2 startup
```

---

## ⚠️ Important Note: Avoid Conflict Errors
Telegram allows only **one instance** of a bot to poll for updates at any given time.
**Before starting the bot on your cloud server, make sure to stop the local process running on your laptop** (`Ctrl + C` in your terminal). Otherwise, you will receive `409 Conflict: terminated by other getUpdates request`.
