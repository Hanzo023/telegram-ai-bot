# Telegram AI Assistant Bot

A personal Telegram bot powered by Claude AI that provides intelligent conversational assistance.

## Features

- 🔒 **Secure**: Only responds to authorized user (configurable user ID)
- 💬 **Conversational**: Maintains conversation history for context-aware responses
- ⌨️ **Typing indicators**: Shows realistic typing action while processing
- 📝 **Markdown support**: Formats responses with Markdown for better readability
- 🧹 **Clear command**: Reset conversation history anytime with `/clear`
- 🤖 **Claude AI**: Powered by Claude Sonnet 5 for intelligent responses

## Prerequisites

- Node.js (v18 or higher)
- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- An Anthropic API key (or compatible API endpoint)
- Your Telegram User ID

## Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd telegram-ai-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and fill in your credentials:
   - `TELEGRAM_BOT_TOKEN`: Get from [@BotFather](https://t.me/botfather)
   - `ANTHROPIC_API_KEY`: Your Anthropic API key
   - `ANTHROPIC_BASE_URL`: API endpoint (default: https://api.anthropic.com)
   - `ALLOWED_USER_ID`: Your Telegram user ID (numeric)

   **Finding your Telegram User ID:**
   - Message [@userinfobot](https://t.me/userinfobot) on Telegram
   - It will reply with your numeric user ID

4. **Start the bot**
   ```bash
   npm start
   ```

## Usage

Once the bot is running:

1. Open Telegram and find your bot
2. Send `/start` to see the welcome message
3. Send any text message to chat with Claude
4. Use `/clear` to reset the conversation history

**Note:** The bot will only respond to messages from the authorized user ID configured in `.env`. All other users will be silently ignored.

## Commands

- `/start` - Display welcome message and available commands
- `/clear` - Clear conversation history and start fresh

## Project Structure

```
telegram-ai-bot/
├── bot.js           # Main bot application
├── package.json     # Node.js dependencies and scripts
├── .env            # Environment variables (not in git)
├── .env.example    # Example environment variables
├── .gitignore      # Git ignore rules
└── README.md       # This file
```

## Technologies

- [Grammy](https://grammy.dev/) - Telegram Bot framework
- [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) - Anthropic API client
- [dotenv](https://www.npmjs.com/package/dotenv) - Environment variable management

## Security

- The bot enforces strict user authentication via `ALLOWED_USER_ID`
- API keys and tokens are stored in `.env` (excluded from git)
- Unauthorized users cannot interact with the bot

## License

MIT
