# Telegram AI Bot

A personal Telegram bot powered by Claude 4.5 Haiku for AI-assisted conversations.

## Features

- Direct integration with Claude 4.5 Haiku via Anthropic API
- Conversation history management (maintains context across messages)
- User authentication (only specified user can interact)
- Simple command interface
- Automatic conversation trimming to manage token usage

## Prerequisites

- Node.js (v18 or higher recommended)
- A Telegram account
- An Anthropic API key

## Setup Instructions

### 1. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` command
3. Follow the prompts to name your bot
4. Save the bot token provided by BotFather

### 2. Get Your Telegram User ID

1. Search for [@userinfobot](https://t.me/userinfobot) on Telegram
2. Start a conversation to get your user ID
3. Save this ID (you'll need it for the ALLOWED_USER_ID)

### 3. Get Anthropic API Key

1. Sign up at [Anthropic](https://console.anthropic.com/)
2. Navigate to API Keys section
3. Create a new API key and save it

### 4. Install Dependencies

```bash
npm install
```

### 5. Configure Environment Variables

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and fill in your credentials:
   ```
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   ANTHROPIC_BASE_URL=https://api.anthropic.com
   ALLOWED_USER_ID=your_telegram_user_id_here
   ```

### 6. Run the Bot

```bash
npm start
```

The bot will start and log "Bot is running..." to the console.

## Usage

### Commands

- `/start` - Display welcome message and available commands
- `/clear` - Clear conversation history

### Chatting

Simply send any text message to the bot, and it will respond using Claude 3.5 Sonnet. The bot maintains conversation context automatically.

## Security

- Only the user specified in `ALLOWED_USER_ID` can interact with the bot
- Unauthorized users are silently rejected
- Never commit your `.env` file or share your API keys

## Configuration

### Conversation History

The bot maintains up to 20 messages (10 exchanges) in history. Older messages are automatically removed. You can adjust this in `bot.js` by modifying the history length check:

```javascript
if (history.length > 20) {
  history.splice(0, 2);
}
```

### Model Selection

The bot uses `claude-sonnet-5` by default. You can change the model in `bot.js`:

```javascript
model: 'claude-sonnet-5',
```

### Custom API Endpoint

If you're using a custom Anthropic API endpoint or proxy, update the `ANTHROPIC_BASE_URL` in your `.env` file.

## Troubleshooting

### Bot doesn't respond

- Verify your bot token is correct
- Check that your user ID matches the one in `.env`
- Ensure the bot is running in the console
- Check console logs for errors

### API errors

- Verify your Anthropic API key is valid and has credits
- Check the `ANTHROPIC_BASE_URL` is correct
- Review console error logs for specific API error messages

## License

MIT
