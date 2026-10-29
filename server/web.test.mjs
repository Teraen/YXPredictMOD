import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import http from 'node:http';
import {Rooms} from './rooms.mjs';
import {PredictionWeb} from './web.mjs';
import {createHandler} from './server.mjs';
const bridgeKey='a'.repeat(64),subject='b'.repeat(64),other='c'.repeat(64);
const ticket=(user,key=bridgeKey)=>{const data=Buffer.from(JSON.stringify(user)).toString('base64url');return data+'.'+createHmac('sha256',Buffer.from(key,'hex')).update(data).digest('base64url');};
function setup(save){let now=100000;const rooms=new Rooms(undefined,save,()=>now),web=new PredictionWeb(rooms,{bridgeKey,now:()=>now});return {rooms,web,user:{subject,name:'观众甲',expiresAt:160000},key:rooms.register('原昵称').token,time:n=>now=n};}
test('guide identity proof authenticates, expires and cannot be tampered or signed with another key',()=>{
 const x=setup();assert.equal(x.web.identity(ticket(x.user)).subject,subject);
 assert.throws(()=>x.web.identity(ticket({...x.user,subject:other},'f'.repeat(64))));
 assert.throws(()=>x.web.identity(ticket({...x.user,expiresAt:99999})));
 assert.throws(()=>x.web.identity(ticket({...x.user,expiresAt:999999})));
 assert.throws(()=>x.web.identity('invalid'));assert.throws(()=>new PredictionWeb(x.rooms,{bridgeKey:''}).identity(ticket(x.user)));
 x.time(160000);assert.throws(()=>x.web.identity(ticket(x.user)));
});
test('binding requires one-time possession, cannot steal an owner and survives reloading',()=>{
 const x=setup(),code=x.web.issueCode(x.key).code;assert.equal(x.web.me(x.user).linked,false);
 assert.equal(x.web.leaderboard().total,1);assert.equal(x.web.leaderboard().items[0].name,'原昵称');
 assert.throws(()=>x.web.bind(x.user,'TP-0000000000'));assert.equal(x.web.bind(x.user,code).linked,true);assert.throws(()=>x.web.bind(x.user,code));
 const code2=x.web.issueCode(x.key).code;assert.throws(()=>x.web.bind({...x.user,subject:other},code2));assert.equal(x.rooms.state.accounts[x.key].webOwner,subject);
 const reloaded=new PredictionWeb(new Rooms(structuredClone(x.rooms.state)),{bridgeKey});assert.equal(reloaded.me(x.user).accounts,1);
 const key=x.rooms.register('第二账户').token;x.web.bind(x.user,x.web.issueCode(key).code);assert.equal(x.web.me(x.user).balance,2000);
});
test('daily check-in adds 200 to the bound betting account once per China day and never inflates profit',()=>{
 const x=setup();assert.throws(()=>x.web.checkIn(x.user));x.web.bind(x.user,x.web.issueCode(x.key).code);
 const before=x.web.me(x.user);assert.equal(before.checkIn.claimed,false);
 const first=x.web.checkIn(x.user);assert.equal(first.balance,1200);assert.equal(first.net,0);assert.equal(first.checkInReceipt.amount,200);
 assert.equal(x.web.leaderboard().items[0].net,0);assert.equal(x.web.checkIn(x.user).checkInReceipt.duplicate,true);assert.equal(x.rooms.state.accounts[x.key].balance,1200);
 x.web.rename(x.user,'改名后');assert.equal(x.web.checkIn(x.user).checkInReceipt.duplicate,true);
 const second=x.rooms.register('第二账户').token;x.web.bind(x.user,x.web.issueCode(second).code);assert.equal(x.web.checkIn(x.user).checkInReceipt.duplicate,true);
 x.time(Date.parse('1970-01-01T15:59:59.999Z'));assert.equal(x.web.checkIn(x.user).checkInReceipt.duplicate,true);
 x.time(Date.parse('1970-01-01T16:00:00.000Z'));assert.equal(x.web.checkIn(x.user).checkInReceipt.amount,200);
 assert.equal(x.rooms.state.accounts[x.key].balance,1400);assert.equal(x.rooms.state.accounts[second].balance,1000);
 assert.equal(Object.keys(x.rooms.state.walletEvents).length,2);assert.equal(x.web.me(x.user).net,0);
 const again=new PredictionWeb(new Rooms(structuredClone(x.rooms.state)),{bridgeKey,now:()=>Date.parse('1970-01-01T16:00:01Z')});assert.equal(again.checkIn(x.user).checkInReceipt.duplicate,true);
});
test('daily persistence errors roll back credit, profile and ledger, and balance limits reject safely',()=>{
 let fail=false;const x=setup(()=>{if(fail)throw Error('disk');});x.web.bind(x.user,x.web.issueCode(x.key).code);const before=structuredClone(x.rooms.state);
 fail=true;assert.throws(()=>x.web.checkIn(x.user));assert.deepEqual(x.rooms.state,before);fail=false;assert.equal(x.web.checkIn(x.user).balance,1200);
 x.time(86400001);x.rooms.state.accounts[x.key].balance=1e12-100;assert.throws(()=>x.web.checkIn(x.user));assert.equal(x.rooms.state.accounts[x.key].balance,1e12-100);
});
test('parallel check-ins from distinct valid identity proofs credit exactly once',async()=>{
 const x=setup();x.web.bind(x.user,x.web.issueCode(x.key).code);const origin='https://duma.kaigua.vip';
 const server=http.createServer(createHandler(x.rooms,{bridgeKey,now:()=>100000,webOrigin:origin}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const replies=await Promise.all(Array.from({length:12},async(_,i)=>{
   const response=await fetch('http://127.0.0.1:'+server.address().port+'/web/check-in',{method:'POST',headers:{'content-type':'application/json','x-prediction-client':'1',origin,'x-prediction-identity':ticket({...x.user,expiresAt:160000+i})},body:'{}'});
   assert.equal(response.status,200);return (await response.json()).data.checkInReceipt;
  }));
  assert.equal(replies.filter(r=>!r.duplicate).length,1);assert.equal(replies.reduce((sum,r)=>sum+r.amount,0),200);
  assert.equal(x.rooms.state.accounts[x.key].balance,1200);assert.equal(Object.keys(x.rooms.state.walletEvents).length,1);assert.equal(x.web.me(x.user).net,0);
 }finally{await new Promise(r=>server.close(r));}
});
test('unbound and bound accounts all rank, successful binding merges only that verified owner',()=>{
 const x=setup(),otherKey=x.rooms.register('未绑定仙友').token;
 assert.equal(x.web.leaderboard().total,2);x.web.bind(x.user,x.web.issueCode(x.key).code);assert.equal(x.web.leaderboard().total,2);
 x.web.bind(x.user,x.web.issueCode(otherKey).code);assert.equal(x.web.leaderboard().total,1);assert.equal(x.web.leaderboard().items[0].name,x.user.name);
 const board=JSON.stringify(x.web.leaderboard());for(const secret of [x.key,otherKey,subject])assert.equal(board.includes(secret),false);
});
test('binding code expires, replacement invalidates old code and failed persistence does not consume it',()=>{
 let fail=false;const x=setup(()=>{if(fail)throw new Error('disk');});
 const first=x.web.issueCode(x.key).code,second=x.web.issueCode(x.key).code;assert.throws(()=>x.web.bind(x.user,first));
 fail=true;assert.throws(()=>x.web.bind(x.user,second));assert.equal(x.rooms.state.accounts[x.key].webOwner,undefined);
 fail=false;assert.equal(x.web.bind(x.user,second).linked,true);
 const key=x.rooms.register('过期').token,code=x.web.issueCode(key).code;x.time(400001);assert.throws(()=>x.web.bind(x.user,code));
});
test('rename isolates identities, updates room display, invalidates rankings and rejects controls',()=>{
 const x=setup();x.web.bind(x.user,x.web.issueCode(x.key).code);assert.equal(x.web.leaderboard().items[0].name,'观众甲');
 x.web.rename(x.user,'风起');assert.equal(x.rooms.displayName(x.key),'风起');assert.equal(x.web.leaderboard().items[0].name,'风起');
 assert.throws(()=>x.web.rename(x.user,'再改'));assert.throws(()=>x.web.rename({...x.user,subject:other},'坏\n名'));
 x.web.rename({...x.user,subject:other},'另一个人');assert.equal(x.web.me(x.user).name,'风起');
 x.time(130001);assert.equal(x.web.rename(x.user,'云来').name,'云来');
});
test('ranking excludes grants and committed capital, recognizes realized payouts and exposes no identity secrets',()=>{
 const x=setup();x.web.bind(x.user,x.web.issueCode(x.key).code);
 const s={id:'web-game',gameRoomId:'native-web',round:1,closedThrough:0,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:'uid-private-'+i,name:'角色'+i})),ranks:Array(8).fill(0),baseRates:Array(64).fill(40000)};
 const code=x.rooms.create(x.key,s).code;
 x.rooms.trade(code,x.key,{kind:'buy',player:0,rank:1,stake:100,version:x.rooms.view(code,x.key).version,operation:'web-profit-buy'});
 assert.equal(x.web.me(x.user).balance,900);assert.equal(x.web.me(x.user).net,0);
 s.ended=true;s.ranks=[1,2,3,4,5,6,7,8];x.rooms.sync(code,x.key,s);
 assert.equal(x.web.me(x.user).net,300);assert.equal(x.web.me(x.user).games,1);
 x.rooms.commit(()=>{x.rooms.state.accounts[x.key].balance+=50;x.rooms.state.accounts[x.key].reliefCount=1;});
 assert.equal(x.web.me(x.user).net,300);
 const board=x.web.leaderboard();assert.equal(board.items[0].net,300);const json=JSON.stringify(board);
 for(const secret of [x.key,subject,'uid-private','webOwner','balance','accounts'])assert.equal(json.includes(secret),false,secret);
});
test('web HTTP serves CSP assets, public ranking, authenticated profile and same-origin binding',async()=>{
 const x=setup(),server=http.createServer(createHandler(x.rooms,{bridgeKey,now:()=>100000,webOrigin:'http://example.test'}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy'),/script-src 'self'/);
  for(const path of ['/app.js','/styles.css','/web/leaderboard'])assert.equal((await fetch(base+path)).status,200);
  assert.equal((await fetch(base+'/web/me')).status,401);
  const headers={'content-type':'application/json','x-prediction-client':'1','x-prediction-identity':ticket(x.user),origin:'http://example.test'};
  const code=(await (await fetch(base+'/v1/room',{method:'POST',headers:{authorization:'Bearer '+x.key,'content-type':'application/json'},body:JSON.stringify({action:'linkCode'})})).json()).data.code;
  const post=(h)=>fetch(base+'/web/bind',{method:'POST',headers:h,body:JSON.stringify({code})});
  assert.equal((await post({...headers,origin:'https://evil.test'})).status,403);assert.equal((await post(headers)).status,200);
  const me=await fetch(base+'/web/me',{headers});assert.equal((await me.json()).data.linked,true);
 }finally{await new Promise(r=>server.close(r));}
});
test('forfeited wagers are realized losses, not held capital, and cannot receive future champion rewards',()=>{
 const x=setup();const snapshot={id:'forfeit-stats',round:1,closedThrough:0,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:'p'+i,name:'p'+i})),ranks:Array(8).fill(0),baseRates:Array(64).fill(40000)};
 const code=x.rooms.create(x.key,snapshot).code;x.rooms.trade(code,x.key,{kind:'buy',player:0,rank:1,stake:1000,version:x.rooms.view(code,x.key).version,operation:'forfeit-all-in'});
 x.rooms.abandon(code,x.key,snapshot.id,'forfeit-departure');
 assert.equal(x.web.leaderboard().items[0].net,-1000);assert.equal(x.web.totals().get(x.key).held,0);assert.equal(x.rooms.state.accounts[x.key].balance,50);
 snapshot.round=15;snapshot.ended=true;snapshot.ranks=[1,2,3,4,5,6,7,8];x.rooms.sync(code,x.key,snapshot);
 assert.equal(x.rooms.state.accounts[x.key].balance,50);assert.equal(x.web.leaderboard().items[0].net,-1000);
});
