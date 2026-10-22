# 🛠️ Known Errors & Troubleshooting Guide

> A battle-tested catalog of real errors, root causes, and verified fixes encountered while building the **Telegram AI Bot & Remote Agent**. If you are building this project from scratch or deploying to production, this guide will save you hours of debugging.

---

## 📑 Error Index

1. [Telegram 409 Conflict: Terminated by Other getUpdates Request](#1-telegram-409-conflict-terminated-by-other-getupdates-request)
2. [Render Free Tier Sleeps After 15 Minutes (Unresponsive Bot)](#2-render-free-tier-sleeps-after-15-minutes-unresponsive-bot)
3. [Agent Stalls at "Completed maximum agent tool iterations"](#3-agent-stalls-at-completed-maximum-agent-tool-iterations)
4. [WebSocket Disconnected with Code 1006 (Dropped Tunnel)](#4-websocket-disconnected-with-code-1006-dropped-tunnel)
5. [Files Disappear After Cloud Server Redeploy or Restart](#5-files-disappear-after-cloud-server-redeploy-or-restart)
6. [GrammY Polling Crashes with `Error: Aborted delay`](#6-grammy-polling-crashes-with-error-aborted-delay)
7. [Laptop Runner Rejected: WebSocket 4001 or 4003](#7-laptop-runner-rejected-websocket-4001-or-4003)
8. [Cross-Platform Path Corruptions (Windows `\` vs Linux `/`)](#8-cross-platform-path-corruptions-windows--vs-linux-)
9. [Interactive CLI Commands Freeze the Agent Tunnel Indefinitely](#9-interactive-cli-commands-freeze-the-agent-tunnel-indefinitely)
10. [ReferenceError: State Map Is Not Defined on Message Receive](#10-referenceerror-state-map-is-not-defined-on-message-receive)
11. [PDF or File Extraction Memory Spike / OOM Crash](#11-pdf-or-file-extraction-memory-spike--oom-crash)
12. [YouTube Extraction Blocked by Bot Detection](#12-youtube-extraction-blocked-by-bot-detection)

---

### 1. Telegram 409 Conflict: Terminated by Other getUpdates Request

#### 🔴 Symptom
```text
GrammyError: Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request; 
make sure that only one bot instance is running)
```

#### 🔍 Root Cause
Telegram strictly permits only **one active connection per bot token**. This error occurs when you run `node bot.js` locally on your development machine while the bot is also running in the cloud (on Render, Docker, or Railway). Both instances attempt to poll Telegram simultaneously, kicking each other in an infinite disconnect loop.

#### 🛠️ Fix
* **Rule**: Run `bot.js` **only in the cloud** (Render). On your local laptop, run **only** [`laptop-runner.js`](./laptop-runner.js).
* If you need to test `bot.js` locally:
  1. Open your Render dashboard and click **Suspend Service**.
  2. Run `npm start` locally.
  3. When finished, resume your Render cloud service.

---

### 2. Render Free Tier Sleeps After 15 Minutes (Unresponsive Bot)

#### 🔴 Symptom
Your bot works immediately after deployment, but after 15–20 minutes of inactivity, sending a message in Telegram receives no response, or takes 30–50 seconds to reply ("cold start" latency).

#### 🔍 Root Cause
Render puts free Web Services to sleep if they do not receive incoming HTTP traffic for 15 minutes. While asleep, Node.js process execution is suspended, halting outbound Telegram polling.

#### 🛠️ Fix
Pair the bot's internal [`/health`](./bot.js) endpoint with a free external pinger like [UptimeRobot](https://uptimerobot.com):
1. Create a free HTTP(s) monitor targeting:
   `https://<your-app-name>.onrender.com/health`
2. Set the monitoring interval to **`5 minutes`** (under 15 minutes).
3. **The Dual Advantage**: Our `/health` endpoint checks `bot.isRunning()`. If polling drops or stalls, it responds with `HTTP 503 Service Unavailable`, prompting UptimeRobot to notify you immediately!

---

### 3. Agent Stalls at "Completed maximum agent tool iterations"

#### 🔴 Symptom
When sending an `/agent` instruction in Telegram, the bot thinks for a few moments, calls several tools in a loop, and then responds:
```text
Completed maximum agent tool iterations.
🛠️ Autonomous tools executed:
• list_laptop_files
• run_terminal_cmd
• get_file_contents
```
The requested file edit or command was never actually executed.

#### 🔍 Root Cause
1. **Tool Name Hallucinations**: LLMs often guess standard tool names like `run_terminal_cmd` or `get_file_contents` instead of the project's exact declared names (`run_laptop_terminal`, `read_laptop_file`). If the tool dispatcher doesn't recognize the alias, it returns `Unknown tool`, forcing the LLM into a confusion retry loop.
2. **Low Step Budget**: Complex multi-step actions (read file $\rightarrow$ rewrite $\rightarrow$ test $\rightarrow$ git commit) easily exceed low step budgets (e.g. 6–8 steps).

#### 🛠️ Fix
In [`gemini-agent-service.js`](./gemini-agent-service.js):
1. **Add Flexible Aliases**: Map all common LLM variations (`run_terminal_cmd`, `run_command`, `get_file_contents`, `read_file`, `write_file`, `list_directory_contents`) to their underlying laptop RPC handlers.
2. **Increase Max Steps**: Raise `maxSteps` to **25** iterations.
3. **Context Injection**: Pass recent conversation history into `runGeminiAgent` so follow-up commands (e.g. *"keep parts 1 to 5"*) understand previous turns.

---

### 4. WebSocket Disconnected with Code 1006 (Dropped Tunnel)

#### 🔴 Symptom
In [`runner.log`](./runner.log):
```text
[Runner] Disconnected (code: 1006) (Connection dropped or target server unreachable).
[Runner] Reconnecting in 3.0s (attempt 1)...
```

#### 🔍 Root Cause
`1006` is a generic abnormal WebSocket closure. It happens when:
- Wi-Fi switches networks or laptops sleep/wake.
- Intermediate routers or Render NAT close idle TCP connections after 60 seconds without data.

#### 🛠️ Fix
1. **Heartbeat Pings**: Both the client (every 5 seconds in [`laptop-runner.js`](./laptop-runner.js)) and the server (every 10 seconds in [`laptop-bridge.js`](./laptop-bridge.js)) exchange automated ping frames:
   ```javascript
   // Client ping interval: keeps edge reverse proxy tunnels alive
   const pingInterval = setInterval(() => {
     if (ws && ws.readyState === WebSocket.OPEN) ws.ping();
   }, 5000);
   ```
2. **Exponential Reconnect Backoff**: [`laptop-runner.js`](./laptop-runner.js) automatically schedules a clean reconnection within 1.5–10 seconds.
3. **Spec Caching**: Hardware specs are cached in memory so `/spec` queries still return the machine's profile even during a transient 3-second reconnect.

---

### 5. Files Disappear After Cloud Server Redeploy or Restart

#### 🔴 Symptom
Files uploaded to the bot or stored locally on the cloud server vanish whenever a new commit is pushed or the Render instance restarts.

#### 🔍 Root Cause
Cloud PaaS providers (Render, Fly.io, Heroku) use **ephemeral containers**. Any local files saved to disk during runtime are destroyed upon container recreation.

#### 🛠️ Fix
We implemented the **Telegram Cloud Vault** architecture:
1. When a user uploads a document, the bot forwards it to Telegram's cloud storage and preserves its permanent `file_id`.
2. The file registry index is serialized into JSON and pinned as a message in the user's private chat.
3. On every container boot, `restoreVaultFromTelegram()` loads the pinned index, recovering 100% of files and configurations with zero paid database dependencies.

---

### 6. GrammY Polling Crashes with `Error: Aborted delay`

#### 🔴 Symptom
```text
UnhandledPromiseRejection: Error: Aborted delay
    at AbortSignal.<anonymous> (node_modules/grammy/out/bot.js:...)
```

#### 🔍 Root Cause
When an unhandled network error occurs during long-polling, Grammy aborts its internal delay controller. If the runner attempts to restart `bot.start()` while the previous `AbortController` is still flagged as aborted, Grammy rejects immediately.

#### 🛠️ Fix
In your supervisor / restart routine in [`bot.js`](./bot.js), recycle Grammy's internal abort flags before re-initiating polling:
```javascript
try {
  if (bot.pollingAbortController) {
    bot.pollingAbortController = undefined;
  }
  bot.pollingRunning = false;
  await bot.start();
} catch (err) {
  console.warn('[Watchdog] Handled polling restart:', err.message);
}
```

---

### 7. Laptop Runner Rejected: WebSocket 4001 or 4003

#### 🔴 Symptom
```text
[Laptop Bridge] Unauthorized connection attempt: Invalid secret from 127.0.0.1
-- OR --
[Runner] Disconnected (code: 4001, reason: "Invalid secret")
-- OR --
[Runner] Disconnected (code: 4003, reason: "Unauthorized User ID")
```

#### 🔍 Root Cause
* **Code 4001 / Invalid Secret**:
  1. **Token Revocation Mismatch**: By default, the bridge secret is derived from the first 20 characters of `TELEGRAM_BOT_TOKEN` (`process.env.TELEGRAM_BOT_TOKEN.slice(0, 20)`). When you revoke or regenerate your bot token via [@BotFather](https://t.me/BotFather), this prefix changes.
  2. **Zombie Background Process**: An older detached runner (spawned silently via `start-agent.bat` or `.vbs`) may still be alive in memory loaded with the old token, repeatedly trying to connect with outdated credentials.
  3. **Cloud Environment Variable Desynchronization**: If you set `LAPTOP_RUNNER_SECRET` in your local `.env`, but omit it in the cloud dashboard (Render Environment Variables), Render falls back to your cloud bot token while your local laptop sends the custom secret.
* **Code 4003 / Unauthorized User ID**: The numerical Telegram user ID passed by the runner is not present in the server's `ALLOWED_USER_ID` whitelist.

#### 🛠️ Fix
1. **Kill Zombie Background Runners**:
   ```powershell
   # Windows PowerShell: Terminate any orphaned node runner processes
   Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*laptop-runner*" } | Stop-Process -Force
   ```
2. **Synchronize Secrets**:
   - Easiest method: Leave `LAPTOP_RUNNER_SECRET` blank/commented out on both your local machine and your Render dashboard. Both will automatically derive matching secrets from `TELEGRAM_BOT_TOKEN.slice(0, 20)`.
   - Explicit method: If you define a custom `LAPTOP_RUNNER_SECRET` in `.env`, ensure the identical key-value pair is saved in your cloud deployment dashboard (Render -> Environment Variables).
3. **Verify Whitelist**: Ensure `ALLOWED_USER_ID` in both `.env` and Render contains your exact numerical ID from [@userinfobot](https://t.me/userinfobot).

---

### 8. Cross-Platform Path Corruptions (Windows `\` vs Linux `/`)

#### 🔴 Symptom
Agent file operations fail with corrupted paths like:
```text
File not found: /opt/render/project/src/C:\projects\app\index.js
```

#### 🔍 Root Cause
The cloud bot runs on Linux (POSIX paths using `/`), while the laptop runner often runs on Windows (drive letters `C:\` and backslashes `\`). Standard Node.js `path.join()` corrupts absolute Windows paths when executed on a Linux host.

#### 🛠️ Fix
Use the custom cross-platform path helper in [`laptop-bridge.js`](./laptop-bridge.js):
```javascript
export function joinLaptopPath(baseDir, relativePath) {
  if (!baseDir) return relativePath || '';
  if (!relativePath) return baseDir;
  // If already absolute (handles both C:\ and /), preserve as-is
  if (/^[a-zA-Z]:[\\\/]/.test(relativePath) || relativePath.startsWith('/')) {
    return relativePath;
  }
  if (/^[a-zA-Z]:/.test(baseDir) || baseDir.includes('\\')) {
    const cleanBase = baseDir.replace(/[\\\/]+$/, '');
    const cleanRel = relativePath.replace(/^[\\\/]+/, '').replaceAll('/', '\\');
    return `${cleanBase}\\${cleanRel}`;
  }
  return path.join(baseDir, relativePath);
}
```

---

### 9. Interactive CLI Commands Freeze the Agent Tunnel Indefinitely

#### 🔴 Symptom
Sending `/agent npm init` or `/agent python` causes the bot to hang indefinitely without returning output.

#### 🔍 Root Cause
CLI tools that prompt for user input (e.g. `Press Enter to continue...`, `y/n?`, or interactive REPLs) hold standard input open. Since the WebSocket RPC runner is non-interactive, the process waits forever.

#### 🛠️ Fix
In [`laptop-runner.js`](./laptop-runner.js):
1. **Strict Execution Timeout**: Wrap every execution in a 30-second timeout:
   ```javascript
   exec(command, { cwd, shell, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => { ... });
   ```
2. **Command Blacklisting**: Reject interactive shells (`python -i`, `cmd.exe`, `powershell -NoExit`) and dangerous wipe commands (`rmdir /s /q C:\`, `format`).

---

### 10. ReferenceError: State Map Is Not Defined on Message Receive

#### 🔴 Symptom
```text
ReferenceError: userAwaitingRename is not defined
    at bot.on (bot.js:842:9)
```

#### 🔍 Root Cause
In complex stateful chat features (such as in-chat file renaming or directory prompts), calling `.has(userId)` or `.get(userId)` on an uninitialized `Map` throws a runtime `ReferenceError` when the user sends a message.

#### 🛠️ Fix
Always initialize state collections at the top level of [`bot.js`](./bot.js):
```javascript
const userAwaitingRename = new Map(); // userId -> { source, idx, oldName, fullPath }
const pendingFiles = new Map();       // userId -> { code, filename, suggestedPath }
```

---

### 11. PDF or File Extraction Memory Spike / OOM Crash

#### 🔴 Symptom
Uploading a 20 MB scanned textbook PDF crashes the Node.js container with:
```text
JavaScript heap out of memory
```

#### 🔍 Root Cause
Render free containers have a strict 512 MB RAM limit. Loading a massive multi-page PDF into a single buffer and parsing it with `pdf-parse` can exhaust heap allocation.

#### 🛠️ Fix
In [`gemini-agent-service.js`](./gemini-agent-service.js) and [`bot.js`](./bot.js):
1. Enforce a **5 MB size guard** before running in-memory text parsing.
2. Truncate extracted document text to the first 100–300 lines before forwarding to Claude or Gemini:
   ```javascript
   const lines = textContent.split('\n').slice(0, 300).join('\n');
   ```

---

### 12. YouTube Extraction Blocked by Bot Detection

#### 🔴 Symptom
```text
ERROR: [youtube] Sign in to confirm you're not a bot.
```

#### 🔍 Root Cause
YouTube regularly flags data center IP addresses (like Render, AWS, and DigitalOcean) and blocks `yt-dlp` requests that lack authentic session cookies.

#### 🛠️ Fix
1. Export your browser cookies using the *Get cookies.txt LOCALLY* Chrome/Firefox extension.
2. Store the Netscape cookie text in the `YOUTUBE_COOKIES` environment variable on Render.
3. [`search-service.js`](./search-service.js) will automatically write `cookies.txt` to disk and pass `--cookies cookies.txt` to `yt-dlp`.

---

## 💡 Quick Health Verification Checklist

Before reporting a bug, verify these 5 checkpoints:
1. [ ] Is `ALLOWED_USER_ID` configured with your exact numerical Telegram ID?
2. [ ] Is UptimeRobot pinging your cloud `/health` endpoint every 5 minutes?
3. [ ] Are you running `bot.js` in only **one** location (Render or local, never both)?
4. [ ] Does [`run.bat`](./run.bat) connect and output `Server handshake confirmed`?
5. [ ] Is `STORAGE_DIR` set to `./` or an accessible project folder?
