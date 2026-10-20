# 🤖 Telegram AI Agent & Remote Laptop Bridge

> An end-to-end autonomous AI assistant on Telegram powered by **Claude 3.5 Sonnet** and **Google Gemini 2.5 Flash**, featuring bidirectional voice calls, document intelligence, live web research, and a secure **outbound reverse-tunnel remote agent** to control your local computer from anywhere in the world.

---

## 🌟 The Evolution: From Simple Chatbot to Autonomous Agent

Over a week of development, this project evolved from a basic text chatbot into a full-fledged autonomous computing companion:

```
[Day 1: Simple Bot] ────────► [Day 3: Multimodal & Voice] ────────► [Day 5: Cloud Vault & Research] ────────► [Day 7: Full Autonomous Remote Agent]
• Claude 3.5 Sonnet            • Voice note transcription           • PDF & document parsing           • Outbound WebSocket reverse tunnel
• Multi-turn chat memory       • Voice audio responses              • Telegram Cloud Vault             • Remote terminal command execution
• User whitelist security      • Real-time duplex voice calls       • Deep Research & Web Search       • Pending code review & inline save UI
                                                                                                       • Background daemon (PM2 & silent VBS)
```

### 1. 🧠 Intelligent Conversational Core
* Powered by **Anthropic Claude 3.5 Sonnet** with thoughtful, nuanced, human-like reasoning.
* **Persistent Context Management**: Multi-turn conversation sessions persisted to disk and automatically synchronized across cloud container resets.
* **Strict Whitelist Security**: Restricts access exclusively to authorized Telegram User IDs (`ALLOWED_USER_ID`), blocking unauthorized users.

### 2. 🎙️ Multimodal & Real-Time Voice
* **Voice Note Transcription**: Send any Telegram voice message or audio file — transcribed with Google Gemini.
* **Voice Audio Replies**: Toggle `/live` mode to receive voice audio responses directly in chat.
* **Live Duplex Calls (`/call`)**: Integrated Telegram WebApp with low-latency bidirectional voice communication powered by the Gemini Live API.
* **Voice Personas (`/voice`)**: Choose between expressive voices (Aoede, Charon, Fenrir, Kore, Puck).

### 3. ☁️ Telegram Cloud Vault & Document Intelligence
* **Document Parsing**: Upload PDFs, text files, Python scripts, JSON, Markdown, or spreadsheets. The bot extracts text, maintains active document context, and generates interactive quizzes (`/quiz`).
* **Telegram Cloud Vault (`/storage`)**: Free, permanent cloud storage backed by Telegram's cloud storage.
* **Ephemeral Cloud Resilience**: Automatically creates and updates a pinned vault index (`VAULT_DATA`) so file records and user settings survive ephemeral cloud resets (like Render dyno restarts).
* **Storage Modes**: `/local` (Dual sync), `/cloud` (Cloud only), and `/nosave` (Laptop only).

### 4. 🔬 Deep Research, Search & Creation
* **Live Web Grounding (`/search`)**: Real-time Google search grounding with clickable citation links.
* **Deep Research (`/deep_research`)**: Autonomous multi-step research reports synthesized across multiple search queries.
* **YouTube Discovery (`/youtube`)**: Search and discover relevant YouTube videos and channels.
* **AI Image Generation (`/image`)**: High-resolution image synthesis using Gemini.

### 5. 💻 Remote Laptop Agent & Fleet Bridge (`/agent`, `/devices`, `/status`)
* **Outbound Reverse Tunnel**: Connects your laptop to the cloud bot via a persistent outbound WebSocket (`wss://`). **Zero open ports, zero port forwarding, and fully secure on public Wi-Fi.**
* **Terminal Execution**: Run PowerShell or Bash scripts on your laptop right from Telegram (`/agent`).
* **Interactive Code Review & Pending Saves**: When code is generated, the bot holds it in state and prompts you with inline buttons (`[📁 Target Folder]`, `[🖥️ Desktop]`, `[☁️ Cloud Vault]`, `[✏️ Custom Path]`, `[❌ Discard]`) rather than blindly writing to disk.
* **Zero Terminal Footprint**: Run as a silent background daemon with PM2 or VBScript launcher. No CMD windows required.
* **Multi-User Fleet Monitoring**: Supports teams and multi-device setups — `/devices` and `/status` track each authorized user's laptop name, OS, and online state.
* **Permanent 4-Layer Memory**: Remembers your configured storage directory (`/directory`) across laptop disconnects, reboots, and cloud container redeployments.

