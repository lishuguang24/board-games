#!/usr/bin/env node
/**
 * 二阶井字棋 · 联机对战服务器（零依赖，Node >= 16）
 *
 *   启动:  node ttt-server.js        （端口默认 3888，可用 PORT=xx 覆盖）
 *
 * - 房间制：创建房间得 4 位房间号，朋友凭房间号或邀请链接加入
 * - 服务器权威：所有落子都在服务器校验并执行，客户端只做展示
 * - 实时通道：SSE（Server-Sent Events）下行推送 + HTTP POST 上行提交
 * - 支持：聊天、观战、认输、再战（交换棋子）、断线重连、席位释放
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3888;
const CLIENT_FILE = path.join(__dirname, '二阶井字棋-联机版.html');

/* ---------- 从客户端页面提取游戏核心（规则单一来源） ---------- */
const coreJs = fs.readFileSync(CLIENT_FILE, 'utf8')
  .match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const coreCtx = {};
vm.runInNewContext(coreJs, coreCtx);
vm.runInNewContext('globalThis.__C = { State, WIN_TAB, Search, placingWins, filterSuicidal, LEVELS };', coreCtx);
const { State, Search, placingWins, filterSuicidal, LEVELS } = coreCtx.__C;

/* ---------- 工具 ---------- */
const rid = () => crypto.randomBytes(9).toString('base64url');
const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12) || '玩家';
const cleanText = s => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, 300);

function stateToJSON(s) {
  return {
    px: [...s.px], po: [...s.po],
    mx: s.mx, mo: s.mo, mdraw: s.mdraw,
    turn: s.turn, active: s.active,
    winner: s.winner, moves: s.moves,
  };
}

/* ---------- 房间 ---------- */
const rooms = new Map();          // code -> room
const MAX_ROOMS = 500;

function newRoom() {
  if (rooms.size >= MAX_ROOMS) throw new Error('服务器房间已满，请稍后再试');
  let code;
  do { code = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms.has(code));
  const room = {
    code,
    players: [null, null],        // [seat0=X, seat1=O]；{sid, name, online, bot?, level?} | null
    conns: new Map(),             // pid -> {res, sid, name, seat}  seat=-1 为观战
    chat: [],                     // 最近聊天记录
    rematchVotes: new Set(),      // 投票方的 sid
    game: new State(),
    lastMove: -1,
    seatTimers: [null, null],
    history: [],                  // 着法序列（悔棋重放用）
    pending: null,                // 悔棋/求和请求 {type:'undo'|'draw', fromSeat}
    botToken: 0, evalToken: 0, botTimer: null, evalTimer: null,
    pendingBot: null,             // 大厅勾选的人机难度，创建者入座后自动补 AI
    lastTouch: Date.now(),
  };
  rooms.set(code, room);
  return room;
}
function getRoom(code) { return rooms.get(code) || null; }
function touch(room) { room.lastTouch = Date.now(); }

function seatViews(room) {
  return room.players.map((p, i) => p
    ? { name: p.name, online: p.online, side: i + 1, bot: !!p.bot, level: p.level || null }
    : null);
}
function specCount(room) {
  let n = 0;
  for (const c of room.conns.values()) if (c.seat < 0) n++;
  return n;
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
    try { send(c.res, event, data); } catch (e) { /* 连接已断，close 时清理 */ }
  }
}
function broadcastState(room) {
  broadcast(room, 'state', {
    state: stateToJSON(room.game),
    lastMove: room.lastMove,
    rematchVotes: [...room.rematchVotes].map(sid => sidOf(room, sid)).filter(Boolean),
    pending: room.pending ? { type: room.pending.type, fromSeat: room.pending.fromSeat } : null,
  });
}
/* 把投票 sid 翻译成执子方编号，客户端按 mySide 判断 */
function sidOf(room, sid) {
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (p && p.sid === sid) return i + 1;
  }
  return 0;
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
/* 连接当前实际占用的席位（再战换边后会变化），未入座返回 -1 */
function seatOf(room, conn) {
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (p && p.sid === conn.sid) return i;
  }
  return -1;
}
function sendHello(room, conn) {
  const seat = seatOf(room, conn);
  send(conn.res, 'hello', {
    pid: conn.pid,
    role: seat >= 0 ? 'player' : 'spec',
    side: seat >= 0 ? seat + 1 : 0,
    seats: seatViews(room),
    specCount: specCount(room),
    yourSide: seat >= 0 ? seat + 1 : 0,
    state: stateToJSON(room.game),
    lastMove: room.lastMove,
    rematchVotes: [...room.rematchVotes].map(sid => sidOf(room, sid)).filter(Boolean),
    pending: room.pending ? { type: room.pending.type, fromSeat: room.pending.fromSeat } : null,
    chat: room.chat.slice(-40),
  });
}

