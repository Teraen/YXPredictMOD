import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Rooms} from './rooms.mjs';
import {createHandler} from './server.mjs';
import http from 'node:http';
export function fixture(options={}) {
 let now=100000;const rooms=new Rooms(undefined,options.save,()=>now,options);
 const a=rooms.register('甲').token,b=rooms.register('乙').token;
 const snapshot={id:'champion',gameRoomId:'native-one',round:9,closedThrough:0,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:'p'+i,name:'角色'+i})),ranks:Array(8).fill(0),active:Array(8).fill(true),baseRates:Array(64).fill(40100)};
 const code=rooms.create(a,snapshot).code;
 const trade=(player=0,rank=1,kind='buy',stake=101)=>rooms.trade(code,a,{player,rank,kind,stake,operation:'champion-op-'+(++sequence),version:rooms.view(code,a).version});let sequence=0;
 return {rooms,a,b,snapshot,code,trade,time:n=>now=n};
}
test('production champion policy rejects every other rank without spending; second/third settle once after round 10',()=>{
 for(let rank=1;rank<=8;rank++){
  const x=fixture();assert.equal(x.rooms.view(x.code,x.a).rules,3);x.trade();
  for(let r=2;r<=8;r++){const before=structuredClone(x.rooms.state);assert.throws(()=>x.trade(1,r));assert.deepEqual(x.rooms.state,before);}
  const claim=x.rooms.view(x.code,x.a).positions[0].claim;assert.equal(claim,405);
  x.snapshot.round=10;x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(x.rooms.view(x.code,x.a).open,false);
  assert.throws(()=>x.trade(1));assert.throws(()=>x.trade(0,1,'sell'));
  const reloaded=new Rooms(structuredClone(x.rooms.state),undefined,()=>100000);reloaded.syncTimes.set(x.code,100000);
  assert.throws(()=>reloaded.sync(x.code,x.a,{...x.snapshot,round:9}));
  x.snapshot.ended=true;x.snapshot.round=15;x.snapshot.ranks=[rank,...Array.from({length:8},(_,i)=>i+1).filter(n=>n!==rank)];
  reloaded.sync(x.code,x.a,x.snapshot);const expected=899+(rank===1?claim:rank===2?Math.floor(claim/4):rank===3?Math.floor(claim/10):0);
  assert.equal(reloaded.view(x.code,x.a).balance,expected);reloaded.sync(x.code,x.a,x.snapshot);assert.equal(reloaded.view(x.code,x.a).balance,expected);
 }
});
test('exited state follows UID, persists across reload and cannot resurrect without a final rank',()=>{
 const x=fixture();x.snapshot.players.reverse();x.snapshot.active[7]=false;x.rooms.sync(x.code,x.a,x.snapshot);
 assert.equal(x.rooms.view(x.code,x.a).active[0],false);assert.throws(()=>x.trade());
 const r=new Rooms(structuredClone(x.rooms.state),undefined,()=>100000);x.snapshot.active.fill(true);r.sync(x.code,x.a,x.snapshot);
 assert.equal(r.view(x.code,x.a).active[0],false);assert.throws(()=>r.trade(x.code,x.a,{kind:'buy',player:0,rank:1,stake:10,version:r.view(x.code,x.a).version,operation:'reload-exit'}));
});
test('public rooms list paginates independently of matching; private/stale/ended rooms are excluded',()=>{
 const x=fixture();x.rooms.state.rooms[x.code].allowMatch=false;
 assert.equal(x.rooms.list(x.b).rooms[0].code,x.code);assert.throws(()=>x.rooms.random(x.b));
 const privateRoom=x.rooms.create(x.b,{...x.snapshot,id:'private',gameRoomId:'native-private'},true,false);
 assert.equal(privateRoom.isPublic,false);assert.equal(privateRoom.allowMatch,false);assert.equal(x.rooms.list(x.a).total,1);
 for(let i=0;i<7;i++)x.rooms.create(x.a,{...x.snapshot,id:'public-'+i,gameRoomId:'native-'+i},false,true);
 assert.equal(x.rooms.list(x.b).rooms.length,6);assert.equal(x.rooms.list(x.b,1).rooms.length,2);
 x.snapshot.round=10;x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(x.rooms.list(x.b).rooms.find(r=>r.code===x.code)?.open??x.rooms.list(x.b,1).rooms.find(r=>r.code===x.code).open,false);
 x.time(115001);assert.equal(x.rooms.list(x.b).total,0);
});
test('champion crowd coefficient freezes for current round and compares all horses next round',()=>{
 const x=fixture();x.snapshot.round=1;x.rooms.state.rooms[x.code].round=0;x.rooms.sync(x.code,x.a,x.snapshot);
 x.trade();assert.equal(x.rooms.view(x.code,x.a).quoteRates[0],40100);
 x.snapshot.round=2;const v=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(v.factors[0],7500);assert.equal(v.factors[8],12500);assert.equal(v.positions[0].claim,405);
});
test('HTTP requires capable client before creating/joining champion rooms',async()=>{
 const x=fixture(),server=http.createServer(createHandler(x.rooms));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const url='http://127.0.0.1:'+server.address().port+'/v1/room';
  const post=body=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+x.b,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({action:'join',code:x.code,gameId:x.snapshot.id})).status,409);
  assert.equal((await post({action:'join',protocol:3,code:x.code,gameId:x.snapshot.id})).status,200);
  assert.equal((await post({action:'create',snapshot:{...x.snapshot,id:'other'}})).status,409);
  assert.equal((await post({action:'create',protocol:3,snapshot:{...x.snapshot,id:'other',gameRoomId:'native-other'},isPublic:false})).status,200);
 }finally{await new Promise(r=>server.close(r));}
});
test('upgraded server retains historical payout promises but prevents adding new legacy bets',()=>{
 const x=fixture({championOnly:false});x.trade(0,3);const claim=x.rooms.view(x.code,x.a).positions[0].claim;
 const upgraded=new Rooms(structuredClone(x.rooms.state),undefined,()=>100000);upgraded.syncTimes.set(x.code,100000);
 assert.throws(()=>upgraded.trade(x.code,x.a,{kind:'buy',player:1,rank:1,stake:10,version:upgraded.view(x.code,x.a).version,operation:'legacy-new-buy'}));
 x.snapshot.ended=true;x.snapshot.ranks=[2,1,3,4,5,6,7,8];upgraded.sync(x.code,x.a,x.snapshot);
 assert.equal(upgraded.view(x.code,x.a).balance,899+Math.floor(claim/4));
});
test('champion co-eliminations use the highest interval return and survive reordering, final results and reload',()=>{
 for(const low of [2,3,4])for(const player of [low-1,low]){
  const x=fixture();x.trade(player);const claim=x.rooms.view(x.code,x.a).positions[player].claim;
  x.snapshot.round=9;x.snapshot.roundComplete=true;x.snapshot.eliminationRounds=[0,9,8,7,6,5,4,3];x.snapshot.eliminationRounds[low]=x.snapshot.eliminationRounds[low-1];
  x.snapshot.ranks=[0,2,3,4,5,6,7,8];x.snapshot.ranks[low-1]=x.snapshot.ranks[low]=0;
  x.snapshot.players.reverse();x.snapshot.ranks.reverse();x.snapshot.eliminationRounds.reverse();
  let v=x.rooms.sync(x.code,x.a,x.snapshot),payout=low===2?Math.floor(claim/4):low===3?Math.floor(claim/10):0;
  assert.equal(v.positions[player].payout,payout);assert.equal(v.balance,899+payout);assert.equal(v.settled,false);
  const restored=new Rooms(structuredClone(x.rooms.state));v=restored.sync(x.code,x.a,x.snapshot);assert.equal(v.balance,899+payout);
  x.snapshot.round=15;x.snapshot.ended=true;x.snapshot.ranks=[8,7,6,5,4,3,2,1];
  const a=7-(low-1),b=7-low;[x.snapshot.ranks[a],x.snapshot.ranks[b]]=[x.snapshot.ranks[b],x.snapshot.ranks[a]];
  v=restored.sync(x.code,x.a,x.snapshot);assert.equal(v.balance,899+payout);assert.equal(v.settled,true);assert.equal(restored.sync(x.code,x.a,x.snapshot).balance,899+payout);
 }
});
test('partial cohort heartbeat keeps the current version stable while trading remains paused',()=>{
 const x=fixture();x.snapshot.eliminationRounds=Array(8).fill(0);x.snapshot.roundComplete=false;
 const first=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(first.open,false);
 const next=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(next.version,first.version);assert.equal(next.open,false);
});
