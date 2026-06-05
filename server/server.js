// Реалтайм-сервер драфта: HTTP (отдаёт клиент) + WebSocket (одна комната).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const room = new Room();

// --- HTTP: статика из public ---
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(full);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(data);
  });
});

// --- WebSocket ---
const wss = new WebSocketServer({ server });
const clients = new Set();

function broadcast() {
  const msg = JSON.stringify({ type: 'state', state: room.serialize() });
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}
function sendErr(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message }));
}

wss.on('connection', (ws) => {
  ws.seatId = null;
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'pool', units: room.pool, clubOdds: room.clubOdds }));
  broadcast();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'join') {
        const id = room.join(String(msg.name || 'Player').slice(0, 24));
        ws.seatId = id; // null = спектатор
        ws.send(JSON.stringify({ type: 'joined', you: id }));
      } else if (msg.type === 'ready') {
        if (ws.seatId) room.setReady(ws.seatId, msg.ready !== false);
      } else if (msg.type === 'start') {
        room.start();
      } else { // игровые действия
        if (!ws.seatId) throw new Error('вы спектатор');
        room.action(ws.seatId, msg);
      }
      broadcast();
    } catch (e) {
      sendErr(ws, e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws.seatId) room.disconnect(ws.seatId);
    broadcast();
  });
});

server.listen(PORT, () => {
  console.log(`Draft Club сервер: http://localhost:${PORT}`);
});
