import 'dotenv/config';
import { Bot } from 'grammy';
import Anthropic from '@anthropic-ai/sdk';

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const allowedUserId = parseInt(process.env.ALLOWED_USER_ID);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const conversationHistory = new Map();

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== allowedUserId) {
    console.log(`Rejected message from unauthorized user: ${ctx.from?.id}`);
    return;
  }
  await next();
});

bot.command('start', async (ctx) => {
  await ctx.reply(
    'Hello! I\'m your personal AI assistant powered by Claude 3.5 Sonnet.\n\n' +
    'Just send me any message and I\'ll help you with your questions.\n\n' +
    'Commands:\n' +
    '/clear - Clear conversation history\n' +
    '/start - Show this message',
    { parse_mode: 'Markdown' }
  );
});

bot.command('clear', async (ctx) => {
  conversationHistory.delete(ctx.from.id);
  await ctx.reply('✅ Conversation history cleared!');
});

bot.on('message:text', async (ctx) => {
  const userId = ctx.from.id;
  const userMessage = ctx.message.text;

  if (userMessage.startsWith('/')) {
    return;
  }

  await ctx.replyWithChatAction('typing');

  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }

  const history = conversationHistory.get(userId);
  history.push({
    role: 'user',
    content: userMessage,
  });

  try {
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction('typing').catch(() => {});
    }, 5000);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      messages: history,
    });

    clearInterval(typingInterval);

    const assistantMessage = response.content[0].text;

    history.push({
      role: 'assistant',
      content: assistantMessage,
    });

    if (history.length > 20) {
      history.splice(0, 2);
    }

    await ctx.reply(assistantMessage, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error calling Claude API:', error);
    console.error('Full error details:', JSON.stringify(error, null, 2));
    await ctx.reply(
      '❌ Sorry, I encountered an error processing your request. Please try again.',
      { parse_mode: 'Markdown' }
    );
  }
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

bot.start();
console.log('Bot is running...');
