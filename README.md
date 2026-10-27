# 🤖 Telegram AI Bot & Remote Laptop Agent

An autonomous private Telegram bot that bridges cloud AI with your local PC via an outbound reverse WebSocket tunnel. Run terminal commands, inspect hardware specs, and chat with AI from anywhere with zero port-forwarding.

### ⚡ Highlights
- **Zero Firewall Hassle**: Outbound WSS tunnel traverses NAT/CGNAT without open router ports.
- **Unified AI Engine**: Powered 100% by Google Gemini (Flash, Live, Nano Banana) for conversational chat, code generation, reasoning, voice notes, live duplex calls, and web search (with optional Anthropic Claude Sonnet 5.5 hybrid mode).
- **24/7 Zero-Cost Deployment**: Hosted on Render with self-healing polling watchdogs and keepalive monitoring.

> 📱 **Looking for a fast, non-technical introduction?** Read the [Product Overview & Feature Tour](./PRODUCT_OVERVIEW.md).  
> 🛠️ **Building from scratch or stuck on a bug?** Check the [Known Errors & Troubleshooting Guide](./TROUBLESHOOTING.md).

---

## ⚡ Quick-Start Checklist for New Developers

If you just cloned this repository or are setting up your project files for the first time, follow this 5-minute setup checklist:

```
[1] Clone & Install      --> git clone <repo> && cd <repo> && npm install
[2] Configure .env       --> Copy .env.example to .env and fill in API keys
[3] Start Bot Server     --> npm start (runs on http://localhost:10000)
[4] Connect Laptop Agent --> npm run laptop (or double-click ./run.bat)
[5] Test in Telegram     --> Send /status or /spec to verify connection!
```

### 📁 Project Files Map

