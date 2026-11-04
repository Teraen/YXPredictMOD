import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Rooms} from './rooms.mjs';
import {PredictionWeb} from './web.mjs';
import {HourlyEvents} from './hourly.mjs';
import {qqCommand} from './qq.mjs';
import {linkCandidates,syncQqWallet} from './qq-wallet.mjs';
import {normalizeRaceCommand,raceNoticeTargets,RACE_GROUP,LEGACY_GROUP,TRANSITION_SLOT} from './race-policy.mjs';
const bridgeKey='a'.repeat(64);
function fixture(save){
 let clock=Date.UTC(2026,10,3,6),now=()=>clock;const rooms=new Rooms(undefined,save,now),web=new PredictionWeb(rooms,{bridgeKey,now}),hourly=new HourlyEvents(rooms,web);
 const actor=(n='b')=>({subject:n.repeat(64),qqSubject:n.repeat(64),scope:'qq-racing',groupId:RACE_GROUP,name:'未绑定道友',boundAccount:false});
 const user=actor(),call=(text,extra={},who=user)=>qqCommand(web,hourly,who,{text,messageId:'race-message',messageAt:now(),...extra});
 const snapshot={id:'racing-new-group',gameRoomId:'native-race',round:1,closedThrough:0,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:'native-'+i,name:'选手'+i})),ranks:Array(8).fill(0),baseRates:Array(64).fill(40000),horseTitles:Array(8).fill('上等马'),states:Array.from({length:8},()=>({life:100,wins:0,losses:0})),builds:Array.from({length:8},()=>({characterId:1000001,characterName:'青松',careerId:1,careerName:'符师',sectId:1,sectName:'剑宗',realmId:1,realmName:'炼气',talents:[],baijia:[],fates:[],resonance:null,selectionRound:0,selectionsKnown:false,cards:null,cardNames:null}))};
 const open=()=>hourly.open({roomId:'native-race',round:1,isPrivate:false,playerCount:8,avgRankScore:6500},snapshot);
 const sign=p=>{const payload=Buffer.from(JSON.stringify({...p,expiresAt:now()+60000})).toString('base64url');return payload+'.'+createHmac('sha256',Buffer.from(bridgeKey,'hex')).update(payload).digest('base64url');};
 return {rooms,web,hourly,user,actor,call,open,snapshot,now,time:n=>clock=n,sign};
}
test('rounds ten and twelve accept only full-balance guesses and keep both withdrawal commands closed',()=>{
 for(const round of [10,12]){
  const x=fixture();x.call('注册 小白');const {code}=x.open(),key=x.web.playKey(x.user);
  x.rooms.sync(code,x.hourly.data().hostToken,{...x.snapshot,round,liveRound:round,closedThrough:round-1,open:false,sourcePhase:'preparation'});
  let room=x.rooms.state.rooms[code];assert.equal(room.open,false);assert.equal(room.tradingClosed,true);
  assert.equal(x.web.watch(room).allInOpen,true);
  const before=structuredClone(x.rooms.state);
  assert.throws(()=>x.call('竞猜 3 100',{messageId:'late-partial'}),/截止/);
  assert.deepEqual(x.rooms.state,before);
  const full=x.call('全猜 3',{messageId:'late-full'});
  assert.equal(x.rooms.state.rooms[code].positions[key][2].stake,1000);assert.equal(x.web.me(x.user).playBalance,0);
  qqCommand(x.web,x.hourly,x.user,{action:'ack',receiptId:full.receiptId});
  for(const command of ['减半 3','撤回 3']){
   const unchanged=structuredClone(x.rooms.state);
   assert.throws(()=>x.call(command,{messageId:'late-withdraw'}),/截止|停止/);assert.deepEqual(x.rooms.state,unchanged);
   room=x.rooms.state.rooms[code];
   assert.throws(()=>x.rooms.trade(code,key,{kind:'sell',allIn:true,rank:1,player:2,stake:0,operation:'forged-full-sell',version:room.version}),/截止|停止/);
   assert.deepEqual(x.rooms.state,unchanged);
  }
 }
});

