import { GoogleGenAI } from '@google/genai';
import { spawn } from 'child_process';

/**
 * Supported Gemini Live Voices:
 * - Puck (Warm, expressive neutral/male)
 * - Aoede (Breezy, natural female)
 * - Charon (Deep, steady male)
 * - Fenrir (Authoritative, clear male)
 * - Kore (Bright, professional female)
 */
export const AVAILABLE_VOICES = ['Puck', 'Aoede', 'Charon', 'Fenrir', 'Kore'];
export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';

const userVoicePreferences = new Map(); // userId -> voiceName
const userLiveMode = new Map(); // userId -> boolean

/**
 * Get the user's selected Gemini Live voice
 */
export function getUserVoice(userId) {
  return userVoicePreferences.get(userId) || 'Puck';
}

/**
 * Set the user's selected Gemini Live voice
 */
export function setUserVoice(userId, voiceName) {
  if (AVAILABLE_VOICES.includes(voiceName)) {
    userVoicePreferences.set(userId, voiceName);
    return true;
  }
  return false;
}

/**
 * Check if the user has Live Voice Mode enabled
 */
export function isUserLiveModeEnabled(userId) {
  return !!userLiveMode.get(userId);
}

/**
 * Toggle or set Live Voice Mode for a user
 */
export function setUserLiveMode(userId, enabled) {
  userLiveMode.set(userId, !!enabled);
  return userLiveMode.get(userId);
}

/**
 * Transcode any audio buffer (OGG/OGA/MP3/WAV/AAC) into 16kHz 16-bit mono PCM.
 * Gemini Live expects audio/pcm;rate=16000.
 */
export function audioToPcm16k(audioBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '16000',
      '-ac', '1',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];
    ff.stdout.on('data', (chunk) => chunks.push(chunk));
    ff.stderr.on('data', () => {});
    ff.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
    ff.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`FFmpeg audioToPcm16k failed with exit code ${code}`));
      }
    });

    ff.stdin.write(audioBuffer);
    ff.stdin.end();
  });
}

/**
 * Transcode Gemini Live 24kHz 16-bit mono PCM output into an Opus-encoded OGG voice note.
 * Telegram expects OGG container with Opus audio for native voice messages.
 */
export function pcm24kToOgg(pcmBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-f', 's16le',
      '-ar', '24000',
      '-ac', '1',
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-f', 'ogg',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];
    ff.stdout.on('data', (chunk) => chunks.push(chunk));
    ff.stderr.on('data', () => {});
    ff.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
    ff.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`FFmpeg pcm24kToOgg failed with exit code ${code}`));
      }
    });

    ff.stdin.write(pcmBuffer);
    ff.stdin.end();
  });
}

/**
 * Execute a real-time exchange with Gemini Live API (gemini-3.8-live).
 * Supports both audio input (Telegram voice notes) and text prompts.
 * Returns the spoken reply as an OGG Opus buffer and the real-time transcription.
 *
 * @param {Object} params
 * @param {string} [params.text] - Optional text input
 * @param {Buffer} [params.audioBuffer] - Optional audio input buffer (OGG/MP3/etc.)
 * @param {string} [params.voice] - Voice name (Puck, Aoede, Charon, Fenrir, Kore)
 * @param {string} [params.systemInstruction] - System prompt instructions
 * @param {Function} [params.onTranscriptChunk] - Callback for streaming transcript chunks
 * @param {number} [params.timeoutMs=25000] - Max duration before timeout
 * @returns {Promise<{ replyText: string, voiceBuffer: Buffer|null, success: boolean, error?: string }>}
 */