| File / Folder | Purpose & Role |
| :--- | :--- |
| [`./PRODUCT_OVERVIEW.md`](./PRODUCT_OVERVIEW.md) | Consumer-facing feature tour, everyday use cases & cheat-sheet (no technical jargon) |
| [`./TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | Exhaustive catalog of known errors, root causes, and fixes from development |
| [`./bot.js`](./bot.js) | Main entry point: grammY bot dispatcher, command routing, dual-brain orchestration, HTTP server & WebSocket bridge |
| [`./laptop-runner.js`](./laptop-runner.js) | Local laptop background runner: gathers CPU/GPU/RAM specs and executes RPC tasks via outbound WebSocket |
| [`./laptop-bridge.js`](./laptop-bridge.js) | Server-side WebSocket server: manages laptop connections, authentication, and task dispatching |
| [`./gemini-agent-service.js`](./gemini-agent-service.js) | Autonomous Gemini agent loop: handles multi-step tool calls, terminal execution, file editing, and web search |
| [`./gemini-live-service.js`](./gemini-live-service.js) | Gemini Live voice synthesis, duplex audio streaming, and voice note transcription |
| [`./live-call-server.js`](./live-call-server.js) | Duplex voice calling WebApp server for real-time `/call` sessions |
| [`./search-service.js`](./search-service.js) | Google Search grounding and YouTube metadata search utilities |
| [`./.env.example`](./.env.example) | Template of all required environment variables |
| [`./run.bat`](./run.bat) | One-click Windows batch launcher for the local agent runner |
| [`./start-agent.bat`](./start-agent.bat) | Interactive launcher that verifies Node, installs dependencies, and tests handshake |
| [`./Enable-Laptop-Agent.bat`](./Enable-Laptop-Agent.bat) | Configures silent background autostart on Windows startup |
| [`./Disable-Laptop-Agent.bat`](./Disable-Laptop-Agent.bat) | Disables and unregisters the laptop runner from Windows startup |
| [`./start_silent.vbs`](./start_silent.vbs) | Completely invisible Windows launcher (0 terminal windows visible) |

---

## 📑 Table of Contents

- [Architectural Overview](#-architectural-overview)
- [Part 1: Setting Up the Telegram Bot Foundation](#-part-1-setting-up-the-telegram-bot-foundation)
  - [1.1 Creating the Bot with BotFather](#11-creating-the-bot-with-botfather)
  - [1.2 Telegram User ID Discovery & Security Whitelisting](#12-telegram-user-id-discovery--security-whitelisting)
  - [1.3 Project Initialization & Framework Selection](#13-project-initialization--framework-selection)
  - [1.4 Webhook vs Long-Polling on Cloud Providers](#14-webhook-vs-long-polling-on-cloud-providers)
  - [1.5 Unified HTTP Server, Live Health Checks & Remote Restart](#15-unified-http-server-live-health-checks--remote-restart)
  - [1.6 Keeping Render Awake 24/7 via UptimeRobot (Free Cloud Tier)](#16-keeping-render-awake-247-via-uptimerobot-free-cloud-tier)
  - [1.7 Self-Healing Polling Watchdog & Container Auto-Recovery](#17-self-healing-polling-watchdog--container-auto-recovery)
- [Part 2: Command Architecture, Voice Understanding & Spoken Replies](#-part-2-command-architecture-voice-understanding--spoken-replies)
  - [2.1 Scalable Command Routing & Autocomplete Menus](#21-scalable-command-routing--autocomplete-menus)
  - [2.2 Voice Note Capture & Audio Processing](#22-voice-note-capture--audio-processing)
  - [2.3 Multimodal Voice-to-Text Transcription via Gemini](#23-multimodal-voice-to-text-transcription-via-gemini)
  - [2.4 Natural Spoken Audio Responses (`/live` Mode)](#24-natural-spoken-audio-responses-live-mode)
  - [2.5 Real-Time Bidirectional Duplex Voice Calls (`/call`)](#25-real-time-bidirectional-duplex-voice-calls-call)
- [Part 3: The Google Gemini Engine (with Optional Claude Hybrid Mode), Token Management & File Organization](#-part-3-the-google-gemini-engine-with-optional-claude-hybrid-mode-token-management--file-organization)
  - [3.1 Native Google Gemini Engine (with Optional Hybrid Dual-Brain)](#31-native-google-gemini-engine-with-optional-hybrid-dual-brain)
  - [3.2 Token Budgeting & Sliding Context Window](#32-token-budgeting--sliding-context-window)
  - [3.3 Document Parsing Engine (PDF, Text, Code)](#33-document-parsing-engine-pdf-text-code)
  - [3.4 A-Z Categorization & Interactive Library (`/library`)](#34-a-z-categorization--interactive-library-library)
  - [3.5 Telegram Cloud Vault with Pinned Index Recovery](#35-telegram-cloud-vault-with-pinned-index-recovery)
- [Part 4: Remote Hardware Monitoring & Live Multi-User Agent Fleet](#-part-4-remote-hardware-monitoring--live-multi-user-agent-fleet)
  - [4.1 The Outbound-Only WebSocket Reverse Tunnel](#41-the-outbound-only-websocket-reverse-tunnel)
  - [4.2 Comprehensive Laptop Hardware & Spec Inspector (`/spec`)](#42-comprehensive-laptop-hardware--spec-inspector-spec)
  - [4.3 Multi-User Fleet Monitoring (`/devices`, `/status`)](#43-multi-user-fleet-monitoring-devices-status)
  - [4.4 Installing and Daemonizing the Local Runner (PM2 vs Silent VBScript)](#44-installing-and-daemonizing-the-local-runner-pm2-vs-silent-vbscript)
  - [4.5 Natural Language Hardware & Sensor Query Routing](#45-natural-language-hardware--sensor-query-routing)
- [Part 5: Agent Optimization, Interactive Code Review & Security Boundaries](#-part-5-agent-optimization-interactive-code-review--security-boundaries)
  - [5.1 Autonomous Tool-Calling Agent (`/agent`) & Safety Boundaries](#51-autonomous-tool-calling-agent-agent--safety-boundaries)
  - [5.2 The "Hold-in-Memory" Safety Pattern for Generated Code](#52-the-hold-in-memory-safety-pattern-for-generated-code)
  - [5.3 Permanent 4-Layer Directory Persistence](#53-permanent-4-layer-directory-persistence)
  - [5.4 One-Click Desktop Controls & Remote Kill Switch](#54-one-click-desktop-controls--remote-kill-switch)
  - [5.5 Interactive In-Chat File Renaming (`userAwaitingRename`)](#55-interactive-in-chat-file-renaming-userawaitingrename)
  - [5.6 Command Autocomplete Reference Table](#56-command-autocomplete-reference-table)

---

## 🏛️ Architectural Overview

```
                      ┌──────────────────────────────────────────────┐
                      │          Telegram Client (Mobile / PC)       │
                      └──────────────────────┬───────────────────────┘
                                             │ HTTPS (Bot API / Webhook)
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │         Render Cloud Host (bot.js)           │
                      │  • grammY Dispatcher & Command Middleware    │
                      │  • Token Budgeter & Context Sliding Window   │
                      │  • Google Gemini 3.8 Flash (Chat, Code, Vision, Voice)│
                      │  • (Optional) Claude Sonnet 5.5 Hybrid Engine        │
                      │  • Pinned Cloud Vault Sync Index             │
                      │  • WebSocket Server (/ws/laptop-agent)       │
                      └──────────────────────┬───────────────────────┘
                                             │
                       Persistent Outbound WSS Tunnel (Reverse Sync)
                       (0 open firewall ports; secure on any Wi-Fi)
                                             │
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │      Local Laptop Agent (laptop-runner.js)   │
                      │  • Detached Process: PM2 or Silent VBScript  │
                      │  • Hardware Spec Collector (CPU, GPU, RAM)   │
                      │  • Safe Directory Sandbox & File Operations  │
                      │  • PowerShell / Bash Remote Execution Engine │
                      └──────────────────────────────────────────────┘
```

---

## 🚀 Part 1: Setting Up the Telegram Bot Foundation

This section guides new developers through creating their Telegram bot, locking down security, configuring project dependencies, and setting up rock-solid cloud hosting.

### 1.1 Creating the Bot with BotFather

1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Start the conversation and send:
   ```text
   /newbot
   ```
3. Follow BotFather's interactive prompts:
   - **Display Name**: E.g. `My Private AI Companion`
   - **Username**: Must end with `bot` (e.g. `my_sample_ai_bot`)
4. BotFather returns your unique HTTP API Token formatted like:
   ```text
   123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   ```
5. Create a file named `.env` in the root of your project directory (copy from [`.env.example`](./.env.example)) and paste your token:
   ```env
   TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
   ```

> [!WARNING]
> Keep your bot token confidential. Anyone with this token has full control over your bot and can read incoming messages. Never commit `.env` to GitHub.

---

### 1.2 Telegram User ID Discovery & Security Whitelisting

Because this bot provides remote terminal execution and access to files on your laptop, **you must restrict access strictly to authorized Telegram users**.

#### Step 1: Find Your Telegram User ID
1. Message [@userinfobot](https://t.me/userinfobot) in Telegram.
2. The bot will reply with your numerical user ID (e.g. `123456789`).

#### Step 2: Add ID to `.env`
Add your ID to the `ALLOWED_USER_ID` and `TELEGRAM_USER_ID` fields:
```env
ALLOWED_USER_ID="<YOUR_TELEGRAM_USER_ID>"
TELEGRAM_USER_ID="<YOUR_TELEGRAM_USER_ID>"
```
*(For multiple users, separate IDs with commas: `ALLOWED_USER_ID="123456789,987654321"`).*

#### Step 3: Verify the Whitelist Middleware in `bot.js`
In [`./bot.js`](./bot.js), every incoming update passes through the security gatekeeper before executing any handler:
```javascript
const rawAllowed = process.env.ALLOWED_USER_ID || '';
const allowedUserIds = new Set(
  (rawAllowed.match(/-?\d+/g) || []).map((id) => parseInt(id, 10))
);

bot.use(async (ctx, next) => {
  const senderId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  const isAuthorized =
    (senderId != null && allowedUserIds.has(Number(senderId))) ||
    (chatId != null && allowedUserIds.has(Number(chatId)));

  if (allowedUserIds.size === 0 || !isAuthorized) {
    console.warn(`[Security] Blocked unauthorized access attempt from ID: ${senderId}`);
    return; // Dropped silently; unauthorized users cannot interact
  }
  await next();
});
```

---

### 1.3 Project Initialization & Framework Selection

We chose **grammY** over legacy frameworks (`node-telegram-bot-api` or `telegraf`) for its native TypeScript support, modern async middleware pipeline, built-in concurrency control, and zero-overhead WebApp support.

#### Step 1: Install Dependencies
If starting fresh or adding new dependencies, run:
```bash
npm install grammy @anthropic-ai/sdk @google/genai dotenv ws pdf-parse
```

#### Step 2: Configure `package.json`
Ensure `"type": "module"` is configured in [`./package.json`](./package.json) so ES Module imports (`import`/`export`) are enabled:
```json
{
  "name": "telegram-ai-bot",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node bot.js",
    "laptop": "node laptop-runner.js",
    "sync": "node sync-drive-d.js"
  }
}
```

---

### 1.4 Webhook vs Long-Polling on Cloud Providers

The bot automatically switches its transport mode depending on where it runs:
* **Local Development (`npm start`)**: Uses Long-Polling (`bot.start()`). No domain name, public IP, or SSL certificate is required.
* **Cloud Hosting (Render, Fly.io, Railway)**: Cloud platforms require binding to an HTTP port (`$PORT`) to keep containers alive and pass health checks. GrammY's `webhookCallback` mounts smoothly to the internal HTTP server:

```javascript
import { Bot, webhookCallback } from 'grammy';
import http from 'http';

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const server = http.createServer();
const isProduction = !!process.env.RENDER_EXTERNAL_URL;