test('all-in closes at actual round thirteen and cannot use stale, incomplete or non-preparation status',()=>{
 for(const reason of ['round13','live13','monitor13','battle','unknown','incomplete','offline','verifying']){
  const x=fixture();x.call('注册 小白');const {code}=x.open();
  const s={...x.snapshot,round:12,liveRound:12,closedThrough:11,open:false,sourcePhase:'preparation'};
  if(reason==='round13'){s.round=13;s.liveRound=13;s.closedThrough=12;}
  if(reason==='live13')s.liveRound=13;
  if(reason==='battle')s.sourcePhase='battle';
  if(reason==='unknown')delete s.sourcePhase;
  if(reason==='incomplete')s.roundComplete=false;
  x.rooms.sync(code,x.hourly.data().hostToken,s);
  if(reason==='offline')x.rooms.syncTimes.set(code,x.now()-15001);
  if(reason==='monitor13')x.rooms.sourceHealth.set(code,{state:'live',at:x.now(),round:13});
  if(reason==='verifying')x.rooms.sourceHealth.set(code,{state:'verifying',at:x.now(),round:12});
  const before=structuredClone(x.rooms.state);
  assert.throws(()=>x.call('全猜 3',{messageId:'blocked-all-in'}));
  assert.deepEqual(x.rooms.state,before,reason);
 }
});

test('old saved round twelve state needs a verified fresh preparation snapshot before enabling all-in',()=>{
 const x=fixture();x.call('注册 小白');const {code}=x.open(),room=x.rooms.state.rooms[code];
 room.round=12;room.liveRound=12;room.open=true;room.tradingClosed=true;delete room.allInOpen;
 assert.equal(x.rooms.isOpen(room,true),false);
 x.rooms.sync(code,x.hourly.data().hostToken,{...x.snapshot,round:12,liveRound:12,closedThrough:11,open:false,sourcePhase:'preparation'});
 const p=x.hourly.presentation(x.rooms.state.rooms[code],'round',12);
 assert.equal(p.allInOpen,true);assert.match(p.closingWarning,/第13回合/);
});

test('all-in uses the selected wallet balance once, including amounts above the normal order limit',()=>{
 for(const balance of [10,1000,15037,350000,70000000001]){
  const x=fixture();x.call('注册 小白');const {code}=x.open(),key=x.web.playKey(x.user);
  x.rooms.state.accounts[key].balance=balance;
  const reply=x.call('全猜 3',{messageId:'full-wallet'});
  const room=x.rooms.state.rooms[code],position=room.positions[key][2];
  assert.equal(x.web.me(x.user).playBalance,0);
  assert.equal(position.stake,balance);assert.equal(position.rank,1);
  assert.equal(position.claim,Number(BigInt(balance)*BigInt(room.quoteRates[16])*3n/10000n));
  assert.equal(position.cashoutLocked,true);
  assert.equal(room.actionCounts[key][2],1);assert.equal(room.cashflows[key].invested,balance);
  assert(reply.lines[0].includes('全部可用'+balance+'马币'));
  const snapshot=structuredClone(x.rooms.state);
  assert.deepEqual(x.call('/全猜 3',{messageId:'full-wallet'}),reply);
  assert.deepEqual(x.rooms.state,snapshot);
 }
});

test('first-round triple claims settle by the locked amount for first, second and third place',()=>{
 for(const rank of [1,2,3]){
  const x=fixture();x.call('注册 小白');const {code}=x.open(),key=x.web.playKey(x.user);
  const reply=x.call('全猜 3');assert.match(reply.lines[0],/首回合额外×3/);
  const room=x.rooms.state.rooms[code],claim=room.positions[key][2].claim;
  assert.equal(claim,13800);
  const available=[1,2,3,4,5,6,7,8].filter(r=>r!==rank),ranks=Array.from({length:8},(_,i)=>i===2?rank:available.shift());
  x.rooms.sync(code,x.hourly.data().hostToken,{...x.snapshot,round:20,closedThrough:20,open:false,ended:true,ranks});
  const expected=rank===1?claim:rank===2?Math.floor(claim/4):Math.floor(claim/10);
  assert.equal(x.rooms.state.accounts[key].balance,expected);
  x.rooms.sync(code,x.hourly.data().hostToken,{...x.snapshot,round:20,closedThrough:20,open:false,ended:true,ranks});
  assert.equal(x.rooms.state.accounts[key].balance,expected);
 }
});

