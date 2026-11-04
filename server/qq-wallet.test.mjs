import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import http from 'node:http';
import {Rooms} from './rooms.mjs';
import {PredictionWeb} from './web.mjs';
import {HourlyEvents} from './hourly.mjs';
import {qqCommand} from './qq.mjs';
import {linkCandidates,syncQqWallet} from './qq-wallet.mjs';
import {createHandler} from './server.mjs';
const bridgeKey='a'.repeat(64),qq='b'.repeat(64),subject='c'.repeat(64),uid='1234567890abcdef12345678';
function fixture(save){const rooms=new Rooms(undefined,save),web=new PredictionWeb(rooms,{bridgeKey}),hourly=new HourlyEvents(rooms,web);return {rooms,web,hourly};}
const pre={subject:qq,qqSubject:qq,scope:'qq-wallet',groupId:'599092307',name:'未绑定道友'};
const licensed=x=>({...pre,subject,name:'道友甲',scope:'qq-prediction',bindingDigest:linkCandidates(x.rooms).digest,gameUidRef:createHmac('sha256',Buffer.from(bridgeKey,'hex')).update('prediction-game-uid:'+uid).digest('hex')});
test('unbound QQ can open once through /马币 without a market, while wagering and receipt mutation require a license',()=>{
 const x=fixture(),first=qqCommand(x.web,x.hourly,pre,{text:'/马币'});assert(first.lines[0].includes('已自动开通'));assert(first.lines[0].includes('可用1000'));
 const key=x.web.playKey(pre);for(let i=0;i<3;i++)qqCommand(x.web,x.hourly,pre,{text:'/马币'});
 assert.equal(Object.keys(x.rooms.state.accounts).length,1);assert.equal(x.rooms.state.accounts[key].balance,1000);
 for(const text of ['/下注 1 100','/退半 1','/清仓 1','/选手 1','/赌马'])assert.throws(()=>qqCommand(x.web,x.hourly,pre,{text}),/认证/);
 assert.throws(()=>qqCommand(x.web,x.hourly,pre,{action:'ack',receiptId:'fake'}));
 assert.throws(()=>qqCommand(x.web,x.hourly,{...pre,boundAccount:true},{text:'/马币',action:'ack',receiptId:'fake'}),/旧钱包凭据/);
});
test('later verified UID automatically binds the existing game wallet, transfers earlier QQ coins once and preserves accounting',()=>{
 const x=fixture();qqCommand(x.web,x.hourly,pre,{text:'/马币'});const earlier=x.web.playKey(pre),game=x.rooms.register('游戏昵称').token;
 x.rooms.state.accounts[game].uid=uid;x.rooms.state.accounts[game].balance=2400;
 const user=licensed(x),result=syncQqWallet(x.web,user);assert.equal(result.created,false);assert.equal(result.me.playBalance,3400);assert.equal(result.me.net,1400);
 assert.equal(x.rooms.state.accounts[earlier].balance,0);assert.equal(x.rooms.state.accounts[earlier].walletRedirect,game);assert.equal(x.rooms.state.accounts[game].webOwner,subject);
 for(let i=0;i<3;i++)assert.equal(syncQqWallet(x.web,user).me.playBalance,3400);
 assert.equal(x.rooms.account(earlier).balance,0);assert.equal(Object.keys(x.rooms.state.walletEvents).length,1);
 assert.equal(qqCommand(x.web,x.hourly,pre,{text:'/马币'}).lines[0].includes('可用3400'),true);
 const restored=new PredictionWeb(new Rooms(structuredClone(x.rooms.state)),{bridgeKey});assert.equal(syncQqWallet(restored,user).me.playBalance,3400);
});
test('an expired but still bound QQ synchronizes its wallet without gaining wagering permission or resetting check-in',()=>{
 const x=fixture();syncQqWallet(x.web,pre);const user={...licensed(x),boundAccount:true,scope:'qq-wallet'};
 syncQqWallet(x.web,user);const old=x.web.playKey(user);x.web.checkIn(user);const day=x.rooms.state.profiles[subject].lastCheckInDay;
 const game=x.rooms.register('游戏').token;x.rooms.state.accounts[game].uid=uid;
 const proof={...licensed(x),boundAccount:true,scope:'qq-wallet'};syncQqWallet(x.web,proof);
 assert.equal(x.web.playKey(proof),game);assert.equal(x.rooms.state.profiles[subject].rewardAccount,game);assert.equal(x.rooms.state.profiles[subject].lastCheckInDay,day);
 assert.equal(x.rooms.state.accounts[old].balance,0);assert.equal(x.rooms.state.accounts[game].balance,2200);
 assert.throws(()=>qqCommand(x.web,x.hourly,proof,{text:'/下注 1 100'}),/认证/);assert.equal(syncQqWallet(x.web,proof).me.playBalance,2200);
});
test('a licensed QQ with an existing UID wallet never receives a second opening grant',()=>{
 const x=fixture(),game=x.rooms.register('旧账户').token;x.rooms.state.accounts[game].uid=uid;x.rooms.state.accounts[game].balance=37;
 const result=syncQqWallet(x.web,licensed(x));assert.equal(result.created,false);assert.equal(result.me.playBalance,37);assert.equal(Object.keys(x.rooms.state.accounts).length,1);
});
test('pending QQ positions retain their original active wallet until settled, then available coins synchronize',()=>{
 const x=fixture();syncQqWallet(x.web,pre);const key=x.web.playKey(pre),game=x.rooms.register('游戏').token;x.rooms.state.accounts[game].uid=uid;
 x.rooms.state.rooms.holding={settled:false,members:[key],positions:{[key]:[{stake:100,claim:400,resolved:false}]},receipts:{},payouts:{}};
 x.rooms.state.accounts[key].balance=900;const user=licensed(x);syncQqWallet(x.web,user);assert.equal(x.web.playKey(user),key);assert.equal(x.rooms.state.accounts[key].balance,900);
 x.rooms.state.rooms.holding.settled=true;x.rooms.state.rooms.holding.positions[key][0].resolved=true;x.rooms.state.accounts[key].balance+=400;
 assert.equal(syncQqWallet(x.web,user).me.playBalance,2300);assert.equal(x.web.playKey(user),game);
});
test('stale candidate pools, another owner, changed QQ-to-game binding and failed saves preserve every coin',()=>{
 let fail=false;const x=fixture(()=>{if(fail)throw new Error('disk failure')});syncQqWallet(x.web,pre);const stale=licensed(x),game=x.rooms.register('游戏').token;x.rooms.state.accounts[game].uid=uid;
 let before=structuredClone(x.rooms.state);assert.throws(()=>syncQqWallet(x.web,stale),/绑定数据已更新/);assert.deepEqual(x.rooms.state,before);
 x.rooms.state.accounts[game].webOwner='d'.repeat(64);before=structuredClone(x.rooms.state);assert.throws(()=>syncQqWallet(x.web,licensed(x)),/其他身份/);assert.deepEqual(x.rooms.state,before);
 delete x.rooms.state.accounts[game].webOwner;before=structuredClone(x.rooms.state);fail=true;assert.throws(()=>syncQqWallet(x.web,licensed(x)));assert.deepEqual(x.rooms.state,before);fail=false;
 syncQqWallet(x.web,licensed(x));before=structuredClone(x.rooms.state);assert.throws(()=>syncQqWallet(x.web,{...licensed(x),subject:'e'.repeat(64)}),/其他游戏账号/);assert.deepEqual(x.rooms.state,before);
});
test('candidate listing requires bot credentials; wallet-only signed proofs cannot access website actions or bet',async()=>{
 const x=fixture(),botKey='k'.repeat(32),server=http.createServer(createHandler(x.rooms,{bridgeKey,botKey}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,headers={'content-type':'application/json',authorization:'Bearer '+botKey};
 const payload=Buffer.from(JSON.stringify({...pre,expiresAt:Date.now()+60000})).toString('base64url'),ticket=payload+'.'+createHmac('sha256',Buffer.from(bridgeKey,'hex')).update(payload).digest('base64url');
 const post=(path,body,h=headers)=>fetch(base+path,{method:'POST',headers:h,body:JSON.stringify(body)});
 try{
  assert.equal((await post('/bot/accounts',{action:'candidates'},{})).status,401);
  const list=await(await post('/bot/accounts',{action:'candidates'})).json();assert.deepEqual(list.data.uids,[]);assert(!JSON.stringify(list).includes('token'));
  const proofHeaders={...headers,'x-prediction-identity':ticket};assert.equal((await post('/bot/command',{text:'/马币'},proofHeaders)).status,200);
  const parallel=await Promise.all(Array.from({length:12},()=>post('/bot/command',{text:'/马币'},proofHeaders)));assert(parallel.every(r=>r.status===200));assert.equal(x.web.me(pre).playBalance,1000);
  assert.equal((await post('/bot/command',{text:'/下注 1 100'},proofHeaders)).status,403);
  const webHeaders={...proofHeaders,'x-prediction-client':'1'};for(const path of ['/web/play','/web/check-in','/web/profile','/web/bind'])assert.equal((await post(path,{action:'openAccount'},webHeaders)).status,403);
  assert.equal((await fetch(base+'/web/me',{headers:proofHeaders})).status,403);assert.equal(Object.keys(x.rooms.state.accounts).length,1);
 }finally{await new Promise(r=>server.close(r));}
});
