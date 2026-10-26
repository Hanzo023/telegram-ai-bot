# Git Setup & Branch Workflow Instructions

This repository uses a two-tier branching strategy:
* **`main`**: Production deployment branch connected to automated cloud hosting (Render).
* **`Testing-branch`**: Active feature development, bug fixes, and integration testing branch.

---

## 🚀 Daily Development Workflow (`Testing-branch`)

When working on bug fixes, agent tool enhancements, or test routines, always develop and push to `Testing-branch`:

```bash
# 1. Ensure you are on the Testing-branch
git checkout Testing-branch

# 2. Check changed files and ensure no credentials or temp files are staged
git status

# 3. Stage modified files
git add bot.js laptop-runner.js laptop-bridge.js gemini-agent-service.js tools/ README.md TROUBLESHOOTING.md

# 4. Commit with descriptive semantic message
git commit -m "fix: terminal progress streaming, non-destructive window vision, and queue follow-up handling"

# 5. Push directly to remote Testing-branch (do NOT push to main during test cycles)
git push origin Testing-branch
```

---

## 🔒 Security & `.gitignore` Verification

The repository is configured to exclude sensitive files:
- `node_modules/` (dependencies)
- `.env` (API keys, bot token, secret credentials)
- `agent_vision.png`, `runner.log` (local runtime artifacts)

Verify before committing:
```bash
git status
```
> [!CAUTION]
> Never commit `.env` or any file containing API keys (`TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) to Git.

---

## 🔀 Merging from `Testing-branch` into `main` (Production Release)

Once changes on `Testing-branch` are verified:

```bash
# 1. Switch to main
git checkout main

# 2. Pull latest remote main
git pull origin main

# 3. Merge tested changes
git merge Testing-branch

# 4. Push release to production
git push origin main
```
