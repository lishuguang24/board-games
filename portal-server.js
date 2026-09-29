#!/usr/bin/env node
/**
 * 游戏门户服务器（零依赖）
 *
 *   启动:  node portal-server.js    （端口默认 3000，云平台自动注入 PORT）
 *
 * 一个网址托管三个对战平台 + 门户首页：
 *   /          门户首页（三个游戏入口）
 *   /ttt/      二阶井字棋（内部 127.0.0.1:3888）
 *   /othello/  黑白棋   （内部 127.0.0.1:3889）
 *   /quoridor/ 墙棋     （内部 127.0.0.1:3890）
 *
 * 子服务器以子进程方式拉起并自动重启；反向代理透传 SSE 流。
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const GAMES = [
  { prefix: '/ttt',       file: 'ttt-server.js',       port: 3888, name: '二阶井字棋', desc: '3×3 宫 × 每宫 9 格 · 落子决定对手去向 · 分难度人机 + 远程对战', emoji: '🎯' },
  { prefix: '/othello',   file: 'othello-server.js',   port: 3889, name: '黑白棋',     desc: '八向夹翻 · 大逆转常态 · 精确残局求解的实时形势预测', emoji: '⚫' },
  { prefix: '/quoridor',  file: 'quoridor-server.js',  port: 3890, name: '墙棋',       desc: '走子与筑墙的攻防博弈 · 跳子/侧跳/通路校验 · 新手引导', emoji: '🧱' },
];

/* ---------- 子服务器管理 ---------- */
const children = new Map();
function startGame(g) {
  const child = spawn(process.execPath, [path.join(__dirname, g.file)], {
    env: { ...process.env, PORT: String(g.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(g.prefix, child);
  const tag = `[${g.prefix}]`;
  child.stdout.on('data', d => process.stdout.write(`${tag} ${d}`));
  child.stderr.on('data', d => process.stderr.write(`${tag} ${d}`));
  child.on('exit', (code, sig) => {
    console.log(`${tag} 子服务器退出（code=${code} sig=${sig}），3 秒后重启`);
    setTimeout(() => startGame(g), 3000);
  });
  console.log(`${tag} 已启动 ${g.file}（内部端口 ${g.port}）`);
}
for (const g of GAMES) startGame(g);
process.on('exit', () => { for (const c of children.values()) c.kill(); });

/* ---------- 反向代理（透传 SSE） ---------- */
function proxy(req, res, targetPort, stripPrefix) {
  const url = req.url.replace(stripPrefix, '') || '/';
  const opts = {
    hostname: '127.0.0.1', port: targetPort,
    path: url, method: req.method, headers: { ...req.headers },
  };
  delete opts.headers['connection'];
  const upstream = http.request(opts, ur => {
    const headers = { ...ur.headers };
    delete headers['transfer-encoding'];          // 由本连接自行分块
    res.writeHead(ur.statusCode, headers);
    ur.pipe(res);
  });
  upstream.on('error', e => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('游戏服务暂时不可用（可能正在唤醒），请几秒后刷新重试');
  });
  req.pipe(upstream);
}

/* ---------- 门户首页 ---------- */
const PORTAL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>棋类对战平台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;padding:30px;
  background:radial-gradient(1100px 700px at 20% -10%, #17234c 0%, #070b18 60%);
  color:#dbe4f5;font-family:"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
h1{font-size:30px;letter-spacing:2px}
.sub{color:#8fa0c5;font-size:14px;margin-top:-22px}
.grid{display:flex;gap:22px;flex-wrap:wrap;justify-content:center;max-width:1020px}
a.card{width:300px;text-decoration:none;background:#121b38;border:1px solid #26335a;border-radius:18px;
  padding:26px 24px;color:#dbe4f5;transition:.2s;display:block}
a.card:hover{border-color:#818cf8;transform:translateY(-4px);box-shadow:0 12px 32px rgba(0,0,0,.4)}
.emoji{font-size:40px;margin-bottom:12px}
.card h2{font-size:20px;margin-bottom:10px}
.card p{color:#8fa0c5;font-size:13px;line-height:1.9}
.go{margin-top:16px;color:#818cf8;font-size:14px;font-weight:600}
a.card:hover .go{color:#a5b4fc}
footer{color:#5b6b90;font-size:12px;text-align:center;line-height:1.9}
</style>
</head>
<body>
<h1>棋类对战平台</h1>
<p class="sub">创建房间 · 发送链接 · 远程对战（支持聊天、观战、断线重连）</p>
<div class="grid">
  <a class="card" href="/ttt/"><div class="emoji">🎯</div><h2>二阶井字棋</h2>
    <p>3×3 宫 × 每宫 9 格。落子位置决定对手去向，占领三宫连线获胜。分难度人机对战 + 远程对战。</p>
    <div class="go">进入对战 →</div></a>
  <a class="card" href="/othello/"><div class="emoji">⚫</div><h2>黑白棋</h2>
    <p>八向夹翻、大逆转常态。深度搜索 + 残局精确求解的实时形势预测，边下边聊。</p>
    <div class="go">进入对战 →</div></a>
  <a class="card" href="/quoridor/"><div class="emoji">🧱</div><h2>墙棋 Quoridor</h2>
    <p>走子与筑墙的攻防博弈，先到对面底线者胜。跳子、侧跳、通路校验，附新手引导。</p>
    <div class="go">进入对战 →</div></a>
</div>
<footer>任意设备打开即玩 · 无需安装 · 电脑手机平板均可</footer>
</body>
</html>`;

/* ---------- 主服务 ---------- */
const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];

  if (p === '/' || p === '/index.html' || p === '/favicon.ico' && req.method === 'GET' && p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(PORTAL_HTML);
  }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }

  const g = GAMES.find(x => p === x.prefix || p.startsWith(x.prefix + '/'));
  if (!g) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<meta charset="utf-8"><body style="background:#070b18;color:#dbe4f5;font-family:sans-serif;display:flex;justify-content:center;padding-top:20vh"><div><a href="/" style="color:#818cf8">← 返回门户</a><h2>404 页面不存在</h2></div></body>');
  }
  if (p === g.prefix) {
    // 补尾斜杠，保证页面内的相对路径正确
    res.writeHead(301, { Location: g.prefix + '/' + ((req.url || '').split('?')[1] ? '?' + req.url.split('?')[1] : '') });
    return res.end();
  }
  proxy(req, res, g.port, g.prefix);
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) nets.push(ni.address);
  console.log('==============================================');
  console.log('  棋类对战平台 · 门户已启动');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  for (const ip of nets) console.log(`  局域网访问: http://${ip}:${PORT}`);
  console.log('  云部署:     Render/Railway 会自动注入 PORT');
  console.log('  停止服务: Ctrl+C');
  console.log('==============================================');
});
