import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rooms, RoomError } from './rooms.mjs';
import { PredictionWeb } from './web.mjs';
import { createAuthRelay } from './auth.mjs';

export function createHandler(rooms, options = {}) {
  const buckets = new Map();
  const web = new PredictionWeb(rooms, options);
  const webOrigin = options.webOrigin ?? process.env.PREDICTION_WEB_ORIGIN ?? 'https://duma.kaigua.vip';
  const relayAuth = createAuthRelay({...options,webOrigin});
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET' && req.url === '/healthz') { res.end('{"ok":true,"mode":"free-points"}'); return; }
      const peer = req.socket.remoteAddress;
      const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
      const ip = local && typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : peer, now = Date.now();
      if (buckets.size > 10000) for (const [k,v] of buckets) if (now - v.at > 60000) buckets.delete(k);
      let b = buckets.get(ip); if (!b || now - b.at > 60000) buckets.set(ip, b = {at: now, count: 0});
      if (++b.count > 600) throw new RoomError('请求过于频繁', 429);
      if (req.method === 'GET' && ['/', '/app.js', '/styles.css'].includes(req.url)) {
        const file = req.url === '/' ? 'index.html' : req.url.slice(1);
        res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
        res.setHeader('X-Content-Type-Options','nosniff');res.end(fs.readFileSync(new URL('./web/'+file,import.meta.url)));return;
      }
      const requestUrl = new URL(req.url,'http://localhost');
      if (req.method === 'GET' && requestUrl.pathname === '/web/leaderboard') { res.end(JSON.stringify({ok:true,data:web.leaderboard(Number(requestUrl.searchParams.get('page')??0))}));return; }
      if (req.method === 'GET' && req.url === '/web/me') { res.end(JSON.stringify({ok:true,data:web.me(web.identity(req.headers['x-prediction-identity']))}));return; }
      if (req.method !== 'POST' || !['/v1/room','/web/bind','/web/profile','/web/check-in','/auth/login','/auth/logout','/auth/ticket'].includes(req.url)) throw new RoomError('接口不存在', 404);
      if((req.url.startsWith('/web/')||req.url.startsWith('/auth/'))&&(req.headers['x-prediction-client']!=='1'||(req.headers.origin&&req.headers.origin!==webOrigin)))throw new RoomError('请在本站页面操作',403);
      let size = 0, chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 32768) throw new RoomError('请求过大', 413); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RoomError('JSON无效'); }
      if (!body || typeof body !== 'object') throw new RoomError('请求无效');
      if(req.url.startsWith('/auth/')){await relayAuth(req,res,body);return;}
      if (req.url.startsWith('/web/')) { const user=web.identity(req.headers['x-prediction-identity']); const data=req.url==='/web/bind'?web.bind(user,body.code):req.url==='/web/check-in'?web.checkIn(user):web.rename(user,body.name);res.end(JSON.stringify({ok:true,data}));return; }
      const key = req.headers.authorization?.replace(/^Bearer /, '');
      if (body.action !== 'register' && body.identity !== undefined) rooms.identify(key, body.identity);
      let result;
      switch (body.action) {
        case 'register': result = rooms.register(body.name); break;
        case 'linkCode': result = web.issueCode(key); break;
        case 'create': if(rooms.championOnly&&(body.protocol!==3||!body.snapshot?.baseRates))throw new RoomError('请更新至0.7.11并等待冠军倍率就绪后创建房间',409);result = rooms.create(key, body.snapshot, body.allowMatch, body.isPublic); break;
        case 'list': result = rooms.list(key, body.page); break;
        case 'join': if(rooms.state.rooms[body.code]?.rules===3&&body.protocol!==3)throw new RoomError('请更新至0.7.11后加入冠军预测房间',409);result = rooms.join(body.code, key, body.gameId); break;
        case 'findGame': result = rooms.findByGame(key, body.nativeId); break;
        case 'lookup': result = rooms.lookup(key, body.code); break;
        case 'random': result = rooms.random(key, body.exclude ?? ''); break;
        case 'view': result = rooms.view(body.code, key); break;
        case 'sync': result = rooms.sync(body.code, key, body.snapshot); break;
        case 'trade': result = rooms.trade(body.code, key, body); break;
        case 'abandon': result = rooms.abandon(body.code, key, body.gameId, body.operation); break;
        default: throw new RoomError('操作无效');
      }
      res.end(JSON.stringify({ok: true, data: result}));
    } catch (e) {
      res.statusCode = e instanceof RoomError ? e.status : 500;
      res.end(JSON.stringify({ok: false, error: e instanceof RoomError ? e.message : '服务端保存失败，操作未确认'}));
    }
  };
}
export function start({ directory = process.env.ROOM_DATA || './room-data', host = process.env.ROOM_HOST || '127.0.0.1', port = Number(process.env.ROOM_PORT || 8123) } = {}) {
  fs.mkdirSync(directory, {recursive: true});
  const lockPath = path.join(directory, 'server.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid room server lock; inspect before removing it');
    try { process.kill(pid, 0); throw new Error('Room data is already in use'); }
    catch (alive) { if (alive.code !== 'ESRCH') throw alive; }
    fs.unlinkSync(lockPath); lock = fs.openSync(lockPath, 'wx');
  }
  fs.writeFileSync(lock, String(process.pid));
  // A stale PID lock can be reclaimed after a crash; live writers are never replaced.
  const file = path.join(directory, 'rooms.json');
  let state;
  try { state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; }
  catch (e) { fs.closeSync(lock); fs.unlinkSync(lockPath); throw e; }
  const save = value => {
    const tmp = file + '.tmp'; const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  };
  const rooms = new Rooms(state, save);
  const server = http.createServer(createHandler(rooms));
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.on('close', () => { fs.closeSync(lock); fs.unlinkSync(lockPath); });
  server.listen(port, host, () => console.log(`Free-points room server on ${host}:${server.address().port}`));
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
