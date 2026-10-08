'use strict';
// In-memory observation fixture: no DB, secrets, outbound clients or application imports.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function choice(value, fallback, allowed) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new Error('Invalid non-secret fixture setting');
  return value;
}
function integer(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error('Invalid numeric fixture setting');
  return Number(value);
}
const testVersion = choice(process.env.TEST_VERSION, 'env-a', ['env-a', 'env-b', 'env-c', 'env-d', 'env-e', 'env-f']);
const workerEnabled = choice(process.env.WORKER_ENABLED, 'false', ['false', 'true']) === 'true';
const shutdownMode = choice(process.env.SHUTDOWN_MODE, 'drain', ['drain', 'immediate']);
const drainMs = integer(process.env.DRAIN_MS, 25000, 100, 25000);
const port = integer(process.env.PORT, 10000, 0, 65535);
const host = choice(process.env.BIND_HOST, '0.0.0.0', ['0.0.0.0', '127.0.0.1']);
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !/^--command-tag=(baseline|command-b|suspended-command)$/.test(args[0]))) throw new Error('Invalid fixture command');
const commandTag = args[0] ? args[0].split('=')[1] : 'baseline';
const build = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-receipt.json'), 'utf8'));
const sourceVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'source-version.json'), 'utf8')).sourceVersion;
if (build.sourceVersion !== sourceVersion || !['fixture-v1', 'fixture-v2'].includes(sourceVersion)) throw new Error('Build/source fixture mismatch');
const startupId = randomUUID();
const startedAt = new Date().toISOString();
const runtimeCommit = /^[a-f0-9]{40}$/i.test(process.env.RENDER_GIT_COMMIT || '') ? process.env.RENDER_GIT_COMMIT : null;
const instanceId = /^[a-zA-Z0-9_-]{1,160}$/.test(process.env.RENDER_INSTANCE_ID || '') ? process.env.RENDER_INSTANCE_ID : null;
const identity = { startupId, instanceId, runtimeCommit, buildId: build.buildId, sourceVersion, testVersion, workerEnabled, commandTag };
let stopping = false;
let shutdownReason = null;
let task = null;
let workerTicks = 0;
let serverClosed = false;
let exiting = false;
let deadline;
const events = [];
function log(event, fields = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...identity, ...fields };
  events.push(entry);
  if (events.length > 100) events.shift();
  // Small synchronous lines make the exit-path receipt less vulnerable to stdio buffering.
  fs.writeSync(1, JSON.stringify(entry) + '\n');
}
function dummyFileStatus() {
  try {
    const value = fs.readFileSync('/etc/secrets/lifecycle-marker.txt', 'utf8');
    return { present: true, marker: ['dummy-a', 'dummy-b'].includes(value.trim()) ? value.trim() : 'unexpected' };
  } catch (e) {
    return { present: false, marker: null };
  }
}
function status() {
  return { timestamp: new Date().toISOString(), ...identity, startedAt, uptimeMs: Math.round(process.uptime() * 1000),
    runtimeNodeVersion: process.version, dummyFile: dummyFileStatus(), build, shutdownMode, drainMs, stopping, workerTicks,
    activeTask: task ? { id: task.id, kind: task.kind, startedAt: task.startedAt, durationMs: task.durationMs } : null };
}
function json(res, code, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
  res.end(JSON.stringify(body, null, 2));
}
function finishShutdown(reason, code = 0) {
  if (exiting) return;
  exiting = true;
  clearTimeout(deadline);
  clearInterval(heartbeat);
  clearInterval(worker);
  if (task) {
    clearTimeout(task.timer);
    log('task_abandoned', { taskId: task.id, kind: task.kind, reason });
    if (task.response) json(task.response, 503, { outcome: 'abandoned', startupId, taskId: task.id });
    task = null;
  }
  log('shutdown', { reason, exitCode: code, serverClosed });
  server.closeAllConnections();
  process.exit(code);
}
function maybeFinish() {
  if (stopping && !task && serverClosed) finishShutdown('drained');
}
function beginTask(kind, durationMs, response) {
  if (stopping || task) return null;
  const current = { id: randomUUID(), kind, startedAt: new Date().toISOString(), durationMs, response };
  task = current;
  log('task_started', { taskId: current.id, kind, durationMs });
  current.timer = setTimeout(() => {
    if (task !== current) return;
    task = null;
    log('task_completed', { taskId: current.id, kind });
    if (response) json(response, 200, { outcome: 'completed', startupId, taskId: current.id });
    maybeFinish();
  }, durationMs);
  if (response) response.on('close', () => {
    if (task === current && !response.writableEnded) log('task_client_closed', { taskId: current.id, kind });
    // A disconnected browser does not cancel synthetic in-flight work.
  });
  return current.id;
}
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Disposable lifecycle fixture</title>
<style>body{font:16px system-ui;max-width:1000px;margin:30px auto;padding:16px}button{padding:10px;margin:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f4f6;padding:15px}</style>
<h1>Disposable lifecycle fixture</h1><p>Non-secret observations only. All buttons call this service on the same origin. No external assets or APIs.</p>
<button id="refresh">Refresh status</button><button id="worker">Start one 120-second synthetic worker task</button>
<button id="http">Start one 20-second in-flight HTTP task</button><button id="events">Show recent local events</button>
<p>No automatic polling. Refresh status every 5 seconds during active tests to avoid idle spin-down. Copy receipts before replacement; memory is ephemeral.</p><pre id="out">Loading…</pre>
<script>
async function show(url, options) {try {const response = await fetch(url, options); document.getElementById('out').textContent = JSON.stringify(await response.json(), null, 2);} catch {document.getElementById('out').textContent = 'Request failed. Inspect instance-scoped logs; this is not termination evidence.';}}
document.getElementById('refresh').onclick = () => show('/status');
document.getElementById('events').onclick = () => show('/events');
document.getElementById('worker').onclick = () => show('/task?seconds=120', {method:'POST'});
document.getElementById('http').onclick = () => show('/inflight?seconds=20');
show('/status');
</script></html>`;
const server = http.createServer((req, res) => {
  // Parse only a bounded path; never log headers, body, cookies, origin, IP or arbitrary input.
  if (!req.url || req.url.length > 256) { json(res, 400, { error: 'invalid_path' }); return; }
  let url;
  try { url = new URL(req.url, 'http://fixture.invalid'); } catch { json(res, 400, { error: 'invalid_path' }); return; }
  if (stopping) { json(res, 503, { error: 'shutting_down', startupId }); return; }
  if (req.method === 'GET' && ['/status', '/health'].includes(url.pathname)) { json(res, 200, status()); return; }
  if (req.method === 'GET' && url.pathname === '/events') { json(res, 200, { startupId, events }); return; }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(page); return;
  }
  if ((req.method === 'POST' && url.pathname === '/task') || (req.method === 'GET' && url.pathname === '/inflight')) {
    // Reject cross-origin browser task creation; no CORS, no body and one task maximum.
    if (req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { error: 'cross_origin' }); return; }
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) { json(res, 403, { error: 'cross_origin' }); return; } }
      catch { json(res, 403, { error: 'cross_origin' }); return; }
    }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) { json(res, 400, { error: 'no_body_allowed' }); return; }
    const kind = url.pathname === '/task' ? 'worker' : 'http';
    if (kind === 'worker' && !workerEnabled) { json(res, 409, { error: 'worker_disabled', startupId, workerEnabled }); return; }
    const seconds = url.searchParams.get('seconds') || '20';
    if (!/^\d+$/.test(seconds) || Number(seconds) < 1 || Number(seconds) > 120 || [...url.searchParams.keys()].some(key => key !== 'seconds') || url.searchParams.getAll('seconds').length > 1) {
      json(res, 400, { error: 'duration_must_be_1_to_120_seconds' }); return;
    }
    if (task) { json(res, 409, { error: 'task_already_active', startupId }); return; }
    const id = beginTask(kind, Number(seconds) * 1000, kind === 'http' ? res : null);
    if (kind === 'worker') json(res, 202, { taskId: id, startupId, durationMs: Number(seconds) * 1000 });
    return;
  }
  json(res, 404, { error: 'fixture_route_not_found' });
});
server.keepAliveTimeout = 1000;
server.headersTimeout = 5000;
server.requestTimeout = 10000;
server.maxConnections = 16;
server.on('error', error => { log('server_error', { reason: 'listen_or_runtime_error', errorCode: ['EPERM', 'EACCES', 'EADDRINUSE'].includes(error.code) ? error.code : 'other' }); process.exit(1); });
const heartbeat = setInterval(() => log('heartbeat', { stopping, workerTicks, taskId: task ? task.id : null }), 5000);
const worker = workerEnabled ? setInterval(() => { if (!stopping) { workerTicks++; log('worker_tick', { workerTicks }); } }, 10000) : undefined;
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('exit', code => log('process_exit', { exitCode: code, shutdownReason }));
function stop(signal) {
  log(signal, { alreadyStopping: stopping, activeTaskId: task ? task.id : null });
  if (stopping) return;
  stopping = true;
  shutdownReason = signal;
  clearInterval(worker);
  log('shutdown_started', { shutdownMode, drainMs });
  server.close(() => { serverClosed = true; maybeFinish(); });
  if (shutdownMode === 'immediate') { finishShutdown('immediate'); return; }
  deadline = setTimeout(() => finishShutdown('drain_deadline', 2), drainMs);
  maybeFinish();
}
server.listen(port, host, () => log('startup', { startedAt, port: server.address().port, host, shutdownMode, drainMs, build }));