test('first-round all-in permanently locks that position against halves, sells and switches, including after restart',()=>{
 const x=fixture();x.call('注册 小白');const {code}=x.open(),key=x.web.playKey(x.user);
 const reply=x.call('全猜 3');qqCommand(x.web,x.hourly,x.user,{action:'ack',receiptId:reply.receiptId});
 for(const round of [1,2,9]){
  x.rooms.sync(code,x.hourly.data().hostToken,{...x.snapshot,round,liveRound:round,closedThrough:round-1,open:true,sourcePhase:'preparation'});
  for(const command of ['减半 3','撤回 3']){
   const before=structuredClone(x.rooms.state);
   assert.throws(()=>x.call(command,{messageId:'locked-reduction'}),/锁定至结算/);
   assert.deepEqual(x.rooms.state,before);
  }
  for(const kind of ['half','sell','switch']){
   const room=x.rooms.state.rooms[code],before=structuredClone(x.rooms.state);
   assert.throws(()=>x.rooms.trade(code,key,{kind,player:2,rank:1,stake:1,operation:'locked-operation',version:room.version}),/锁定至结算/);
   assert.deepEqual(x.rooms.state,before);
  }
 }
 const restored=new Rooms(JSON.parse(JSON.stringify(x.rooms.state)),undefined,x.now);
 restored.sync(code,x.hourly.data().hostToken,{...x.snapshot,round:9,liveRound:9,closedThrough:8,open:true,sourcePhase:'preparation'});
 assert.equal(restored.state.rooms[code].positions[key][2].cashoutLocked,true);
 assert.throws(()=>restored.trade(code,key,{kind:'sell',player:2,rank:1,operation:'post-restart-sell',version:restored.state.rooms[code].version}),/锁定至结算/);
});

test('later full guesses receive no triple bonus and can be withdrawn before round ten',()=>{
 for(const cachedFirst of [false,true]){
  const x=fixture();x.call('注册 小白');const {code}=x.open(),key=x.web.playKey(x.user),round=cachedFirst?1:2;
  x.rooms.sync(code,x.hourly.data().hostToken,{...x.snapshot,round,liveRound:2,closedThrough:round-1,open:true,sourcePhase:'preparation'});
  const reply=x.call('全猜 3');let p=x.rooms.state.rooms[code].positions[key][2];
  assert.equal(p.claim,4600);assert(!p.cashoutLocked);assert(!reply.lines[0].includes('首回合额外'));
  qqCommand(x.web,x.hourly,x.user,{action:'ack',receiptId:reply.receiptId});
  x.call('撤回 3',{messageId:'normal-full-sell'});assert.equal(x.rooms.state.accounts[key].balance,970);
 }
});

test('triple promotion applies only to the new first-round full fill and keeps the merged position locked',()=>{
 const x=fixture();x.call('注册 小白');const {code}=x.open(),key=x.web.playKey(x.user);
 const initial=x.call('竞猜 3 100',{messageId:'initial-regular'});qqCommand(x.web,x.hourly,x.user,{action:'ack',receiptId:initial.receiptId});
 const full=x.call('全猜 3',{messageId:'remaining-full'});qqCommand(x.web,x.hourly,x.user,{action:'ack',receiptId:full.receiptId});
 x.call('签到');x.call('竞猜 3 200',{messageId:'later-regular'});
 const p=x.rooms.state.rooms[code].positions[key][2];
 assert.equal(p.claim,460+12420+920);assert.equal(p.stake,1200);assert.equal(p.cashoutLocked,true);
});

test('unsafe potential all-in rewards are rejected before any debit or position is saved',()=>{
 const x=fixture();x.call('注册 小白');x.open();const key=x.web.playKey(x.user);
 x.rooms.state.accounts[key].balance=1000000000000;
 const before=structuredClone(x.rooms.state);
 assert.throws(()=>x.call('全猜 3'),/超过马币余额上限/);assert.deepEqual(x.rooms.state,before);
});

