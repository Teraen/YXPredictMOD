import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {Rooms} from './rooms.mjs';
import {PredictionWeb} from './web.mjs';
import {HourlyEvents} from './hourly.mjs';
import {qqCommand,isPredictionCommand} from './qq.mjs';
import {syncQqWallet,linkCandidates} from './qq-wallet.mjs';
import {createHandler} from './server.mjs';

const bridgeKey='a'.repeat(64),groupId='599092307';
function walletFixture(save){
 let clock=Date.UTC(2026,10,2,15,59,59);const now=()=>clock,rooms=new Rooms(undefined,save,now),web=new PredictionWeb(rooms,{bridgeKey,now}),hourly=new HourlyEvents(rooms,web);
 const actor=(n,active=true)=>({subject:(active?'b':n).repeat(64),qqSubject:n.repeat(64),scope:active?'qq-prediction':'qq-wallet',groupId,name:'测试道友',bindingDigest:linkCandidates(rooms).digest});
 const sender=()=>actor('c'),receiver=()=>actor('d',false),sign=user=>{const payload=Buffer.from(JSON.stringify({...user,expiresAt:user.expiresAt??now()+60000})).toString('base64url');return payload+'.'+createHmac('sha256',Buffer.from(bridgeKey,'hex')).update(payload).digest('base64url');};
 const transfer=(amount='200',messageId='transfer-1',recipient=receiver())=>qqCommand(web,hourly,sender(),{text:'/马币转账 '+amount,messageId,messageAt:now(),recipientTicket:sign(recipient)});
 const ack=reply=>qqCommand(web,hourly,sender(),{action:'ack',receiptId:reply.receiptId});
 return {rooms,web,hourly,now,time:n=>clock=n,sender,receiver,sign,transfer,ack};
}

test('coin help lists balance, shared check-in, mentions, multi-bets and receipts without creating a wallet or needing a market',()=>{
 const x=walletFixture(),before=structuredClone(x.rooms.state),reply=qqCommand(x.web,x.hourly,x.receiver(),{text:'/马币帮助'});
 for(const text of ['余额','帮助','签到','转账','竞猜','减半','撤回','查单','注册','走势'])assert(reply.lines.some(line=>line.includes(text)));
 assert.equal(reply.forward,false);assert.deepEqual(x.rooms.state,before);for(const text of ['/马币帮助','/马币签到','/马币转账 200'])assert(isPredictionCommand(text));assert(!isPredictionCommand('/马币转账错误'));
});
test('the same transfer retried through the new short alias returns its old receipt without another debit',()=>{
 const x=walletFixture(),first=x.transfer('200','short-alias-retry');
 const retry=qqCommand(x.web,x.hourly,x.sender(),{text:'转账 200',messageId:'short-alias-retry',messageAt:x.now(),recipientTicket:x.sign(x.receiver())});
 assert.deepEqual(retry,first);assert.equal(x.web.me(x.sender()).playBalance,800);assert.equal(x.web.me(x.receiver()).playBalance,1200);
});

test('group and website check-in share the same Beijing day in either order, including midnight and repeated delivery',()=>{
 for(const websiteFirst of [false,true]){
  const x=walletFixture();syncQqWallet(x.web,x.sender());
  const group=()=>qqCommand(x.web,x.hourly,x.sender(),{text:'/马币签到'}),website=()=>x.web.checkIn(x.sender());
  (websiteFirst?website:group)();const reply=(websiteFirst?group:website)();
  assert.equal(x.web.me(x.sender()).playBalance,1200);for(let i=0;i<3;i++)group();assert.equal(x.web.me(x.sender()).playBalance,1200);
  assert.equal(Object.values(x.rooms.state.walletEvents).filter(e=>e.kind==='daily-check-in').length,1);
  if(websiteFirst)assert(reply.lines[0].includes('今天已签到'));else assert.equal(reply.checkInReceipt.duplicate,true);
  x.time(x.now()+2000);group();assert.equal(x.web.me(x.sender()).playBalance,1400);assert.equal(x.web.me(x.sender()).net,0);
 }
});

test('wallet-only or expired identities cannot sign in or send transfers, and malformed sign-in never auto-opens',()=>{
 const x=walletFixture(),before=structuredClone(x.rooms.state);
 for(const text of ['/马币签到','/马币转账 200'])assert.throws(()=>qqCommand(x.web,x.hourly,x.receiver(),{text}),/认证/);
 assert.throws(()=>qqCommand(x.web,x.hourly,x.sender(),{text:'/马币签到 extra'}),/用法/);assert.deepEqual(x.rooms.state,before);
});

