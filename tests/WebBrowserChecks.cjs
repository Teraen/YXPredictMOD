const assert=require('node:assert/strict'),path=require('node:path'),http=require('node:http'),{pathToFileURL}=require('node:url'),{generateKeyPairSync}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd(),auth=process.env.AUTH_SERVER_PATH||path.resolve(root,'../yxp-modloader/apps/auth-server');
const load=p=>import(pathToFileURL(p).href);
(async()=>{
 process.env.YX_PREDICTION_BRIDGE_KEY='d'.repeat(64);
 const {Rooms}=await load(path.join(root,'server/rooms.mjs')),{createHandler}=await load(path.join(root,'server/server.mjs'));
 const {openDb}=await load(path.join(auth,'dist/db.js')),{createService}=await load(path.join(auth,'dist/service.js')),{createGuideService}=await load(path.join(auth,'dist/guides/service.js')),{buildServer}=await load(path.join(auth,'dist/routes.js'));
 const db=openDb(':memory:'),at=Date.now();db.prepare('INSERT INTO licenses (qq,machineCode,uidHash,uid,characterName,fingerprintHash,issuedAt,expiresAt,lastActivatedAt) VALUES (?,?,?,?,?,?,?,?,?)').run('10001','local-qa','a'.repeat(64),'qa-uid','云间客','b'.repeat(64),at,at+86400000,at);
 const guides=createGuideService(db),app=buildServer({service:createService({db,privateKey:generateKeyPairSync('ed25519').privateKey}),guides,adminToken:'qa',rateLimitPerMinute:1000});await app.ready();
 const rooms=new Rooms(),key=rooms.register('云间客').token;const snapshot={horseShuffle:true,horseTitles:['特等马','上等马','中等马','中等马','中等马','中等马','牛马','海马'],id:'browser-live',gameRoomId:'browser-native',round:2,closedThrough:0,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:'local-qa-player-'+i,name:['云间客','松风踏云听雨归鹤竹间客','寒山万里长夜归云听雨人','竹间月','听雨人','长夜灯','归云鹤','青霄'][i]})),ranks:Array(8).fill(0),active:Array(8).fill(true),baseRates:Array(64).fill(40000),states:Array.from({length:8},(_,i)=>({life:100-i*4,wins:1,losses:0}))};const roomCode=rooms.create(key,snapshot).code;const handler=createHandler(rooms,{webOrigin:'http://127.0.0.1'});
 const server=http.createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 // Match the temporary origin, using the same production handler and actual guide session.
 const authServer=http.createServer((req,res)=>app.routing(req,res));await new Promise(r=>authServer.listen(0,'127.0.0.1',r));const webHandler=createHandler(rooms,{webOrigin:base,authOrigin:'http://127.0.0.1:'+authServer.address().port});server.removeAllListeners('request');server.on('request',(req,res)=>webHandler(req,res));
 const browser=await chromium.launch({headless:true,executablePath:process.env.WEB_TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/');await page.waitForFunction(()=>!document.getElementById('stat-players').textContent.includes('—'));
  assert.match(await page.locator('#rankings').innerText(),/云间客/);
  await page.screenshot({path:path.join(root,'.cache/web-desktop.png'),fullPage:true});
  await page.locator('#login-open').click();await page.locator('#login-code').fill(guides.issue('10001').code);await page.locator('#login-form button[type=submit]').click();await page.locator('#account').waitFor({state:'visible'});
  assert.equal(await page.locator('#my-name').innerText(),'云间客');
  const code=(await (await fetch(base+'/v1/room',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({action:'linkCode'})})).json()).data.code;
  await page.locator('#bind-code').fill(code);await page.locator('#bind-form button[type=submit]').click();await page.waitForFunction(()=>document.getElementById('bind-state').textContent.startsWith('已绑定 1'));
  await page.locator('#check-in').click();await page.waitForFunction(()=>document.getElementById('check-in').textContent==='今日已签到');assert.equal(rooms.state.accounts[key].balance,1200);assert.equal(await page.locator('#my-net').innerText(),'0');
  await page.locator('#new-name').fill('松风听弈');await page.locator('#rename-form button[type=submit]').click();await page.waitForFunction(()=>document.getElementById('my-name').textContent==='松风听弈');
  assert.equal(rooms.displayName(key),'松风听弈');await page.screenshot({path:path.join(root,'.cache/web-account.png'),fullPage:true});
  await page.locator('#show-board').click();await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('rankings').textContent.includes('松风听弈'));
  await page.locator('#show-hall').click();await page.locator('#room-list .room-card').waitFor();await page.screenshot({path:path.join(root,'.cache/web-hall-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile hall with long roster overflows');await page.setViewportSize({width:1440,height:1100});
  await page.locator('#room-list .room-card button').click();await page.locator('#bet-controls').waitFor({state:'visible'});assert.equal(await page.locator('.horse-card').count(),8);assert.equal(await page.locator('.horse-tier').first().innerText(),'特等马');assert.equal(await page.locator('#life-chart svg').count(),1);
  await page.locator('#bet-amount').fill('37');await page.locator('#bet-buy').click();await page.waitForFunction(()=>document.getElementById('held-position').textContent.includes('37'));assert.equal(rooms.view(roomCode,key).balance,1163);assert.equal(rooms.view(roomCode,key).positions[0].claim,148);
  snapshot.round=3;snapshot.states[0].life=88;snapshot.battles=[{round:2,first:'local-qa-player-0',second:'local-qa-player-1',winner:'local-qa-player-0',firstCards:[1000011,1000021],secondCards:[1000031],firstNames:['云舞诀','清风剑'],secondNames:['飞灵闪'],firstLife:88,secondLife:96,firstMirror:false,secondMirror:false}];rooms.sync(roomCode,key,snapshot);await page.waitForFunction(()=>document.getElementById('watch-live').textContent.includes('第 3 回合'));assert((await page.locator('#round-notes').innerText()).includes('100 → 88'));
  assert.equal(await page.locator('.duel-table').count(),1);assert((await page.locator('#battle-tables').innerText()).includes('云舞诀'));assert((await page.locator('#battle-tables').innerText()).includes('云间客 胜'));await page.screenshot({path:path.join(root,'.cache/web-watch-desktop.png'),fullPage:true});
  snapshot.battles=[];snapshot.round=10;rooms.sync(roomCode,key,snapshot);await page.waitForFunction(()=>document.getElementById('bet-reason').textContent.includes('竞猜已截止'));assert(await page.locator('#bet-buy').isDisabled());
  snapshot.round=17;snapshot.ended=true;snapshot.ranks=[1,2,3,4,5,6,7,8];rooms.sync(roomCode,key,snapshot);await page.waitForFunction(()=>document.getElementById('bet-reason').textContent.includes('已结算'));assert.equal(rooms.view(roomCode,key).balance,1311);assert.equal(await page.locator('#play-balance').innerText(),'1,311');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'.cache/web-watch-mobile.png'),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile page overflows');
  await page.locator('#show-mine').click();await page.locator('#logout').click();await page.locator('#signed-out').waitFor({state:'visible'});
  assert.equal((await page.request.post(base+'/auth/ticket',{headers:{'x-prediction-client':'1'},data:{}})).status(),401);
  assert.deepEqual(errors,[]);console.log('WEB QA PASS: actual guide auth/bind/check-in, public hall, eight players, 37-coin input, shared MOD wallet, life frame updates, named card tables/explicit winner, round10 close, final payout, mobile/no script errors');
 }finally{await browser.close();await new Promise(r=>server.close(r));await new Promise(r=>authServer.close(r));await app.close();db.close();}
})().catch(e=>{console.error(e);process.exit(1)});
