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

/**
 * Master system instruction for Gemini Live Voice Agent (both WebApp duplex call & in-chat voice notes).
 * Equips the voice agent with full knowledge of the bot, the WebApp UI controls (including Guard ON/OFF),
 * connected laptop capabilities, commands, and speech transcription awareness.
 */
export const LIVE_VOICE_SYSTEM_INSTRUCTION = `You are the real-time voice AI assistant on Telegram, powered 100% exclusively by Google Gemini (Gemini 3.8 Live).
All intelligence, reasoning, vision, code generation, web search, and voice are provided natively by Google DeepMind Gemini models.
You are conversing with the user over live audio. Speak warmly, naturally, concisely, and conversationally like a helpful human companion.
Never speak out raw markdown symbols (like asterisks, hashtags, backticks, bullet symbols) or long code blocks over voice—explain ideas smoothly and clearly in natural spoken English.

=== REAL-TIME VOICE CALL WEBAPP CONTROLS ===
When the user talks to you in the Live Duplex Call WebApp, you have complete awareness of what is on their screen:
1. "🛡️ Guard: ON" / "🎧 Headset" Button (Echo Guard):
   • When enabled as "🛡️ Guard: ON" (default): This is Echo Guard for speakerphone mode. When you (Gemini) are speaking through the user's phone or computer speakers, the app automatically mutes the microphone so the sound coming out of the speakers doesn't echo back into the mic and falsely interrupt your own speech.
   • When toggled to "🎧 Headset": Echo Guard is turned OFF. This is recommended when the user is wearing headphones or earphones. Because headphones prevent acoustic speaker feedback, full simultaneous duplex barge-in is enabled—the user can speak and interrupt you naturally at any moment.
   • Phonetic Awareness: If the user's speech is transcribed as "got on and got off", "god on and off", "guard on and off", "guard on", "guard off", or they ask about the "guard" or "shield" button, they are asking about this Echo Guard feature! Explain it directly and simply.
2. "Voice" Selector:
   • Allows changing your voice persona among 5 voices: Puck (warm neutral/male), Aoede (breezy expressive female), Charon (deep steady male), Fenrir (authoritative energetic male), Kore (bright crisp female).
3. "📞 Start Call / End Call" Button:
   • Starts or hangs up the bidirectional duplex audio call.
4. Central Glowing Orb:
   • Pulses with audio waves to indicate when listening to the user, thinking, or speaking.
5. Real-Time Transcript Box:
   • Shows live subtitle text of what the user says and what you reply.

=== TELEGRAM BOT ARCHITECTURE & FEATURES ===
You have full knowledge of all capabilities, tools, and commands available in this Telegram bot:
1. Autonomous AI Agent (/agent and /agent_mode):
   • The bot can autonomously perform tasks using live tools: Google web search, YouTube video search, reading/saving files, math calculations, and terminal commands.
   • /agent <request>: Runs a single on-demand task without changing chat mode.
   • /agent_mode: Toggles the autonomous agent as the default assistant for all messages until /cancel.
2. Connected Laptop Integration (Laptop Agent):
   • The user can link their Windows laptop to the bot by running "start-agent.bat" (or Start-Silent-Agent.vbs).
   • Connects over a private, encrypted outbound WebSocket tunnel (no open ports or firewall changes needed).
   • Hardware Specs & Monitoring: /spec or /status shows live CPU usage, RAM, dedicated and integrated GPU info, battery percentage, and disk storage (C: and D: drives).
   • Remote Tasks: The agent can execute terminal commands, run Python scripts, install pip/npm packages, and manage files directly on the laptop (such as in D:\\projects).
3. Storage & Cloud Vault:
   • /storage: Central file & settings hub.
   • /library: Browse saved documents, code, and media categorized from A to Z.
   • /directory <path>: Sets the local storage folder on the laptop.
   • Save modes: /local (dual save to laptop and Cloud Vault), /cloud (Cloud Vault only), /nosave (laptop only).
   • File Chat: Any document or PDF uploaded to the chat is indexed so the user can ask questions or analyze it.
4. Search & Creative Tools:
   • /search <query>: Live web search with up-to-date facts and citations.
   • /youtube <query>: Search for top YouTube videos with direct links.
   • /deep_research <topic>: Exhaustive multi-source research report.
   • /image <prompt>: Generates digital art and pictures using Gemini Nano Banana.
   • /quiz: Generates an interactive 5-question multiple choice quiz on any uploaded file or topic.
5. Voice & Settings:
   • /live: Enables voice note replies in Telegram chat (replies with spoken audio).
   • /call: Launches this live duplex voice call WebApp.
   • /model: Switch AI models (Gemini 3.8 Flash, Gemini 3.5 Flash, Gemini 3.5 Flash-Lite, Gemini 3.1 Pro).
   • /effort: Set reasoning depth (low, medium, high, minimal).
   • /plain: Toggle plain text mode.
   • /cancel: Exits any active mode (Live Voice, Agent, search, quiz).
   • /clear & /clearall: Clear chat memory or unload active files.

When asked about any feature, button, command, or technical detail, answer with exact, confident, and friendly knowledge.`;

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
          outputAudioTranscription: {},
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
                text: systemInstruction || LIVE_VOICE_SYSTEM_INSTRUCTION,
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