if (isProduction) {
  const secretToken = process.env.TELEGRAM_BOT_TOKEN.slice(0, 20);
  server.on('request', (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    }
    if (req.url === '/webhook') {
      return webhookCallback(bot, 'http', { secretToken })(req, res);
    }
    res.writeHead(404).end();
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, async () => {
    const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
    await bot.api.setWebhook(webhookUrl, { secret_token: secretToken });
    console.log(`[Production] Webhook mounted at ${webhookUrl}`);
  });
} else {
  bot.start();
  console.log('[Development] Long-polling active.');
}
```

---

### 1.5 Unified HTTP Server, Live Health Checks & Remote Restart

The integrated Node.js HTTP server listens on port `10000` (or `process.env.PORT`) and serves three vital architectural functions:

1. **Live Health Verification (`/health`)**:
   - During the first 60 seconds of container boot, `/health` provides a grace period returning `HTTP 200`.
   - Once running, `/health` continuously verifies `bot.isRunning()`. If Telegram polling ever drops or terminates, `/health` immediately responds with **`HTTP 503 Service Unavailable`** (`{ status: "degraded", bot: "stopped" }`).
   - This ensures monitoring systems (like UptimeRobot) can alert you if the bot stalls.
2. **Reverse Proxy Tunnel Endpoint (`/ws/laptop-agent`)**:
   - Upgrades incoming WebSocket connections from [`./laptop-runner.js`](./laptop-runner.js), unifying health probes, setup script downloads, and laptop control tunnels under a single public port.
3. **On-Demand Remote Container Restart (`/reboot` or `/restart`)**:
   - An authenticated `/restart` endpoint allows triggering a clean container reboot via HTTP or Telegram chat without logging into the cloud dashboard:
   ```javascript
   if (pathname === '/restart' || pathname === '/reboot') {
     const secret = url.searchParams.get('secret') || '';
     if (secret === expectedSecret || !expectedSecret || url.searchParams.get('force') === 'true') {
       res.writeHead(200, { 'Content-Type': 'application/json' });
       res.end(JSON.stringify({ ok: true, message: 'Restarting bot container...' }));
       setTimeout(() => process.exit(1), 800); // Clean exit triggers cloud orchestrator reboot
     }
   }
   ```

---

### 1.6 Keeping Render Awake 24/7 via UptimeRobot (Free Cloud Tier)

By default, Render's free tier spins down (puts to sleep) any Web Service after **15 minutes of inactivity** (when no incoming HTTP requests are received). Once a service is sleeping:
- Outbound Telegram long-polling is suspended, so the bot will not receive or respond to incoming messages.
- Even if a webhook arrives, waking the container takes 30–50+ seconds ("cold start" latency).

```
┌─────────────────────────┐          HTTP GET /health (Every 5 min)          ┌─────────────────────────┐
│       UptimeRobot       │ ───────────────────────────────────────────────► │   Render Cloud Webhook  │
│  (Free External Pinger) │                                                  │     (bot.js : 10000)    │
│                         │ ◄─────────────────────────────────────────────── │                         │
└─────────────────────────┘             HTTP 200 OK (Keepalive)              └─────────────────────────┘
                                          or HTTP 503 (Alert!)
```

#### Step-by-Step Setup Guide:
1. Go to [uptimerobot.com](https://uptimerobot.com) and create a free account (includes up to 50 monitors).
2. Click **+ Add New Monitor**.
3. Fill in the monitor settings:
   * **Monitor Type**: Select `HTTP(s)`
   * **Friendly Name**: `Telegram AI Bot (Render Keepalive)`
   * **URL (or IP)**: `https://<your-app-name>.onrender.com/health`
   * **Monitoring Interval**: Set to **`5 minutes`** (must be **under 15 minutes** to prevent sleep).
   * **Monitor Timeout**: `30 seconds`
4. Click **Create Monitor**.

