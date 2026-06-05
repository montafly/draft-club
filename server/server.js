// Реалтайм-сервер драфта: HTTP (клиент) + WebSocket (много комнат по коду).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

const rooms = new Map(); // code -> { room, clients:Set<ws> }
function makeCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => a[Math.floor(Math.random() * a.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

// --- HTTP: статика из public ---
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (file.endsWith('/')) file += 'index.html';
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

const wss = new WebSocketServer({ server });

function broadcast(code) {
  const e = rooms.get(code);
  if (!e) return;
  const msg = JSON.stringify({ type: 'state', state: e.room.serialize() });
  for (const c of e.clients) if (c.readyState === 1) c.send(msg);
}
function sendErr(ws, message) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message })); }

function attach(ws, code) {
  ws.roomCode = code;
  const e = rooms.get(code);
  e.clients.add(ws);
  ws.send(JSON.stringify({ type: 'room', code }));
  ws.send(JSON.stringify({ type: 'pool', units: e.room.pool, clubOdds: e.room.clubOdds }));
}
function doJoin(ws, name) {
  const e = rooms.get(ws.roomCode);
  const id = e.room.join(String(name || 'Player').slice(0, 24));
  ws.seatId = id;
  ws.send(JSON.stringify({ type: 'joined', you: id }));
  broadcast(ws.roomCode);
}

wss.on('connection', (ws) => {
  ws.roomCode = null; ws.seatId = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'createRoom') {
        const code = makeCode();
        rooms.set(code, { room: new Room(), clients: new Set() });
        attach(ws, code);
        doJoin(ws, msg.name);
      } else if (msg.type === 'joinRoom') {
        const code = String(msg.code || '').toUpperCase();
        if (!rooms.has(code)) return sendErr(ws, 'Комната не найдена');
        attach(ws, code);
        doJoin(ws, msg.name);
      } else {
        const e = rooms.get(ws.roomCode);
        if (!e) return sendErr(ws, 'Сначала создай или войди в комнату');
        if (msg.type === 'ready') { if (ws.seatId) e.room.setReady(ws.seatId, msg.ready !== false); }
        else if (msg.type === 'start') { e.room.start(); }
        else { if (!ws.seatId) throw new Error('вы зритель'); e.room.action(ws.seatId, msg); }
        broadcast(ws.roomCode);
      }
    } catch (err) { sendErr(ws, err.message); }
  });
  ws.on('close', () => {
    const e = rooms.get(ws.roomCode);
    if (!e) return;
    e.clients.delete(ws);
    if (ws.seatId) e.room.disconnect(ws.seatId);
    broadcast(ws.roomCode);
  });
});

server.listen(PORT, () => console.log(`Draft Club сервер: http://localhost:${PORT}`));
