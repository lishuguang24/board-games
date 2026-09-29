#!/usr/bin/env node
/**
 * 黑白棋 · 双人对战服务器（零依赖，Node >= 16）
 *
 *   启动:  node othello-server.js     （端口默认 3889，可用 PORT=xx 覆盖）
 *
 * - 房间制 + SSE 实时推送 + HTTP POST 提交，服务器权威判定
 * - 每步棋附带浅层搜索形势预测（黑方胜率）
 * - 自动跳过（Pass）、认输、再战换边、观战、断线重连
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3889;
const CLIENT_FILE = path.join(__dirname, '黑白棋-联机对战.html');

/* ---------- 从客户端页面提取游戏核心（规则单一来源） ---------- */
const coreJs = fs.readFileSync(CLIENT_FILE, 'utf8')
  .match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const coreCtx = {};
vm.runInNewContext(coreJs, coreCtx);
vm.runInNewContext('globalThis.__C = { Othello, blackWinPct, evalDetail };', coreCtx);
const { Othello, blackWinPct, evalDetail } = coreCtx.__C;

/* ---------- 工具 ---------- */
const rid = () => crypto.randomBytes(9).toString('base64url');
const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12) || '玩家';
const cleanText = s => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, 300);

/* ---------- 房间 ---------- */
const rooms = new Map();
const MAX_ROOMS = 500;

function newRoom() {
  if (rooms.size >= MAX_ROOMS) throw new Error('服务器房间已满，请稍后再试');
  let code;
  do { code = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms.has(code));
  const room = {
    code,
    players: [null, null],        // seat0=黑(先手), seat1=白
    conns: new Map(),             // pid -> {res, sid, name, seat}
    chat: [],
    rematchVotes: new Set(),
    game: new Othello(),
    evalPct: 50,
    evalTag: '',
    seatTimers: [null, null],
    lastTouch: Date.now(),
  };
  rooms.set(code, room);
  return room;
}
function getRoom(code) { return rooms.get(code) || null; }
function touch(room) { room.lastTouch = Date.now(); }

function seatViews(room) {
  return room.players.map((p, i) => p
    ? { name: p.name, online: p.online, side: i + 1 }
    : null);
}
function specCount(room) {
  let n = 0;
  for (const c of room.conns.values()) if (c.seat < 0) n++;
  return n;
}
function seatOf(room, conn) {
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (p && p.sid === conn.sid) return i;
  }
  return -1;
}
function sidOf(room, sid) {
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (p && p.sid === sid) return i + 1;
  }
  return 0;
}
function sysChat(room, text) {
  const msg = { sys: true, text, ts: Date.now() };
  room.chat.push(msg);
  if (room.chat.length > 100) room.chat.shift();
  broadcast(room, 'chat', msg);
}

/* ---------- SSE ---------- */
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(room, event, data) {
  for (const c of room.conns.values()) {
    try { send(c.res, event, data); } catch (e) { /* close 时清理 */ }
  }
}
function broadcastState(room) {
  broadcast(room, 'state', {
    state: room.game.toJSON(),
    evalPct: room.evalPct,
    evalTag: room.evalTag,
    rematchVotes: [...room.rematchVotes].map(sid => sidOf(room, sid)).filter(Boolean),
  });
}
function broadcastRoom(room) {
  for (const c of room.conns.values()) {
    const seat = seatOf(room, c);
    send(c.res, 'room', {
      seats: seatViews(room),
      specCount: specCount(room),
      yourSide: seat >= 0 ? seat + 1 : 0,
    });
  }
}
function sendHello(room, conn) {
  const seat = seatOf(room, conn);
  send(conn.res, 'hello', {
    pid: conn.pid,
    role: seat >= 0 ? 'player' : 'spec',
    side: seat >= 0 ? seat + 1 : 0,
    seats: seatViews(room),
    specCount: specCount(room),
    state: room.game.toJSON(),
    evalPct: room.evalPct,
    evalTag: room.evalTag,
    rematchVotes: [...room.rematchVotes].map(sid => sidOf(room, sid)).filter(Boolean),
    chat: room.chat.slice(-40),
  });
}

