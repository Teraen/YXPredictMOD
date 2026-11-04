import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import http from 'node:http';
import {Rooms} from './rooms.mjs';
import {PredictionWeb} from './web.mjs';
import {BrowserAuth} from './browser-auth.mjs';
import {createHandler} from './server.mjs';
import {syncQqWallet,linkCandidates} from './qq-wallet.mjs';
const bridgeKey='a'.repeat(64),qq='12345678';
function fixture(save){let now=100000;const rooms=new Rooms(undefined,save,()=>now),web=new PredictionWeb(rooms,{bridgeKey,now:()=>now}),auth=new BrowserAuth(web);const jar={};const req=()=>({headers:{cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join('; ')}});const res={headers:{},getHeader(k){return this.headers[k]},setHeader(k,v){this.headers[k]=v;if(k==='Set-Cookie')for(const c of v){const [k,value]=c.split(';')[0].split('=');jar[k]=value;}}};
 const register=(login='viewer',name='网页观众')=>auth.password(req(),res,{login,password:'long-password-123',name},'ip-'+login,true);
 const proof=(number=qq)=>({subject:createHmac('sha256',Buffer.from(bridgeKey,'hex')).update('prediction-qq:'+number).digest('hex'),qqSubject:createHmac('sha256',Buffer.from(bridgeKey,'hex')).update('prediction-qq:'+number).digest('hex'),scope:'qq-racing',groupId:'613486881',name:'未绑定道友',boundAccount:false});
 return {rooms,web,auth,req,res,jar,register,proof,time:n=>now=n};
}
test('password signup persists salted hashes and secure revocable sessions; reopening never grants twice',async()=>{
 const x=fixture(),me=await x.register();assert.equal(me.balance,1000);assert.equal(me.links.password,true);const text=JSON.stringify(x.rooms.state);assert(!text.includes('long-password-123'));assert(!text.includes(x.jar.yx_race_session));
 assert(x.res.headers['Set-Cookie'].every(s=>s.includes('HttpOnly; SameSite=Strict; Secure')));
 const again=new BrowserAuth(new PredictionWeb(new Rooms(structuredClone(x.rooms.state)),{bridgeKey,now:()=>100000}));assert.equal(again.session(x.req()).subject,x.auth.session(x.req()).subject);
 await assert.rejects(x.register(),/已注册/);await assert.rejects(x.auth.password(x.req(),x.res,{login:'viewer',password:'wrong-password'},'other',false),/不正确/);
 x.auth.logout(x.req(),x.res);assert.equal(x.auth.session(x.req()),null);
 assert.equal((await x.auth.password(x.req(),x.res,{login:'viewer',password:'long-password-123'},'other',false)).balance,1000);
 x.time(31*86400000);assert.equal(x.auth.session(x.req()),null);
});
test('QQ code is only a locator: exact QQ and initiating browser secret are both required',async()=>{
 const x=fixture(),challenge=x.auth.challenge(x.req(),x.res,{qq},'ip');const code=challenge.command.split(' ')[1];
 assert.throws(()=>x.auth.confirmQq(x.proof('99999999'),code),/QQ不符/);assert.deepEqual(x.auth.finishQq(x.req(),x.res),{pending:true});x.auth.confirmQq(x.proof(),code);
 assert.throws(()=>x.auth.finishQq({headers:{}},x.res),/过期/);const result=x.auth.finishQq(x.req(),x.res);assert.equal(result.me.balance,1000);assert.equal(result.me.links.qq,true);assert.equal(Object.keys(x.rooms.state.accounts).length,1);assert(!JSON.stringify(x.rooms.state).includes(qq));
 assert(x.jar.yx_race_session);assert.throws(()=>x.auth.finishQq(x.req(),x.res),/过期/);assert.throws(()=>x.auth.confirmQq(x.proof(),code));
});
test('binding a new QQ to direct registration reuses funds and grants; group and web share one check-in',async()=>{
 const x=fixture();await x.register();const user=x.auth.session(x.req()),old=x.web.playKey(user);x.web.checkIn(user);
 const code=x.auth.challenge(x.req(),x.res,{qq},'ip').command.split(' ')[1];x.auth.confirmQq(x.proof(),code);const me=x.auth.finishQq(x.req(),x.res).me;
 assert.equal(me.balance,1200);assert.equal(me.checkIn.claimed,true);assert.equal(Object.keys(x.rooms.state.accounts).length,1);assert.equal(x.web.playKey(x.auth.session(x.req())),old);
 assert.equal(syncQqWallet(x.web,x.proof()).me.balance,1200);assert.equal(x.web.checkIn(x.proof()).checkInReceipt.duplicate,true);
});
test('QQ existing wallet binding preserves both histories; later game binding retains browser login aliases',async()=>{
 const x=fixture(),proof=x.proof();syncQqWallet(x.web,proof);await x.register();
 const code=x.auth.challenge(x.req(),x.res,{qq},'ip').command.split(' ')[1];x.auth.confirmQq(proof,code);assert.equal(x.auth.finishQq(x.req(),x.res).me.balance,2000);
 const browser=x.auth.session(x.req()),game={...proof,subject:'b'.repeat(64),boundAccount:true,bindingDigest:linkCandidates(x.rooms).digest};syncQqWallet(x.web,game);
 assert.equal(x.auth.session(x.req()).subject,game.subject);assert.equal(x.web.me(browser).balance,2000);assert.equal(x.web.me(game).balance,2000);
 x.auth.logout(x.req(),x.res);assert.equal((await x.auth.password(x.req(),x.res,{login:'viewer',password:'long-password-123'},'ip',false)).balance,2000);
});
test('game code can directly log in, is single use and binds a registered browser without losing wallet claims',async()=>{
 const x=fixture(),game=x.rooms.register('游戏观众').token,code=x.web.issueCode(game).code;
 const me=x.auth.game(x.req(),x.res,{code});assert.equal(me.balance,1000);assert.equal(me.links.game,true);assert.equal(Object.keys(x.rooms.state.accounts).length,1);assert.throws(()=>x.auth.game(x.req(),x.res,{code}));
 x.auth.logout(x.req(),x.res);assert.equal(x.auth.game(x.req(),x.res,{code:x.web.issueCode(game).code}).balance,1000);
 x.auth.logout(x.req(),x.res);await x.register();const current=x.auth.session(x.req());x.web.checkIn(current);const result=x.auth.game(x.req(),x.res,{code:x.web.issueCode(game).code});assert.equal(result.balance,2200);assert.equal(result.checkIn.claimed,true);assert.equal(result.wallets.length,2);assert.equal(result.links.password,true);
 const selected=result.wallets.find(w=>!w.selected);x.web.play(x.auth.session(x.req()),{action:'selectAccount',wallet:selected.id});assert.equal(x.web.me(x.auth.session(x.req())).playBalance,1200);
});
test('multiple independently password-registered wallets cannot be farmed into the same proved identity',async()=>{
 const x=fixture();await x.register();const code=x.auth.challenge(x.req(),x.res,{qq},'ip').command.split(' ')[1];x.auth.confirmQq(x.proof(),code);x.auth.finishQq(x.req(),x.res);x.auth.logout(x.req(),x.res);await x.register('second');
 const again=x.auth.challenge(x.req(),x.res,{qq},'ip').command.split(' ')[1];x.auth.confirmQq(x.proof(),again);const before=structuredClone(x.rooms.state);assert.throws(()=>x.auth.finishQq(x.req(),x.res),/独立登录/);assert.deepEqual(x.rooms.state,before);
});
test('failed persistence rolls back new login accounts, binding, check-in and preserves one-time game code',async()=>{
 let fail=false;const x=fixture(()=>{if(fail)throw Error('disk')});fail=true;await assert.rejects(x.register(),/disk/);assert.equal(Object.keys(x.rooms.state.accounts).length,0);fail=false;const key=x.rooms.register('游戏').token,code=x.web.issueCode(key).code,before=structuredClone(x.rooms.state);fail=true;assert.throws(()=>x.auth.game(x.req(),x.res,{code}),/disk/);assert.deepEqual(x.rooms.state,before);fail=false;assert.equal(x.auth.game(x.req(),x.res,{code}).balance,1000);
});
test('pending wagers and retry operation survive merged ownership and selecting another wallet',async()=>{
 const x=fixture();await x.register();const user=x.auth.session(x.req()),key=x.web.playKey(user),s={id:'browser-test',round:2,closedThrough:0,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:'private-'+i,name:'选手'+i})),ranks:Array(8).fill(0),baseRates:Array(64).fill(40000)};
 const game=x.rooms.register('游戏').token,code=x.rooms.create(game,s).code;x.web.play(user,{action:'join',code});const order={action:'trade',code,player:0,rank:1,kind:'buy',stake:100,version:x.rooms.state.rooms[code].version,operation:'unique-browser-order'};
 x.web.play(user,order);const original=structuredClone(x.rooms.state.rooms[code].positions[key]);x.auth.game(x.req(),x.res,{code:x.web.issueCode(game).code});const merged=x.auth.session(x.req());assert.deepEqual(x.rooms.state.rooms[code].positions[key],original);
 const before=x.web.me(merged).balance;x.web.play(merged,order);assert.equal(x.web.me(merged).balance,before);assert.deepEqual(x.rooms.state.rooms[code].positions[key],original);
 const old=x.web.me(merged).wallets.find(w=>w.pending);x.web.play(merged,{action:'selectAccount',wallet:old.id});assert.equal(x.web.play(merged,{action:'view',code}).wallet.positions[0].claim,400);
});
test('HTTP cookie auth works without license or guide; cross-origin mutations and forged cookies are rejected',async()=>{
 const x=fixture(),origin='https://duma.kaigua.vip',server=http.createServer(createHandler(x.rooms,{bridgeKey,now:()=>100000,webOrigin:origin}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-prediction-client':'1',origin,...headers},body:JSON.stringify(body)});
 const signup=await post('/session/register',{login:'http-user',password:'safe-password-22',name:'手机观众'});assert.equal(signup.status,200);const cookie=signup.headers.getSetCookie()[0].split(';')[0];assert.equal((await (await fetch(base+'/web/me',{headers:{cookie}})).json()).data.balance,1000);
 assert.equal((await post('/web/check-in',{}, {cookie,origin:'https://other.test'})).status,403);assert.equal((await post('/web/check-in',{}, {cookie})).status,200);assert.equal((await fetch(base+'/web/me',{headers:{cookie:'yx_race_session='+'f'.repeat(64)}})).status,401);
 assert.equal((await post('/session/logout',{}, {cookie})).status,200);assert.equal((await fetch(base+'/web/me',{headers:{cookie}})).status,401);
 }finally{await new Promise(r=>server.close(r));}
});
test('concurrent duplicate registrations issue one wallet; login hashing is bounded',async()=>{
 const x=fixture(),results=await Promise.allSettled(Array.from({length:8},(_,i)=>x.auth.password(x.req(),x.res,{login:'one-login',password:'long-password-123'},'ip-'+i,true)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(Object.keys(x.rooms.state.accounts).length,1);assert.equal(x.auth.hashing,0);
});
test('expired or replaced QQ challenges and a switched browser identity cannot finalize login',async()=>{
 const x=fixture(),old=x.auth.challenge(x.req(),x.res,{qq},'ip').command.split(' ')[1];x.auth.challenge(x.req(),x.res,{qq},'ip');assert.throws(()=>x.auth.confirmQq(x.proof(),old));
 const code=x.auth.challenge(x.req(),x.res,{qq},'ip').command.split(' ')[1];x.auth.confirmQq(x.proof(),code);await x.register();assert.throws(()=>x.auth.finishQq(x.req(),x.res),/状态已变化/);x.auth.logout(x.req(),x.res);x.time(500000);assert.throws(()=>x.auth.finishQq(x.req(),x.res),/过期/);
});
test('a game-code browser login later converges with the signed QQ game identity without resetting balances',()=>{
 const x=fixture(),key=x.rooms.register('游戏道友').token,uid='1'.repeat(24);x.rooms.identify(key,{uid,name:'游戏道友'});x.auth.game(x.req(),x.res,{code:x.web.issueCode(key).code});const before=x.auth.session(x.req());
 const proof={...x.proof(),subject:'d'.repeat(64),boundAccount:true,bindingDigest:linkCandidates(x.rooms).digest,gameUidRef:createHmac('sha256',Buffer.from(bridgeKey,'hex')).update('prediction-game-uid:'+uid).digest('hex')};
 syncQqWallet(x.web,proof);assert.equal(x.auth.session(x.req()).subject,proof.subject);assert.equal(x.web.me(before).balance,1000);assert.equal(x.web.me(proof).links.game,true);assert.equal(Object.keys(x.rooms.state.accounts).length,1);
});
