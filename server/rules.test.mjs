import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Rooms as CurrentRooms} from './rooms.mjs';
class Rooms extends CurrentRooms { constructor(state, save, now) { super(state, save, now, {championOnly:false}); } }
import {wagerFactorBps,returnFor,sale} from './odds.mjs';
const cases=JSON.parse(fs.readFileSync(new URL('./fixtures/single-player-parity.json',import.meta.url),'utf8'));
for(let n=0;n<cases.length;n++)test('C# single-player oracle parity scenario '+n,()=>{
 const expected=cases[n],rooms=new Rooms(),key=rooms.register('oracle').token;
 const snapshot={id:expected.id,round:expected.round,closedThrough:0,open:true,ended:false,players:expected.players,ranks:Array(8).fill(0),baseRates:expected.baseRates};
 let view=rooms.create(key,snapshot);const code=view.code;assert.equal(view.rules,2);
 for(let i=0;i<expected.steps.length;i++){
  const step=expected.steps[i];const args={...step,version:rooms.view(code,key).version,operation:'oracle-operation-'+i};
  if(step.ok)rooms.trade(code,key,args);else assert.throws(()=>rooms.trade(code,key,args));
  view=rooms.view(code,key);assert.equal(view.balance,step.balance,'step '+i+' balance');
  for(let p=0;p<8;p++){
   const actual=view.positions[p],target=step.positions[p];
   assert.deepEqual({claim:actual?.claim??0,cost:actual?.stake??0,rank:actual?.rank??0,resolved:actual?.resolved??false},target,'step '+i+' position '+p);
  }
 }
 snapshot.ended=true;snapshot.ranks=expected.ranks;view=rooms.sync(code,key,snapshot);
 assert.equal(view.balance,expected.finalBalance);assert.equal(view.payout,expected.payout);
 rooms.sync(code,key,snapshot);assert.equal(rooms.view(code,key).balance,expected.finalBalance);
});
function setup(){
 const rooms=new Rooms();const a=rooms.register('甲').token,b=rooms.register('乙').token;
 const snapshot={id:'coeff-game',round:1,closedThrough:0,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:String(i),name:String(i)})),ranks:Array(8).fill(0),baseRates:Array(64).fill(40000)};
 const code=rooms.create(a,snapshot).code;rooms.join(code,b,snapshot.id);
 const trade=(key,kind,player,rank,stake,operation)=>rooms.trade(code,key,{kind,player,rank,stake,operation,version:rooms.view(code,key).version});
 return {rooms,a,b,snapshot,code,trade};
}
test('baseline exists with no wagers; wagers update the coefficient only next round and rights stay frozen',()=>{
 const x=setup();let r=x.rooms.view(x.code,x.a);assert.equal(r.quoteRates[0],40000);assert.equal(r.factors[0],10000);
 x.trade(x.a,'buy',0,1,100,'coeff-buy-001');r=x.rooms.view(x.code,x.a);assert.equal(r.positions[0].claim,400);assert.equal(r.quoteRates[0],40000);
 x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(x.rooms.view(x.code,x.a).quoteRates[0],40000);
 x.snapshot.round=2;r=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(r.factors[0],7500);assert.equal(r.quoteRates[0],30000);assert.equal(r.baseRates[0],40000);assert.equal(r.positions[0].claim,400);
 x.trade(x.a,'buy',0,1,100,'coeff-buy-002');assert.equal(x.rooms.view(x.code,x.a).positions[0].claim,700);
 const reordered={...x.snapshot,players:[...x.snapshot.players].reverse(),ranks:Array(8).fill(0)};x.rooms.sync(x.code,x.a,reordered);assert.equal(x.rooms.view(x.code,x.a).positions[0].claim,700);
});
test('quarter adjacent returns, early elimination, odd claims and idempotent final payout',()=>{
 const x=setup();x.trade(x.a,'buy',7,7,101,'quarter-adjacent');x.trade(x.b,'buy',7,8,100,'quarter-exact');
 x.snapshot.ranks[7]=8;let r=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(r.balance,1000-101+101);assert.equal(x.rooms.view(x.code,x.b).balance,1300);
 x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(x.rooms.view(x.code,x.a).balance,1000);
 x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(x.rooms.view(x.code,x.b).balance,1300);
 for(let rank=1;rank<=8;rank++)for(let final=1;final<=8;final++)assert.equal(returnFor(405,rank,final),rank===final?405:Math.abs(rank-final)===1?101:0);
});
test('sell uses current rate, switch failure restores everything, impossible rates stay zero, coefficient bounds',()=>{
 const x=setup();x.trade(x.a,'buy',0,1,101,'sale-before-round');x.snapshot.round=2;x.rooms.sync(x.code,x.a,x.snapshot);
 let r=x.rooms.view(x.code,x.a),claim=r.positions[0].claim,rate=r.quoteRates[0],balance=r.balance;
 x.trade(x.a,'half',0,0,0,'sale-half-claim');r=x.rooms.view(x.code,x.a);assert.equal(r.balance,balance+sale(claim,rate,true));assert.equal(r.positions[0].claim,claim-Math.floor(claim/2));
 const before=structuredClone(x.rooms.state);assert.throws(()=>x.trade(x.a,'switch',0,2,10000,'invalid-switch-amount'));assert.deepEqual(x.rooms.state,before);
 x.snapshot.round=3;x.snapshot.baseRates[2]=0;r=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(r.quoteRates[2],0);assert.throws(()=>x.trade(x.a,'buy',0,3,10,'invalid-zero-rate'));
 for(const total of [1,10,100,1000000])for(const selected of [0,total/2,total])assert.ok(wagerFactorBps(selected,total)>=7500&&wagerFactorBps(selected,total)<=12500);
});
test('legacy wager rooms keep their old payout promise even if host upgrades',()=>{
 const x=setup();const legacy={...x.snapshot,id:'legacy',baseRates:undefined};const r=x.rooms.create(x.a,legacy);assert.equal(r.rules,1);
 const next={...legacy,baseRates:Array(64).fill(40000)};x.rooms.sync(r.code,x.a,next);assert.equal(x.rooms.view(r.code,x.a).rules,1);
});
test('base quote refresh within a round retains the frozen wagering coefficient',()=>{
 const x=setup();x.trade(x.a,'buy',0,1,100,'base-refresh-buy');x.snapshot.baseRates[0]=50000;
 const view=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(view.baseRates[0],50000);assert.equal(view.factors[0],10000);assert.equal(view.quoteRates[0],50000);assert.equal(view.positions[0].claim,400);
});
test('512 actions per player persists through liquidation and reloading; other players remain independent',()=>{
 const x=setup();
 for(let i=0;i<512;i++)x.trade(x.a,i%2===0?'buy':'sell',0,1,1,'action-limit-'+i);
 assert.throws(()=>x.trade(x.a,'buy',0,1,1,'action-over-limit'));
 const saved=new Rooms(structuredClone(x.rooms.state));saved.sync(x.code,x.a,x.snapshot);
 assert.throws(()=>saved.trade(x.code,x.a,{kind:'buy',player:0,rank:1,stake:1,operation:'reload-over-limit',version:saved.view(x.code,x.a).version}));
 x.trade(x.a,'buy',1,1,1,'different-player');
});
test('no-buy outcomes and zero-value liquidation match single-player constraints',()=>{
 const x=setup();x.trade(x.a,'buy',0,1,10,'impossible-liquidation');x.snapshot.round=2;
 x.snapshot.baseRates[0]=0;const view=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(view.positions[0].claim,40);
 x.trade(x.a,'sell',0,0,0,'zero-value-sell');assert.equal(x.rooms.view(x.code,x.a).balance,990);
 assert.equal(x.rooms.view(x.code,x.a).positions[0],null);
});
test('one survivor closes trading even if a delayed host open flag is still true',()=>{
 const x=setup();x.snapshot.ranks=[0,2,3,4,5,6,7,8];const r=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(r.open,false);assert.throws(()=>x.trade(x.a,'buy',0,1,10,'one-survivor-block'));
});