---

## 🏗️ Architecture

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 Telegram Client (Phone / PC)            │
                  └───────────────────────────┬────────────────────────────┘
                                              │ Telegram Bot API (HTTPS)
                                              ▼
                  ┌────────────────────────────────────────────────────────┐
                  │          Cloud Bot Engine (Render / Docker Host)       │
                  │  • grammY Telegram Framework                           │
                  │  • Claude 3.5 Sonnet / Gemini 2.5 API Integrations     │
                  │  • WebSocket Tunnel Server (/ws/laptop-agent)          │
                  │  • Pinned Cloud Vault Sync & Memory Cache              │
                  └───────────────────────────┬────────────────────────────┘
                                              │
                      Outbound Secure WSS Tunnel (Reverse Connection)
                      No inbound open ports required on user machine
                                              │
                                              ▼
                  ┌────────────────────────────────────────────────────────┐
                  │           Local Laptop Agent Runner (Your PC)          │
                  │  • Background Daemon: PM2 or WMI Silent VBScript       │
                  │  • System Hardware Monitoring (CPU, RAM, Uptime)       │
                  │  • PowerShell Command Execution Engine                 │
                  │  • Direct File Read / Write / Rename / Delete API      │
                  └────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start Guide

### Step 1: Clone the Repository & Install Dependencies

```bash
git clone https://github.com/Hanzo023/telegram-ai-bot.git
cd telegram-ai-bot
npm install
```

### Step 2: Configure Environment Variables

Copy the example environment configuration:
```bash
cp .env.example .env
```

Edit `.env` with your preferred text editor:
```env
# Telegram Bot Token from @BotFather
TELEGRAM_BOT_TOKEN="1234567890:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"

# AI Model Credentials
ANTHROPIC_API_KEY="sk-ant-api03-..."
ANTHROPIC_BASE_URL="https://api.anthropic.com"
ANTHROPIC_MODEL="claude-3-5-sonnet-20241022"
GEMINI_API_KEY="AIzaSy..."

# Authorization (Your Telegram numeric user ID, find via @userinfobot)
# Supports comma-separated IDs for multiple users (e.g. 11111111,22222222)
ALLOWED_USER_ID="8199950189"

# Local Storage Directory
STORAGE_DIR="D:\\drive-download-20260715T073323Z-1-001"

# Remote Agent Bridge Configuration
SERVER_URL="https://your-bot-app.onrender.com"
LAPTOP_RUNNER_SECRET="choose_a_strong_secret_phrase"
DEVICE_NAME="My-Main-Laptop"
```

---

### Step 3: Run or Deploy the Cloud Bot

#### Option A: Local / Development
```bash
npm start
```

