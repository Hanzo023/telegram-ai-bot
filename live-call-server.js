import { WebSocketServer } from 'ws';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_LIVE_MODEL, AVAILABLE_VOICES } from './gemini-live-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIVE_CALL_HTML_PATH = path.resolve(__dirname, 'live-call.html');

/**
 * Attach the Gemini Live WebApp & WebSocket duplex audio bridge to the HTTP server
 * @param {import('http').Server} server
 */
export function setupLiveCallServer(server) {
  // 1. HTTP route intercept for /live-call and /live-call.html
  const originalListeners = server.listeners('request').slice(0);
  server.removeAllListeners('request');

  server.on('request', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/live-call' || url.pathname === '/live-call.html') {
      try {
        if (fs.existsSync(LIVE_CALL_HTML_PATH)) {
          const html = fs.readFileSync(LIVE_CALL_HTML_PATH, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          return res.end(html);
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end(`Error reading live-call.html: ${err.message}`);
      }
    }

    // Pass through to original health check listener
    for (const listener of originalListeners) {
      listener(req, res);
    }
  });

  // 2. WebSocket server for duplex audio
  const wss = new WebSocketServer({ server, path: '/ws/live-call' });

  wss.on('connection', async (ws, req) => {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      ws.send(JSON.stringify({ type: 'status', text: 'Error: GEMINI_API_KEY missing on server.' }));
      ws.close();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const voiceParam = url.searchParams.get('voice');
    const activeVoice = AVAILABLE_VOICES.includes(voiceParam) ? voiceParam : 'Puck';

    console.log(`[Live Call] New real-time duplex voice connection started (voice: ${activeVoice})`);

    const ai = new GoogleGenAI({ apiKey });
    let liveSession = null;
    let isTerminated = false;

    try {
      liveSession = await ai.live.connect({
        model: DEFAULT_LIVE_MODEL,
        config: {
          responseModalities: ['audio'],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
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
                  'You are a real-time conversational AI agent on Telegram voice call. ' +
                  'Respond directly, warmly, and concisely in human conversational spoken language.',
              },
            ],
          },
        },
        callbacks: {
          onmessage: (msg) => {
            if (isTerminated) return;
            const content = msg.serverContent;

            // Stream transcription text
            if (content?.outputTranscription) {
              if (ws.readyState === ws.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: 'transcript',
                    text: content.outputTranscription.text,
                  })
                );
              }
            }

            // Stream binary PCM audio chunks back to browser/phone
            if (content?.modelTurn?.parts) {
              for (const p of content.modelTurn.parts) {
                if (p.inlineData?.data && ws.readyState === ws.OPEN) {
                  const audioBuf = Buffer.from(p.inlineData.data, 'base64');
                  ws.send(audioBuf);
                }
              }
            }
          },
          onerror: (err) => {
            console.error('[Live Call WebSocket Error]:', err);
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'status', text: `Gemini Error: ${err.message || 'Connection error'}` }));
            }
          },
          onclose: (e) => {
            console.log('[Live Call] Gemini Live session ended', e?.reason || '');
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'status', text: 'Call session ended.' }));
              ws.close();
            }
          },
        },
      });

      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'status', text: 'Gemini 3.8 Live connected! Listening...' }));
      }
    } catch (connErr) {
      console.error('[Live Call Connection Failed]:', connErr);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'status', text: `Failed to connect to Live API: ${connErr.message}` }));
        ws.close();
      }
      return;
    }

    // Forward incoming microphone PCM from client to Gemini Live
    ws.on('message', (data, isBinary) => {
      if (isTerminated || !liveSession) return;
      if (isBinary) {
        // Data is ArrayBuffer/Buffer of 16kHz 16-bit mono PCM from user's microphone
        try {
          liveSession.sendRealtimeInput({
            audio: {
              data: data.toString('base64'),
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        } catch (sendErr) {
          console.warn('[Live Call] Error forwarding mic chunk:', sendErr.message);
        }
      } else {
        // Client sent text control
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'text') {
            liveSession.sendRealtimeInput({ text: parsed.text });
          }
        } catch {}
      }
    });

    const cleanup = () => {
      if (isTerminated) return;
      isTerminated = true;
      console.log('[Live Call] Client disconnected; terminating Gemini Live session.');
      try {
        liveSession?.close?.();
      } catch {}
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  console.log('[Live Call Server] WebSocket duplex bridge mounted at /ws/live-call and /live-call');
}
