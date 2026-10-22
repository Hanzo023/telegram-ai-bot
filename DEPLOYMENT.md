# 🌐 24/7 Cloud Deployment Guide for Telegram AI Bot

This guide provides step-by-step instructions for deploying your private Telegram AI Bot & Remote Laptop Agent to run **24/7 in the cloud** without requiring your physical laptop to stay open.

---

## 📑 Contents

- [Architectural Overview](#-architectural-overview)
- [Option 1: Render.com (Recommended — 100% Free)](#-option-1-rendercom-recommended--100-free)
  - [Step 1: Push Code to GitHub](#step-1-push-your-latest-code-to-github)
  - [Step 2: Create Web Service on Render](#step-2-create-a-web-service-on-render)
  - [Step 3: Configure Environment Variables](#step-3-add-environment-variables)
  - [Step 4: Keep It Awake 24/7 via UptimeRobot](#step-4-keep-it-awake-247-via-uptimerobot-prevent-sleeping)
  - [Step 5: Link Your Laptop Remote Agent](#step-5-link-your-laptop-remote-agent-start-agentbat)
- [Option 2: Railway.app (Zero-Config, ~$1-2/month)](#-option-2-railwayapp-simplest--most-reliable-1-2month)
- [Option 3: Linux VPS (Oracle Always-Free / Hetzner / DigitalOcean)](#-option-3-linux-vps-oracle-cloud-always-free-or-hetzner--digitalocean)
- [High Availability, Watchdogs & Troubleshooting](#-high-availability-watchdogs--troubleshooting)
  - [Automatic Polling Watchdog](#1-automatic-polling-watchdog)
  - [How to Reboot the Bot Remotely (`/reboot` & `/restart`)](#2-how-to-reboot-the-bot-remotely-reboot--restart)
  - [Avoiding Telegram 409 Polling Conflict](#3-avoiding-telegram-409-polling-conflicts)

---

## 🏛️ Architectural Overview

```
                      ┌──────────────────────────────────────────────┐
                      │          Telegram Client (Mobile / PC)       │
                      └──────────────────────┬───────────────────────┘
                                             │ HTTPS
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │         Render Cloud Host (bot.js)           │
                      │  • Port 10000: Health check & WebSockets     │
                      │  • Long-polling Telegram for incoming chats  │
                      │  • Supervised by 15s Watchdog auto-restarter │
                      └──────────────────────┬───────────────────────┘
                                             ▲
                                             │ Outbound WSS Tunnel
                                             │ (/ws/laptop-agent)
                                             │
                      ┌──────────────────────┴───────────────────────┐
                      │     Local Laptop Agent (laptop-runner.js)    │
                      │  • Runs in background via Silent VBS / PM2   │
                      │  • Executes terminal commands & reads specs  │
                      └──────────────────────────────────────────────┘
```

* **Cloud Server (`bot.js`)**: Runs 24/7 on Render. It receives messages from Telegram, calls Claude Sonnet 5.5 and Gemini 3.8 Flash, and hosts the WebSocket bridge.
* **Local Laptop Runner (`laptop-runner.js`)**: Runs on your physical computer. It dials out to the cloud server, allowing you to run PowerShell/bash commands and check hardware status from your phone while away.

---

## ⚡ Option 1: Render.com (Recommended — 100% Free)

Render provides a generous free tier for Web Services. By pairing Render with **UptimeRobot**, you can keep the bot alive 24/7 with zero sleeping.

### Step 1: Push your latest code to GitHub
Make sure all repository changes are pushed to your `main` branch:
```bash
git add .
git commit -m "feat: production cloud deployment setup"
git push origin main
```

### Step 2: Create a Web Service on Render
1. Go to [render.com](https://render.com) and log in with GitHub.
2. Click **New +** ➔ **Web Service**.
3. Select your repository (`telegram-ai-bot`).
4. Configure the service settings:
   * **Name**: `telegram-ai-bot` (or any custom name)
   * **Region**: Choose the closest location to you (e.g., `Singapore`, `Frankfurt`, `Oregon`)
   * **Branch**: `main`
   * **Runtime**: **`Docker`** *(Recommended — automatically installs Node 22, `ffmpeg`, and `yt-dlp`)* OR **`Node`**
   * **Build Command** *(if using Node runtime)*: `npm install && pip install yt-dlp || npm install`
   * **Start Command** *(if using Node runtime)*: `npm start`
   * **Instance Type**: **`Free`**

### Step 3: Add Environment Variables
In the **Environment Variables** section on your Render dashboard, configure:

| Variable | Description | Example / Value |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Bot API token from [@BotFather](https://t.me/BotFather) | `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ` |
| `ALLOWED_USER_ID` | Your numerical Telegram user ID | `<YOUR_TELEGRAM_USER_ID>` |
| `ANTHROPIC_API_KEY` | Your Anthropic Claude API key | `sk-ant-api03-...` |
| `ANTHROPIC_BASE_URL` | Anthropic endpoint or custom proxy | `https://api.anthropic.com` |
| `ANTHROPIC_MODEL` | Claude model name | `claude-sonnet-5-5` |
| `GEMINI_API_KEY` | Google Gemini API key from AI Studio | `AIzaSy...` |
| `SERVER_URL` | Public Render service URL | `https://telegram-ai-bot-xxxx.onrender.com` |
| `STORAGE_DIR` | *(Optional)* Default folder on laptop | `D:\projects` |
| `YOUTUBE_COOKIES` | *(Optional)* Netscape format cookies text | Exported via *Get cookies.txt LOCALLY* extension |

Click **Deploy Web Service**.

---

### Step 4: Keep It Awake 24/7 via UptimeRobot (Prevent Sleeping)

> [!IMPORTANT]
> **Why this step is required**: Render free Web Services spin down (sleep) after **15 minutes of inactivity** (when no incoming HTTP requests are received). Once asleep, the Telegram bot cannot receive or answer messages!

To prevent sleeping, set up an automated pinger using [UptimeRobot](https://uptimerobot.com) (100% free, up to 50 monitors):

1. Go to [uptimerobot.com](https://uptimerobot.com) and create a free account.
2. In the dashboard, click **+ Add New Monitor**.
3. Configure the monitor:
   * **Monitor Type**: `HTTP(s)`
   * **Friendly Name**: `Telegram AI Bot (Render Keepalive)`
   * **URL (or IP)**: `https://your-bot-name.onrender.com/health`
   * **Monitoring Interval**: **`5 minutes`** (or `10 minutes` — must be **under 15 minutes** to prevent sleep!)
   * **Monitor Timeout**: `30 seconds`
4. Click **Create Monitor**.

---

### Step 5: Link Your Laptop Remote Agent (`start-agent.bat`)

Once your cloud service is running on Render:
1. Open Telegram and send `/setup_laptop` (or `/runner`) to your bot.
2. The bot will deliver a personalized **`start-agent.bat`** pre-configured with your user ID and cloud URL.
3. Save `start-agent.bat` into your local project directory (e.g., `<your-project-folder>`).
4. Double-click **`start-agent.bat`** (or run `Enable-Laptop-Agent.bat` for silent background autostart).
5. The bot will send a confirmation in Telegram:
   ```
   💻 Laptop Connected: DESKTOP-XXXX
   • Host: DESKTOP-XXXX (Windows 11 Pro)
   • Status: Active & listening for remote commands.
   ```
6. You can now control your laptop, run terminal tasks, and inspect hardware specs from anywhere!

---

## 🚀 Option 2: Railway.app (Simplest & Most Reliable, ~$1-2/month)

Railway does not spin down free containers, making it an excellent alternative if you want background worker behavior without requiring an external ping monitor:

### Step 1: Sign up and Deploy
1. Go to [railway.app](https://railway.app) and log in with GitHub.
2. Click **New Project** ➔ **Deploy from GitHub repo**.
3. Choose `telegram-ai-bot`.

### Step 2: Add Variables
1. Navigate to your project service ➔ **Variables** tab.
2. Add your environment variables:
   * `TELEGRAM_BOT_TOKEN`
   * `ALLOWED_USER_ID`
   * `ANTHROPIC_API_KEY`
   * `ANTHROPIC_BASE_URL`
   * `GEMINI_API_KEY`
3. Railway will build and launch your bot automatically.

---

## 🐧 Option 3: Linux VPS (Oracle Cloud Always-Free or Hetzner / DigitalOcean)

If you have a dedicated Linux server or an Oracle Cloud Always-Free VM:

```bash
# 1. Clone repository
git clone https://github.com/Hanzo023/telegram-ai-bot.git
cd telegram-ai-bot

# 2. Install dependencies
npm install

# 3. Create .env configuration
nano .env

# 4. Install PM2 (Process Manager)
npm install -g pm2

# 5. Start the bot
pm2 start bot.js --name "telegram-bot"

# 6. Save process list to auto-start on boot
pm2 save
pm2 startup
```

---

## 🛡️ High Availability, Watchdogs & Troubleshooting

### 1. Automatic Polling Watchdog
`bot.js` includes an internal **15-second Polling Supervisor**. If Telegram polling ever drops due to upstream network blips, 409 conflicts, or socket disconnects:
* The supervisor attempts clean re-connection without throwing `Error: Aborted delay`.
* If polling is unresponsive for >45 seconds (3 consecutive checks), the supervisor triggers `process.exit(1)`.
* Render, Docker, or PM2 immediately respawns a clean, fresh container with new TCP sockets.

### 2. How to Reboot the Bot Remotely (`/reboot` & `/restart`)
If your bot ever encounters an unrecoverable state, you can reboot the container without logging into Render:
* **Via Telegram Chat**: Send the `/reboot` or `/restart` command directly to the bot.
* **Via HTTP Endpoint**: Access `https://your-bot-name.onrender.com/restart?force=true` from your browser.
* **Via Render Dashboard**: Click **Manual Deploy** ➔ **Deploy latest commit** (or **Restart Service**).

### 3. Avoiding Telegram 409 Polling Conflicts
Telegram strictly enforces that **only one instance of a bot token can poll for updates at any time**:
* **Rule**: Run `bot.js` **only in the cloud** (Render).
* **On your local laptop**: Run **only** `laptop-runner.js` (`start-agent.bat` or `npm run laptop`).
* If you ever run `node bot.js` on your laptop while Render is active, Telegram will throw `409 Conflict: terminated by other getUpdates request`.

---

## 📄 License & Maintainer
Created and maintained by **Din Sopheakyuth**. Licensed under the [MIT License](LICENSE).