/* ---------- 加入 / 离开 ---------- */
function joinStream(room, conn) {
  // 1. 重连回收席位：同 sid 且席位已离线 → 坐回原位
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
  // 2. 空席位直接入座
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
    sysChat(room, `「${conn.name}」${hadOther ? '加入了对局' : '创建了房间'}，执 ${seat === 0 ? 'X' : 'O'}`);
  } else {
    sysChat(room, `「${conn.name}」进入房间观战`);
  }
  // 大厅勾选的人机对战 → 创建者入座后自动补 AI
  if (room.pendingBot && seat >= 0) {
    const lv = room.pendingBot;
    room.pendingBot = null;
    addBot(room, lv);
  }
  maybeBotMove(room);
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
function doMove(room, conn, move) {
  const seat = seatOf(room, conn);
  if (!(seat >= 0)) throw new Error('观战模式不能落子');
  const side = seat + 1;
  const g = room.game;
  if (g.winner !== 0) throw new Error('对局已结束');
  if (g.turn !== side) throw new Error('还没轮到你');
  const m = Number(move);
  if (!Number.isInteger(m) || m < 0 || m > 80 || !g.legalMoves().includes(m)) {
    throw new Error('非法着法');
  }
  g.makeMove(m);
  room.lastMove = m;
  room.history.push(m);
  room.pending = null;
  touch(room);
  broadcastState(room);
  if (g.winner !== 0) {
    const who = g.winner === 3 ? '平局！' : `「${room.players[g.winner - 1]?.name ?? (g.winner === 1 ? 'X' : 'O')}」获胜！🎉`;
    onGameOver(room, who);
  } else {
    scheduleEval(room);
    maybeBotMove(room);
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
  if (g.winner !== 0) throw new Error('对局已结束');
  g.winner = 3 - (seat + 1);
  room.rematchVotes.clear();
  onGameOver(room, `「${conn.name}」认输，${g.winner === 1 ? 'X' : 'O'} 方获胜`);
}
function doRematch(room, conn) {
  const seat = seatOf(room, conn);
  if (!(seat >= 0)) throw new Error('观战者不能发起再战');
  if (room.game.winner === 0) throw new Error('对局还没结束');
  const sid = room.players[seat]?.sid;
  if (sid) room.rematchVotes.add(sid);
  // 人类玩家全部同意即开新局（AI 对手由服务器代为同意）
  const humans = room.players.filter(p => p && !p.bot).length;
  if (room.rematchVotes.size >= Math.max(1, Math.min(humans, 2)) || room.rematchVotes.size >= 2) {
    // 双方同意（或只剩一人）→ 交换席位后开新局
    room.players.reverse();
    room.game = new State();
    room.lastMove = -1;
    room.history = [];
    room.pending = null;
    room.rematchVotes.clear();
    room.botToken++; room.evalToken++;
    sysChat(room, '新对局开始，双方已交换棋子！');
    broadcastRoom(room);
    broadcastState(room);
    broadcastEval(room, 50);
    maybeBotMove(room);
  } else {
    broadcast(room, 'rematch', { votes: [...room.rematchVotes].map(s => sidOf(room, s)).filter(Boolean) });
    sysChat(room, `「${conn.name}」想再来一局`);
  }
}

/* ---------- 终局收尾 ---------- */
function onGameOver(room, msg) {
  room.pending = null;
  if (msg) sysChat(room, msg);
  broadcastState(room);
  const w = room.game.winner;
  broadcastEval(room, w === 3 ? 50 : w === 1 ? 100 : 0);
}

/* ---------- AI 对手（服务器运行，分难度，分批计算不阻塞） ---------- */
function addBot(room, level) {
  if (!LEVELS[level]) level = 'medium';
  for (let i = 0; i < 2; i++) {
    if (!room.players[i]) {
      room.players[i] = { sid: 'bot-' + rid(), name: 'AI·' + LEVELS[level].name, online: true, bot: true, level };
      room.rematchVotes.clear();
      sysChat(room, `「AI·${LEVELS[level].name}」加入了对局，执 ${i === 0 ? 'X' : 'O'}`);
      broadcastRoom(room);
      return true;
    }
  }
  return false;
}
function botPick(stats, opts) {
  if (opts.tempPower) {
    const cand = stats.slice(0, Math.min(opts.topN || 6, stats.length));
    let tot = 0;
    const ws = cand.map(s => { const w = Math.pow(Math.max(1, s.visits), opts.tempPower); tot += w; return w; });
    let r = Math.random() * tot;
    for (let i = 0; i < cand.length; i++) { r -= ws[i]; if (r <= 0) return cand[i].move; }
    return cand[0].move;
  }
  const mx = stats[0].visits;
  const top = stats.filter(s => s.visits >= mx * 0.8);
  return top[(Math.random() * top.length) | 0].move;
}
function maybeBotMove(room, delay = 650) {
  const g = room.game;
  if (!g || g.winner !== 0) return;
  const p = room.players[g.turn - 1];
  if (!p || !p.bot) return;
  clearTimeout(room.botTimer);
  room.botTimer = setTimeout(() => runBotSearch(room, g), delay);
}
function runBotSearch(room, g) {
  if (room.game !== g || g.winner !== 0) return;
  const side = g.turn;
  const p = room.players[side - 1];
  if (!p || !p.bot) return;
  const opts = LEVELS[p.level] || LEVELS.medium;
  const token = ++room.botToken;
  // 必胜点截获
  const myM = side === 1 ? g.mx : g.mo;
  for (const m of g.legalMoves()) {
    const b = (m / 9) | 0, c = m % 9;
    const myB = side === 1 ? g.px[b] : g.po[b];
    if (placingWins(myM, b) && placingWins(myB, c)) {
      return botPlay(room, g, m, token);
    }
  }
  const search = new Search(g, opts.c);
  // 战术过滤：搜索树只保留不会立刻送对手赢棋的着法
  search.root.untried = filterSuicidal(g, side, search.root.untried);
  const t0 = Date.now();
  const batch = () => {
    if (token !== room.botToken || room.game !== g || g.winner !== 0 || g.turn !== side) return;
    const until = Math.min(opts.maxSims, search.sims + 600);
    while (search.sims < until) search.step();
    if (search.sims < opts.maxSims && Date.now() - t0 < opts.timeMs) return setImmediate(batch);
    botPlay(room, g, botPick(search.rootStats(), opts), token);
  };
  batch();
}
function botPlay(room, g, m, token) {
  if (token !== room.botToken || room.game !== g || g.winner !== 0) return;
  g.makeMove(m);
  room.lastMove = m;
  room.history.push(m);
  room.pending = null;
  touch(room);
  broadcastState(room);
  if (g.winner !== 0) {
    onGameOver(room, `「${room.players[g.winner - 1]?.name}」获胜！🎉`);
  } else {
    scheduleEval(room);
  }
}

/* ---------- 胜率预测（每步后用轻量 MCTS 快速评估，执 X 方视角） ---------- */
function scheduleEval(room, delay = 200) {
  clearTimeout(room.evalTimer);
  room.evalTimer = setTimeout(() => runEval(room), delay);
}
function runEval(room) {
  const g = room.game;
  if (g.winner !== 0) return broadcastEval(room, g.winner === 3 ? 50 : g.winner === 1 ? 100 : 0);
  const token = ++room.evalToken;
  const search = new Search(g, 1.2);
  const t0 = Date.now();
  const batch = () => {
    if (token !== room.evalToken || room.game !== g) return;   // 局面已更新，作废
    const until = Math.min(900, search.sims + 300);
    while (search.sims < until) search.step();
    if (search.sims < 900 && Date.now() - t0 < 800) return setImmediate(batch);
    let w = 0, v = 0;
    for (const ch of search.root.children) { w += ch.wins; v += ch.visits; }
    if (!v) return;
    const rate = w / v;                          // 执子方胜率（平局计 0.5）
    broadcastEval(room, Math.round((g.turn === 1 ? rate : 1 - rate) * 100));
  };
  batch();
}
function broadcastEval(room, xPct) {
  broadcast(room, 'eval', { x: Math.max(0, Math.min(100, Math.round(xPct))) });
}

/* ---------- 悔棋 / 求和请求 ---------- */
function doRequest(room, conn, type) {
  if (type !== 'undo' && type !== 'draw') throw new Error('未知请求');
  const seat = seatOf(room, conn);
  if (!(seat >= 0)) throw new Error('观战者不能发起请求');
  if (room.game.winner !== 0) throw new Error('对局已结束');
  const other = room.players[1 - seat];
  if (!other) throw new Error('对手还没加入');
  room.pending = { type, fromSeat: seat };
  if (other.bot) {
    room.pending = null;
    if (type === 'draw') throw new Error('AI 拒绝了求和 :)');
    return respondUndo(room, seat + 1, `AI 大方地同意了「${conn.name}」的悔棋请求`);
  }
  sysChat(room, `「${conn.name}」请求${type === 'undo' ? '悔棋' : '求和'}`);
  broadcastState(room);
}
function doRespond(room, conn, accept) {
  const pend = room.pending;
  if (!pend) throw new Error('没有待处理的请求');
  const seat = seatOf(room, conn);
  if (!(seat >= 0)) throw new Error('观战者不能回应');
  if (seat === pend.fromSeat) throw new Error('不能回应自己的请求');
  room.pending = null;
  if (!accept) {
    sysChat(room, `「${conn.name}」拒绝了对方的${pend.type === 'undo' ? '悔棋' : '求和'}请求`);
    broadcastState(room);
    return;
  }
  if (pend.type === 'draw') {
    room.game.winner = 3;
    room.rematchVotes.clear();
    onGameOver(room, '双方同意和棋，平局');
    return;
  }
  respondUndo(room, seat + 1, `「${conn.name}」同意了悔棋`);
}
/* 回退着法直到 responderSide 一方行棋（人机时会把 AI 的应手一起撤掉） */
function respondUndo(room, responderSide, msg) {
  let k = 0, ns = null;
  for (k = 1; k <= room.history.length; k++) {
    ns = new State();
    for (const m of room.history.slice(0, room.history.length - k)) ns.makeMove(m);
    if (ns.turn === responderSide) break;
  }
  if (!ns) throw new Error('没有可悔的棋');
  room.history = room.history.slice(0, room.history.length - k);
  room.game = ns;
  room.lastMove = room.history.length ? room.history[room.history.length - 1] : -1;
  room.rematchVotes.clear();
  sysChat(room, msg);
  broadcastState(room);
  scheduleEval(room);
  maybeBotMove(room);
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
    /* --- 加入校验（正式入座在 SSE 建立时进行） --- */
    if (p === '/api/join' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const name = cleanName(body.name);
      let room;
      if (body.create) {
        room = newRoom();
        if (body.bot && LEVELS[String(body.bot)]) room.pendingBot = String(body.bot);   // 人机对战：创建者入座后自动补 AI
      } else {
        room = getRoom(String(body.room ?? ''));
        if (!room) return json(res, 404, { ok: false, error: '房间不存在，请核对房间号' });
      }
      touch(room);
      return json(res, 200, { ok: true, room: room.code });
    }

    /* --- SSE 实时通道 --- */
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
      req.on('close', () => { /* res.close 已覆盖 */ });
      return;
    }

    /* --- 游戏动作 --- */
    if (req.method === 'POST' && ['/api/move', '/api/chat', '/api/resign', '/api/rematch', '/api/leave',
                                  '/api/addbot', '/api/kickbot', '/api/request', '/api/respond'].includes(p)) {
      const body = JSON.parse((await readBody(req)) || '{}');
      const room = getRoom(String(body.room ?? ''));
      if (!room) return json(res, 404, { ok: false, error: '房间不存在' });
      const conn = room.conns.get(String(body.pid ?? ''));
      if (!conn) return json(res, 403, { ok: false, error: '连接已失效，请刷新页面' });
      touch(room);
      try {
        switch (p) {
          case '/api/move': doMove(room, conn, body.move); break;
          case '/api/chat': doChat(room, conn, body.text); break;
          case '/api/resign': doResign(room, conn); break;
          case '/api/rematch': doRematch(room, conn); break;
          case '/api/addbot': {
            const seat = seatOf(room, conn);
            if (!(seat >= 0)) throw new Error('观战者不能召唤 AI');
            if (!room.players.includes(null)) throw new Error('没有空座位');
            if (room.players.some(x => x && x.bot)) throw new Error('房间里已有 AI');
            if (!addBot(room, String(body.level ?? 'medium'))) throw new Error('召唤失败');
            maybeBotMove(room);
            break;
          }
          case '/api/kickbot': {
            const i = room.players.findIndex(x => x && x.bot);
            if (i < 0) throw new Error('房间里没有 AI');
            room.players[i] = null;
            room.botToken++;
            clearTimeout(room.botTimer);
            room.rematchVotes.clear();
            sysChat(room, 'AI 已移除，空出的座位可供好友加入');
            broadcastRoom(room);
            break;
          }
          case '/api/request': doRequest(room, conn, String(body.type ?? '')); break;
          case '/api/respond': doRespond(room, conn, !!body.accept); break;
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

    /* --- 静态页面 --- */
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
    if (room.conns.size === 0 && now - room.lastTouch > 15 * 60_000) {
      clearTimeout(room.botTimer);
      clearTimeout(room.evalTimer);
      rooms.delete(code);
    }
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
  console.log('  二阶井字棋 · 联机对战平台已启动');
  console.log(`  本机对战:      http://localhost:${PORT}`);
  for (const ip of nets) console.log(`  局域网对战:    http://${ip}:${PORT}   ← 同一 WiFi 的朋友可直接打开`);
  console.log(`  跨网络联机:    需在路由器把端口 ${PORT} 映射到本机，或使用内网穿透工具`);
  console.log('  停止服务: Ctrl+C');
  console.log('==============================================');
});
