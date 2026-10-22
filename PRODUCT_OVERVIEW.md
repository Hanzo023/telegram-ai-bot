# 📱 Telegram AI Bot: Product Overview & Feature Tour

> **The elevator pitch**: Imagine having a genius private AI companion in your pocket that not only chats with Claude and Gemini, but can also inspect your laptop hardware, run terminal commands, and fetch files while you're away from home — with zero open firewall ports.

---

## 🌟 Top 6 Everyday Superpowers

```
                    ┌──────────────────────────────────────────────┐
                    │               YOUR SMARTPHONE                │
                    │   "How's my laptop?"   "Run git pull & test" │
                    └──────────────────────┬───────────────────────┘
                                           │ Telegram Message
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │       CLOUD BRAIN (Google Gemini Native)     │
                    │   • Deep reasoning & coding assistance       │
                    │   • Live Google search & audio synthesis     │
                    └──────────────────────┬───────────────────────┘
                                           │ Secure Outbound Tunnel
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │            YOUR HOME/WORK PC                 │
                    │   • CPU, GPU, RAM & Battery metrics          │
                    │   • Remote terminal task execution           │
                    └──────────────────────────────────────────────┘
```

### 1. 💻 Check Your PC Hardware From Anywhere
Ever left home wondering if your computer is running hot, running out of battery, or pegging the CPU?
* Type `/spec` or simply ask: *"how's my cpu doing?"*
* Instantly receive real-time specs:
  * **Processor**: Core counts, clock speeds, and live CPU load.
  * **Dual Graphics**: Dedicated GPU (e.g. *RTX 3060 Laptop GPU*) + integrated graphics.
  * **Memory & Storage**: Free RAM and remaining GB across all drives (`C:`, `D:`).
  * **Battery**: Current battery charge percentage and power state.

### 2. ⚡ Run Remote Terminal Tasks (`/agent`)
Forgot to pull git updates, install an npm package, or trigger a backup before leaving your desk?
* Type: `/agent pull latest changes in my project and run tests`
* The bot executes the commands on your PC, inspects the output, self-corrects if there are errors, and gives you a clear summary of the results right in chat.

### 3. 🎙️ Spoken Voice Notes & Duplex Phone Calls
Don't feel like typing or reading long text blocks while walking or driving?
* **Voice Replies (`/live`)**: Send a voice note or text. The bot replies with a natural, expressive spoken audio note.
* **Hands-Free Duplex Calls (`/call`)**: Opens a real-time voice call WebApp inside Telegram. Speak naturally and get instant answers with sub-second latency powered by Gemini Live.

### 4. 🧠 All-in-One AI Intelligence (Google Gemini Native + Optional Hybrid)
Powered 100% natively by Google Gemini:
* **Google Gemini 3.8 Flash**: Handles conversational chat, code generation, instant audio transcription, voice generation, live Google Search grounding, and high-speed autonomous tools.
* **Optional Hybrid Mode (Claude Sonnet 5.5)**: Want a dual-brain setup? You can optionally connect Anthropic Claude for coding/text while keeping Gemini for voice and search.

### 5. ☁️ Permanent Free File Vault (`/storage` & `/library`)
Send any PDF, code script, spreadsheet, or photo to the bot:
* The bot organizes files into categorized folders (Documents, Code, Data, Media).
* Browse your collection with an interactive A-Z keyboard (`/library`).
* **Zero Cost**: Files are preserved permanently for free in Telegram Cloud Vault — even when cloud servers restart.

### 6. 📝 Turn Any Document Into an Interactive Quiz (`/quiz`)
Studying for an exam or learning a new framework?
* Drop a lecture PDF, cheat-sheet, or code file into chat and type `/quiz`.
* The bot instantly generates an interactive 5-question multiple choice test with explanations to test your comprehension.

---

## 🕹️ Everyday Commands Cheat-Sheet

| What You Want To Do | Command to Send | What Happens |
| :--- | :--- | :--- |
| **Check PC Health** | `/spec` | Shows CPU, dual GPUs, RAM, battery, and free disk space |
| **Run a PC Task** | `/agent <task>` | Executes terminal commands, reads files, and fixes issues |
| **Check Bot Uptime** | `/status` | Shows cloud bot uptime, runner connection, and active devices |
| **Spoken Voice Notes**| `/live` | Toggles spoken voice replies on/off |
| **Real-Time Phone Call**| `/call` | Opens a live duplex voice call WebApp |
| **Search the Web** | `/search <query>` | Performs a live Google search with verified citations |
| **Search YouTube** | `/youtube <query>` | Finds top YouTube videos and channel links |
| **Generate an Image** | `/image <prompt>` | Creates high-resolution images via Gemini |
| **Browse Files** | `/library` | Opens your interactive A-Z file library |
| **Take a Quiz** | `/quiz` | Creates an interactive 5-question test on your uploaded file |
| **Clear Chat** | `/clear` | Clears recent conversation while keeping loaded files |
| **Reboot Bot** | `/reboot` | Restarts the cloud container process remotely |

---

## 🔒 Private & Secure By Design

* **Zero Open Firewall Ports**: The laptop runner connects *outbound* via WebSockets. It works seamlessly through mobile hotspots, apartment Wi-Fi, and corporate CGNAT with zero port forwarding.
* **Strict Whitelisting**: Only YOUR Telegram User ID can talk to the bot or control the computer. Unauthorized users receive no response.
* **Safety Guardrails**: Destructive commands (like drive formatting or system wipes) are blocked by pattern-matching guards, and all generated code is held in memory for your approval before saving.
* **100% Free to Host**: Runs 24/7 on Render's free tier with automated keepalive probes.

---

## 🚀 How to Get Started in 3 Steps

1. **Clone & Configure**: Copy [`.env.example`](./.env.example) to `.env` and add your Telegram Bot token and AI API keys.
2. **Launch the Cloud Bot**: Deploy to Render (or run `npm start` locally).
3. **Launch the PC Runner**: Double-click [`run.bat`](./run.bat) on your laptop.

Open Telegram, send `/spec`, and your private AI companion is live!