test('all-in resolves normal low-balance relief before taking the final available amount',()=>{
 const x=fixture();x.call('注册 小白');const {code}=x.open(),key=x.web.playKey(x.user);
 x.rooms.state.accounts[key].balance=1;
 x.call('全猜 3');
 assert.equal(x.rooms.state.rooms[code].positions[key][2].stake,51);
 assert.equal(x.web.me(x.user).playBalance,0);
});

test('all-in leaves existing positions and other wallets intact and settles its locked champion reward',()=>{
 const x=fixture();x.call('注册 小白');const {code}=x.open(),key=x.web.playKey(x.user);
 const other=x.rooms.register('原钱包').token;x.rooms.state.accounts[other].webOwner=x.user.subject;
 const first=x.call('竞猜 1 100',{messageId:'earlier-quiz'});
 qqCommand(x.web,x.hourly,x.user,{action:'ack',receiptId:first.receiptId});
 x.call('全猜 3',{messageId:'rest-quiz'});
 const room=x.rooms.state.rooms[code],claim=room.positions[key][2].claim;
 assert.equal(room.positions[key][0].stake,100);assert.equal(room.positions[key][2].stake,900);
 assert.equal(x.rooms.state.accounts[other].balance,1000);
 x.rooms.sync(code,x.hourly.data().hostToken,{...x.snapshot,round:20,closedThrough:20,open:false,ended:true,ranks:[8,7,1,6,5,4,3,2]});
 assert.equal(x.rooms.state.accounts[key].balance,claim);
 assert.equal(room.payouts[key],claim);assert.equal(x.rooms.state.accounts[other].balance,1000);
});

test('all-in receipts survive restart and never consume a later check-in grant',()=>{
 const x=fixture();x.call('注册 小白');x.open();
 const reply=x.call('全猜 选手2',{messageId:'full-restart'});
 x.call('签到');assert.equal(x.web.me(x.user).playBalance,200);
 const rooms=new Rooms(JSON.parse(JSON.stringify(x.rooms.state)),undefined,x.now),web=new PredictionWeb(rooms,{bridgeKey,now:x.now}),hourly=new HourlyEvents(rooms,web);
 assert.deepEqual(qqCommand(web,hourly,x.user,{text:'/全猜 选手2',messageId:'full-restart',messageAt:x.now()}),reply);
 assert.equal(web.me(x.user).playBalance,200);
 assert.throws(()=>qqCommand(web,hourly,x.user,{text:'全猜 4',messageId:'full-restart',messageAt:x.now()}),/内容不一致/);
 assert.equal(web.me(x.user).playBalance,200);
});

test('all-in rejects empty funds, extra amounts, retired players and round ten without changing state',()=>{
 for(const reason of ['empty','amount','retired','closed','missing']){
  const x=fixture();x.call('注册 小白');const {code}=x.open(),room=x.rooms.state.rooms[code],key=x.web.playKey(x.user);
  if(reason==='empty'){x.rooms.state.accounts[key].balance=0;x.rooms.state.accounts[key].transferOut=1000;}
  if(reason==='retired')room.active[2]=false;
  if(reason==='closed'){room.round=13;room.tradingClosed=true;}
  const before=structuredClone(x.rooms.state);
  assert.throws(()=>x.call(reason==='amount'?'全猜 3 200':reason==='missing'?'全猜':'全猜 3'),reason==='empty'?/没有可用马币/:reason==='retired'?/已淘汰|退出/:reason==='closed'?/截止/:/用法|选手编号/);
  assert.deepEqual(x.rooms.state,before,reason);
 }
});

test('failed all-in persistence rolls back funds, positions and receipts so the exact message can retry',()=>{
 let fail=false;const x=fixture(()=>{if(fail)throw Error('disk full');});x.call('注册 小白');x.open();
 const before=structuredClone(x.rooms.state);fail=true;
 assert.throws(()=>x.call('全猜 3',{messageId:'all-save-failure'}),/disk full/);
 assert.deepEqual(x.rooms.state,before);fail=false;
 const reply=x.call('全猜 3',{messageId:'all-save-failure'});
 assert.equal(x.web.me(x.user).playBalance,0);
 assert.deepEqual(x.call('全猜 3',{messageId:'all-save-failure'}),reply);
});