> [!TIP]
> **Dual Benefit (Keepalive + Failure Alerting)**:
> In addition to preventing Render from going to sleep, our [`/health`](#15-unified-http-server-live-health-checks--remote-restart) endpoint returns **`503 Service Unavailable`** if the Telegram polling loop ever drops. UptimeRobot will immediately catch the 503 response and notify you via email or push notification!

---

### 1.7 Self-Healing Polling Watchdog & Container Auto-Recovery

In long-running production deployments (24/7 on Render or Docker), Telegram long-polling can occasionally stall due to transient upstream network disconnects, TCP keepalive timeouts, or temporary instance concurrency conflicts (`409 Conflict: terminated by other getUpdates request`).

To achieve 99.99% unattended uptime, the bot implements a dual-layer watchdog architecture:

```
                    ┌────────────────────────────────────────┐
                    │      Active Watchdog (Every 15s)       │
                    └───────────────────┬────────────────────┘
                                        │
                         Check: bot.isRunning() == true?
                                        │
                       ┌────────────────┴────────────────┐
                       ▼ YES                             ▼ NO (Dead)
                 [Reset Counter]               [Increment Dead Checks]
                                                         │
                                               3 Dead Checks (>45s)?
                                                         │
                                                         ▼
                                            process.exit(1) (Crash-Only)
                                                         │
                                                         ▼
                                          Docker / Render Instantly Respawns
                                          Fresh Container with Clean Sockets
```

1. **Watchdog Supervisor Timer**: Every 15 seconds, a supervisor interval checks whether `bot.isRunning()` is true. If polling remains dead for 3 consecutive cycles (>45 seconds), it invokes `process.exit(1)`. Cloud runtimes detect the exit and immediately launch a fresh container with clean memory and new network sockets.
2. **Unbroken Polling Loop**: Unlike default implementations that break upon loop completion, the runner restarts polling if it ever resolves cleanly without an explicit shutdown flag.
3. **Internal AbortController Recycling**: When restarting Grammy polling after an error or conflict, internal abort controllers and running flags are reset to prevent `Error: Aborted delay` rejections.
4. **Instant In-Chat `/reboot` Command**: If you ever need to force a fresh restart from mobile, typing `/reboot` directly in Telegram restarts the cloud container in 15–20 seconds.

---

## 🎙️ Part 2: Command Architecture, Voice Understanding & Spoken Replies

This section covers setting up command autocomplete menus, processing audio voice notes, and establishing real-time duplex voice conversations.

### 2.1 Scalable Command Routing & Autocomplete Menus

When users open the bot and type `/`, Telegram displays an interactive command palette with descriptions.

#### How to Register Commands in Telegram:
In [`./bot.js`](./bot.js), we define and register the command list on startup:
```javascript
const botCommands = [
  { command: 'agent', description: '🤖 Autonomous task with terminal, files, and research' },
  { command: 'spec', description: '💻 View detailed laptop hardware specs (CPU, GPU, RAM, Disks)' },
  { command: 'status', description: '📊 System health, hardware status, and cloud bot uptime' },
  { command: 'live', description: '🎙️ Toggle voice reply mode (spoken audio responses)' },
  { command: 'call', description: '📞 Live duplex real-time voice call WebApp' },
  { command: 'storage', description: '☁️ Cloud Vault & local storage hub' },
  { command: 'library', description: '📁 Browse saved files categorized A-Z' },
  { command: 'directory', description: '📁 Set or view your local project folder path' },
  { command: 'clear', description: '🧹 Clear recent chat history' }
];

await bot.api.setMyCommands(botCommands);
await bot.api.setMyCommands(botCommands, { scope: { type: 'all_private_chats' } });
```

---

### 2.2 Voice Note Capture & Audio Processing

When a user speaks into Telegram, the app delivers a `.oga` (Ogg Opus) audio payload. The bot downloads the audio directly into memory:

```javascript
bot.on('message:voice', async (ctx) => {
  await ctx.replyWithChatAction('typing');
  const file = await ctx.getFile();
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  
  const response = await fetch(fileUrl);
  const audioBuffer = Buffer.from(await response.arrayBuffer());

  // Pass buffer to transcription
  const transcription = await transcribeAudioWithGemini(audioBuffer, 'audio/ogg');
  
  // Forward transcription to conversational brain
  await handleUserMessage(ctx, transcription);
});
```

---

### 2.3 Multimodal Voice-to-Text Transcription via Gemini

Instead of maintaining heavy local Python Whisper models or FFmpeg binaries, we use **Google Gemini 3.8 Flash** via [`@google/genai`](./gemini-live-service.js) for sub-second, highly accurate audio transcription:

```javascript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function transcribeAudioWithGemini(buffer, mimeType = 'audio/ogg') {
  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: [
      {
        parts: [
          {
            inlineData: {
              data: buffer.toString('base64'),
              mimeType: mimeType,
            },
          },
          {
            text: 'Transcribe this voice note verbatim. Output ONLY the raw transcript without notes or commentary.',
          },
        ],
      },
    ],
  });
  return response.text.trim();
}
```

---

### 2.4 Natural Spoken Audio Responses (`/live` Mode)

Users can type `/live` in Telegram to toggle spoken replies. When `/live` is active:
1. Claude or Gemini generates the conversational reply text.
2. The bot synthesizes realistic speech using the Gemini TTS API.
3. The generated audio buffer is transmitted back to Telegram via `ctx.replyWithVoice`:

```javascript
if (userLiveMode.get(ctx.from.id)) {
  const speechBuffer = await synthesizeSpeechWithGemini(replyText, userVoicePersona.get(ctx.from.id) || 'Kore');
  await ctx.replyWithVoice(new InputFile(speechBuffer, 'response.ogg'));
} else {
  await ctx.reply(replyText, { parse_mode: 'Markdown' });
}
```

---

### 2.5 Real-Time Bidirectional Duplex Voice Calls (`/call`)

For hands-free conversational interaction while driving, walking, or coding, the bot features a duplex voice calling WebApp powered by Gemini Live:
* **Launch**: Tap `/call` in chat to open the full-screen Telegram WebApp.
* **Audio Input**: The Web Audio API captures microphone audio as 16kHz PCM chunks and streams them via WebSocket.
* **Audio Output**: Incoming audio chunks from Gemini Live are queued and played back seamlessly in the browser.
* **Voice Personas (`/voice`)**: Allows users to switch expressive voices (*Aoede, Charon, Fenrir, Kore, Puck*).

---

## 🧠 Part 3: The Google Gemini Engine (with Optional Claude Hybrid Mode), Token Management & File Organization

This section covers configuring Google Gemini as your primary all-in-one AI engine, managing conversation context budgets, and optionally setting up hybrid Claude Sonnet 5.5 operation.

### 3.1 Native Google Gemini Engine (with Optional Hybrid Dual-Brain)

The bot runs 100% natively on **Google Gemini** as a unified AI brain for conversation, multimodal reasoning, tool calling, and live duplex audio:

| Feature / Task | Primary Model | Key Strengths |
| :--- | :--- | :--- |
| **Conversational Chat & Code** | `gemini-3.8-flash` (auto-fallback to `3.5-flash` / `3.5-flash-lite`) | High-speed reasoning, 1M+ token context window, precise code generation, and automatic resilience against demand spikes. |
| **Multimodal Vision & Documents** | `gemini-3.8-flash` | Native photo/screenshot inspection and direct PDF OCR extraction. |
| **Real-Time Spoken Audio** | `gemini-3.8-live` | Expressive spoken voice note replies (`/live`) and sub-second bidirectional duplex calling (`/call`). |
| **Live Web Grounding & Search** | Gemini Web Grounding + Google Search | Real-time factual web verification, YouTube search, and structured research. |
| **Image Generation** | `gemini-nano-banana-2.1` | Instant on-demand image synthesis directly inside Telegram via `/image`. |

#### Primary Configuration (Gemini-First) in `.env`:
Only a single Gemini API key is needed to run the entire bot:
```env
# Google Gemini Configuration (Required)
GEMINI_API_KEY="AIzaSy..."
GEMINI_MODEL="gemini-3.8-flash"

# Storage Directory Configuration (defaults to ./)
STORAGE_DIR="./"
```

---

#### 🔀 Optional Hybrid Mode: Anthropic Claude Sonnet 5.5 + Gemini

If you have an Anthropic Claude API key and prefer using **Claude Sonnet 5.5** for general conversational chat and coding while keeping Gemini for voice notes, live duplex calls, and web search, you can enable the optional hybrid mode:

1. In your `.env` file (or Render/hosting dashboard), configure:
```env
# Enable Optional Hybrid Mode
AI_PROVIDER="hybrid"

# Anthropic Claude Configuration (Optional)
ANTHROPIC_API_KEY="sk-ant-api03-..."
ANTHROPIC_BASE_URL="https://api.anthropic.com"
ANTHROPIC_MODEL="claude-sonnet-5-5"
ANTHROPIC_MAX_TOKENS=20000

# Google Gemini Configuration (Required for voice, search, image & agent tools)
GEMINI_API_KEY="AIzaSy..."
```

2. **How Hybrid Mode Operates**:
   * **General Chat & Code**: Routed to Claude Sonnet 5.5 for nuanced logic and deep coding discussion.
   * **Spoken Voice Notes & Duplex Calls**: Handled by Gemini 3.8 Live (`/live` and `/call`).
   * **Web Search Grounding & Deep Research**: Grounded via Gemini with live citation links.
   * **Image Generation**: Created on demand via Gemini Nano Banana (`/image`).
   * **Automatic Quota & Outage Fallback**: If your Claude API key expires, encounters rate limits, or suffers an outage, the bot automatically and seamlessly falls back to Gemini 3.8 Flash so your chats are never interrupted!

---

#### 🧠 Integrating Gemini Pro & Argon Models (Pay-As-You-Go / Upgraded Quotas)

> [!NOTE]
> **Standard Free-Tier Key Note**: Standard / Free-tier API keys generated from [Google AI Studio](https://aistudio.google.com) do **not** support Gemini Pro models or specialized preview models (e.g. Argon) — they have a strict 0–2 RPM limit that triggers `429 Quota Exhausted` or `404 Model Not Found`. By default, this bot is configured out-of-the-box for the 100% free, high-throughput **Flash family** (`gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`).

If your API key is linked to a Google Cloud project with **Pay-As-You-Go billing enabled**, or you have enterprise/whitelist access to Pro and specialized preview tiers (such as **Gemini 3.1 Pro** or experimental models like **Argon**), here is how to set them up:

1. **Option 1: Set `GEMINI_MODEL` via Environment Variable (Zero Code Changes)**:
   In your `.env` file or hosting environment variables (e.g. Render dashboard), specify your model ID:
   ```env
   GEMINI_MODEL="gemini-3.1-pro"        # or your authorized Argon / Pro model name
   ```
   The bot will immediately use it as your default conversation and coding engine.

2. **Option 2: Switch Models Dynamically in Telegram**:
   You can switch models on the fly directly in chat without restarting the bot:
   ```text
   /model gemini-3.1-pro
   ```
   *(Or `/model <your-argon-model-id>`)*

3. **Option 3: Add to the Interactive Telegram Keyboard (`bot.js`)**:
   If you want your model to appear as a one-tap button inside the `/model` menu, open [`bot.js`](./bot.js) and add the model object to `SUPPORTED_MODELS`:
   ```javascript
   {
     id: 'gemini-3.1-pro', // or your authorized Argon model string
     name: 'Gemini 3.1 Pro',
     provider: 'gemini',
     icon: '🧠',
     badge: 'Pro Tier',
     description: 'Complex reasoning and heavy logic (Requires Pay-As-You-Go key).',
     supportedEfforts: ['low', 'medium', 'high'],
   },
   ```
   And add it to `candidateGeminiModels`:
   ```javascript
   const candidateGeminiModels = [
     DEFAULT_GEMINI_MODEL,
     'gemini-3.1-pro',
     'gemini-3.8-flash',
     'gemini-3.5-flash',
     'gemini-3.5-flash-lite',
   ].filter(Boolean);
   ```

---

### 3.2 Token Budgeting & Sliding Context Window

Without active context management, conversation history rapidly balloons, causing high API costs and latency. We implemented a multi-stage budgeting system:

1. **Message Count Cap (`MAX_HISTORY_MESSAGES = 50`)**: Keeps the conversation context within the last 25 turns.
2. **Session Expiration (`CONVERSATION_SESSION_TIMEOUT_HOURS = 24`)**: If the user is inactive for more than 24 hours, the session history resets automatically.
3. **Sliding Truncation**: When history exceeds token boundaries, older turns are pruned while preserving system prompts and the active document context:
   ```javascript
   function trimHistory(history, maxTokens = 12000) {
     while (history.length > 2 && estimateTokenCount(history) > maxTokens) {
       history.splice(0, 2); // Remove oldest user + assistant pair
     }
     return history;
   }
   ```

---

### 3.3 Document Parsing Engine (PDF, Text, Code)

When you send a file to the bot in Telegram:
* **PDFs**: Extracted automatically using `pdf-parse` into structured text and stored in session memory.
* **Source Code (`.py`, `.js`, `.json`, `.md`, `.sql`)**: Read directly as UTF-8 text with syntax highlighting tags.
* **Interactive Quizzes (`/quiz`)**: Load any lecture note or source code file and type `/quiz` — the bot generates an interactive 5-question multiple-choice quiz testing your comprehension.

---

### 3.4 A-Z Categorization & Interactive Library (`/library`)

Files uploaded or synced from the laptop are organized into standard categories:
* 📄 **Documents**: `.pdf`, `.docx`, `.txt`, `.md`
* 💻 **Code & Scripts**: `.py`, `.js`, `.ts`, `.html`, `.css`, `.json`, `.sql`
* 📊 **Data & Sheets**: `.csv`, `.xlsx`, `.sqlite`, `.db`
* 🎨 **Media & Images**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.mp3`, `.wav`

The `/library` command provides an interactive BotFather-style inline keyboard allowing users to browse their storage alphabetical index (A-Z), inspect file sizes, preview contents, rename files, or delete them remotely.

---

### 3.5 Telegram Cloud Vault with Pinned Index Recovery

Cloud hosts like Render use ephemeral filesystems — whenever code is redeployed or containers restart, locally stored files are wiped.

#### The Solution: Free Permanent Storage via Telegram Cloud Vault
1. When a file is uploaded, the bot forwards it to Telegram's cloud storage and records its permanent `file_id`.
2. The index is serialized into a compact JSON payload (`VAULT_DATA`) and pinned in the user's private chat.
3. On every container reboot, `restoreVaultFromTelegram()` inspects the pinned message, instantly recovering the full file registry, user settings, and local directory configurations!

---

## 💻 Part 4: Remote Hardware Monitoring & Live Multi-User Agent Fleet

This section walks through connecting your physical laptop to the bot using a secure outbound WebSocket tunnel, enabling live `/spec` inspections and remote execution.

### 4.1 The Outbound-Only WebSocket Reverse Tunnel

Traditional remote access methods require opening inbound ports, configuring dynamic DNS, or paying for third-party VPNs. If your laptop is on a mobile hotspot, corporate network, or public Wi-Fi, inbound connections are blocked by Carrier-Grade NAT (CGNAT).

**Our Outbound Reverse-Tunnel Architecture**:
1. When your laptop boots, [`./laptop-runner.js`](./laptop-runner.js) initiates an **outgoing** WebSocket connection (`wss://`) to the Cloud Bot Engine.
2. Firewalls and routers permit outbound HTTPS/WSS traffic without special configuration.
3. The Cloud Bot keeps the tunnel open. When you send `/agent` or `/spec` in Telegram, the cloud server dispatches RPC tasks down through the established tunnel.
4. **High-Frequency Keepalive Heartbeat**: To prevent cloud reverse proxies (like Render) from closing idle TCP sockets after 10–15 seconds of inactivity, [`./laptop-runner.js`](./laptop-runner.js) emits keepalive pings every **5 seconds**, and the server sends pings every **10 seconds**.
5. **Zero-Configuration Handshake Negotiation**: The runner and server authenticate via `LAPTOP_RUNNER_SECRET`. If omitted from `.env`, both seamlessly derive the identical secret from `TELEGRAM_BOT_TOKEN.slice(0, 20)`, guaranteeing matching credentials out-of-the-box.
6. **Security**: No open ports on your PC, secret handshake token verification, and strict user whitelist checks.

```
[Your Laptop] ──(Outbound WSS:443)──► [Cloud Bot on Render] ◄──(HTTPS)── [Telegram App]
```

---

### 4.2 Comprehensive Laptop Hardware & Spec Inspector (`/spec`)

Sending `/spec` queries live hardware metrics from the laptop daemon in real-time:
* **Processor (CPU)**: Model name, architecture, active core/thread count, and base clock frequency.
* **Dual GPU Detection**: Queries `Win32_VideoController` to detect both integrated and dedicated graphics (e.g., *AMD Radeon Graphics + NVIDIA GeForce RTX 3060 Laptop GPU*).
* **Memory (RAM)**: Real-time calculation of Total, Used, and Free RAM with usage percentage.
* **Power & Battery**: Queries `Win32_Battery` to report remaining charge percentage.
* **Storage Drives**: Calculates total capacity and free gigabytes across all mounted physical drives (`C:`, `D:`).
* **Offline Resilience**: If the laptop is asleep or restarting, the bot automatically serves the last reported hardware profile with a `🟡 Offline / Cached` indicator.

---

### 4.3 Multi-User Fleet Monitoring (`/devices`, `/status`)

For shared workspaces or team setups, the bridge supports multiple concurrent devices and users:
* Each connected machine registers its own `hostname`, `deviceName`, and `userId`.
* Sending `/devices` lists all authorized members and shows who has an active laptop runner online.
* Sending `/status` displays the caller's live laptop specs, other team members' devices, active storage directories, loaded documents, and cloud bot memory health.

---

### 4.4 Installing and Daemonizing the Local Runner (PM2 vs Silent VBScript)

The local runner should run permanently in the background without cluttering your desktop with open terminal windows. Scripts resolve paths dynamically relative to their own location using `%~dp0`:

#### Method 1: PM2 Process Manager (Recommended for Developers)
```powershell
# Install PM2 globally
npm install -g pm2

# Start the agent in the background (relative to project folder)
cd <your-project-folder>
pm2 start laptop-runner.js --name "telegram-agent"
pm2 save

# Management Shortcuts:
# • ./pm2-status.bat  -> View status & RAM usage
# • ./pm2-logs.bat    -> View real-time RPC logs
# • ./pm2-stop.bat    -> Stop the agent
```

#### Method 2: Silent VBScript Launcher (Zero Terminal Windows)
For users who do not want to install PM2, [`./start_silent.vbs`](./start_silent.vbs) dynamically resolves its current directory using `fso.GetParentFolderName(WScript.ScriptFullName)` and launches [`./run.bat`](./run.bat) in completely hidden window mode (`0`):
```vbscript
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = currentDir
WshShell.Run Chr(34) & currentDir & "\run.bat" & Chr(34), 0, False
Set WshShell = Nothing
```
Double-clicking [`./start_silent.vbs`](./start_silent.vbs) launches the agent with **zero CMD or terminal windows visible**.

#### Method 3: Interactive Launcher with Handshake Verification (`./start-agent.bat`)
[`./start-agent.bat`](./start-agent.bat) checks for Node.js, auto-installs missing dependencies (`ws`, `dotenv`), launches the silent background runner, and waits for a confirmed server handshake before quietly closing its terminal:
```cmd
start-agent.bat
```

#### Method 4: Permanent Windows Boot Autostart (`./Enable-Laptop-Agent.bat`)
To ensure your laptop connects to Telegram automatically whenever you turn on your computer:
* Double-click [`./Enable-Laptop-Agent.bat`](./Enable-Laptop-Agent.bat) to register the silent runner in your Windows Startup directory.
* To turn it off anytime, double-click [`./Disable-Laptop-Agent.bat`](./Disable-Laptop-Agent.bat) or send `/kill_runner` in Telegram.

#### Method 5: Simple Foreground Batch Runner (`./run.bat`)
For instant interactive debugging in an active command prompt:
```cmd
@echo off
cd /d "%~dp0"
node laptop-runner.js
```

---

### 4.5 Natural Language Hardware & Sensor Query Routing

You do not need to remember exact slash commands. If you type:
* *"check my cpu and gpu temperature"*
* *"how is my cpu doing?"*
* *"what are my hardware specs?"*
* *"laptop battery"*

The bot's text dispatcher intercepts the phrase and automatically invokes [`handleSpecCommand`](#42-comprehensive-laptop-hardware--spec-inspector-spec) to return your live hardware specs!

---

## 🛠️ Part 5: Agent Optimization, Interactive Code Review & Security Boundaries

This section details the autonomous agent loop, file management safety patterns, directory persistence, and remote kill controls.

### 5.1 Autonomous Tool-Calling Agent (`/agent`) & Safety Boundaries

The `/agent` command transforms the bot into an autonomous problem-solving agent with eight live tools:
1. **`list_open_windows`**: Enumerates all currently visible desktop applications and browser windows (e.g., Brave, Chrome, Roblox, Steam, VS Code, Discord, Terminal) with their process names and titles.
2. **`take_screenshot(window_title, caption)`**: Captures a live screenshot of the laptop screen or a targeted application window and delivers the photo directly to Telegram. Uses native Win32 window focus without altering or minimizing windows.
3. **`run_laptop_terminal(command, cwd)`**: Executes shell commands on your physical machine with live streaming progress updates, detached GUI/TUI launching, and silent package installation enforcement (180s for installs, 60s for standard commands).
4. **`read_laptop_file(file_path, max_lines)`**: Reads file contents from disk.
5. **`write_laptop_file(file_path, content)`**: Writes or patches files directly.
6. **`list_laptop_files(dir_path)`**: Lists files and folders.
7. **`get_laptop_status()`**: Inspects hardware specs, battery, and thermals.
8. **`request_laptop_approval(title, message, action_payload)`**: Prompts for user verification when security or installation dialogs appear.

#### 🛡️ Autonomous Safety & Defense-in-Depth for Remote Execution
Allowing an AI model to execute terminal commands requires strict security boundaries to prevent accidental damage, prompt injection, or malicious execution:

1. **User ID Authentication Gatekeeper**:
   Only messages from authorized, whitelisted Telegram User IDs (`ALLOWED_USER_ID`) can invoke `/agent`. Unauthorized requests are dropped silently before reaching any AI model or runner.

2. **Destructive Command Blacklisting & Pattern Matching**:
   [`./laptop-runner.js`](./laptop-runner.js) enforces defensive regex checks before executing any command. High-risk destructive commands (such as `format <drive>:`, `diskpart`, `mkfs`, recursive drive wipes like `rmdir /s /q C:\` or `del /f /s /q C:\`, and system shutdowns) are intercepted and rejected immediately with an execution error returned to Telegram.

3. **Strict Execution Timeouts (60s–180s) & Detached GUI Spawning**:
   Every CLI command dispatched to PowerShell is wrapped with an execution timeout (`180s` for package installers like `winget`, `npm`, `pip`; `60s` for standard commands) and non-interactive stdio (`stdio: ['ignore', 'pipe', 'pipe']`). Any command that spawns interactive TUIs or GUI desktop windows (e.g. `start ...`, `start wt`, `yazi`) is automatically launched detached with `child.unref()` so child processes never freeze the runner tunnel.

4. **Real-Time Terminal Streaming & Progress Updates**:
   While long-running commands or installations run, `laptop-runner.js` sends `COMMAND_PROGRESS` WebSocket frames every 2 seconds containing the most recent terminal output. The bot throttles updates to 1500ms to respect Telegram rate limits and renders the live progress cleanly in chat.

5. **Mid-Task Concurrent Checks & Immediate Cancellation**:
   If you send a follow-up message while a task is running (e.g. *"take a screenshot of the progress"*), the bot immediately answers concurrent queries and injects the follow-up instruction into the agent's next step. Send `/stop` or `/abort` anytime to halt execution immediately.

4. **Directory Sandboxing & Path Traversal Prevention**:
   Remote file reads, writes, and deletions requested by the agent are restricted using path normalization (`path.resolve()`). The runner explicitly verifies that resolved targets do not point into protected operating system roots (e.g. `C:\Windows`, `System32`), preventing directory traversal attacks (`../../Windows/System32`).

5. **Live Tool Audit Trail in Telegram Chat**:
   The Telegram interface renders verified status badges for every autonomous tool executed (`🛠️ Autonomous tools executed: • run_laptop_terminal • read_laptop_file`). You can always see exactly what commands were run, their parameters, and their exit status in real-time.

---

### 5.2 The "Hold-in-Memory" Safety Pattern for Generated Code

To prevent AI from accidentally overwriting production files when writing new standalone code, we implemented an interactive code review pipeline:
1. When new code is generated, the agent **does not write directly to disk**.
2. It caches the code buffer in memory and presents an interactive Telegram inline menu:
   * **`[ 📁 Target Folder ]`**: Saves to your configured project folder.
   * **`[ 🖥️ Desktop ]`**: Saves directly to `%USERPROFILE%\Desktop`.
   * **`[ ☁️ Cloud Vault ]`**: Uploads only to Telegram Cloud (0 local disk usage).
   * **`[ ✏️ Custom Path ]`**: Prompts you to specify an exact relative or absolute file path.
   * **`[ ❌ Discard ]`**: Discards the generated buffer safely.

---

### 5.3 Permanent 4-Layer Directory Persistence

One of the most persistent challenges in cloud-hosted bots is remembering user directory settings when containers reset. We solved this with a 4-layer fallback architecture:

```
[Layer 1: Runtime Memory] ──► [Layer 2: Local & Default JSON] ──► [Layer 3: Telegram Pinned Sync] ──► [Layer 4: Runner Handshake]
Checked first             Fallback if container restarts      Restores from chat pinned index     Syncs laptop folder on connect
```

* **Setting Directory in Chat**: Type `/directory <path>` (e.g. `/directory C:\projects\my-app` or `/directory ./my-project`) in Telegram.
* **Default Config File**: [`./default_user_settings.json`](./default_user_settings.json) is committed to git as a clean template so fresh cloud instances boot properly.
* **Handshake Sync**: Whenever `laptop-runner.js` connects, it passes its local working folder in the query parameters (`storageDir`), which the cloud server automatically registers.
* **Result**: The bot **never forgets your path**, even when the agent is disconnected or offline.

---

### 5.4 One-Click Desktop Controls & Remote Kill Switch

Total user control over when the laptop agent is running:
* **Desktop Shortcuts**:
  * [**`./Disable-Laptop-Agent.bat`**](./Disable-Laptop-Agent.bat): Kills the running node runner and removes Windows Startup / Registry auto-run entries.
  * [**`./Enable-Laptop-Agent.bat`**](./Enable-Laptop-Agent.bat): Restores auto-run and starts the background runner.
* **Telegram Remote Kill**:
  * In Telegram `/status`, tap **`[ 🛑 Disable Laptop Agent ]`** or type `/disable_laptop` to shut down the runner on your laptop remotely from your phone.

---

### 5.5 Interactive In-Chat File Renaming (`userAwaitingRename`)

Users can manage and organize assets stored in either Telegram Cloud Vault or their physical laptop directly inside the Telegram chat UI:
1. In `/storage` or `/library`, tapping **`[ ✏️ Rename ]`** under any file triggers an interactive session via an in-memory tracking map (`userAwaitingRename`):
   ```javascript
   const userAwaitingRename = new Map(); // userId -> { source: 'cloud' | 'laptop', idx, oldName, fullPath }
   ```
2. The user is prompted to reply with the desired new filename:
   * **Cloud Vault files**: The JSON index metadata, file extension, and category are updated and automatically synced to the Telegram pinned backup message.
   * **Laptop files**: A remote task (`rename`) is transmitted over the WebSocket tunnel to `laptop-runner.js`, which atomically renames the physical file on the Windows/Linux/macOS filesystem using Node's `fs.promises.rename`.
3. Sending `/cancel` at any point cleanly discards the rename prompt.

---

### 5.6 Command Autocomplete Reference Table

| Command | Category | Functionality |
| :--- | :--- | :--- |
| `/model [name]` | 🤖 Engine | Switch AI model (Gemini 3.8 Flash, 3.5 Flash, 3.5 Flash-Lite) & toggle auto-fallback |
| `/effort [lvl]` | 🧠 Engine | Set Gemini thinking/reasoning effort level (`low`, `medium`, `high`, `minimal`) |
| `/plain [on/off]`| 💬 Chat | Toggle 100% plain text mode (strips markdown asterisks, hashes, and headers) |
| `/spec` | 💻 System | View complete laptop hardware specifications (CPU, dual GPUs, RAM, battery, drives) |
| `/status` | 📊 System | Check cloud bot uptime, runner connection state, and memory health |
| `/reboot` | 🔄 System | Cleanly restart the Telegram bot container process to auto-heal connections |
| `/logs` | 📋 Admin | View last 50 lines of stdout/stderr and recent crash tracebacks from phone |
| `/fix <instruction>` | 🛠️ Admin | Autonomous hot-patch with Anti-Brick syntax guard and permanent GitHub sync |
| `/devices` | 👥 Team | View all authorized users' laptops and their online status |
| `/agent <task>` | 🤖 Agent | Run autonomous tasks with live terminal tools, file editing, and research |
| `/agent_mode` | 🎚️ Agent | Toggle Agent mode as default for all messages (or `/cancel` to restore standard chat) |
| `/live` | 🎙️ Voice | Toggle spoken audio voice replies for all bot responses |
| `/call` | 📞 Voice | Launch low-latency bidirectional voice call WebApp |
| `/voice` | 🗣️ Voice | Switch Gemini Live voice persona (Aoede, Charon, Fenrir, Kore, Puck) |
| `/deep_research`| 🔬 Research | Perform exhaustive multi-source web research with synthesized report |
| `/search <query>`| 🌐 Research | Live Google Search grounding with verified citation links |
| `/youtube <query>`| 🎥 Media | Search YouTube videos, channels, and playlists |
| `/image <prompt>` | 🎨 Creative | Generate high-quality images via Gemini |
| `/storage` | ☁️ Files | Open the interactive Cloud Vault & local storage control hub |
| `/directory [path]`| 📁 Files | View or update your laptop's target project directory |
| `/library` | 📁 Files | Browse files stored locally or in Cloud Vault sorted A-Z |
| `/quiz` | 📝 Learning | Generate an interactive multiple-choice quiz on any loaded document |
| `/save [path]` | 💾 Files | Accept and save pending generated code to disk |
| `/stop` / `/abort`| 🛑 Agent | Immediately halt running agent task and clear pending execution queue |
| `/cancel` | ❌ Control | Discard pending code save, cancel directory prompt, or exit command modes |
| `/clear` | 🧹 Chat | Clear recent conversation turns while retaining loaded files |
| `/clearall` | 🗑️ Chat | Wipe all conversation history, sessions, and active documents |

---

## 📄 License & Credits

* **Creator & Maintainer**: **Din Sopheakyuth**
* **AI Architecture & Intelligence**:
  * **Google Gemini & Google DeepMind**: For powering conversational reasoning, multimodal vision, voice comprehension, Gemini 3.8 Flash / Live APIs, live search grounding, ideation, and architectural solutions throughout the development lifecycle.
  * **Anthropic Claude (Optional Hybrid)**: For powering deep reasoning, nuanced conversation, and software engineering capabilities via Claude Sonnet 5.5 when hybrid mode is enabled.
  * **Antigravity (Google DeepMind)**: For autonomous pair-programming and rapid development assistance.

Licensed under the [MIT License](LICENSE).