test('a transfer debits once, auto-opens the recipient, keeps both net winnings unchanged, and survives reload',()=>{
 const x=walletFixture(),reply=x.transfer();assert(reply.lines[0].includes('自动开通'));assert.equal(x.web.me(x.sender()).playBalance,800);assert.equal(x.web.me(x.receiver()).playBalance,1200);
 assert.equal(x.web.me(x.sender()).net,0);assert.equal(x.web.me(x.receiver()).net,0);const before=structuredClone(x.rooms.state);
 for(let i=0;i<4;i++)assert.deepEqual(x.transfer(),reply);assert.deepEqual(x.rooms.state,before);
 assert.equal(Object.values(x.rooms.state.walletEvents).filter(e=>e.kind==='qq-transfer').length,1);
 const restored=new Rooms(structuredClone(before),undefined,x.now),web=new PredictionWeb(restored,{bridgeKey,now:x.now});assert.deepEqual(qqCommand(web,new HourlyEvents(restored,web),x.sender(),{text:'/马币转账 200',messageId:'transfer-1',messageAt:x.now(),recipientTicket:x.sign(x.receiver())}),reply);
 assert.equal(web.me(x.sender()).playBalance,800);assert.equal(web.me(x.receiver()).playBalance,1200);
});

test('transfer retries bind to the original recipient and amount; new spending waits for its unconfirmed receipt',()=>{
 const x=walletFixture(),reply=x.transfer(),before=structuredClone(x.rooms.state);
 assert.throws(()=>x.transfer('201'),/内容不一致/);assert.throws(()=>x.transfer('200','transfer-1',{...x.receiver(),subject:'e'.repeat(64),qqSubject:'e'.repeat(64)}),/内容不一致/);
 const pending=x.transfer('100','transfer-2');assert(pending.lines.at(-1).includes('尚未执行'));assert.deepEqual(x.rooms.state,before);
 x.ack(reply);x.transfer('100','transfer-2');assert.equal(x.web.me(x.sender()).playBalance,700);assert.equal(x.web.me(x.receiver()).playBalance,1300);
});

test('invalid amounts, insufficient money, a forged recipient, same-account transfers and balance overflow leave no partial account or debit',()=>{
 for(const amount of ['0','-1','1.5','NaN','1000000000001','1001']){
  const x=walletFixture(),before=structuredClone(x.rooms.state);assert.throws(()=>x.transfer(amount));assert.deepEqual(x.rooms.state,before);
 }
 const x=walletFixture();assert.throws(()=>x.transfer('1','same-qq',x.sender()),/自己/);assert.equal(Object.keys(x.rooms.state.accounts).length,0);
 assert.throws(()=>x.transfer('1','same-owner',{...x.sender(),qqSubject:'e'.repeat(64)}),/同一账户/);assert.equal(Object.keys(x.rooms.state.accounts).length,0);
 assert.throws(()=>qqCommand(x.web,x.hourly,x.sender(),{text:'/马币转账 1',messageId:'forged',messageAt:x.now(),recipientTicket:'forged'}),/凭据/);
 syncQqWallet(x.web,x.receiver());x.rooms.state.accounts[x.web.playKey(x.receiver())].balance=1e12;const before=structuredClone(x.rooms.state);assert.throws(()=>x.transfer('1'),/上限/);assert.deepEqual(x.rooms.state,before);
});

test('failed transfer or check-in persistence rolls back wallets, grants, counters, financial events and receipts',()=>{
 let fail=false;const x=walletFixture(()=>{if(fail)throw Error('disk failure')});fail=true;let before=structuredClone(x.rooms.state);
 assert.throws(()=>x.transfer(),/disk failure/);assert.deepEqual(x.rooms.state,before);assert.throws(()=>qqCommand(x.web,x.hourly,x.sender(),{text:'/马币签到'}),/disk failure/);assert.deepEqual(x.rooms.state,before);
 fail=false;syncQqWallet(x.web,x.sender());syncQqWallet(x.web,x.receiver());before=structuredClone(x.rooms.state);fail=true;assert.throws(()=>x.transfer(),/disk failure/);assert.deepEqual(x.rooms.state,before);
});

