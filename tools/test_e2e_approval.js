/**
 * tools/test_e2e_approval.js
 * 
 * End-to-end live round-trip test:
 * 1. Spins up a test HTTP server with setupLaptopBridge.
 * 2. Connects a test laptop runner client over WebSocket.
 * 3. Tests request_approval RPC task over WebSocket (Runner invokes Python snapshot).
 * 4. Tests APPROVAL_REQUIRED event callback dispatch.
 * 5. Tests approve_step RPC task over WebSocket (Runner executes action and auto-refreshes).
 * 6. Tests Local Loopback IPC HTTP POST -> WebSocket forwarding.
 */

import http from 'http';
import { WebSocket } from 'ws';
import {
  setupLaptopBridge,
  setApprovalRequiredCallback,
  sendLaptopTask,
  sendLaptopApproveStep,
  requestLaptopApproval,
  getExpectedSecret,
} from '../laptop-bridge.js';
import { execFile } from 'child_process';
import path from 'path';

console.log('='.repeat(70));
console.log('🌐 END-TO-END REMOTE APPROVAL BRIDGE & DAEMON VERIFICATION');
console.log('='.repeat(70));

const TEST_PORT = 58992;
const TEST_USER_ID = 8199950189;
const allowedUserIds = new Set([TEST_USER_ID]);

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

const bridgeWss = setupLaptopBridge(server, allowedUserIds);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/ws/laptop-agent') {
    bridgeWss.handleUpgrade(req, socket, head, (ws) => {
      bridgeWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
console.log(`[Bridge Server] Mounted at ws://127.0.0.1:${TEST_PORT}/ws/laptop-agent`);

let receivedApprovalEvents = [];
setApprovalRequiredCallback((userId, data) => {
  console.log(`  📬 [Bridge Callback Triggered] User: ${userId}, Window: "${data.windowTitle}", Type: ${data.type}`);
  receivedApprovalEvents.push({ userId, data });
});

// Run Python helper
function runPython(args) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve('tools', 'request_approval.py');
    execFile('python', [scriptPath, ...args], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (parseErr) {
        reject(new Error(`Failed to parse Python JSON: ${parseErr.message}`));
      }
    });
  });
}

// Connect Runner WebSocket client
const secret = getExpectedSecret();
const wsUrl = `ws://127.0.0.1:${TEST_PORT}/ws/laptop-agent?secret=${encodeURIComponent(secret)}&userId=${TEST_USER_ID}&deviceName=E2E-Laptop&hostname=TestHost&platform=win32`;

const clientWs = new WebSocket(wsUrl);

await new Promise((resolve, reject) => {
  clientWs.on('open', resolve);
  clientWs.on('error', reject);
});

console.log('[Runner Client] Connected to test bridge via WebSocket.');

// Handle tasks on Runner Client exactly as laptop-runner.js does
clientWs.on('message', async (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.id && msg.action) {
      if (msg.action === 'request_approval') {
        const pyRes = await runPython(msg.windowTitle ? ['--title', msg.windowTitle] : []);
        // Emit APPROVAL_REQUIRED event over WS
        clientWs.send(JSON.stringify({
          type: 'APPROVAL_REQUIRED',
          approvalId: msg.id,
          windowTitle: pyRes.windowTitle,
          isDesktopFallback: pyRes.isDesktopFallback,
          bounds: pyRes.bounds,
          image: pyRes.image,
          timestamp: Date.now(),
        }));
        // Reply to task
        clientWs.send(JSON.stringify({
          id: msg.id,
          success: pyRes.success,
          windowTitle: pyRes.windowTitle,
          image: pyRes.image,
        }));
      } else if (msg.action === 'approve_step') {
        const pyRes = await runPython(['--action', 'key', '--key', 'f13', '--refresh']);
        clientWs.send(JSON.stringify({
          id: msg.id,
          success: pyRes.success,
          step: msg.step,
          windowTitle: pyRes.refreshedSnapshot?.windowTitle || 'Refreshed Window',
          image: pyRes.refreshedSnapshot?.image || '',
        }));
      }
    }
  } catch (err) {
    console.error('Runner client error handling message:', err);
  }
});

let passed = 0;
let failed = 0;

// TEST 1: Request approval task from Server to Laptop
console.log('\n[Test 1] Testing requestLaptopApproval RPC over WebSocket...');
try {
  receivedApprovalEvents = [];
  const res = await requestLaptopApproval(TEST_USER_ID, undefined, 15000);
  if (!res.success) throw new Error(`requestLaptopApproval failed: ${res.error}`);
  if (!res.image || res.image.length < 5000) throw new Error('Missing or empty image in response');
  if (receivedApprovalEvents.length === 0) throw new Error('APPROVAL_REQUIRED event callback was not triggered on bridge');
  console.log(`  ✅ RPC task succeeded! Received image (${res.image.length} chars).`);
  console.log(`  ✅ Bridge event callback triggered with window: "${receivedApprovalEvents[0].data.windowTitle}"`);
  passed++;
} catch (err) {
  console.error(`  ❌ Test 1 FAILED: ${err.message}`);
  failed++;
}

// TEST 2: Approve step task from Server to Laptop
console.log('\n[Test 2] Testing sendLaptopApproveStep RPC over WebSocket...');
try {
  const stepRes = await sendLaptopApproveStep(TEST_USER_ID, {
    approvalId: 'test_appr_123',
    step: 'enter',
  }, 15000);
  if (!stepRes.success) throw new Error(`sendLaptopApproveStep failed: ${stepRes.error}`);
  if (!stepRes.image || stepRes.image.length < 5000) throw new Error('Missing refreshed image in step response');
  console.log(`  ✅ Remote approve_step executed! Refreshed image received (${stepRes.image.length} chars).`);
  passed++;
} catch (err) {
  console.error(`  ❌ Test 2 FAILED: ${err.message}`);
  failed++;
}

// TEST 3: Local Loopback IPC Simulation
console.log('\n[Test 3] Testing Local Loopback IPC HTTP POST forwarding to bridge...');
try {
  receivedApprovalEvents = [];
  // Simulate what laptop-runner.js does when an IPC post arrives at 127.0.0.1:52199
  const testIpcPayload = {
    type: 'APPROVAL_REQUIRED',
    approvalId: 'ipc_test_999',
    windowTitle: 'Local Modal Dialog Setup',
    image: 'fake_base64_for_ipc_test_1234567890',
    bounds: { left: 100, top: 100, width: 400, height: 300 },
  };

  // Forward over open WS
  clientWs.send(JSON.stringify(testIpcPayload));

  // Wait briefly for bridge message event
  await new Promise(r => setTimeout(r, 200));

  if (receivedApprovalEvents.length === 0) {
    throw new Error('Bridge did not receive forwarded IPC approval event');
  }
  const lastEvent = receivedApprovalEvents[receivedApprovalEvents.length - 1];
  if (lastEvent.data.approvalId !== 'ipc_test_999') {
    throw new Error(`Expected approvalId ipc_test_999, got ${lastEvent.data.approvalId}`);
  }
  console.log(`  ✅ Loopback IPC event successfully reached bridge via WebSocket!`);
  console.log(`  ✅ Forwarded window title: "${lastEvent.data.windowTitle}"`);
  passed++;
} catch (err) {
  console.error(`  ❌ Test 3 FAILED: ${err.message}`);
  failed++;
}

// Teardown
clientWs.close();
server.close();

console.log('\n' + '='.repeat(70));
console.log(`🏁 E2E RESULTS: ${passed} Passed | ${failed} Failed`);
console.log('='.repeat(70) + '\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
