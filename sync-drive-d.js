import 'dotenv/config';
import { Bot, InputFile } from 'grammy';
import fs from 'fs';
import path from 'path';
import { getFileCategory } from './search-service.js';

const STORAGE_DIR = process.env.STORAGE_DIR || 'D:\\drive-download-20260715T073323Z-1-001';
const rawAllowedId = (process.env.ALLOWED_USER_IDS || process.env.ALLOWED_USER_ID || '').trim();
const allowedUserId = rawAllowedId ? parseInt(rawAllowedId.split(/[,;\s]+/)[0], 10) : null;

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN not found in environment');
  process.exit(1);
}

if (!allowedUserId) {
  console.error('Error: ALLOWED_USER_ID not found in environment');
  process.exit(1);
}

if (!fs.existsSync(STORAGE_DIR)) {
  console.error(`Error: Storage directory not found at: ${STORAGE_DIR}`);
  process.exit(1);
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

function getFilesRecursively(dir, maxDepth = 3, currentDepth = 0) {
  const results = [];
  if (currentDepth > maxDepth || !fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'temp_downloads') {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getFilesRecursively(fullPath, maxDepth, currentDepth + 1));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

async function syncDriveDFiles() {
  console.log(`Scanning "${STORAGE_DIR}" for files...`);
  const allFiles = getFilesRecursively(STORAGE_DIR);

  if (allFiles.length === 0) {
    console.log(`No files found in ${STORAGE_DIR}`);
    return;
  }

  console.log(`Found ${allFiles.length} file(s) to sync to Telegram Cloud Vault.`);

  for (const fullPath of allFiles) {
    const fileName = path.basename(fullPath);
    const ext = fileName.split('.').pop().toLowerCase();
    const cat = getFileCategory(ext);

    console.log(`Uploading ${fileName} [Category: ${cat.name}] to Telegram...`);
    try {
      await bot.api.sendDocument(allowedUserId, new InputFile(fullPath), {
        caption: `${cat.icon} Synced from Drive D: ${fileName}`,
      });
      console.log(`Successfully uploaded: ${fileName}`);
    } catch (err) {
      console.error(`Failed to upload ${fileName}:`, err.message);
    }
  }

  console.log('All files from Drive D synced to Telegram Cloud Vault!');
}

syncDriveDFiles();
