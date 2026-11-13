import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot_runtime.log');

// Ensure log directory exists
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (err) {
  console.warn('[Logger] Failed to create log directory:', err.message);
}

function appendToFile(level, category, message, meta = null) {
  try {
    const timestamp = new Date().toISOString();
    let metaStr = '';
    if (meta !== null && meta !== undefined) {
      if (meta instanceof Error) {
        metaStr = ` | Error: ${meta.message} | Stack: ${meta.stack}`;
      } else if (typeof meta === 'object') {
        try {
          metaStr = ` | ${JSON.stringify(meta)}`;
        } catch {
          metaStr = ` | [Circular/Unserializable Meta]`;
        }
      } else {
        metaStr = ` | ${meta}`;
      }
    }
    const logLine = `[${timestamp}] [${level}] [${category}] ${message}${metaStr}\n`;
    fs.appendFileSync(LOG_FILE, logLine, { encoding: 'utf8' });
  } catch (err) {
    // Fail silently to never disrupt runtime
  }
}

export const logger = {
  info(message, meta = null) {
    console.log(`[INFO] ${message}`, meta ? meta : '');
    appendToFile('INFO', 'GENERAL', message, meta);
  },

  warn(message, meta = null) {
    console.warn(`⚠️ [WARN] ${message}`, meta ? meta : '');
    appendToFile('WARN', 'GENERAL', message, meta);
  },

  error(message, errorOrMeta = null) {
    console.error(`❌ [ERROR] ${message}`, errorOrMeta ? errorOrMeta : '');
    appendToFile('ERROR', 'GENERAL', message, errorOrMeta);
  },

  query({ userId, text, command = null, mode = 'chat' } = {}) {
    const preview = typeof text === 'string' ? text.replace(/[\r\n]+/g, ' ').slice(0, 150) : '';
    const msg = `User ${userId} [${mode}] ${command ? `cmd="${command}" ` : ''}query="${preview}"`;
    console.log(`[LOG:QUERY] ${msg}`);
    appendToFile('INFO', 'QUERY', msg, { userId, command, mode, textPreview: preview });
  },

  modelRouting({ userId, selectedModel, candidateModels = [], fallback = false } = {}) {
    const msg = `User ${userId} routed to model: ${selectedModel} (fallback: ${fallback})`;
    console.log(`[LOG:ROUTING] ${msg}`);
    appendToFile('INFO', 'MODEL_ROUTING', msg, { userId, selectedModel, candidateModels, fallback });
  },

  geminiLatency({ model, latencyMs, success = true, error = null } = {}) {
    const status = success ? 'SUCCESS' : `FAILED (${error || 'Unknown error'})`;
    const msg = `Model: ${model} | Latency: ${latencyMs}ms | Status: ${status}`;
    console.log(`[LOG:LATENCY] ${msg}`);
    appendToFile(success ? 'INFO' : 'ERROR', 'API_LATENCY', msg, { model, latencyMs, success, error });
  },

  tokenUsage({ model, promptTokens = 0, candidateTokens = 0, totalTokens = 0 } = {}) {
    const msg = `Model: ${model} | Prompt: ${promptTokens} | Candidates: ${candidateTokens} | Total: ${totalTokens}`;
    console.log(`[LOG:TOKENS] ${msg}`);
    appendToFile('INFO', 'TOKEN_USAGE', msg, { model, promptTokens, candidateTokens, totalTokens });
  },

  exception(err, context = '') {
    const contextPrefix = context ? `[${context}] ` : '';
    const errMessage = err?.message || String(err);
    const stack = err?.stack || '';
    console.error(`💥 [LOG:EXCEPTION] ${contextPrefix}${errMessage}\n${stack}`);
    appendToFile('ERROR', 'EXCEPTION', `${contextPrefix}${errMessage}`, { stack, context });
  },

  getLogFilePath() {
    return LOG_FILE;
  },
};

export default logger;
