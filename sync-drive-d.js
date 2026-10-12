import 'dotenv/config';
import { Bot, InputFile } from 'grammy';
import fs from 'fs';
import path from 'path';

const STORAGE_DIR = process.env.STORAGE_DIR || 'D:\\drive-download-20260715T073323Z-1-001';
const rawAllowedId = (process.env.ALLOWED_USER_ID || '').trim();
const allowedUserId = rawAllowedId ? parseInt(rawAllowedId, 10) : null;

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

const SUPPORTED_EXTENSIONS = [
  'py', 'java', 'cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'js', 'ts', 'cs', 'go', 'rs', 'html', 'css', 'sql',
  'pdf', 'txt', 'md'
];

async function syncDriveDFiles() {
  console.log(`Scanning "${STORAGE_DIR}" for files...`);
  const entries = fs.readdirSync(STORAGE_DIR, { withFileTypes: true });
  const filesToSync = [];

  for (const entry of entries) {
    if (entry.isFile() && !entry.name.startsWith('.')) {
      const ext = entry.name.split('.').pop().toLowerCase();
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        filesToSync.push(entry.name);
      }
    }
  }

  if (filesToSync.length === 0) {
    console.log(`No supported files found in ${STORAGE_DIR}`);
    return;
  }

  console.log(`Found ${filesToSync.length} file(s) to sync to Telegram Cloud Vault:`, filesToSync);

  for (const fileName of filesToSync) {
    const filePath = path.join(STORAGE_DIR, fileName);
    console.log(`Uploading ${fileName} to Telegram...`);
    try {
      await bot.api.sendDocument(allowedUserId, new InputFile(filePath), {
        caption: `Synced from Drive D: ${fileName}`,
      });
      console.log(`Successfully uploaded: ${fileName}`);
    } catch (err) {
      console.error(`Failed to upload ${fileName}:`, err.message);
    }
  }

  console.log('All files from Drive D synced to Telegram Cloud Vault!');
}

syncDriveDFiles();
