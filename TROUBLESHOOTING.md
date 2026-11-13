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
13. [Gemini API 404 / 429: Model Not Found or Quota Exhausted on Pro / Argon Models](#13-gemini-api-404--429-model-not-found-or-quota-exhausted-on-pro--argon-models)
14. [Terminal Installation or Long Command Freezes (`winget`, `npm`, `pip`)](#14-terminal-installation-or-long-command-freezes-winget-npm-pip)
15. [Targeted Window Screenshot Minimizes, Closes, or Captures Desktop Background](#15-targeted-window-screenshot-minimizes-closes-or-captures-desktop-background)
16. [Follow-up Prompts Trapped or Ignored During Active Agent Execution](#16-follow-up-prompts-trapped-or-ignored-during-active-agent-execution)
17. [Task Cancellation and Emergency Queue Purge (`/stop`, `/abort`, `/cancel`)](#17-task-cancellation-and-emergency-queue-purge-stop-abort-cancel)

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
2. Truncate extracted document text to the first 100–300 lines before forwarding to Gemini:
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

### 13. Gemini API 404 / 429: Model Not Found or Quota Exhausted on Pro / Argon Models

#### 🔴 Symptom
```text
GoogleGenAIError: [404 Not Found] models/gemini-3.1-pro is not found for API version v1beta
```
Or:
```text
GoogleGenAIError: [429 ResourceExhausted] Quota exceeded for metric 'GenerateContent Requests per minute' (limit: 0 or 2 RPM)
```

#### 🔍 Root Cause
1. **Tier Incompatibility**: Standard / Free-tier API keys from [Google AI Studio](https://aistudio.google.com) do **not** have quota for Gemini Pro models or specialized preview models (e.g. Argon). They have either 0 RPM or strict 2 RPM limits intended only for web console experimentation.
2. **Missing Billing Account**: Pro and preview models require the Google Cloud Project hosting your API key to have **Pay-As-You-Go billing enabled**.

#### 🛠️ Fix
* **If you are using a Standard / Free Key**: Stick with the high-quota **Flash Family**:
  * `gemini-3.8-flash` (Default Flagship)
  * `gemini-3.5-flash` (High Availability Fallback)
  * `gemini-3.5-flash-lite` (Ultra-Fast)
  These models are 100% free with generous RPM on standard keys. Run `/model 3.8` in chat or make sure `GEMINI_MODEL=gemini-3.8-flash`.
* **If you have a Pay-As-You-Go / Upgraded Key**:
  1. Open [Google AI Studio](https://aistudio.google.com) and link your project to a billing account (Pay-As-You-Go).
  2. Set `GEMINI_MODEL=gemini-3.1-pro` (or your authorized Argon model string) in your environment variables.
  3. Or run `/model <model-name>` dynamically inside your Telegram chat.

---

### 14. Terminal Installation or Long Command Freezes (`winget`, `npm`, `pip`)

#### 🔴 Symptom
When the agent attempts to install packages or run package managers (e.g. `winget install yazi`, `pip install pillow`, `npm install`), the task hangs indefinitely or times out with:
```text
Laptop task "run_command" timed out after 60 seconds of inactivity.
```
No live feedback appears in Telegram, and subsequent commands cannot run until the lock clears.

#### 🔍 Root Cause
1. **Interactive Prompt Blocks**: Package managers frequently prompt for user input (e.g., license agreements, source agreements, or `[y/N]` confirmations). Without explicit non-interactive flags, standard input waits forever.
2. **Standard I/O Pipe Hangs**: Using `child_process.exec()` creates buffered pipes. When terminal programs or GUI launchers spawn child processes, standard output streams can remain open indefinitely.
3. **Inadequate Timeout**: Standard commands use a default 60s timeout, which is insufficient for downloading and extracting larger software packages.

#### 🛠️ Fix
1. **Enforce Non-Interactive Flags in System Instructions**:
   In [`gemini-agent-service.js`](./gemini-agent-service.js), enforce mandatory silent flags in the agent's prompt:
   - `winget`: `winget install <id> -e --silent --accept-package-agreements --accept-source-agreements`
   - `pip`: `pip install <package> --no-input -q`
   - `npm`: `npm install <package> --yes --no-audit --no-fund`
2. **Spawn Decoupled Processes with Ignored Stdin**:
   In [`laptop-runner.js`](./laptop-runner.js):
   - For commands launching GUI/TUI windows (starting with `start ` or running interactive TUIs like `yazi`), spawn detached with `stdio: 'ignore'` and call `child.unref()`.
   - For CLI commands, spawn `powershell.exe -NoProfile -NonInteractive -Command` using `stdio: ['ignore', 'pipe', 'pipe']`.
   - Extend timeout to `180000` ms (3 minutes) for installation commands.
3. **Stream Real-Time Progress (`COMMAND_PROGRESS`)**:
   [`laptop-runner.js`](./laptop-runner.js) throttles `stdout`/`stderr` chunks and sends `COMMAND_PROGRESS` WebSocket frames every 2 seconds with the latest output lines. [`laptop-bridge.js`](./laptop-bridge.js) refreshes the task timeout timer on each chunk and forwards progress to the user's status message.

---

### 15. Targeted Window Screenshot Minimizes, Closes, or Captures Desktop Background

#### 🔴 Symptom
When asking the agent to take a screenshot of an open application window (e.g. *"take a screenshot of Gemini"*, *"screenshot Brave"*, or *"screenshot yazi"*):
1. The target application abruptly shrinks, unmaximizes, or hides behind other windows.
2. Telegram Desktop minimizes itself.
3. The resulting screenshot captures the empty desktop background or an unintended window instead of the requested app.

#### 🔍 Root Cause
1. **Unwanted Window Minimization**: Legacy capture scripts contained a helper `find_and_minimize_telegram()` that actively minimized Telegram Desktop using Win32 `SW_MINIMIZE (6)` or sent close/minimize keys.
2. **Destructive Restore on Maximized Windows**: Calling `ShowWindow(hwnd, 9)` (`SW_RESTORE`) on an already maximized browser window restores it to its normal floating dimensions, causing it to shrink or disappear behind other windows.
3. **OS Foreground Focus Lock**: Windows forbids background processes from grabbing focus without an active user event, causing standard `.activate()` calls to fail silently.

#### 🛠️ Fix
1. **Remove All Minimization/Closing Logic**:
   Completely removed `find_and_minimize_telegram` and `restore_telegram` from both [`tools/capture_app.py`](./tools/capture_app.py) and [`tools/request_approval.py`](./tools/request_approval.py). The system never alters other windows.
2. **Iconic State Check with Safe Foreground Bypass**:
   Use `bring_window_to_front(hwnd)`:
   ```python
   def bring_window_to_front(hwnd):
       try:
           # ONLY restore if the window is actually minimized
           if user32.IsIconic(hwnd):
               user32.ShowWindow(hwnd, 9)  # SW_RESTORE
               time.sleep(0.25)
           else:
               # Preserve Maximized or Normal state
               user32.ShowWindow(hwnd, 5)  # SW_SHOW

           # Bypass Windows foreground lock using Alt key simulation
           user32.keybd_event(0x12, 0, 0, 0)      # Alt down
           user32.SetForegroundWindow(hwnd)
           user32.BringWindowToTop(hwnd)
           user32.keybd_event(0x12, 0, 2, 0)      # Alt up
           time.sleep(0.35)                       # Wait for repaint
       except Exception:
           pass
   ```
3. **Case-Insensitive Substring Match**:
   Enumerate visible windows via `EnumWindows` and match against title strings (e.g. querying `"gemini"` matches `"Google Gemini - Brave"` and crops the window bounds accurately with `isDesktopFallback: false`).

---

### 16. Follow-up Prompts Trapped or Ignored During Active Agent Execution

#### 🔴 Symptom
While the agent is busy running a multi-step task or an installation command, sending a follow-up message in chat (e.g. *"Can you take a screenshot of the progress?"* or *"What's taking so long?"*) produces no immediate response. The message is either dropped or ignored until after the entire agent run finishes.

#### 🔍 Root Cause
The per-user concurrency queue in [`bot.js`](./bot.js) used a boolean `q.isProcessing = true` lock. When new messages arrived during an active turn, `triggerUserQueueExecution` returned silently, buffering messages in `q.items` without notifying the user or passing context to the active agent loop.

#### 🛠️ Fix
1. **Instant Acknowledgment & Status Feedback**:
   In `enqueueUserMessage`, when a message arrives while a task is running:
   The bot immediately sends: `⚙️ *Task in progress! Queued your follow-up request...*` (throttled to avoid duplicate spam).
2. **Instant Concurrent Checks**:
   - If the user asks for a screenshot (e.g. *"take a screenshot"*, *"screenshot"*), `handleConcurrentScreenshot` immediately fires an asynchronous capture and delivers the image to Telegram without interrupting the running task.
   - If the user queries progress, `handleConcurrentStatusCheck` responds with the current status and elapsed time.
3. **Mid-Task Agent Context Polling (`pollUserQueue`)**:
   [`gemini-agent-service.js`](./gemini-agent-service.js) accepts a `pollUserQueue` callback. After each tool finishes, the agent checks the queue. If follow-up text exists, it injects:
   `[USER MID-TASK FOLLOW-UP / PRIORITY INSTRUCTION]: "<text>"`
   directly into the model's next interaction turn.
4. **Guaranteed Chained Queue Execution**:
   In [`bot.js`](./bot.js), both `handleAgentCommand` and `triggerUserQueueExecution` contain `finally` blocks that clear debounce timers and immediately trigger the next turn if items remain in `q.items`.

---

### 17. Task Cancellation and Emergency Queue Purge (`/stop`, `/abort`, `/cancel`)

#### 🔴 Symptom
A long-running agent command or incorrect prompt cannot be halted without stopping the cloud bot service or killing processes on the laptop.

#### 🔍 Root Cause
No abort signaling existed between the Telegram command dispatcher and the active `runGeminiAgent` iteration loop.

#### 🛠️ Fix
1. **Active Session Tracking**:
   [`bot.js`](./bot.js) tracks active agent executions in `activeAgentSessions` (`Map<userId, session>`) containing an `AbortController`.
2. **Immediate Stop Handlers**:
   - Added command handlers for `/stop` and `/abort`.
   - Updated `/cancel` to check `activeAgentSessions` and signal abort.
   - Any chat message containing `stop`, `abort`, or `cancel` during an active task triggers `handleTaskStop(userId, ctx)`.
3. **Queue Purge & Agent Termination**:
   Calling `handleTaskStop` aborts `session.abortController`, calls `clearUserQueue(userId)` to discard pending debounced requests, and sends:
   `🛑 *Active agent task stopped and pending queue cleared.*`

---

## 💡 Quick Health Verification Checklist

Before reporting a bug, verify these 5 checkpoints:
1. [ ] Is `ALLOWED_USER_ID` configured with your exact numerical Telegram ID?
2. [ ] Is UptimeRobot pinging your cloud `/health` endpoint every 5 minutes?
3. [ ] Are you running `bot.js` in only **one** location (Render or local, never both)?
4. [ ] Does [`run.bat`](./run.bat) connect and output `Server handshake confirmed`?
5. [ ] Is `STORAGE_DIR` set to `./` or an accessible project folder?

---

## 🛡️ Autonomous Self-Healing & Remote Hot-Patch Engine

When running headless on Render Free Tier (0.1 vCPU, 512 MB RAM), bugs or unexpected runtime exceptions can be inspected, patched, and deployed directly from your mobile phone via Telegram without opening a laptop.

### 1. Unkillable Watchdog Architecture (`watchdog.js`)
- Render's `npm start` command invokes [`watchdog.js`](./watchdog.js), which forks [`bot.js`](./bot.js) as a supervised child process.
- **Zero 502 Probing Downtime**: If `bot.js` crashes or exits unexpectedly, the watchdog immediately starts an emergency HTTP health check server on `PORT` (200 OK) so UptimeRobot and Render never register a container failure.
- **Direct Telegram Alert**: Sends an immediate crash notification with the exact error traceback to `ADMIN_USER_ID`.
- **Emergency Telegram Poller**: When the main bot is dead, the watchdog activates an emergency Telegram long-poller to accept admin `/logs` and `/fix` commands directly from phone chat.

### 2. Admin Remote Control Commands (`/logs` and `/fix`)
- Restricted strictly to `ADMIN_USER_ID` (with fallback to `ALLOWED_USER_ID`).
- **`/logs`**: Returns the last 50 lines of stdout/stderr captured in an in-memory ring buffer (up to 250 lines) plus the latest recorded exception traceback.
- **`/fix <instruction>`**:
  1. Identifies the target file (explicitly mentioned in instruction, or extracted from the latest crash traceback stack frame, defaulting to `bot.js`).
  2. Synthesizes a patch using Gemini with low temperature (`0.2`) and resilient model fallback (`gemini-3.5-flash` ➔ `gemini-3.5-flash-lite` ➔ `gemini-3.8-flash`).
  3. **Anti-Brick Guard**: Validates candidate code in memory/temp file before touching production files (`node --check` for JS, `python -m py_compile` for Python, `JSON.parse` for JSON). If syntax checks fail, feeds the error back to Gemini to self-correct (up to 3 retries).
  4. **Permanent GitHub Sync**: Commits the validated code directly to `GITHUB_REPO` (`GITHUB_BRANCH`) via the GitHub REST API (`PUT /repos/{owner}/{repo}/contents/{path}`) with commit message `[Auto-Fix via Phone]`, ensuring Render's next deploy preserves the fix permanently.
  5. **Instant Hot-Reload**: Overwrites the local file and restarts the worker process within ~3 seconds.