test('only an explicit complete-balance order bypasses the ordinary 10000 limit',()=>{
 const x=fixture();x.call('注册 小白');const {code}=x.open(),key=x.web.playKey(x.user),room=x.rooms.state.rooms[code];
 x.rooms.join(code,key,room.gameId);x.rooms.state.accounts[key].balance=35000;
 const order={kind:'buy',player:2,rank:1,operation:'ordinary-full-order',version:room.version,stake:35000};
 const before=structuredClone(x.rooms.state);
 assert.throws(()=>x.rooms.trade(code,key,order),/10000/);
 assert.throws(()=>x.rooms.trade(code,key,{...order,stake:20000,allIn:true}),/全部可用余额/);
 assert.deepEqual(x.rooms.state,before);
 x.rooms.trade(code,key,{...order,allIn:true});assert.equal(x.rooms.state.accounts[key].balance,0);
});

test('quiz aliases preserve canonical receipt digests and never repeat a debit',()=>{
 for(const [input,canonical]of [['竞猜','下注'],['观战','赛马'],['走势','盘口'],['减半','退半'],['撤回','清仓'],['马币','马币']]){
  for(const prefix of ['','/'])assert.equal(normalizeRaceCommand(prefix+input+' 1 200'),'/'+canonical+' 1 200');
 }
 const x=fixture();x.call('注册 小白');x.open();
 const first=x.call('/下注 1 100',{messageId:'same-quiz-operation'});
 const after=structuredClone(x.rooms.state);
 assert.deepEqual(x.call('竞猜 1 100',{messageId:'same-quiz-operation'}),first);
 assert.deepEqual(x.rooms.state,after);
 assert.equal(x.web.me(x.user).playBalance,900);
 const help=x.call('帮助').lines.join('\n');
 for(const name of ['竞猜','观战','走势','减半','撤回','马币'])assert(help.includes(name));
 assert(!/下注|盘口|赛马|封盘|赔率|清仓|退半/.test(help));
});