#### Option B: Deploy to Render (Cloud Host)
1. Push your repository to GitHub.
2. In [Render Dashboard](https://dashboard.render.com/), create a new **Web Service**.
3. Connect your repository.
4. Set:
   * **Runtime**: `Node`
   * **Build Command**: `npm install`
   * **Start Command**: `npm start`
5. In **Environment Variables**, add the variables from `.env` (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `ALLOWED_USER_ID`, `LAPTOP_RUNNER_SECRET`).
6. Deploy! Render will provide your public URL (e.g., `https://telegram-ai-bot-znei.onrender.com`).

---

### Step 4: Run the Local Laptop Agent (Background)

Choose your preferred background runner mode on your laptop:

#### Method 1: PM2 Process Manager (Recommended)
PM2 provides auto-restart on crashes and background daemonization:
```powershell
# 1. Start with PM2
pm2 start laptop-runner.js --name "telegram-agent"
pm2 save

# Helper 1-click batch files available:
# • pm2-status.bat  (View status & memory)
# • pm2-logs.bat    (View real-time logs)
# • pm2-stop.bat    (Stop the runner)
```

#### Method 2: Silent VBScript Launcher (Zero CMD Windows)
Double-click [`start_silent.vbs`](file:///D:/projects/telegram-ai-bot/start_silent.vbs) or use the Desktop shortcut [`Start-Silent-Agent.vbs`](file:///C:/Users/dsoph/Desktop/Start-Silent-Agent.vbs).
* Runs completely in the background with zero terminal windows.
* Verified handshake will appear in `runner.log`.

#### Managing the Runner:
* **Disable / Stop**:
  * Tap **`[ 🛑 Disable Laptop Agent ]`** inside Telegram under `/status`
  * Or double-click [`Disable-Laptop-Agent.bat`](file:///C:/Users/dsoph/Desktop/Disable-Laptop-Agent.bat) on your Desktop.
* **Enable / Start**:
  * Double-click [`Enable-Laptop-Agent.bat`](file:///C:/Users/dsoph/Desktop/Enable-Laptop-Agent.bat) or [`Start-Silent-Agent.vbs`](file:///C:/Users/dsoph/Desktop/Start-Silent-Agent.vbs).

---

## 📱 Telegram Commands Reference

| Command | Category | Description |
| :--- | :--- | :--- |
| `/agent <task>` | 🤖 Agent | Execute autonomous tasks with live tools (terminal, files, research) |
| `/agent_mode` | 🤖 Agent | Toggle Agent mode as default for all general chat messages |
| `/devices` | 🤖 Agent | View online status of all authorized users' laptops |
| `/deep_research`| 🔬 Research | Generate comprehensive multi-source factual research reports |
| `/search <query>`| 🌐 Research | Live Google Search grounding with verified source links |
| `/youtube <query>`| 🎥 Media | Search YouTube videos, channels, and playlists |
| `/image <prompt>` | 🎨 Creative | Generate high-quality images via Gemini |
| `/live` | 🎙️ Voice | Toggle spoken voice responses for all bot replies |
| `/call` | 📞 Voice | Open real-time duplex bidirectional voice WebApp |
| `/voice` | 🗣️ Voice | Switch Gemini voice persona (Aoede, Charon, Fenrir, etc.) |
| `/storage` | ☁️ Files | Open the interactive Cloud Vault & Local storage hub |
| `/directory <path>`| 📁 Files | Set or view your local project folder path |
| `/save [path]` | 💾 Files | Save pending generated code to your target directory |
| `/cancel` | ❌ Files | Discard pending code save or cancel directory input |
| `/library` | 📚 Files | Browse files saved in your local folder or Cloud Vault |
| `/quiz` | 📝 Learning | Generate an interactive multiple-choice quiz from loaded document |
| `/status` | 📊 System | View live laptop hardware specs (CPU, RAM, uptime) & bot engine health |
| `/clear` | 🧹 Chat | Clear recent conversation history while retaining loaded files |
| `/clearall` | 🧹 Chat | Clear all conversation history, sessions, and active documents |

---

## 🔒 Security Architecture

1. **Outbound-Only Tunneling**:
   * The local runner initiates an outgoing secure WebSocket connection (`wss://`) to the cloud server.
   * No inbound ports are opened on your router or laptop, making it completely safe from external port scans.
2. **Secret Handshake & Token Authentication**:
   * Every connection validates `LAPTOP_RUNNER_SECRET` and matches the user's numeric Telegram ID against `ALLOWED_USER_ID`.
3. **Directory Boundary Protection**:
   * Path traversal guards (`..` sanitization) prevent rogue script execution outside designated project paths.
4. **Interactive Code Confirmation**:
   * Generated files are kept in memory and require interactive confirmation via inline buttons before writing to disk.

---

## 📄 License

MIT License.
