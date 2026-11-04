import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rooms, RoomError } from './rooms.mjs';
import { PredictionWeb } from './web.mjs';
import { createAuthRelay } from './auth.mjs';
import {HourlyEvents} from './hourly.mjs';
import {serviceAccess,qqCommand} from './qq.mjs';
import {linkCandidates} from './qq-wallet.mjs';
import {BrowserAuth} from './browser-auth.mjs';

export function createHandler(rooms, options = {}) {
  const buckets = new Map();
  const web = new PredictionWeb(rooms, options);
  const browserAuth=new BrowserAuth(web,options);
  const webUser=req=>{const session=browserAuth.session(req);if(session)return session;const user=web.identity(req.headers['x-prediction-identity']);if(['qq-wallet','qq-racing'].includes(user.scope))throw new RoomError('请使用网页登录',403);return user;};
  const hourly=new HourlyEvents(rooms,web);
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
      if (req.method === 'GET' && ['/', '/app.js', '/styles.css','/spectate.js','/assets/xianfu-mountains.png'].includes(req.url)) {
        const file = req.url === '/' ? 'index.html' : req.url.slice(1);
        res.setHeader('Content-Type', file.endsWith('.png')?'image/png':file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
        res.setHeader('X-Content-Type-Options','nosniff');res.end(fs.readFileSync(new URL('./web/'+file,import.meta.url)));return;
      }
      const requestUrl = new URL(req.url,'http://localhost');
      const art=/^\/art\/(cards|talents|baijia|fates|resonances|characters|frames|ui)\/([a-zA-Z0-9_-]{1,80})\.png$/.exec(requestUrl.pathname);
      if(req.method==='GET'&&art){
        // Native skip choices use the NPC's small ID, not a strategy config row.
        // They all resolve to the game's common Skip icon.
        const name=art[1]==='baijia'&&/^[1-9][0-9]{0,2}$/.test(art[2])?'skip':art[2];
        const file=path.join(options.artDirectory??process.env.PREDICTION_ART_DIR??'/var/lib/yx-prediction/art',art[1],name+'.png');
        if(!fs.existsSync(file))throw new RoomError('图像待同步',404);
        res.setHeader('Content-Type','image/png');res.setHeader('Cache-Control','public, max-age=86400');res.setHeader('X-Content-Type-Options','nosniff');res.end(fs.readFileSync(file));return;
      }
      if (req.method === 'GET' && requestUrl.pathname === '/web/leaderboard') { res.end(JSON.stringify({ok:true,data:web.leaderboard(Number(requestUrl.searchParams.get('page')??0))}));return; }
      if(req.method==='GET'&&requestUrl.pathname==='/web/rooms'){res.end(JSON.stringify({ok:true,data:web.listRooms(Number(requestUrl.searchParams.get('page')??0))}));return;}
      if(req.method==='GET'&&requestUrl.pathname==='/web/room'){res.end(JSON.stringify({ok:true,data:web.watch(web.publicRoom(requestUrl.searchParams.get('code')))}));return;}
      if (req.method === 'GET' && req.url === '/web/me') {res.end(JSON.stringify({ok:true,data:web.me(webUser(req))}));return; }
      if (req.method !== 'POST' || !['/v1/room','/web/play','/web/bind','/web/profile','/web/check-in','/auth/login','/auth/logout','/auth/ticket','/ops/hourly','/bot/command','/bot/events','/bot/accounts','/session/register','/session/login','/session/game','/session/qq/start','/session/qq/finish','/session/logout'].includes(req.url)) throw new RoomError('接口不存在', 404);
      if((req.url.startsWith('/web/')||req.url.startsWith('/auth/')||req.url.startsWith('/session/'))&&(req.headers['x-prediction-client']!=='1'||(req.headers.origin&&req.headers.origin!==webOrigin)))throw new RoomError('请在本站页面操作',403);
      let size = 0, chunks = [];const bodyLimit=req.url==='/ops/hourly'?131072:32768;
      for await (const chunk of req) { size += chunk.length; if (size > bodyLimit) throw new RoomError('请求过大', 413); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RoomError('JSON无效'); }
      if (!body || typeof body !== 'object') throw new RoomError('请求无效');
      if(req.url.startsWith('/session/')){const data=await browserAuth.handle(req,res,body,ip);res.end(JSON.stringify({ok:true,data}));return;}
      if(req.url==='/ops/hourly'){
        serviceAccess(req.headers.authorization,options.observerKey??process.env.PREDICTION_OBSERVER_KEY);
        const data=body.action==='status'?hourly.status():body.action==='open'?hourly.open(body.info,body.snapshot,body.model??null):body.action==='sync'?hourly.sync(body.code,body.snapshot):body.action==='report'?hourly.recoverReport(body.code,body.gameId,body.battles,body.builds??null):body.action==='source'?hourly.source(body.code,body.gameId,body.state,body.round):null;
        if(!data)throw new RoomError('观战操作无效');res.end(JSON.stringify({ok:true,data}));return;
      }
      if(req.url.startsWith('/bot/')){
        serviceAccess(req.headers.authorization,options.botKey??process.env.PREDICTION_BOT_KEY);
        let data;
        if(req.url==='/bot/accounts'){if(body.action!=='candidates')throw new RoomError('身份查询操作无效');data=linkCandidates(rooms);}
        else if(req.url==='/bot/events'){if(body.action==='claim'){if(body.protocol!==2)throw new RoomError('请更新观战消息适配器',409);data=hourly.claim();}else if(body.action==='ack')data=hourly.ack(body.id,body.lease,body.groupId??null);else throw new RoomError('通知操作无效');}
        else data=qqCommand(web,hourly,web.identity(req.headers['x-prediction-identity']),body);
        res.end(JSON.stringify({ok:true,data}));return;
      }
      if(req.url.startsWith('/auth/')){await relayAuth(req,res,body);return;}
      if (req.url.startsWith('/web/')) { const user=webUser(req);const data=req.url==='/web/play'?web.play(user,body):req.url==='/web/bind'?web.bind(user,body.code):req.url==='/web/check-in'?web.checkIn(user):web.rename(user,body.name);res.end(JSON.stringify({ok:true,data}));return; }
      const key = req.headers.authorization?.replace(/^Bearer /, '');
      if (body.action !== 'register' && body.identity !== undefined) rooms.identify(key, body.identity);
      let result;
      switch (body.action) {
        case 'register': result = rooms.register(body.name); break;
        case 'linkCode': result = web.issueCode(key); break;
        case 'create': if(rooms.championOnly&&(![3,4].includes(body.protocol)||!body.snapshot?.baseRates))throw new RoomError('请更新MOD并等待冠军奖励倍率就绪后创建房间',409);if(body.snapshot?.horseShuffle&&body.protocol!==4)throw new RoomError('请更新至0.8.0后创建随机换档房间',409);result = rooms.create(key, body.snapshot, body.allowMatch, body.isPublic); break;
        case 'list': result = rooms.list(key, body.page); break;
        case 'join': if(rooms.state.rooms[body.code]?.rules===3&&![3,4].includes(body.protocol))throw new RoomError('请更新MOD后加入冠军预测房间',409);if(rooms.state.rooms[body.code]?.horseShuffle&&body.protocol!==4)throw new RoomError('请更新至0.8.0后加入随机换档房间',409);result = rooms.join(body.code, key, body.gameId); break;
        case 'findGame': result = rooms.findByGame(key, body.nativeId); break;
        case 'lookup': result = rooms.lookup(key, body.code); break;
        case 'random': result = rooms.random(key, body.exclude ?? ''); break;
        case 'view': result = rooms.view(body.code, key); break;
        case 'sync': result = rooms.sync(body.code, key, body.snapshot); break;
        case 'trade': if(rooms.state.rooms[body.code]?.horseShuffle&&body.protocol!==4)throw new RoomError('请更新至0.8.0后参与随机换档房间',409);result = rooms.trade(body.code, key, body); break;
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
