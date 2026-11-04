import test from 'node:test';
import assert from 'node:assert/strict';
import {Rooms} from './rooms.mjs';
import {PredictionWeb} from './web.mjs';
import {HourlyEvents,hourlySlot,hourlySearch,eligibleLobby,publicSummary} from './hourly.mjs';
import {publicPresentation} from './public-build.mjs';
import {qqCommand,serviceAccess} from './qq.mjs';
import http from 'node:http';
import {createHmac,createHash} from 'node:crypto';
import {createHandler} from './server.mjs';
import {readFileSync} from 'node:fs';
import {shuffleReveal} from './shuffle-reveal.mjs';

const user={subject:'a'.repeat(64),qqSubject:'c'.repeat(64),bindingDigest:createHash('sha256').update('[]').digest('hex'),gameUidRef:null,name:'认证观众',scope:'qq-prediction',groupId:'599092307'};
function fixture(save){
 let now=Date.UTC(2026,10,1,0,0);const rooms=new Rooms(undefined,save,()=>now),web=new PredictionWeb(rooms,{now:()=>now});
 const hourly=new HourlyEvents(rooms,web),info={roomId:'native-hourly',round:1,isPrivate:false,avgRankScore:6000,playerCount:8};
 const snapshot={id:'code:1234567',gameRoomId:info.roomId,round:1,closedThrough:0,open:true,ended:false,
  players:Array.from({length:8},(_,i)=>({uid:'private-player-'+i,name:'选手'+(i+1)})),ranks:Array(8).fill(0),active:Array(8).fill(true),
  baseRates:Array(64).fill(40000),horseTitles:Array(8).fill('上等马'),states:Array.from({length:8},()=>({life:100,wins:0,losses:0}))};
 snapshot.builds=Array.from({length:8},(_,i)=>({characterId:1000001+i,characterName:'角色'+i,sectId:1,sectName:'剑宗',careerId:2,careerName:'符师',realmId:1,realmName:'炼气',talents:[{id:10001,name:'凝气'}],baijia:[],fates:[],resonance:null,selectionRound:0,selectionsKnown:false,cards:null,cardNames:null}));
 return {rooms,web,hourly,info,snapshot,now:()=>now,time:t=>now=t,open:()=>hourly.open(info,snapshot)};
}
test('closed horse reveal matches the actual donor for every native model fixture, including ties and AI',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('./observer/fixtures/quotes.json',import.meta.url),'utf8'));
 const counts=new Set();
 for(const f of fixtures){
  const room={eventSlot:'event',code:'123456',horseShuffle:true,tradingClosed:true,round:10,gameId:f.id,horseTitles:f.titles,players:f.players.map((p,i)=>({uid:p.uid,name:'选手'+i}))};
  const reveal=shuffleReveal(room),expected=f.sources.flatMap((donor,i)=>donor===i?[]:[{fromSeat:donor+1,fromName:'选手'+donor,toSeat:i+1,toName:'选手'+i,title:f.titles[i]}]);
  counts.add(expected.length);assert.deepEqual(reveal.shuffleTransfers,expected);assert(!JSON.stringify(reveal).includes(f.players[0].uid));
 }
 assert(counts.has(2)&&counts.has(3));
});
test('WHITE reveals only after permanent close, without battle assets, once across resync, restart and per-group retry',()=>{
 const x=fixture();x.time(Date.UTC(2026,10,3,6));x.snapshot.horseShuffle=true;const {code}=x.open(),start=x.hourly.claim();
 for(const target of start.targets)x.hourly.ack(start.id,start.lease,target.groupId);
 x.snapshot.round=9;x.snapshot.open=false;x.snapshot.sourcePhase='battle';x.snapshot.builds=Array(8).fill(null);
 x.hourly.sync(code,x.snapshot);assert.equal(x.hourly.claim(),null);assert(!JSON.stringify(x.web.watch(x.rooms.state.rooms[code])).includes('shuffleTransfers'));
 x.snapshot.liveRound=10;x.hourly.sync(code,x.snapshot);x.hourly.sync(code,x.snapshot);
 const notice=x.hourly.claim();assert.equal(notice.kind,'shuffle');assert.equal(notice.presentation.round,10);assert(notice.presentation.shuffleTransfers.length>=2);
 assert.equal(notice.targets.length,2);x.hourly.ack(notice.id,notice.lease,notice.targets[0].groupId);
 x.time(x.now()+61000);const rooms=new Rooms(structuredClone(x.rooms.state),undefined,x.now),h=new HourlyEvents(rooms,new PredictionWeb(rooms,{now:x.now}));
 const retry=h.claim();assert.equal(retry.id,notice.id);assert.deepEqual(retry.targets,notice.targets.slice(1));
 h.ack(retry.id,retry.lease,retry.targets[0].groupId);h.sync(code,x.snapshot);assert.equal(h.claim(),null);
 assert.equal(h.data().outbox.filter(e=>e.kind==='shuffle').length,1);
 const room=rooms.state.rooms[code];assert.equal(shuffleReveal({...room,tradingClosed:false,ended:false,settled:false}),null);
 assert.equal(shuffleReveal({...room,horseShuffle:false}),null);
 assert.deepEqual(shuffleReveal({...room,horseTitles:Array(8).fill('电子马·中等')}).shuffleTransfers,[]);
});
test('Beijing hourly window excludes 02 through 06 inclusive, keeps searching in fallback and has stable day keys',()=>{
 for(let hour=0;hour<24;hour++){const at=Date.UTC(2026,10,1,hour-8);assert.equal(!!hourlySlot(at),!(hour>=2&&hour<=6));}
 assert.equal(hourlySlot(Date.UTC(2026,10,1,0,4,59)),'2026110108');assert.equal(hourlySlot(Date.UTC(2026,10,1,0,5)),'2026110108');
 assert.equal(hourlySlot(Date.UTC(2026,10,1,0,10)),null);
 assert.equal(hourlySlot(Date.UTC(2026,10,1,16)),'2026110200');
});
test('five minutes switches from 6000 inclusive to strictly above 5000 and exactly ten minutes stops opening',()=>{
 const start=Date.UTC(2026,10,1,0),priority=hourlySearch(start+299999),fallback=hourlySearch(start+300000);
 assert.deepEqual(priority,{slot:'2026110108',searchPhase:'priority',minimumRankScore:6000,minimumRankScoreExclusive:false});
 assert.deepEqual(fallback,{slot:'2026110108',searchPhase:'fallback',minimumRankScore:5000,minimumRankScoreExclusive:true});
 assert.deepEqual(hourlySearch(start+599999),fallback);assert.equal(hourlySearch(start+600000),null);assert.equal(hourlySearch(start+3599999),null);assert.equal(hourlySearch(start+3600000).minimumRankScore,6000);
 for(let hour=2;hour<=6;hour++)for(const minute of [0,5,59])assert.equal(hourlySearch(Date.UTC(2026,10,1,hour-8,minute)),null);
 const x=fixture();
 for(const score of [4999,5000,5001,5999,6000,7000]){
  assert.equal(eligibleLobby({...x.info,avgRankScore:score},priority.minimumRankScore,priority.minimumRankScoreExclusive),score>=6000);
  assert.equal(eligibleLobby({...x.info,avgRankScore:score},fallback.minimumRankScore,fallback.minimumRankScoreExclusive),score>5000);
 }
 assert(!eligibleLobby({...x.info,avgRankScore:5000.5},5000,true));
});
test('fallback opens one fresh 5001-point game per hour; restart and midnight cannot duplicate or weaken exclusions',()=>{
 const x=fixture(),start=x.now();x.info.avgRankScore=5001;
 assert.throws(x.open,/前5分钟/);assert.equal(Object.keys(x.rooms.state.rooms).length,0);
 x.time(start+300000);const status=x.hourly.status();assert.equal(status.available,true);assert.equal(status.searchPhase,'fallback');assert.equal(status.searchMinutes,10);assert.equal(status.priorityMinutes,5);assert.equal(status.minimumRankScoreExclusive,true);
 for(const patch of [{avgRankScore:5000},{round:3},{isPrivate:true},{playerCount:7}])assert.throws(()=>x.hourly.open({...x.info,...patch},x.snapshot));
 const room=x.open();assert.equal(room.bonusBps,11500);assert.equal(x.open().code,room.code);
 const restored=new Rooms(structuredClone(x.rooms.state),undefined,x.now),h=new HourlyEvents(restored,new PredictionWeb(restored,{now:x.now}));
 assert.equal(h.open(x.info,x.snapshot).code,room.code);assert.equal(Object.keys(restored.state.rooms).length,1);
 assert.throws(()=>h.open({...x.info,roomId:'another'}, {...x.snapshot,id:'another',gameRoomId:'another'}),/开过一场/);
 x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];h.sync(room.code,x.snapshot);
 assert.equal(h.status().opened,room.code);
 x.time(Date.UTC(2026,10,1,17,9));assert.equal(h.status().available,true);assert.equal(h.status().minimumRankScoreExclusive,true);
 x.time(Date.UTC(2026,10,1,17,10));assert.equal(h.status().available,false);assert.equal(h.status().searchPhase,null);
 x.time(Date.UTC(2026,10,1,18,5));assert.equal(h.status().available,false);assert.equal(h.status().searchPhase,null);assert.throws(()=>h.open(x.info,{...x.snapshot,id:'blocked',ended:false}),/时段/);
});
test('a candidate picked before minute ten cannot open after it, while accepted wagers keep watching and settle normally',()=>{
 const x=fixture(),start=x.now();x.info.avgRankScore=5001;x.time(start+599999);assert.equal(x.hourly.status().available,true);
 const before=structuredClone(x.rooms.state);x.time(start+600000);assert.throws(x.open,/时段/);assert.deepEqual(x.rooms.state,before);
 const y=fixture(),origin=y.now();y.time(origin+300000);const room=y.open(),key=y.rooms.register('竞猜记录者').token;
 y.rooms.join(room.code,key,y.snapshot.id);y.rooms.trade(room.code,key,{kind:'buy',player:0,rank:1,stake:100,version:y.rooms.state.rooms[room.code].version,operation:'before-search-deadline'});
 const claim=y.rooms.state.rooms[room.code].positions[key][0].claim;
 y.time(origin+600000);assert.equal(y.hourly.status().available,false);assert.equal(y.hourly.status().active.code,room.code);assert.equal(y.hourly.status().searchPhase,null);
 y.snapshot.round=2;y.hourly.sync(room.code,y.snapshot);assert.equal(y.rooms.state.rooms[room.code].positions[key][0].claim,claim);assert.equal(y.web.watch(y.rooms.state.rooms[room.code]).open,true);
 y.snapshot.round=15;y.snapshot.ended=true;y.snapshot.ranks=[1,2,3,4,5,6,7,8];y.hourly.sync(room.code,y.snapshot);
 assert.equal(y.rooms.view(room.code,key).balance,900+claim);assert.equal(y.hourly.status().active,null);
 y.hourly.sync(room.code,y.snapshot);assert.equal(y.rooms.view(room.code,key).balance,900+claim);
});
test('selection uses actual public eight-player round 1/2 and native rank score, never an Elo default',()=>{
 const x=fixture();assert(eligibleLobby(x.info));
 for(const patch of [{isPrivate:true},{round:0},{round:3},{avgRankScore:5999},{avgRankScore:3001},{playerCount:7},{roomId:'../private'}])assert(!eligibleLobby({...x.info,...patch}));
 assert(!eligibleLobby({...x.info,avgRankScore:undefined,elo:9999}));
});
test('opening forwards native per-player ladder/Daoxin scores by UID without shuffling them or exposing Elo/UIDs',()=>{
 const x=fixture();x.info.nativeRanks=x.snapshot.players.map((p,i)=>({uid:p.uid,score:7000+i*100,mode:i%2?'daoxin':'ladder'})).reverse();
 const room=x.open(),event=x.hourly.claim();assert.equal(event.kind,'start');
 for(let i=0;i<8;i++){
  assert.deepEqual(event.presentation.players[i].nativeRank,{score:7000+i*100,mode:i%2?'daoxin':'ladder'});
  assert(event.lines.some(s=>s.startsWith((i+1)+'号 ')&&s.includes((i%2?'道心':'天梯')+' '+(7000+i*100)+'分')));
 }
 assert(!JSON.stringify(event.presentation).includes('private-player-'));assert(!JSON.stringify(event.presentation).includes('elo'));
 assert(!JSON.stringify(x.web.watch(x.rooms.state.rooms[room.code])).includes('nativeRank'));
 x.info.nativeRanks[0].score=999999;
 x.time(x.now()+60001);const saved=new Rooms(structuredClone(x.rooms.state),undefined,x.now),h=new HourlyEvents(saved,new PredictionWeb(saved,{now:x.now}));
 assert.equal(h.claim().presentation.players[7].nativeRank.score,7700);
 const r=saved.state.rooms[room.code];assert(h.presentation(r,'round',1).players.every(p=>!('nativeRank'in p)));assert(h.presentation(r,'settled',1).players.every(p=>!('nativeRank'in p)));
});
test('opening rejects mismatched or malformed native rank annotations before any room or wallet is written',()=>{
 const rows=()=>Array.from({length:8},(_,i)=>({uid:'private-player-'+i,score:7000,mode:'ladder'}));
 for(const patch of [r=>r.pop(),r=>r[0].uid='foreign',r=>r[0].uid=r[1].uid,r=>r[0].score=-1,r=>r[0].score=NaN,r=>r[0].mode='gameMode3']){
  const x=fixture();x.info.nativeRanks=rows();patch(x.info.nativeRanks);const before=structuredClone(x.rooms.state);
  assert.throws(x.open,/公开段位分/);assert.deepEqual(x.rooms.state,before);
 }
 const x=fixture();x.info.nativeRanks=rows();x.info.nativeRanks[0].score=null;x.open();assert(x.hourly.claim().lines.some(s=>s.includes('天梯分未公开')));
});
test('one authoritative hourly room, immutable 15% premium, restart deduplication and unchanged standard quotes',()=>{
 const x=fixture(),r=x.open(),code=r.code;assert.equal(r.players[0].quoteRate,46000);assert.equal(r.bonusBps,11500);
 assert.equal(x.open().code,code);assert.equal(Object.keys(x.rooms.state.rooms).length,1);
 const restored=new Rooms(structuredClone(x.rooms.state),undefined,x.now),h=new HourlyEvents(restored,new PredictionWeb(restored,{now:x.now}));
 assert.equal(h.open(x.info,x.snapshot).code,code);
 x.time(x.now()+3600000);assert.throws(x.open,/上一场/);
 const key=x.rooms.register('普通房主').token,normal=x.rooms.create(key,{...x.snapshot,id:'another',gameRoomId:'another-native'});
 assert.equal(normal.quoteRates[0],40000);assert.equal(normal.bonusBps,10000);
 x.snapshot.round=2;x.snapshot.baseRates.fill(500000);x.hourly.sync(code,x.snapshot);assert.equal(x.rooms.state.rooms[code].quoteRates[0],575000);
});
test('6000 inclusive applies to new openings; an existing lower-score game continues with its original claims',()=>{
 const x=fixture(),r=x.open();x.hourly.data().slots[x.rooms.state.rooms[r.code].eventSlot].info.avgRankScore=3500;
 const key=x.rooms.register('观众').token;x.rooms.join(r.code,key,x.snapshot.id);x.rooms.trade(r.code,key,{kind:'buy',player:0,rank:1,stake:100,version:x.rooms.state.rooms[r.code].version,operation:'score-rule-bet-001'});
 const claim=x.rooms.state.rooms[r.code].positions[key][0].claim;x.snapshot.round=3;x.hourly.sync(r.code,x.snapshot);
 assert.equal(x.rooms.state.rooms[r.code].positions[key][0].claim,claim);assert.equal(x.hourly.status().minimumRankScore,6000);assert.equal(x.hourly.status().active.code,r.code);
 assert.equal(x.hourly.open({...x.info,avgRankScore:3500},x.snapshot).code,r.code);
});
test('ordinary website rooms never prevent an hourly opening; their holdings and game access remain intact',()=>{
 const x=fixture(),key=x.rooms.register('普通房主').token,ordinary=x.rooms.create(key,{...x.snapshot,id:'ordinary-game',gameRoomId:'native-ordinary'});
 x.rooms.trade(ordinary.code,key,{kind:'buy',player:0,rank:1,stake:100,version:x.rooms.state.rooms[ordinary.code].version,operation:'ordinary-before-hourly-001'});
 const before=structuredClone(x.rooms.state.rooms[ordinary.code]),balance=x.rooms.state.accounts[key].balance;
 assert.equal(x.rooms.websiteRoom().code,ordinary.code);assert.equal(x.hourly.status().available,true);
 const event=x.open();assert.equal(x.rooms.websiteRoom().code,event.code);assert.equal(x.web.listRooms().total,1);assert.equal(x.hourly.status().available,false);
 assert.deepEqual(x.rooms.state.rooms[ordinary.code],before);assert.equal(x.rooms.state.accounts[key].balance,balance);
 assert(x.rooms.list(key).rooms.some(r=>r.code===ordinary.code));assert.equal(x.rooms.view(ordinary.code,key).positions[0].claim,400);
});
test('QQ and website use one wallet, duplicate group commands across room changes cannot wager again; expiry does not cancel a locked payout',()=>{
 const x=fixture(),r=x.open();x.web.openAccount(user);const accounts=Object.keys(x.rooms.state.accounts).length;
 const command={text:'/下注 1 100',messageId:'one-message',messageAt:x.now()};
 const first=qqCommand(x.web,x.hourly,user,command);assert.equal(x.web.me(user).playBalance,900);assert.equal(Object.keys(x.rooms.state.accounts).length,accounts);
 const key=x.web.playKey(user);assert.equal(x.rooms.state.rooms[r.code].positions[key][0].claim,460);
 assert.deepEqual(qqCommand(x.web,x.hourly,user,command),first);assert.equal(x.web.me(user).playBalance,900);
 assert.throws(()=>qqCommand(x.web,x.hourly,user,{...command,text:'/下注 2 100'}),/内容不一致/);
  const pending=qqCommand(x.web,x.hourly,user,{...command,messageId:'new-message'});assert(pending.lines.some(s=>s.includes('尚未执行')));assert.equal(x.web.me(user).playBalance,900);
  qqCommand(x.web,x.hourly,user,{action:'ack',receiptId:first.receiptId});
 x.snapshot.round=10;x.hourly.sync(r.code,x.snapshot);assert.throws(()=>qqCommand(x.web,x.hourly,user,{...command,messageId:'late-message'}),/竞猜(?:已)?截止/);
 x.snapshot.round=18;x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];x.hourly.sync(r.code,x.snapshot);
 assert.equal(x.web.me(user).playBalance,1360);x.hourly.sync(r.code,x.snapshot);assert.equal(x.web.me(user).playBalance,1360);
 x.time(x.now()+3600000);x.snapshot.id='next-game';x.snapshot.gameRoomId='next-native';x.info.roomId='next-native';x.snapshot.ended=false;x.snapshot.round=1;x.snapshot.ranks.fill(0);x.open();
 assert.deepEqual(qqCommand(x.web,x.hourly,user,command),first);assert.equal(x.web.me(user).playBalance,1360);
 assert.throws(()=>qqCommand(x.web,x.hourly,user,{...command,messageId:'stale-message'}),/消息已过期/);
});
test('one QQ command buys multiple ordered legs including the same horse twice, and retries never debit again',()=>{
 const x=fixture(),v=x.open(),body={text:'/下注 1 200 2 300 1 200',messageId:'batch-001',messageAt:x.now()};
 const reply=qqCommand(x.web,x.hourly,user,body),key=x.web.playKey(user),r=x.rooms.state.rooms[v.code];
 assert.equal(x.web.me(user).playBalance,300);assert.equal(r.positions[key][0].claim,1840);assert.equal(r.positions[key][1].claim,1380);
 assert.equal(r.cashflows[key].invested,700);assert.equal(r.actionCounts[key][0],2);assert.equal(r.actionCounts[key][1],1);assert.equal(Object.keys(r.receipts).length,3);
 assert(reply.lines[0].includes('3笔，共投入700'));const before=structuredClone(x.rooms.state);
 assert.deepEqual(qqCommand(x.web,x.hourly,user,body),reply);assert.deepEqual(x.rooms.state,before);
 assert.throws(()=>qqCommand(x.web,x.hourly,user,{...body,text:'/下注 1 200 2 300 1 201'}),/内容不一致/);
 const restored=new Rooms(structuredClone(x.rooms.state),undefined,x.now),web=new PredictionWeb(restored,{now:x.now}),hourly=new HourlyEvents(restored,web);
 assert.deepEqual(qqCommand(web,hourly,user,body),reply);assert.equal(web.me(user).playBalance,300);
});
test('insufficient funds, malformed batches or a later eliminated horse roll back all legs and automatic wallet opening',()=>{
 for(const text of ['/下注 1 700 2 400','/下注 1 200 2','/下注 1 200 2 NaN','/下注 '+Array(33).fill('1 1').join(' ')]){
  const x=fixture();x.open();const before=structuredClone(x.rooms.state);
  assert.throws(()=>qqCommand(x.web,x.hourly,user,{text,messageId:'bad-batch',messageAt:x.now()}));assert.deepEqual(x.rooms.state,before);
 }
 const x=fixture(),v=x.open();x.snapshot.active[1]=false;x.hourly.sync(v.code,x.snapshot);const before=structuredClone(x.rooms.state);
 assert.throws(()=>qqCommand(x.web,x.hourly,user,{text:'/下注 1 200 2 300',messageId:'inactive-batch',messageAt:x.now()}),/淘汰|退出/);assert.deepEqual(x.rooms.state,before);
});
test('batch save failures preserve every wallet, claim, cashflow and deduplication receipt',()=>{
 let fail=false;const x=fixture(()=>{if(fail)throw Error('disk failure')});x.open();const before=structuredClone(x.rooms.state);fail=true;
 assert.throws(()=>qqCommand(x.web,x.hourly,user,{text:'/下注 1 200 2 300 1 200',messageId:'disk-batch',messageAt:x.now()}));assert.deepEqual(x.rooms.state,before);
});
test('round nine warning leads the first sentence and multi-bets retain the round ten closure',()=>{
 const x=fixture(),v=x.open();x.snapshot.round=9;x.hourly.sync(v.code,x.snapshot);
 const view=x.web.watch(x.rooms.state.rooms[v.code]),presentation=publicPresentation(view,{round:8,noticeType:'round'});
 assert(publicSummary(view,{round:8})[0].startsWith('提醒：下回合（第10回合）起普通竞猜、减半和撤回截止'));assert.equal(presentation.closingWarning,publicSummary(view,{round:8})[0]);
 const reply=qqCommand(x.web,x.hourly,user,{text:'/下注 1 10 2 20',messageId:'round-nine-batch',messageAt:x.now()});
 qqCommand(x.web,x.hourly,user,{action:'ack',receiptId:reply.receiptId});x.snapshot.round=10;x.hourly.sync(v.code,x.snapshot);
 assert.equal(publicPresentation(x.web.watch(x.rooms.state.rooms[v.code])).closingWarning,null);
 const before=structuredClone(x.rooms.state);assert.throws(()=>qqCommand(x.web,x.hourly,user,{text:'/下注 1 10 2 20',messageId:'round-ten-batch',messageAt:x.now()}),/竞猜(?:已)?截止/);assert.deepEqual(x.rooms.state,before);
});
test('notifications are durable, leased, acknowledgement-gated and contain only public information',()=>{
 const x=fixture(),r=x.open();assert.equal(x.hourly.data().outbox.length,1);
 let item=x.hourly.claim();assert(item);assert.equal(x.hourly.claim(),null);assert.throws(()=>x.hourly.ack(item.id,'wrong'));
 x.time(x.now()+60001);const reclaimed=x.hourly.claim();assert.equal(reclaimed.id,item.id);x.hourly.ack(reclaimed.id,reclaimed.lease);assert.equal(x.hourly.claim(),null);
 x.snapshot.closedThrough=1;x.hourly.sync(r.code,x.snapshot);assert.equal(x.hourly.data().outbox.filter(e=>e.kind==='round').length,1);
 x.time(x.now()+45000);x.hourly.sync(r.code,x.snapshot);x.hourly.sync(r.code,x.snapshot);assert.equal(x.hourly.data().outbox.filter(e=>e.kind==='round').length,1);
 const view=x.web.watch(x.rooms.state.rooms[r.code]);Object.assign(view.players[0],{elo:9999,uid:'private-user',hand:['private-hand']});
 const summary=publicSummary(view).join('\n');assert(!/private-user|private-hand|9999|elo/i.test(summary));assert(summary.includes('上等马'));
 assert.equal(x.hourly.claim(),null);
});
test('actual native round ten permanently closes earlier delayed public rounds, and frozen models survive restart',()=>{
 const x=fixture(),model=x.snapshot.players.map(p=>({uid:p.uid,score:3400,found:true}));
 const view=x.hourly.open(x.info,x.snapshot,model);assert.deepEqual(x.hourly.status().active.model,model);
 x.snapshot.liveRound=10;x.hourly.sync(view.code,x.snapshot);assert.equal(x.web.watch(x.rooms.state.rooms[view.code]).open,false);
 x.snapshot.liveRound=2;x.hourly.sync(view.code,x.snapshot);assert.equal(x.rooms.state.rooms[view.code].tradingClosed,true);
 x.snapshot.closedThrough=1;x.snapshot.roundComplete=false;x.hourly.sync(view.code,x.snapshot);
 assert.equal(x.hourly.data().outbox.filter(e=>e.kind==='round').length,0);
 x.snapshot.roundComplete=true;x.hourly.sync(view.code,x.snapshot);x.time(x.now()+45000);x.hourly.sync(view.code,x.snapshot);assert.equal(x.hourly.data().outbox.filter(e=>e.kind==='round').length,1);
});
test('round announcement waits for public battle coverage and reports the next preparation state as that round result',()=>{
 const x=fixture(),r=x.open();const start=x.hourly.claim();x.hourly.ack(start.id,start.lease);x.snapshot.round=2;x.snapshot.closedThrough=1;x.snapshot.states=x.snapshot.states.map(()=>({life:80,wins:1,losses:0}));
 x.snapshot.builds.forEach(b=>{b.selectionRound=1;b.selectionsKnown=true;});
 x.hourly.sync(r.code,x.snapshot);assert.equal(x.hourly.claim(),null);x.time(x.now()+60000);assert.equal(x.hourly.claim(),null);
 x.snapshot.battles=Array.from({length:4},(_,i)=>({round:1,first:x.snapshot.players[i*2].uid,second:x.snapshot.players[i*2+1].uid,winner:x.snapshot.players[i*2].uid,
  firstMirror:false,secondMirror:false,firstCards:[1000010],secondCards:[1000012],firstNames:['云剑'],secondNames:['防御'],firstLife:80,secondLife:80,lifeDamage:20}));
 x.snapshot.builds[3].characterName='角色待识别';x.hourly.sync(r.code,x.snapshot);assert.equal(x.hourly.claim(),null);x.snapshot.builds[3].characterName='角色3';
 x.hourly.sync(r.code,x.snapshot);const event=x.hourly.data().outbox.find(e=>e.kind==='round');assert(event);assert.equal(event.round,1);
 assert(event.lines.some(line=>line.includes('命元80')));assert(!event.lines.some(line=>line.includes('命元100')));assert.equal(event.lines.filter(line=>line.includes(' 对 ')).length,4);
 assert.equal(x.hourly.claim().round,1);
 x.hourly.sync(r.code,x.snapshot);assert.equal(x.hourly.data().outbox.filter(e=>e.kind==='round').length,1);
});
test('observer liveness reports never refresh quotes; verification pauses immediately and round ten cannot reopen',()=>{
 const x=fixture(),v=x.open(),r=x.rooms.state.rooms[v.code],before=structuredClone(x.rooms.state),at=x.rooms.syncTimes.get(v.code);
 x.hourly.source(v.code,r.gameId,'verifying',1);assert.deepEqual(x.rooms.state,before);assert.equal(x.rooms.isOpen(r),false);assert.equal(x.rooms.availability(r).state,'verifying');
 x.time(x.now()+16000);assert.equal(x.rooms.syncTimes.get(v.code),at);assert.equal(x.web.watch(r).fresh,false);assert.equal(x.rooms.availability(r).state,'verifying');
 x.hourly.sync(v.code,x.snapshot);assert.equal(x.rooms.isOpen(r),true);x.hourly.source(v.code,r.gameId,'verifying',10);assert.equal(x.rooms.availability(r).state,'closed');
 x.hourly.sync(v.code,x.snapshot);assert.equal(x.rooms.isOpen(r),false);assert.equal(x.rooms.availability(r).state,'closed');
 assert.throws(()=>x.hourly.source(v.code,'wrong-game','verifying',1));
});
test('settlement is forwarded once while incomplete final battle reports remain queued',()=>{
 const x=fixture(),v=x.open();let event=x.hourly.claim();x.hourly.ack(event.id,event.lease);
 Object.assign(x.snapshot,{round:2,closedThrough:2,ended:true,open:false,ranks:[1,2,3,4,5,6,7,8]});
 const result=x.hourly.sync(v.code,x.snapshot);assert.equal(result.settled,true);assert.equal(result.reportReady,false);
 const accounts=structuredClone(x.rooms.state.accounts),r=x.rooms.state.rooms[v.code],financial=structuredClone({positions:r.positions,payouts:r.payouts,cashflows:r.cashflows});
 event=x.hourly.claim();assert.equal(event.kind,'settled');assert.equal(event.presentation.noticeType,'settled');assert(event.presentation.settlement.closing.includes('已结算'));
 x.hourly.ack(event.id,event.lease);assert.equal(x.hourly.claim(),null);
 assert(x.hourly.data().outbox.some(e=>e.kind==='round'&&!e.deliveredAt));
 assert.deepEqual(x.rooms.state.accounts,accounts);assert.deepEqual({positions:r.positions,payouts:r.payouts,cashflows:r.cashflows},financial);
});
test('failed saving rolls back wallet, global QQ receipt, joining, account creation and event outbox together',()=>{
 let fail=false;const x=fixture(()=>{if(fail)throw new Error('disk unavailable')});const r=x.open(),before=structuredClone(x.rooms.state);fail=true;
 assert.throws(()=>qqCommand(x.web,x.hourly,user,{text:'/下注 1 100',messageId:'first-command',messageAt:x.now()}));assert.deepEqual(x.rooms.state,before);
 x.snapshot.closedThrough=1;assert.throws(()=>x.hourly.sync(r.code,x.snapshot));assert.deepEqual(x.rooms.state,before);
});
test('bot scope, dedicated service keys, exited players and invalid amounts fail closed',()=>{
 const x=fixture();x.open();assert.throws(()=>serviceAccess(undefined,''));assert.throws(()=>serviceAccess('Bearer '+'x'.repeat(32),'y'.repeat(32)));
 serviceAccess('Bearer '+'x'.repeat(32),'x'.repeat(32));
 const body={text:'/下注 1 100',messageId:'invalid-test',messageAt:x.now()};
 assert.throws(()=>qqCommand(x.web,x.hourly,{...user,scope:undefined},body));assert.throws(()=>qqCommand(x.web,x.hourly,{...user,groupId:'other'},body));
 for(const amount of ['-1','0','1.2','NaN','10001','1e3'])assert.throws(()=>qqCommand(x.web,x.hourly,user,{...body,text:'/下注 1 '+amount}));
 const r=x.rooms.websiteRoom();x.snapshot.active[0]=false;x.hourly.sync(r.code,x.snapshot);assert.throws(()=>qqCommand(x.web,x.hourly,user,body),/退出/);
});
test('real HTTP separates observer, bot and normal clients, and rejects expired or ordinary web tickets',async()=>{
 const x=fixture(),observerKey='o'.repeat(32),botKey='b'.repeat(32),bridgeKey='a'.repeat(64);
 const server=http.createServer(createHandler(x.rooms,{observerKey,botKey,bridgeKey,now:x.now}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 const post=async(path,body,headers={})=>{const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
 const proof=p=>{const body=Buffer.from(JSON.stringify(p)).toString('base64url');return body+'.'+createHmac('sha256',Buffer.from(bridgeKey,'hex')).update(body).digest('base64url');};
 try{
  assert.equal((await post('/ops/hourly',{action:'status'})).status,401);
  assert.equal((await post('/ops/hourly',{action:'status'},{authorization:'Bearer '+botKey})).status,401);
  assert.equal((await post('/ops/hourly',{action:'open',info:x.info,snapshot:x.snapshot},{authorization:'Bearer '+observerKey})).status,200);
  const body={text:'/下注 1 100',messageId:'http-qq-message',messageAt:x.now()};
  for(const p of [{...user,expiresAt:x.now()-1},{...user,scope:undefined,expiresAt:x.now()+10000}])assert([401,403].includes((await post('/bot/command',body,{authorization:'Bearer '+botKey,'x-prediction-identity':proof(p)})).status));
  const ticket=proof({...user,expiresAt:x.now()+10000});assert.equal((await post('/bot/command',body,{authorization:'Bearer '+botKey,'x-prediction-identity':ticket})).status,200);
  assert.equal(x.web.me(user).playBalance,900);
  assert.equal((await post('/bot/events',{action:'claim'},{authorization:'Bearer '+observerKey})).status,401);
  assert.equal((await post('/bot/events',{action:'claim'},{authorization:'Bearer '+botKey})).status,409);
  assert((await post('/bot/events',{action:'claim',protocol:2},{authorization:'Bearer '+botKey})).data);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('concurrent HTTP retries of a multi-bet QQ message create one atomic receipt and one debit',async()=>{
 const x=fixture();x.open();const botKey='b'.repeat(32),bridgeKey='a'.repeat(64),server=http.createServer(createHandler(x.rooms,{botKey,bridgeKey,now:x.now}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const payload=Buffer.from(JSON.stringify({...user,expiresAt:x.now()+60000})).toString('base64url'),proof=payload+'.'+createHmac('sha256',Buffer.from(bridgeKey,'hex')).update(payload).digest('base64url');
 const body={text:'/下注 1 200 2 300 1 200',messageId:'http-batch-once',messageAt:x.now()},url='http://127.0.0.1:'+server.address().port+'/bot/command';
 try{
  const responses=await Promise.all(Array.from({length:8},()=>fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+botKey,'x-prediction-identity':proof},body:JSON.stringify(body)})));
  assert(responses.every(r=>r.status===200));const replies=await Promise.all(responses.map(r=>r.json()));assert(replies.every(r=>JSON.stringify(r.data)===JSON.stringify(replies[0].data)));
  assert.equal(x.web.me(user).playBalance,300);assert.equal(Object.keys(x.rooms.state.qqReceipts).length,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('final public report recovery changes battle annotations only and rejects conflicts atomically',()=>{
 const x=fixture(),v=x.open();assert.throws(()=>x.hourly.recoverReport(v.code,x.snapshot.id,[]),/已结算/);
 Object.assign(x.snapshot,{round:3,closedThrough:3,ended:true,open:false,ranks:[1,2,3,4,5,6,7,8]});
 x.snapshot.builds.forEach(b=>{b.selectionRound=3;b.cards=[1000010];b.cardNames=['云剑'];});x.hourly.sync(v.code,x.snapshot);
 assert.equal(x.hourly.status().reports.length,1);
 const r=x.rooms.state.rooms[v.code],financial=structuredClone({accounts:x.rooms.state.accounts,positions:r.positions,payouts:r.payouts,cashflows:r.cashflows,ranks:r.ranks,states:r.states,open:r.open,settled:r.settled});
 const battles=Array.from({length:4},(_,i)=>({round:3,first:r.players[i*2].uid,second:r.players[i*2+1].uid,winner:r.players[i*2].uid,firstMirror:false,secondMirror:false,firstCards:[1000010],secondCards:[1000010],firstNames:['云剑'],secondNames:['云剑'],firstLife:80,secondLife:60,lifeDamage:20,resultComplete:true}));
 assert.equal(x.hourly.recoverReport(v.code,r.gameId,battles).reportReady,false);assert.deepEqual(x.hourly.status().reports[0].recoveryRounds,[1]);
 assert.deepEqual({accounts:x.rooms.state.accounts,positions:r.positions,payouts:r.payouts,cashflows:r.cashflows,ranks:r.ranks,states:r.states,open:r.open,settled:r.settled},financial);
 const before=structuredClone(x.rooms.state);assert.throws(()=>x.hourly.recoverReport(v.code,r.gameId,[{...battles[0],winner:battles[0].second}]),/战果冲突/);assert.deepEqual(x.rooms.state,before);
 assert.throws(()=>x.hourly.recoverReport(v.code,'wrong-game',battles),/已结算/);
});


test('archive recovery fills every earlier pending round without replaying accounting or delivered notices',()=>{
 const x=fixture(),v=x.open(),r=x.rooms.state.rooms[v.code];
 for(let round=2;round<=5;round++){
  Object.assign(x.snapshot,{round,closedThrough:round-1,open:false,ended:round===5,ranks:round===5?[1,2,3,4,5,6,7,8]:Array(8).fill(0)});
  x.snapshot.builds.forEach(b=>{b.selectionRound=round-1;b.cards=[1000010];b.cardNames=['云剑'];});x.hourly.sync(v.code,x.snapshot);
 }
 x.snapshot.builds.forEach(b=>{b.selectionRound=5;});x.hourly.sync(v.code,x.snapshot);
 const financial=structuredClone({accounts:x.rooms.state.accounts,positions:r.positions,payouts:r.payouts,cashflows:r.cashflows,ranks:r.ranks,states:r.states,frames:r.frames,open:r.open,settled:r.settled});
 const tables=round=>Array.from({length:4},(_,i)=>({round,first:r.players[i*2].uid,second:r.players[i*2+1].uid,winner:r.players[i*2].uid,firstMirror:false,secondMirror:false,firstCards:[1000010],secondCards:[1000010],firstNames:['云剑'],secondNames:['云剑'],firstLife:80,secondLife:60,lifeDamage:20,resultComplete:true}));
 assert.equal(x.hourly.recoverReport(v.code,r.gameId,[...tables(4),...tables(5)]).reportReady,false);
 assert.deepEqual(x.hourly.status().reports[0].recoveryRounds,[1,2,3]);
 x.hourly.recoverReport(v.code,r.gameId,[...tables(1),...tables(2)]);
 assert.deepEqual(x.hourly.status().reports[0].recoveryRounds,[3]);
 assert.equal(x.hourly.recoverReport(v.code,r.gameId,tables(3)).reportReady,true);assert.equal(x.hourly.status().reports.length,0);
 assert.deepEqual({accounts:x.rooms.state.accounts,positions:r.positions,payouts:r.payouts,cashflows:r.cashflows,ranks:r.ranks,states:r.states,frames:r.frames,open:r.open,settled:r.settled},financial);
 const before=structuredClone(x.rooms.state);assert.throws(()=>x.hourly.recoverReport(v.code,r.gameId,tables(6)),/公开牌桌/);assert.deepEqual(x.rooms.state,before);
 const event=x.hourly.claim();x.hourly.ack(event.id,event.lease);const delivered=structuredClone(x.hourly.data().outbox.find(e=>e.id===event.id));
 x.hourly.recoverReport(v.code,r.gameId,tables(1));assert.deepEqual(x.hourly.data().outbox.find(e=>e.id===event.id),delivered);
});


test('historical public build recovery is annotation-only and validates all choices before committing',()=>{
 const x=fixture(),v=x.open(),r=x.rooms.state.rooms[v.code];
 x.snapshot.round=3;x.snapshot.closedThrough=3;x.snapshot.ended=true;x.snapshot.open=false;x.snapshot.ranks=[1,2,3,4,5,6,7,8];
 x.snapshot.builds.forEach(b=>{b.selectionRound=3;b.cards=[1000010];b.cardNames=['终局公开牌'];});x.hourly.sync(v.code,x.snapshot);
 const finance=structuredClone({accounts:x.rooms.state.accounts,positions:r.positions,payouts:r.payouts,states:r.states,frames:r.frames,builds:r.builds});
 const old=x.snapshot.builds.map(b=>({...b,selectionRound:2,cards:[1000020],cardNames:['上轮公开牌']}));
 const battles=[{round:2,first:r.players[0].uid,second:r.players[1].uid,winner:r.players[0].uid,firstMirror:false,secondMirror:false,firstCards:[1000020],secondCards:[1000020],firstLife:80,secondLife:60,lifeDamage:20,resultComplete:true}];
 x.hourly.recoverReport(v.code,r.gameId,battles,old);assert.equal(publicPresentation(x.web.watch(r),{round:2}).players[0].build.selectionRound,2);
 assert.deepEqual({accounts:x.rooms.state.accounts,positions:r.positions,payouts:r.payouts,states:r.states,frames:r.frames,builds:r.builds},finance);
 const before=structuredClone(x.rooms.state);old[0].selectionRound=4;assert.throws(()=>x.hourly.recoverReport(v.code,r.gameId,battles,old),/公开角色/);assert.deepEqual(x.rooms.state,before);
});

test('an already eliminated observer player receiving its last native result retains the accepted round and fixed rank',()=>{
 const x=fixture(),v=x.open();x.snapshot.round=2;x.snapshot.closedThrough=1;x.snapshot.roundComplete=true;
 x.snapshot.eliminationRounds=Array(8).fill(0);x.snapshot.eliminationRounds[2]=1;x.snapshot.ranks[2]=8;x.snapshot.states[2]={life:-1,wins:0,losses:1};x.hourly.sync(v.code,x.snapshot);
 const r=x.rooms.state.rooms[v.code],payouts=structuredClone(r.payouts),accounts=structuredClone(x.rooms.state.accounts);
 x.snapshot.round=6;x.snapshot.closedThrough=5;x.snapshot.eliminationRounds[2]=2;x.snapshot.states[2]={life:-8,wins:0,losses:2};x.hourly.sync(v.code,x.snapshot);
 assert.equal(r.round,6);assert.equal(r.ranks[2],8);assert.equal(r.eliminationRounds[2],1);assert.equal(r.states[2].losses,2);assert.equal(x.snapshot.eliminationRounds[2],2);
 assert.deepEqual(r.payouts,payouts);assert.deepEqual(x.rooms.state.accounts,accounts);
 const before=structuredClone(x.rooms.state);x.snapshot.ranks[2]=7;assert.throws(()=>x.hourly.sync(v.code,x.snapshot),/冲突/);assert.deepEqual(x.rooms.state,before);
});

test('a recovered status jump still announces the preceding complete native tables without inventing missing rounds',()=>{
 const x=fixture(),v=x.open(),r=x.rooms.state.rooms[v.code];
 Object.assign(x.snapshot,{round:6,closedThrough:5,roundComplete:true});
 x.snapshot.states.forEach(p=>{p.wins=3;p.losses=2;});x.snapshot.builds.forEach(b=>{b.selectionRound=5;b.cards=[1000010];b.cardNames=['云剑'];});
 x.snapshot.battles=Array.from({length:4},(_,i)=>({round:5,first:r.players[i*2].uid,second:r.players[i*2+1].uid,winner:r.players[i*2].uid,firstMirror:false,secondMirror:false,firstCards:[1000010],secondCards:[1000010],firstNames:['云剑'],secondNames:['云剑'],firstLife:80,secondLife:60,lifeDamage:20,resultComplete:true}));
 x.hourly.sync(v.code,x.snapshot);
 assert(x.hourly.data().outbox.some(e=>e.code===v.code&&e.kind==='round'&&e.round===5));assert(x.hourly.ready(r,'round',5));
 assert.deepEqual(x.hourly.data().slots[r.eventSlot].participants[5],Array(8).fill(true));assert(!x.hourly.data().outbox.some(e=>e.code===v.code&&e.kind==='round'&&[2,3,4].includes(e.round)));
});

test('quitting before the first battle never waits for a nonexistent table or changes rank when a late result arrives',()=>{
 const x=fixture(),v=x.open(),r=x.rooms.state.rooms[v.code];Object.assign(x.snapshot,{sourcePhase:'preparation',roundComplete:true,eliminationRounds:Array(8).fill(0)});
 x.snapshot.states[0]={life:0,wins:0,losses:0};x.snapshot.ranks[0]=8;x.hourly.sync(v.code,x.snapshot);
 assert.equal(r.observerWithdrawals[0],0);assert.equal(x.hourly.data().slots[r.eventSlot].participants[1][0],false);assert.equal(r.ranks[0],8);assert.equal(publicPresentation(x.web.watch(r),{noticeType:'round'}).players[0].showBoard,false);
 Object.assign(x.snapshot,{round:2,closedThrough:1});x.snapshot.states[0]={life:-5,wins:0,losses:1};x.snapshot.eliminationRounds[0]=1;x.hourly.sync(v.code,x.snapshot);
 assert.equal(r.round,2);assert.equal(r.ranks[0],8);assert.equal(r.eliminationRounds[0],0);
});

test('sequential voluntary exits after the same nonlethal battle keep independent native ranks and do not block on late or temporarily omitted ranks',()=>{
 const x=fixture(),v=x.open(),r=x.rooms.state.rooms[v.code];Object.assign(x.snapshot,{round:2,closedThrough:1,sourcePhase:'preparation',roundComplete:true,eliminationRounds:Array(8).fill(0)});
 x.snapshot.battles=[{round:1,first:r.players[0].uid,second:r.players[1].uid,winner:r.players[1].uid,firstMirror:false,secondMirror:false,firstCards:[1000010],secondCards:[1000010],firstNames:['云剑'],secondNames:['云剑'],firstLife:100,secondLife:100,firstLifeBefore:100,secondLifeBefore:100,lifeDamage:-5,resultComplete:true}];
 x.snapshot.states[0]={life:0,wins:0,losses:1};x.snapshot.ranks[0]=8;x.snapshot.eliminationRounds[0]=1;x.hourly.sync(v.code,x.snapshot);
 x.snapshot.states[1]={life:0,wins:1,losses:0};x.snapshot.ranks[1]=7;x.snapshot.eliminationRounds[1]=1;x.hourly.sync(v.code,x.snapshot);
 assert.deepEqual(r.ranks.slice(0,2),[8,7]);assert.deepEqual(r.rankMinimum.slice(0,2),[8,7]);assert.deepEqual(r.rankMaximum.slice(0,2),[8,7]);assert.deepEqual(r.observerWithdrawals.slice(0,2),[1,1]);
 const accounts=structuredClone(x.rooms.state.accounts);Object.assign(x.snapshot,{round:3,closedThrough:2});x.snapshot.battles=[];
 for(let i=0;i<2;i++){x.snapshot.states[i].life=-5;x.snapshot.states[i].losses++;x.snapshot.eliminationRounds[i]=2;x.snapshot.ranks[i]=0;}
 x.hourly.sync(v.code,x.snapshot);assert.equal(r.round,3);assert.deepEqual(r.ranks.slice(0,2),[8,7]);assert.deepEqual(x.rooms.state.accounts,accounts);assert.equal(publicPresentation(x.web.watch(r),{round:2,noticeType:'round'}).players[0].showBoard,false);
});

test('real simultaneous lethal battles retain cohort payouts when later counters advance and native ordering changes inside the known interval',()=>{
 const x=fixture(),v=x.open(),r=x.rooms.state.rooms[v.code];Object.assign(x.snapshot,{round:2,closedThrough:1,sourcePhase:'preparation',roundComplete:true,eliminationRounds:Array(8).fill(0)});
 x.snapshot.battles=[0,1].map(i=>({round:1,first:r.players[i].uid,second:r.players[i+2].uid,winner:r.players[i+2].uid,firstMirror:false,secondMirror:false,firstCards:[1000010],secondCards:[1000010],firstNames:['云剑'],secondNames:['云剑'],firstLife:5,secondLife:100,firstLifeBefore:5,secondLifeBefore:100,lifeDamage:-10,resultComplete:true}));
 for(let i=0;i<2;i++){x.snapshot.states[i]={life:-5,wins:0,losses:1};x.snapshot.ranks[i]=7+i;x.snapshot.eliminationRounds[i]=1;}
 x.hourly.sync(v.code,x.snapshot);assert.deepEqual(r.rankMinimum.slice(0,2),[7,7]);assert.deepEqual(r.rankMaximum.slice(0,2),[8,8]);assert.equal(r.observerWithdrawals,undefined);
 const accounts=structuredClone(x.rooms.state.accounts);x.snapshot.round=3;x.snapshot.closedThrough=2;
 for(let i=0;i<2;i++){x.snapshot.states[i].losses=2;x.snapshot.eliminationRounds[i]=2;x.snapshot.ranks[i]=8-i;}
 x.snapshot.battles=[];x.hourly.sync(v.code,x.snapshot);assert.equal(r.round,3);assert.deepEqual(r.eliminationRounds.slice(0,2),[1,1]);assert.deepEqual(x.rooms.state.accounts,accounts);
 const before=structuredClone(x.rooms.state);x.snapshot.ranks[0]=6;assert.throws(()=>x.hourly.sync(v.code,x.snapshot),/冲突/);assert.deepEqual(x.rooms.state,before);
});
