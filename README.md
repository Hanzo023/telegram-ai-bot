# 🤖 Telegram AI Bot & Autonomous Remote Agent Guide

> A comprehensive, battle-tested engineering blueprint for building a private, production-ready AI companion on Telegram powered by **Anthropic Claude Sonnet 5.5** and **Google Gemini 3.8 Flash**. This guide details everything developed inside `D:\projects\telegram-ai-bot`: from the initial webhook chatbot to multimodal voice comprehension, hybrid Claude + Gemini model orchestration, token optimization, Telegram Cloud Vault document sorting, and an outbound reverse-tunnel remote agent that monitors your laptop hardware and executes terminal commands securely from anywhere in the world.

---

## 📑 Table of Contents

- [Architectural Overview](#-architectural-overview)
- [Part 1: Setting Up the Telegram Bot Foundation](#-part-1-setting-up-the-telegram-bot-foundation)
  - [1.1 Creating the Bot with BotFather](#11-creating-the-bot-with-botfather)
  - [1.2 Telegram User ID Discovery & Security Whitelisting](#12-telegram-user-id-discovery--security-whitelisting)
  - [1.3 Project Initialization & Framework Selection](#13-project-initialization--framework-selection)
  - [1.4 Webhook vs Long-Polling on Cloud Providers](#14-webhook-vs-long-polling-on-cloud-providers)
  - [1.5 Unified HTTP Server & Health Checks](#15-unified-http-server--health-checks)
- [Part 2: Command Architecture, Voice Understanding & Spoken Replies](#-part-2-command-architecture-voice-understanding--spoken-replies)
  - [2.1 Scalable Command Routing & Autocomplete Menus](#21-scalable-command-routing--autocomplete-menus)
  - [2.2 Voice Note Capture & Audio Processing](#22-voice-note-capture--audio-processing)
  - [2.3 Multimodal Voice-to-Text Transcription via Gemini](#23-multimodal-voice-to-text-transcription-via-gemini)
  - [2.4 Natural Spoken Audio Responses (`/live` Mode)](#24-natural-spoken-audio-responses-live-mode)
  - [2.5 Real-Time Bidirectional Duplex Voice Calls (`/call`)](#25-real-time-bidirectional-duplex-voice-calls-call)
- [Part 3: The Hybrid Claude + Gemini Engine, Token Management & File Organization](#-part-3-the-hybrid-claude--gemini-engine-token-management--file-organization)
  - [3.1 Why a Dual-Brain Engine? (Claude Sonnet 5.5 + Gemini 3.8 Flash)](#31-why-a-dual-brain-engine-claude-sonnet-55--gemini-38-flash)
  - [3.2 Token Budgeting & Sliding Context Window](#32-token-budgeting--sliding-context-window)
  - [3.3 Document Parsing Engine (PDF, Text, Code)](#33-document-parsing-engine-pdf-text-code)
  - [3.4 A-Z Categorization & Interactive Library (`/library`)](#34-a-z-categorization--interactive-library-library)
  - [3.5 Telegram Cloud Vault with Pinned Index Recovery](#35-telegram-cloud-vault-with-pinned-index-recovery)
- [Part 4: Remote Hardware Monitoring & Live Multi-User Agent Fleet](#-part-4-remote-hardware-monitoring--live-multi-user-agent-fleet)
  - [4.1 The Outbound-Only WebSocket Reverse Tunnel](#41-the-outbound-only-websocket-reverse-tunnel)
  - [4.2 Comprehensive Laptop Hardware & Spec Inspector (`/spec`)](#42-comprehensive-laptop-hardware--spec-inspector-spec)
  - [4.3 Multi-User Fleet Monitoring (`/devices`, `/status`)](#43-multi-user-fleet-monitoring-devices-status)
  - [4.4 Installing and Daemonizing the Local Runner (PM2 vs Silent VBScript)](#44-installing-and-daemonizing-the-local-runner-pm2-vs-silent-vbscript)
- [Part 5: Agent Optimization, Interactive Code Review & Fine-Tuning](#-part-5-agent-optimization-interactive-code-review--fine-tuning)
  - [5.1 Autonomous Tool-Calling Agent (`/agent`)](#51-autonomous-tool-calling-agent-agent)
  - [5.2 The "Hold-in-Memory" Safety Pattern for Generated Code](#52-the-hold-in-memory-safety-pattern-for-generated-code)
  - [5.3 Permanent 4-Layer Directory Persistence](#53-permanent-4-layer-directory-persistence)
  - [5.4 One-Click Desktop Controls & Remote Kill Switch](#54-one-click-desktop-controls--remote-kill-switch)
  - [5.5 Command Autocomplete Reference Table](#55-command-autocomplete-reference-table)

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
                      │  • Claude Sonnet 5.5 (Reasoning & Code)      │
                      │  • Gemini 3.8 Flash (Voice, Search, Tools)   │
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

### 1.1 Creating the Bot with BotFather
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Start the chat and issue the command:
   ```text
   /newbot
   ```
3. Follow the interactive prompts to assign:
   * **Display Name**: E.g., `My Autonomous AI Assistant`
   * **Username**: Must end with `bot` (e.g., `my_private_ai_bot`)
4. BotFather returns an HTTP API token formatted like:
   `8758364117:AAHIOxa7vOmFgNCbLKEXRUyI8IJ_kL8XqTk`
   *Save this token securely — it is your `TELEGRAM_BOT_TOKEN`.*

### 1.2 Telegram User ID Discovery & Security Whitelisting
Because your bot will possess remote execution and personal file access capabilities, **never leave it open to the public**. Implement a strict ID whitelist from day one:
1. Message [@userinfobot](https://t.me/userinfobot) on Telegram.
2. Note your numerical ID (e.g., `8199950189`).
3. In your configuration, support comma-separated multi-user authorization:
   ```javascript
   const rawAllowed = process.env.ALLOWED_USER_ID || '';
   const allowedUserIds = new Set(
     (rawAllowed.match(/-?\d+/g) || []).map((id) => parseInt(id, 10))
   );

   bot.use(async (ctx, next) => {
     const senderId = ctx.from?.id;
     if (!senderId || !allowedUserIds.has(senderId)) {
       console.warn(`[Security] Blocked unauthorized access attempt from ID: ${senderId}`);
       return; // Silently drop or reply with an unauthorized message
     }
     await next();
   });
   ```

### 1.3 Project Initialization & Framework Selection
We chose **grammY** over legacy frameworks (`node-telegram-bot-api` or `telegraf`) for its native TypeScript support, modern async middleware pipeline, built-in concurrency control, and zero-overhead WebApp support.

Initialize the project with ES Modules:
```bash
npm init -y
npm install grammy @anthropic-ai/sdk @google/genai dotenv ws pdf-parse
```

Ensure `"type": "module"` is set in `package.json`:
```json
{
  "name": "telegram-ai-bot",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node bot.js",
    "laptop": "node laptop-runner.js"
  }
}
```

### 1.4 Webhook vs Long-Polling on Cloud Providers
* **Local Development**: Long-polling (`bot.start()`) is ideal because you do not need a domain name or SSL certificate.
* **Production on Cloud (Render, Fly.io, Railway)**: Cloud hosts require binding to an HTTP port (`$PORT`) to keep containers alive and pass health checks. Use grammY's built-in `webhookCallback`:

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

### 1.5 Unified HTTP Server & Health Checks
Mounting a `/health` endpoint serves two crucial purposes:
1. **Cloud Keepalive**: Free/Standard cloud tiers (such as Render) require continuous HTTP pinging or activity to prevent cold-sleeps.
2. **Reverse Proxy Tunnel Endpoint**: The same HTTP server is upgraded to handle WebSocket connections (`/ws/laptop-agent`), unifying webhooks, health probes, and remote agent tunnels under a single port.

---

## 🎙️ Part 2: Command Architecture, Voice Understanding & Spoken Replies

### 2.1 Scalable Command Routing & Autocomplete Menus
Telegram bots can automatically register their autocomplete menu with the Telegram API so that when users type `/`, a rich cheat-sheet with descriptions appears:

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

### 2.2 Voice Note Capture & Audio Processing
When a user sends a voice message, Telegram delivers a `.oga` (Ogg Opus) audio file. The bot downloads the audio stream directly into memory:

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

### 2.3 Multimodal Voice-to-Text Transcription via Gemini
We use **Google Gemini 3.8 Flash** for transcription due to its sub-second latency and zero external dependency footprint (avoiding heavyweight local Python Whisper builds):

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

### 2.4 Natural Spoken Audio Responses (`/live` Mode)
Users can toggle `/live` to receive spoken replies rather than text blocks. When `/live` is active:
1. Claude or Gemini generates the conversational reply text.
2. The bot synthesizes speech using the Gemini Text-to-Speech API.
3. The resulting audio buffer is transmitted back to Telegram via `ctx.replyWithVoice`:

```javascript
if (userLiveMode.get(ctx.from.id)) {
  const speechBuffer = await synthesizeSpeechWithGemini(replyText, userVoicePersona.get(ctx.from.id) || 'Kore');
  await ctx.replyWithVoice(new InputFile(speechBuffer, 'response.ogg'));
} else {
  await ctx.reply(replyText, { parse_mode: 'Markdown' });
}
```

### 2.5 Real-Time Bidirectional Duplex Voice Calls (`/call`)
For conversational hands-free interaction, the bot includes a Telegram WebApp that establishes a bidirectional WebSocket stream with Gemini Live:
* **Audio In**: Web Audio API captures microphone input as 16kHz PCM chunks and streams them over the WebSocket.
* **Audio Out**: Incoming audio frames from Gemini Live are queued and played back seamlessly in the browser.
* **Voice Personas (`/voice`)**: Allows users to select expressive voices (e.g., *Aoede, Charon, Fenrir, Kore, Puck*).

---

## 🧠 Part 3: The Hybrid Claude + Gemini Engine, Token Management & File Organization

### 3.1 Why a Dual-Brain Engine? (Claude Sonnet 5.5 + Gemini 3.8 Flash)
Rather than relying on a single AI provider, our architecture pairs two industry-leading models:

| Provider & Model | Primary Responsibilities | Why Selected |
| :--- | :--- | :--- |
| **Anthropic Claude Sonnet 5.5** | General chat, code generation, system architecture, document analysis | Unmatched nuance, thoughtful reasoning, low hallucination rate, and superior software engineering output. |
| **Google Gemini 3.8 Flash** | Voice transcription, audio synthesis, live Google Search grounding, image generation, fast tool execution | Ultra-fast multimodal processing, native Web search grounding, generous rate limits, and built-in TTS. |

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

### 3.3 Document Parsing Engine (PDF, Text, Code)
When users send files to the bot, it detects the file extension and extracts content automatically:
* **PDFs**: Parsed via `pdf-parse` into clean text representations.
* **Source Code (`.py`, `.js`, `.json`, `.md`, `.sql`)**: Read directly as UTF-8 text with syntax highlighting tags.
* **Interactive Quizzes (`/quiz`)**: Users can load a lecture slide or code file and type `/quiz` — the bot synthesizes an interactive 5-question multiple-choice quiz testing comprehension.

### 3.4 A-Z Categorization & Interactive Library (`/library`)
Files uploaded or synced from the laptop are organized into standard categories:
* 📄 **Documents**: `.pdf`, `.docx`, `.txt`, `.md`
* 💻 **Code & Scripts**: `.py`, `.js`, `.ts`, `.html`, `.css`, `.json`, `.sql`
* 📊 **Data & Sheets**: `.csv`, `.xlsx`, `.sqlite`, `.db`
* 🎨 **Media & Images**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.mp3`, `.wav`

The `/library` command provides an interactive BotFather-style inline keyboard allowing users to browse their storage alphabetical index (A-Z), inspect file sizes, preview contents, rename files, or delete them remotely.

### 3.5 Telegram Cloud Vault with Pinned Index Recovery
Cloud hosts like Render use ephemeral filesystems — whenever code is redeployed or containers restart, locally stored files are wiped.

**The Solution: Free Permanent Storage via Telegram Cloud Vault**
1. When a file is uploaded, the bot forwards it to Telegram's cloud storage and records its permanent `file_id`.
2. The index is serialized into a compact JSON payload (`VAULT_DATA`) and pinned in the user's private chat.
3. On every container reboot, `restoreVaultFromTelegram()` inspects the pinned message, instantly recovering the full file registry, user settings, and local directory configurations!

---

## 💻 Part 4: Remote Hardware Monitoring & Live Multi-User Agent Fleet

### 4.1 The Outbound-Only WebSocket Reverse Tunnel
Traditional remote access methods require opening inbound ports, configuring dynamic DNS, or paying for third-party VPNs. If your laptop is on a mobile hotspot, corporate network, or public Wi-Fi, inbound connections are blocked by Carrier-Grade NAT (CGNAT).

**Our Outbound Reverse-Tunnel Architecture**:
1. When your laptop boots, [`laptop-runner.js`](file:///D:/projects/telegram-ai-bot/laptop-runner.js) initiates an **outgoing** WebSocket connection (`wss://`) to the Cloud Bot Engine.
2. Firewalls and routers permit outbound HTTPS/WSS traffic without special configuration.
3. The Cloud Bot keeps the tunnel open. When you send `/agent` or `/spec` in Telegram, the cloud server dispatches RPC tasks down through the established tunnel.
4. **Security**: No open ports on your PC, secret handshake token verification, and strict user whitelist checks.

```
[Your Laptop] ──(Outbound WSS:443)──► [Cloud Bot on Render] ◄──(HTTPS)── [Telegram App]
```

### 4.2 Comprehensive Laptop Hardware & Spec Inspector (`/spec`)
Sending `/spec` queries live hardware metrics from the laptop daemon in real-time:
* **Processor (CPU)**: Model name, architecture, active core/thread count, and base clock frequency.
* **Dual GPU Detection**: Queries `Win32_VideoController` to detect both integrated and dedicated graphics (e.g., *AMD Radeon Graphics + NVIDIA GeForce RTX 3060 Laptop GPU*).
* **Memory (RAM)**: Real-time calculation of Total, Used, and Free RAM with usage percentage.
* **Power & Battery**: Queries `Win32_Battery` to report remaining charge percentage.
* **Storage Drives**: Calculates total capacity and free gigabytes across all mounted physical drives (`C:`, `D:`).
* **Offline Resilience**: If the laptop is asleep or restarting, the bot automatically serves the last reported hardware profile with a `🟡 Offline / Cached` indicator.

### 4.3 Multi-User Fleet Monitoring (`/devices`, `/status`)
For shared workspaces or team setups, the bridge supports multiple concurrent devices and users:
* Each connected machine registers its own `hostname`, `deviceName`, and `userId`.
* Sending `/devices` lists all authorized members and shows who has an active laptop runner online.
* Sending `/status` displays the caller's live laptop specs, other team members' devices, active storage directories, loaded documents, and cloud bot memory health.

### 4.4 Installing and Daemonizing the Local Runner (PM2 vs Silent VBScript)
The local runner should run permanently in the background without cluttering your desktop with open terminal windows. We configured two robust methods:

#### Method 1: PM2 Process Manager (Recommended for Developers)
```powershell
# Install PM2 globally
npm install -g pm2

# Start the agent in the background
cd D:\projects\telegram-ai-bot
pm2 start laptop-runner.js --name "telegram-agent"
pm2 save

# Management Shortcuts:
# • pm2-status.bat  -> View status & RAM usage
# • pm2-logs.bat    -> View real-time RPC logs
# • pm2-stop.bat    -> Stop the agent
```

#### Method 2: Silent VBScript Launcher (Zero Terminal Windows)
For users who do not want to install PM2, [`start_silent.vbs`](file:///D:/projects/telegram-ai-bot/start_silent.vbs) launches `run.bat` in completely hidden window mode (`0`):
```vbscript
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = currentDir
WshShell.Run Chr(34) & currentDir & "\run.bat" & Chr(34), 0, False
Set WshShell = Nothing
```
Double-clicking the Desktop shortcut [`Start-Silent-Agent.vbs`](file:///C:/Users/dsoph/Desktop/Start-Silent-Agent.vbs) launches the agent with **zero CMD or terminal windows visible**.

---

## 🛠️ Part 5: Agent Optimization, Interactive Code Review & Fine-Tuning

### 5.1 Autonomous Tool-Calling Agent (`/agent`)
The `/agent` command transforms the bot into an autonomous problem-solving agent with four live capabilities:
1. **PowerShell / Terminal Execution**: Can install npm/pip packages, run compilation scripts, or query system diagnostics.
2. **File System Inspection & Editing**: Can read source files, apply targeted diffs, or delete temporary assets.
3. **Live Web Research**: Uses Google Search grounding to retrieve current documentation or API changes.
4. **Multi-Step Execution Loop**: Autonomously inspects command exit codes, diagnoses error outputs, and self-corrects scripts until the task is complete.

### 5.2 The "Hold-in-Memory" Safety Pattern for Generated Code
To prevent AI from accidentally overwriting production files, we implemented an interactive code review pipeline:
1. When code is generated, the agent **does not write directly to disk**.
2. It caches the code buffer in memory and presents an interactive Telegram inline menu:
   * **`[ 📁 Target Folder ]`**: Saves to your configured project folder.
   * **`[ 🖥️ Desktop ]`**: Saves directly to your Windows Desktop.
   * **`[ ☁️ Cloud Vault ]`**: Uploads only to Telegram Cloud (0 local disk usage).
   * **`[ ✏️ Custom Path ]`**: Prompts you to specify an exact relative or absolute file path.
   * **`[ ❌ Discard ]`**: Discards the generated buffer safely.

### 5.3 Permanent 4-Layer Directory Persistence
One of the most persistent challenges in cloud-hosted bots is remembering user directory settings when containers reset. We solved this with a 4-layer fallback architecture:

```
[Layer 1: Runtime Memory] ──► [Layer 2: Local & Default JSON] ──► [Layer 3: Telegram Pinned Sync] ──► [Layer 4: Runner Handshake]
Checked first             Fallback if container restarts      Restores from chat pinned index     Syncs laptop folder on connect
```

* **Default Config File**: [`default_user_settings.json`](file:///D:/projects/telegram-ai-bot/default_user_settings.json) is committed to git so fresh cloud instances boot with correct folder knowledge.
* **Handshake Sync**: Whenever `laptop-runner.js` connects, it passes its local working folder in the query parameters (`storageDir`), which the cloud server automatically registers.
* **Result**: The bot **never forgets your path**, even when the agent is disconnected or offline.

### 5.4 One-Click Desktop Controls & Remote Kill Switch
Total user control over when the laptop agent is running:
* **Desktop Shortcuts**:
  * [**`Disable-Laptop-Agent.bat`**](file:///C:/Users/dsoph/Desktop/Disable-Laptop-Agent.bat): Kills the running node runner and removes Windows Startup / Registry auto-run entries.
  * [**`Enable-Laptop-Agent.bat`**](file:///C:/Users/dsoph/Desktop/Enable-Laptop-Agent.bat): Restores auto-run and starts the background runner.
* **Telegram Remote Kill**:
  * In Telegram `/status`, tap **`[ 🛑 Disable Laptop Agent ]`** or type `/disable_laptop` to shut down the runner on your laptop remotely from your phone.

---

### 5.5 Command Autocomplete Reference Table

| Command | Category | Functionality |
| :--- | :--- | :--- |
| `/spec` | 💻 System | View complete laptop hardware specifications (CPU, dual GPUs, RAM, battery, drives) |
| `/status` | 📊 System | Check cloud bot uptime, runner connection state, and memory health |
| `/devices` | 👥 Team | View all authorized users' laptops and their online status |
| `/agent <task>` | 🤖 Agent | Run autonomous tasks with live terminal tools, file editing, and research |
| `/agent_mode` | 🎚️ Agent | Toggle Agent mode as default for all messages (or `/cancel` to restore Claude) |
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
| `/cancel` | ❌ Control | Discard pending code save, cancel directory prompt, or exit command modes |
| `/clear` | 🧹 Chat | Clear recent conversation turns while retaining loaded files |
| `/clearall` | 🗑️ Chat | Wipe all conversation history, sessions, and active documents |

---

## 📄 License & Credits

Created and maintained by **Din Sopheakyuth** with autonomous pair-programming by **Antigravity (Google DeepMind)**.

Licensed under the [MIT License](LICENSE).