test('a recipient later bound to a game wallet keeps transferred money, daily grants and zero transfer profit',()=>{
 const x=walletFixture();x.transfer();const qqUser=x.receiver(),old=x.web.playKey(qqUser),game=x.rooms.register('游戏账户').token,uid='1234567890abcdef12345678';x.rooms.state.accounts[game].uid=uid;
 const recipient={...qqUser,subject:'e'.repeat(64),scope:'qq-prediction',boundAccount:true,bindingDigest:linkCandidates(x.rooms).digest,gameUidRef:createHmac('sha256',Buffer.from(bridgeKey,'hex')).update('prediction-game-uid:'+uid).digest('hex')};
 syncQqWallet(x.web,recipient);assert.equal(x.web.playKey(recipient),game);assert.equal(x.web.me(recipient).playBalance,2200);assert.equal(x.web.me(recipient).net,0);assert.equal(x.rooms.state.accounts[old].balance,0);
 qqCommand(x.web,x.hourly,recipient,{text:'/马币签到'});assert.equal(x.web.checkIn(recipient).checkInReceipt.duplicate,true);assert.equal(x.web.me(recipient).playBalance,2400);assert.equal(x.web.me(recipient).net,0);
});

test('real HTTP concurrent transfer retries debit once; concurrent website/group sign-in grants one daily reward',async()=>{
 const x=walletFixture(),botKey='k'.repeat(32),server=http.createServer(createHandler(x.rooms,{bridgeKey,botKey,now:x.now}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,headers={'content-type':'application/json',authorization:'Bearer '+botKey,'x-prediction-identity':x.sign(x.sender())};
 const post=(path,body,h=headers)=>fetch(base+path,{method:'POST',headers:h,body:JSON.stringify(body)});
 try{
  const body={text:'/马币转账 200',messageId:'parallel-transfer',messageAt:x.now(),recipientTicket:x.sign(x.receiver())};
  const replies=await Promise.all(Array.from({length:12},()=>post('/bot/command',body)));assert(replies.every(r=>r.status===200));
  const data=await Promise.all(replies.map(r=>r.json()));assert(data.every(r=>JSON.stringify(r.data)===JSON.stringify(data[0].data)));
  assert.equal(x.web.me(x.sender()).playBalance,800);assert.equal(x.web.me(x.receiver()).playBalance,1200);
  const grants=await Promise.all(Array.from({length:12},(_,i)=>i%2?post('/bot/command',{text:'/马币签到'}):post('/web/check-in',{}, {...headers,'x-prediction-client':'1'})));
  assert(grants.every(r=>r.status===200));assert.equal(x.web.me(x.sender()).playBalance,1000);assert.equal(x.web.me(x.sender()).net,0);
  const expired=x.sign({...x.receiver(),expiresAt:x.now()-1});
  assert.equal((await post('/bot/command',{...body,messageId:'expired-recipient',recipientTicket:expired})).status,401);
 }finally{await new Promise(r=>server.close(r));}
});

test('transferring away the full wallet cannot farm bankruptcy grants, including after game-wallet synchronization',()=>{
 const x=walletFixture();x.transfer('1000');const key=x.web.playKey(x.sender());assert.equal(x.rooms.account(key).balance,0);assert.equal(x.rooms.state.accounts[key].reliefCount,undefined);
 for(let i=0;i<4;i++)assert.equal(x.rooms.account(key).balance,0);
 const game=x.rooms.register('游戏账户').token,uid='1234567890abcdef12345678';x.rooms.state.accounts[game].uid=uid;
 const user={...x.sender(),bindingDigest:linkCandidates(x.rooms).digest,gameUidRef:createHmac('sha256',Buffer.from(bridgeKey,'hex')).update('prediction-game-uid:'+uid).digest('hex')};
 syncQqWallet(x.web,user);assert.equal(x.web.playKey(user),game);assert.equal(x.rooms.state.accounts[game].transferOut,1000);assert.equal(x.rooms.state.accounts[key].transferOut,0);
 // The old transfer reserve follows its primary wallet; simulate a later empty balance in this isolated fixture.
 x.rooms.state.accounts[game].balance=0;assert.equal(x.rooms.account(game).balance,0);
 const ordinary=x.rooms.register('正常破产').token;x.rooms.state.accounts[ordinary].balance=0;assert.equal(x.rooms.account(ordinary).balance,50);
});
