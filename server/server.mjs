import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rooms, RoomError } from './rooms.mjs';

export function createHandler(rooms) {
  const buckets = new Map();
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET' && req.url === '/healthz') { res.end('{"ok":true,"mode":"free-points"}'); return; }
      if (req.method !== 'POST' || req.url !== '/v1/room') throw new RoomError('接口不存在', 404);
      const peer = req.socket.remoteAddress;
      const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
      const ip = local && typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : peer, now = Date.now();
      if (buckets.size > 10000) for (const [k,v] of buckets) if (now - v.at > 60000) buckets.delete(k);
      let b = buckets.get(ip); if (!b || now - b.at > 60000) buckets.set(ip, b = {at: now, count: 0});
      if (++b.count > 600) throw new RoomError('请求过于频繁', 429);
      let size = 0, chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 32768) throw new RoomError('请求过大', 413); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RoomError('JSON无效'); }
      if (!body || typeof body !== 'object') throw new RoomError('请求无效');
      const key = req.headers.authorization?.replace(/^Bearer /, '');
      if (body.action !== 'register' && body.identity !== undefined) rooms.identify(key, body.identity);
      let result;
      switch (body.action) {
        case 'register': result = rooms.register(body.name); break;
        case 'create': result = rooms.create(key, body.snapshot, body.allowMatch); break;
        case 'join': result = rooms.join(body.code, key, body.gameId); break;
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
