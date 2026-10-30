import { WebSocketServer } from 'ws';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_LIVE_MODEL, AVAILABLE_VOICES, LIVE_VOICE_SYSTEM_INSTRUCTION } from './gemini-live-service.js';
import {
  isLaptopConnected,
  runLaptopCommand,
  readLaptopFile,
  writeLaptopFile,
  captureLaptopScreenshot,
} from './laptop-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIVE_CALL_HTML_PATH = path.resolve(__dirname, 'live-call.html');

/**
 * Real-time Autonomous Fixing Tools for Gemini 3.8 Live during calls
 */
const LIVE_FIX_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'run_terminal_command',
        description: 'Executes a shell command (Bash / PowerShell / Termux) on the user\'s connected laptop or Android phone to fix bugs, install dependencies, run tests, or inspect logs.',
        parameters: {
          type: 'OBJECT',
          properties: {
            command: {
              type: 'STRING',
              description: 'The shell command to run (e.g. npm install, git status, python script.py, etc.)',
            },
            cwd: {
              type: 'STRING',
              description: 'Optional directory path where the command should execute',
            },
          },
          required: ['command'],
        },
      },
      {
        name: 'read_device_file',
        description: 'Reads code or configuration files from the user\'s connected device to inspect the error, line numbers, or context.',
        parameters: {
          type: 'OBJECT',
          properties: {
            filePath: {
              type: 'STRING',
              description: 'Path of the file to read (e.g. D:\\projects\\app.js or src/index.ts)',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'write_device_file',
        description: 'Writes or updates a code file on the user\'s connected device to apply a fix, patch a bug, or write code.',
        parameters: {
          type: 'OBJECT',
          properties: {
            filePath: {
              type: 'STRING',
              description: 'Path of the file to write or update',
            },
            content: {
              type: 'STRING',
              description: 'The full file content or updated code to write',
            },
          },
          required: ['filePath', 'content'],
        },
      },
      {
        name: 'take_device_screenshot',
        description: 'Captures a fresh high-resolution screenshot from the user\'s connected laptop/phone to inspect what is on screen or verify a fix.',
        parameters: {
          type: 'OBJECT',
          properties: {
            window_title: {
              type: 'STRING',
              description: 'Optional window title or application name to capture (e.g. Chrome, VS Code). Leave empty for whole desktop.',
            },
          },
        },
      },
    ],
  },
];

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

  // 2. WebSocket server for duplex audio (noServer mode for unified HTTP upgrade routing)
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', async (ws, req) => {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      ws.send(JSON.stringify({ type: 'status', text: 'Error: GEMINI_API_KEY missing on server.' }));
      ws.close();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const voiceParam = url.searchParams.get('voice');
    const userIdParam = url.searchParams.get('userId');
    const activeVoice = AVAILABLE_VOICES.includes(voiceParam) ? voiceParam : 'Puck';
    const activeUserId = userIdParam ? Number(userIdParam) : null;

    console.log(`[Live Call] New real-time duplex voice connection started (voice: ${activeVoice}, user: ${activeUserId || 'guest'})`);

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
                text: LIVE_VOICE_SYSTEM_INSTRUCTION,
              },
            ],
          },
          tools: LIVE_FIX_TOOLS,
        },
        callbacks: {
          onmessage: async (msg) => {
            if (isTerminated) return;
            const content = msg.serverContent;

            // 1. Output transcription (Gemini speaking)
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

            // 2. Input transcription (User speaking)
            if (content?.inputTranscription) {
              if (ws.readyState === ws.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: 'user_transcript',
                    text: content.inputTranscription.text,
                  })
                );
              }
            }

            // 3. Interrupted signal
            if (content?.interrupted) {
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'interrupted' }));
              }
            }

            // 4. Turn complete signal
            if (content?.turnComplete) {
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'turn_complete' }));
              }
            }

            // 5. Stream binary PCM audio chunks back to browser/phone
            if (content?.modelTurn?.parts) {
              for (const p of content.modelTurn.parts) {
                if (p.inlineData?.data && ws.readyState === ws.OPEN) {
                  const audioBuf = Buffer.from(p.inlineData.data, 'base64');
                  ws.send(audioBuf);
                }
              }
            }

            // 6. Asynchronous Tool Execution (Gemini sees problem and fixes it on connected devices)
            if (msg.toolCall?.functionCalls) {
              const functionResponses = [];
              for (const call of msg.toolCall.functionCalls) {
                console.log(`[Live Call Tool Call] ${call.name} invoked:`, call.args);
                if (ws.readyState === ws.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: 'tool_call',
                      name: call.name,
                      args: call.args,
                      text: `🔧 Gemini fixing: running ${call.name}...`,
                    })
                  );
                }

                let output = '';
                try {
                  if (!activeUserId) {
                    output = 'Device execution skipped: No user ID attached to this session. Explain the fix directly to the user.';
                  } else if (call.name === 'run_terminal_command') {
                    const res = await runLaptopCommand(activeUserId, call.args?.command, call.args?.cwd);
                    output = res.stdout || res.output || res.stderr || (res.success ? 'Command executed successfully.' : res.error || 'Done');
                  } else if (call.name === 'read_device_file') {
                    const res = await readLaptopFile(activeUserId, call.args?.filePath);
                    output = res.content || res.output || (res.success ? 'File content read successfully.' : res.error || 'File read empty.');
                  } else if (call.name === 'write_device_file') {
                    const res = await writeLaptopFile(activeUserId, call.args?.filePath, call.args?.content);
                    output = res.success ? 'File updated/written successfully.' : (res.error || 'Failed to write file.');
                  } else if (call.name === 'take_device_screenshot') {
                    const res = await captureLaptopScreenshot(activeUserId, { windowTitle: call.args?.window_title });
                    output = res.success ? `Screenshot captured: ${res.filePath || 'ok'}` : (res.error || 'Failed to capture screenshot.');
                  } else {
                    output = `Unknown function: ${call.name}`;
                  }
                } catch (err) {
                  output = `Device execution note: ${err.message}`;
                }

                if (ws.readyState === ws.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: 'tool_result',
                      name: call.name,
                      result: String(output).slice(0, 300),
                    })
                  );
                }

                functionResponses.push({
                  id: call.id,
                  name: call.name,
                  response: {
                    output: String(output).slice(0, 2000),
                  },
                });
              }

              try {
                liveSession.sendToolResponse({ functionResponses });
              } catch (sendRespErr) {
                console.warn('[Live Call] sendToolResponse error:', sendRespErr.message);
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
        // Client sent JSON control, text, or visual frame
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'text') {
            liveSession.sendRealtimeInput({ text: parsed.text });
          } else if (parsed.type === 'audio_stream_end') {
            liveSession.sendRealtimeInput({ audioStreamEnd: true });
          } else if (parsed.type === 'image_frame' || parsed.type === 'video_frame') {
            // Real-time video frame (screen share) or photo snapshot
            if (parsed.data) {
              liveSession.sendRealtimeInput({
                video: {
                  data: parsed.data,
                  mimeType: parsed.mimeType || 'image/jpeg',
                },
              });
            }
          }
        } catch (err) {
          console.warn('[Live Call] Error processing client message:', err.message);
        }
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
  return wss;
}