/* ---------- 加入 / 离开 ---------- */
function joinStream(room, conn) {
  let seat = -1;
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (p && p.sid === conn.sid) {
      seat = i;
      clearTimeout(room.seatTimers[i]);
      room.seatTimers[i] = null;
      p.online = true;
      p.name = conn.name;
      break;
    }
  }
  if (seat < 0) {
    for (let i = 0; i < 2; i++) {
      if (!room.players[i]) {
        room.players[i] = { sid: conn.sid, name: conn.name, online: true };
        seat = i;
        break;
      }
    }
  }
  conn.seat = seat;
  room.conns.set(conn.pid, conn);
  sendHello(room, conn);
  broadcastRoom(room);
  if (seat >= 0) {
    const hadOther = [...room.conns.values()].some(c => c !== conn && c.seat >= 0);
    sysChat(room, `「${conn.name}」${hadOther ? '加入了对局' : '创建了房间'}，执 ${seat === 0 ? '黑' : '白'}`);
  } else {
    sysChat(room, `「${conn.name}」进入房间观战`);
  }
}
function leaveStream(room, conn) {
  if (!room.conns.get(conn.pid)) return;
  room.conns.delete(conn.pid);
  const seat = seatOf(room, conn);
  if (seat >= 0) {
    const p = room.players[seat];
    const stillOnline = [...room.conns.values()].some(c => c !== conn && seatOf(room, c) === seat);
    if (p && !stillOnline) {
      p.online = false;
      sysChat(room, `「${conn.name}」掉线了（60 秒内回来可自动回到原位）`);
      room.seatTimers[seat] = setTimeout(() => {
        const cur = room.players[seat];
        if (cur && cur.sid === conn.sid && !cur.online) {
          room.players[seat] = null;
          room.rematchVotes.clear();
          sysChat(room, `「${cur.name}」的席位已空出`);
          broadcastRoom(room);
        }
      }, 60_000);
    }
  } else {
    sysChat(room, `「${conn.name}」离开了房间`);
  }
  broadcastRoom(room);
}

/* ---------- 动作 ---------- */
function doMove(room, conn, cell) {
  const seat = seatOf(room, conn);
  if (!(seat >= 0)) throw new Error('观战模式不能落子');
  const side = seat + 1;
  const g = room.game;
  if (g.over) throw new Error('对局已结束');
  if (g.turn !== side) throw new Error('还没轮到你');
  const c = Number(cell);
  if (!Number.isInteger(c) || c < 0 || c > 63 || !g.legalMoves(side).includes(c)) {
    throw new Error('非法落点');
  }
  g.makeMove(c);
  const d = g.over
    ? { pct: g.winner === 3 ? 50 : g.winner === 1 ? 100 : 0, tag: '终局' }
    : evalDetail(g);
  room.evalPct = d.pct;
  room.evalTag = d.tag;
  touch(room);
  if (g.passed) {
    const skippedName = g.passed === 1 ? room.players[0]?.name ?? '黑方' : room.players[1]?.name ?? '白方';
    sysChat(room, `「${skippedName}」无子可落，跳过一手`);
  }
  broadcastState(room);
  if (g.over) {
    room.rematchVotes.clear();
    const [b, w] = g.counts();
    const who = g.winner === 3
      ? `平局！● ${b} : ${w} ○`
      : `「${room.players[g.winner - 1]?.name ?? (g.winner === 1 ? '黑方' : '白方')}」获胜！🎉（● ${b} : ${w} ○）`;
    sysChat(room, who);
    broadcastState(room);
  }
}
function doChat(room, conn, text) {
  const msg = { name: conn.name, text: cleanText(text), ts: Date.now() };
  if (!msg.text) throw new Error('消息不能为空');
  room.chat.push(msg);
  if (room.chat.length > 100) room.chat.shift();
  broadcast(room, 'chat', msg);
}
function doResign(room, conn) {
  const seat = seatOf(room, conn);
  if (!(seat >= 0)) throw new Error('观战模式不能认输');
  const g = room.game;
  if (g.over) throw new Error('对局已结束');
  g.over = true;
  g.winner = 3 - (seat + 1);
  room.rematchVotes.clear();
  room.evalPct = g.winner === 1 ? 100 : 0;
  room.evalTag = '认输终局';
  sysChat(room, `「${conn.name}」认输，${g.winner === 1 ? '黑' : '白'}方获胜`);
  broadcastState(room);
}
function doRematch(room, conn) {
  const seat = seatOf(room, conn);
  if (!(seat >= 0)) throw new Error('观战者不能发起再战');
  if (!room.game.over) throw new Error('对局还没结束');
  const sid = room.players[seat]?.sid;
  if (sid) room.rematchVotes.add(sid);
  const inGame = room.players.filter(Boolean).length;
  if (room.rematchVotes.size >= Math.max(1, Math.min(inGame, 2))) {
    room.players.reverse();          // 交换黑白
    room.game = new Othello();
    room.evalPct = 50;
    room.evalTag = '';
    room.rematchVotes.clear();
    sysChat(room, '新对局开始，双方已交换黑白！');
    broadcastRoom(room);
    broadcastState(room);
  } else {
    broadcast(room, 'rematch', { votes: [...room.rematchVotes].map(s => sidOf(room, s)).filter(Boolean) });
    sysChat(room, `「${conn.name}」想再来一局`);
  }
}