test('slash and bare racing commands normalize once and anonymous registration requires an explicit leaderboard ID',()=>{
 for(const text of ['赛马注册','/赛马注册'])assert.equal(normalizeRaceCommand(text),'/赛马注册');
 assert.equal(normalizeRaceCommand(' 观战注册 小白 '),'/赛马注册 小白');assert.equal(normalizeRaceCommand('普通聊天'),null);
 const x=fixture(),before=structuredClone(x.rooms.state);assert(x.call('赛马注册').lines.some(l=>l.includes('上榜ID')));assert.deepEqual(x.rooms.state,before);
 assert.throws(()=>x.call('竞猜 1 100'),/先发送/);assert.deepEqual(x.rooms.state,before);
 const r=x.call('观战注册 小白');assert(r.lines.some(l=>l.includes('注册成功')));for(const word of ['竞猜','选手','撤回','签到','认证游戏账号'])assert(r.lines.join(' ').includes(word));
 assert.equal(x.web.me(x.user).playBalance,1000);assert.equal(x.web.leaderboard().items[0].name,'小白');
 for(let i=0;i<4;i++)x.call('/赛马注册');assert.equal(x.web.me(x.user).playBalance,1000);assert.equal(Object.keys(x.rooms.state.accounts).length,1);
});
test('a registered unlicensed QQ can buy, sign in and transfer; receipt retries remain atomic',()=>{
 const x=fixture();x.call('观战注册 小白');x.call('马币签到');assert.equal(x.web.me(x.user).playBalance,1200);x.call('/马币签到');assert.equal(x.web.me(x.user).playBalance,1200);
 const room=x.open(),order={messageId:'unlicensed-bet'};const first=x.call('竞猜 1 100',order);assert.equal(x.web.me(x.user).playBalance,1100);assert.equal(x.rooms.state.rooms[room.code].positions[x.web.playKey(x.user)][0].claim,460);
 assert.deepEqual(x.call('/下注 1 100',order),first);assert.equal(x.web.me(x.user).playBalance,1100);
 x.call('赛马 查单');qqCommand(x.web,x.hourly,x.user,{action:'ack',receiptId:first.receiptId});
 const recipient=x.actor('c'),transfer=x.call('马币转账 200',{recipientTicket:x.sign(recipient),messageId:'registered-transfer'});
 assert.equal(x.web.me(x.user).playBalance,900);assert.equal(x.web.me(recipient).playBalance,1200);assert.deepEqual(x.call('/马币转账 200',{recipientTicket:x.sign(recipient),messageId:'registered-transfer'}),transfer);
 x.call('观战注册 收款道友',{},recipient);assert.equal(x.web.me(recipient).playBalance,1200);assert.equal(x.web.me(recipient).name,'收款道友');
});
test('later game binding retains the registered name, money, grants and old message receipt without double buying',()=>{
 const x=fixture(),uid='1234567890abcdef12345678';x.call('观战注册 小白');x.call('马币签到');const room=x.open(),reply=x.call('竞猜 1 100',{messageId:'before-binding'});
 const game=x.rooms.register('游戏账户').token;x.rooms.state.accounts[game].uid=uid;
 const bound={...x.user,subject:'d'.repeat(64),boundAccount:true,name:'游戏名',bindingDigest:linkCandidates(x.rooms).digest,gameUidRef:createHmac('sha256',Buffer.from(bridgeKey,'hex')).update('prediction-game-uid:'+uid).digest('hex')};
 syncQqWallet(x.web,bound);const balance=x.web.me(bound).balance;
 assert.equal(x.web.me(bound).name,'小白');assert.deepEqual(x.call('竞猜 1 100',{messageId:'before-binding'},bound),reply);assert.equal(x.web.me(bound).balance,balance);
 qqCommand(x.web,x.hourly,bound,{action:'ack',receiptId:reply.receiptId});
 x.snapshot.ended=true;x.snapshot.round=15;x.snapshot.ranks=[1,2,3,4,5,6,7,8];x.hourly.sync(room.code,x.snapshot);
 syncQqWallet(x.web,bound);assert.equal(x.web.playKey(bound),game);assert.equal(x.web.me(bound).playBalance,2560);assert.equal(x.web.me(bound).checkIn.claimed,true);
 assert.equal(x.rooms.state.profiles[bound.subject].name,'小白');
});
test('registration failure and malformed IDs never create partial accounts or duplicate opening grants',()=>{
 let fail=false;const x=fixture(()=>{if(fail)throw Error('disk failed');});const before=structuredClone(x.rooms.state);
 for(const name of ['x'.repeat(25),'bad'+String.fromCharCode(1)])assert.throws(()=>x.call('观战注册 '+name));
 assert.deepEqual(x.rooms.state,before);fail=true;assert.throws(()=>x.call('观战注册 小白'),/disk/);assert.deepEqual(x.rooms.state,before);
});
test('migration sends the exact transition hour to both groups and retains per-group confirmations on restart',()=>{
 for(const kind of ['start','round','settled']){
  const targets=raceNoticeTargets(TRANSITION_SLOT,kind);assert.deepEqual(targets.map(t=>t.groupId),[RACE_GROUP,LEGACY_GROUP]);
  assert.equal(!!targets[1].notice,kind!=='round');if(kind!=='round')assert(targets[1].notice.includes(RACE_GROUP));
 }
 assert.deepEqual(raceNoticeTargets('2026110315','start').map(t=>t.groupId),[RACE_GROUP]);
 const x=fixture();x.open();const event=x.hourly.claim();assert.equal(event.targets.length,2);
 const financial=JSON.stringify(x.rooms.state.accounts);x.hourly.ack(event.id,event.lease,RACE_GROUP);assert.equal(x.rooms.state.hourly.outbox[0].deliveredAt,null);
 x.time(x.now()+60001);const restored=new Rooms(JSON.parse(JSON.stringify(x.rooms.state)),undefined,x.now),h=new HourlyEvents(restored,new PredictionWeb(restored,{bridgeKey,now:x.now}));
 const retry=h.claim();assert.deepEqual(retry.targets.map(t=>t.groupId),[LEGACY_GROUP]);h.ack(retry.id,retry.lease,LEGACY_GROUP);assert(h.data().outbox[0].deliveredAt);assert.equal(JSON.stringify(restored.state.accounts),financial);
});