export async function executeGeminiLiveExchange({
  text,
  audioBuffer,
  voice = 'Puck',
  systemInstruction,
  onTranscriptChunk,
  timeoutMs = 25000,
}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is not configured in environment variables.');
  }

  const ai = new GoogleGenAI({ apiKey });
  let replyText = '';
  const pcmChunks = [];
  let isResolved = false;

  return new Promise(async (resolve, reject) => {
    let timeoutTimer = null;
    let session = null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (session) {
        try {
          session.close?.();
        } catch {}
      }
    };

    const handleSuccess = async () => {
      if (isResolved) return;
      isResolved = true;
      cleanup();

      let voiceBuffer = null;
      if (pcmChunks.length > 0) {
        try {
          const fullPcm = Buffer.concat(pcmChunks);
          voiceBuffer = await pcm24kToOgg(fullPcm);
        } catch (encodeErr) {
          console.warn('[Gemini Live] Failed to encode PCM to OGG:', encodeErr.message);
        }
      }

      resolve({
        replyText: replyText.trim(),
        voiceBuffer,
        success: true,
      });
    };

    const handleError = (err) => {
      if (isResolved) return;
      isResolved = true;
      cleanup();
      reject(err);
    };

    timeoutTimer = setTimeout(() => {
      if (replyText.length > 0 || pcmChunks.length > 0) {
        // Return partial result if timeout hit after receiving content
        handleSuccess();
      } else {
        handleError(new Error('Gemini Live session timed out waiting for response.'));
      }
    }, timeoutMs);

    try {
      const activeVoice = AVAILABLE_VOICES.includes(voice) ? voice : 'Puck';

      session = await ai.live.connect({
        model: DEFAULT_LIVE_MODEL,
        config: {
          responseModalities: ['audio'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: activeVoice,
              },
            },
          },
          systemInstruction: {
            parts: [
              {
                text:
                  systemInstruction ||
                  'You are a warm, witty, and highly intelligent real-time AI assistant on Telegram. ' +
                  'Keep spoken answers concise, conversational, engaging, and directly helpful.',
              },
            ],
          },
        },
        callbacks: {
          onmessage: (msg) => {
            const content = msg.serverContent;
            if (content?.outputTranscription) {
              const chunk = content.outputTranscription.text;
              replyText += chunk;
              if (onTranscriptChunk) {
                try {
                  onTranscriptChunk(chunk, replyText);
                } catch {}
              }
            }

            if (content?.modelTurn?.parts) {
              for (const p of content.modelTurn.parts) {
                if (p.inlineData?.data) {
                  pcmChunks.push(Buffer.from(p.inlineData.data, 'base64'));
                }
              }
            }

            if (content?.turnComplete) {
              handleSuccess();
            }
          },
          onerror: (err) => {
            console.error('[Gemini Live Error]:', err);
            handleError(err);
          },
          onclose: (event) => {
            if (event?.code === 1011 || (event?.reason && event.reason.includes('quota'))) {
              handleError(new Error(`Gemini Live Quota Exceeded: ${event.reason || 'Check your Gemini API quota.'}`));
            } else if (!isResolved && (replyText.length > 0 || pcmChunks.length > 0)) {
              handleSuccess();
            } else if (!isResolved) {
              handleError(new Error(`Gemini Live WebSocket closed prematurely (code ${event?.code || 'unknown'})`));
            }
          },
        },
      });

      // Stream input into Gemini Live
      if (audioBuffer) {
        const pcm16k = await audioToPcm16k(audioBuffer);
        const chunkSize = 3200; // ~100ms chunks at 16kHz 16-bit mono
        for (let i = 0; i < pcm16k.length; i += chunkSize) {
          const chunk = pcm16k.slice(i, i + chunkSize);
          session.sendRealtimeInput({
            audio: {
              data: chunk.toString('base64'),
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        }
        session.sendRealtimeInput({ audioStreamEnd: true });
      } else if (text) {
        session.sendRealtimeInput({ text });
      } else {
        handleError(new Error('Neither text nor audioBuffer was provided to executeGeminiLiveExchange.'));
      }
    } catch (err) {
      handleError(err);
    }
  });
}