/* ---------- HTTP ---------- */
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => {
      b += c;
      if (b.length > limit) { reject(new Error('请求过大')); req.destroy(); }
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/api/join' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const name = cleanName(body.name);
      let room;
      if (body.create) {
        room = newRoom();
      } else {
        room = getRoom(String(body.room ?? ''));
        if (!room) return json(res, 404, { ok: false, error: '房间不存在，请核对房间号' });
      }
      touch(room);
      return json(res, 200, { ok: true, room: room.code });
    }

    if (p === '/events' && req.method === 'GET') {
      const room = getRoom(u.searchParams.get('room') ?? '');
      if (!room) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: fatal\ndata: ${JSON.stringify({ reason: '房间不存在或已解散' })}\n\n`);
        return res.end();
      }
      const conn = {
        pid: rid(),
        sid: String(u.searchParams.get('sid') ?? '').slice(0, 64) || rid(),
        name: cleanName(u.searchParams.get('name')),
        seat: -1,
        res,
      };
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      joinStream(room, conn);
      const hb = setInterval(() => {
        try { send(res, 'ping', { t: Date.now() }); } catch (e) { /* ignore */ }
      }, 20_000);
      const cleanup = () => {
        clearInterval(hb);
        leaveStream(room, conn);
      };
      res.on('close', cleanup);
      return;
    }

    if (req.method === 'POST' && ['/api/move', '/api/chat', '/api/resign', '/api/rematch', '/api/leave'].includes(p)) {
      const body = JSON.parse((await readBody(req)) || '{}');
      const room = getRoom(String(body.room ?? ''));
      if (!room) return json(res, 404, { ok: false, error: '房间不存在' });
      const conn = room.conns.get(String(body.pid ?? ''));
      if (!conn) return json(res, 403, { ok: false, error: '连接已失效，请刷新页面' });
      touch(room);
      try {
        switch (p) {
          case '/api/move': doMove(room, conn, body.cell); break;
          case '/api/chat': doChat(room, conn, body.text); break;
          case '/api/resign': doResign(room, conn); break;
          case '/api/rematch': doRematch(room, conn); break;
          case '/api/leave':
            leaveStream(room, conn);
            try { conn.res.end(); } catch (e) {}
            break;
        }
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      const html = fs.readFileSync(CLIENT_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      return res.end(html);
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    try { json(res, 500, { ok: false, error: e.message }); } catch (_) {}
  }
});

/* ---------- 空房清理 ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.conns.size === 0 && now - room.lastTouch > 15 * 60_000) rooms.delete(code);
  }
}, 60_000);

server.listen(PORT, '0.0.0.0', () => {
  const nets = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) nets.push(ni.address);
    }
  }
  console.log('==============================================');
  console.log('  黑白棋 · 双人对战平台已启动');
  console.log(`  本机对战:      http://localhost:${PORT}`);
  for (const ip of nets) console.log(`  局域网对战:    http://${ip}:${PORT}   ← 同一 WiFi 的朋友可直接打开`);
  console.log(`  跨网络联机:    需在路由器把端口 ${PORT} 映射到本机，或使用内网穿透工具`);
  console.log('  停止服务: Ctrl+C');
  console.log('==============================================');
});
