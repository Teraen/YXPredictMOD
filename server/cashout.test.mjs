import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Rooms} from './rooms.mjs';
import {cashout,eventQuote,sale} from './odds.mjs';

function fixture({bonus=10000,base=50000,save}={}){
  const rooms=new Rooms(undefined,save,()=>100000);
  const a=rooms.register('甲').token,b=rooms.register('乙').token;
  rooms.state.accounts[a].balance=rooms.state.accounts[b].balance=100000;
  const snapshot={id:'personal-cashout',round:1,closedThrough:0,open:true,ended:false,
    players:Array.from({length:8},(_,i)=>({uid:'p'+i,name:'角色'+i})),ranks:Array(8).fill(0),baseRates:Array(64).fill(base)};
  const code=rooms.create(a,snapshot,true,true,bonus===11500?{slot:'2026110201',bonusBps:bonus}:null).code;
  rooms.join(code,b,snapshot.id);
  let sequence=0;
  const view=(key=a)=>rooms.view(code,key);
  const trade=(key=a,kind='buy',player=0,stake=100)=>rooms.trade(code,key,{kind,player,rank:1,stake,operation:'personal-order-'+(++sequence),version:view(key).version});
  const next=()=>{snapshot.round++;return rooms.sync(code,a,snapshot);};
  return {rooms,a,b,snapshot,code,view,trade,next};
}

test('10000 own-only wager cannot profit from lowering its next-round public odds',()=>{
  const x=fixture();x.trade(x.a,'buy',0,10000);
  assert.equal(x.view().positions[0].claim,50000);
  x.next();assert.equal(x.view().quoteRates[0],37500);
  x.trade(x.a,'sell');
  assert.equal(x.view().balance,99700);assert.equal(x.view().positions[0],null);
  assert.equal(x.rooms.state.rooms[x.code].cashflows[x.a].sold,9700);
});

test('all of the owners horses are excluded at entry and exit, including already inflated entry odds',()=>{
  const x=fixture();x.trade(x.a,'buy',1,10000);x.next();
  assert.equal(x.view().quoteRates[0],62500);
  x.trade(x.a,'buy',0,10000);
  assert.equal(x.view().positions[0].claim,62500);
  assert.equal(x.view().positions[0].saleBasis.units,50000);
  x.trade(x.a,'sell',0);assert.equal(x.view().balance,89700);
  x.next();x.trade(x.a,'sell',1);assert.equal(x.view().balance,99400);
});

test('other bettors still affect personal liquidation; their new orders wait until next round',()=>{
  for(const otherHorse of [0,1]){
    const x=fixture();x.trade(x.a);x.trade(x.b,'buy',otherHorse,10000);
    const old=structuredClone(x.rooms.state);x.trade(x.a,'sell');assert.equal(x.view().balance,99997);
    x.rooms.state=old;x.next();x.trade(x.a,'sell');
    const expected=sale(500,eventQuote(50000,otherHorse===0?7500:12500),false);
    assert.equal(x.view().balance,99900+expected);
    assert.equal(expected,otherHorse===0?129:77);
  }
});

test('entry units retain others frozen effect; exit uses their latest frozen effect',()=>{
  const x=fixture();x.trade(x.b,'buy',0,10000);x.next();
  x.trade();assert.deepEqual(x.view().positions[0].saleBasis,{legacyClaim:0,units:375});
  x.trade(x.b,'sell',0);x.trade(x.a,'sell');assert.equal(x.view().balance,99997);
  const y=fixture();y.trade(y.b,'buy',0,10000);y.next();y.trade();y.trade(y.b,'sell');
  y.next();y.trade(y.a,'sell');assert.equal(y.view().balance,99900+sale(375,50000,false));
});

test('partial sells keep the frozen own book through same-round buys and repeated halves',()=>{
  const x=fixture();x.trade(x.a,'buy',0,10000);x.next();
  const book=structuredClone(x.rooms.state.rooms[x.code].saleBook);
  x.trade(x.a,'half');x.trade(x.a,'buy',1,1000);x.trade(x.a,'half');x.trade(x.a,'sell');
  assert.deepEqual(x.rooms.state.rooms[x.code].saleBook,book);
  assert.equal(x.rooms.state.rooms[x.code].cashflows[x.a].sold,9700);
  x.trade(x.a,'sell',1);assert.equal(x.view().balance,99670);
});

test('multiple public fill prices retain exact payout rights but normalize liquidation independently',()=>{
  const x=fixture();x.trade();x.next();x.trade();
  const p=x.view().positions[0];assert.equal(p.claim,875);assert.equal(p.saleBasis.units,1000);
  x.trade(x.a,'half');const remaining=x.view().positions[0];
  assert.equal(remaining.claim,438);assert.equal(remaining.saleBasis.units,501);
  x.trade(x.a,'sell');assert.equal(x.rooms.state.rooms[x.code].cashflows[x.a].sold,193);
  assert.equal(x.view().balance,99993);
});

test('only public-state base price changes still generate normal market gains or losses',()=>{
  for(const base of [30000,80000,0]){
    const x=fixture();x.trade();x.snapshot.baseRates.fill(base);x.next();x.trade(x.a,'sell');
    assert.equal(x.view().balance,99900+sale(500,base,false));
  }
});

test('same-round base refresh changes personal price while retaining the frozen contributions',()=>{
  const x=fixture();x.trade();x.next();const book=structuredClone(x.rooms.state.rooms[x.code].saleBook);
  x.trade(x.b,'buy',1,10000);x.snapshot.baseRates.fill(40000);x.rooms.sync(x.code,x.a,x.snapshot);
  assert.deepEqual(x.rooms.state.rooms[x.code].saleBook,book);assert.equal(x.view().quoteRates[0],30000);
  x.trade(x.a,'sell');assert.equal(x.view().balance,99900+sale(500,40000,false));
});

test('self-neutral prices use the same floors, min/max clamps and hourly premium',()=>{
  for(const bonus of [10000,11500])for(const base of [1,10100,50000,500000])for(const horse of [0,1]){
    const x=fixture({base,bonus});x.trade(x.a,'buy',1,10000);x.next();x.trade(x.a,'buy',0,101);
    const units=Math.floor(101*eventQuote(base,10000,bonus)/10000);
    assert.equal(x.view().positions[0].saleBasis.units,units);
    if(horse===1)x.next();
    x.trade(x.a,'sell');
    assert.equal(x.view().balance,100000-10000-101+sale(units,eventQuote(base,10000,bonus),false));
  }
});

test('legacy holdings keep original sale terms and adding new bets cannot inherit that policy',()=>{
  const x=fixture();x.trade(x.a,'buy',0,10000);
  let r=x.rooms.state.rooms[x.code];delete r.positions[x.a][0].saleBasis;delete r.saleBook;
  x.next();x.trade(x.a,'buy',0,10000);
  let p=x.view().positions[0];assert.deepEqual(p.saleBasis,{legacyClaim:50000,units:50000});assert.equal(p.claim,87500);
  x.trade(x.a,'half');p=x.view().positions[0];
  assert.deepEqual(p.saleBasis,{legacyClaim:25000,units:25000});
  x.trade(x.a,'sell');
  assert.equal(x.rooms.state.rooms[x.code].cashflows[x.a].sold,2*(sale(25000,37500,false)+sale(25000,50000,false)));
  const y=fixture();y.trade(y.a,'buy',0,10000);delete y.rooms.state.rooms[y.code].positions[y.a][0].saleBasis;
  y.next();y.trade(y.a,'sell');assert.equal(y.view().balance,102933);
});

test('old same-round rooms seed a private book once without rewriting quotes, claims or balances',()=>{
  const x=fixture();x.trade();let r=x.rooms.state.rooms[x.code];delete r.saleBook;delete r.positions[x.a][0].saleBasis;
  const original={quoteRates:structuredClone(r.quoteRates),claim:r.positions[x.a][0].claim,balance:x.view().balance};
  assert.equal(r.saleBook,undefined);
  x.rooms.sync(x.code,x.a,x.snapshot);r=x.rooms.state.rooms[x.code];
  assert.deepEqual(r.quoteRates,original.quoteRates);assert.equal(r.positions[x.a][0].claim,original.claim);assert.equal(x.view().balance,original.balance);
  const book=structuredClone(r.saleBook);x.trade(x.b,'buy',1,1000);x.rooms.sync(x.code,x.a,x.snapshot);
  assert.deepEqual(r.saleBook,book);
  delete r.saleBook;x.trade(x.a,'buy');assert.equal(x.view().positions[0].saleBasis.legacyClaim,500);
});

test('persisted frozen books and mixed holdings survive reordering and process restart without public identity leaks',()=>{
  const x=fixture();x.trade();x.trade(x.b,'buy',1,200);x.next();
  const saved=JSON.parse(JSON.stringify(x.rooms.state));
  const restored=new Rooms(saved,undefined,()=>100000);restored.syncTimes.set(x.code,100000);
  const reordered={...x.snapshot,players:[...x.snapshot.players].reverse(),baseRates:[...x.snapshot.baseRates].reverse()};
  restored.sync(x.code,x.a,reordered);assert.deepEqual(restored.state.rooms[x.code].saleBook,x.rooms.state.rooms[x.code].saleBook);
  const v=restored.view(x.code,x.a),json=JSON.stringify(v);
  assert.ok(!json.includes('saleBook'));assert.ok(!json.includes(x.a));assert.ok(!json.includes(x.b));assert.ok(!json.includes('contributions'));
  restored.trade(x.code,x.a,{kind:'sell',player:0,rank:1,operation:'restart-liquidation',version:v.version});
  x.trade(x.a,'sell');assert.deepEqual(restored.view(x.code,x.a),x.view());
});

test('locked payouts for first, second and third remain unchanged after partial sale and multiple fills',()=>{
  for(const rank of [1,2,3,4]){
    const x=fixture();x.trade();x.next();x.trade();x.trade(x.a,'half');
    const p=x.view().positions[0],balance=x.view().balance;
    const ranks=[rank,...Array.from({length:8},(_,i)=>i+1).filter(n=>n!==rank)];
    x.snapshot.ranks=ranks;x.snapshot.round=15;x.snapshot.ended=true;
    const result=x.rooms.sync(x.code,x.a,x.snapshot),payout=rank===1?p.claim:rank===2?Math.floor(p.claim/4):rank===3?Math.floor(p.claim/10):0;
    assert.equal(result.payout,payout);assert.equal(result.balance,balance+payout);
    assert.equal(x.rooms.sync(x.code,x.a,x.snapshot).balance,result.balance);
  }
});

test('invalid orders, duplicate receipts and storage failures preserve all liquidation metadata atomically',()=>{
  let fail=false;const x=fixture({save:()=>{if(fail)throw new Error('disk failed');}});x.trade();x.next();
  for(const input of [{kind:'buy',stake:100001},{kind:'switch',rank:2},{kind:'switch',rank:1}]){
    const before=structuredClone(x.rooms.state);
    assert.throws(()=>x.rooms.trade(x.code,x.a,{player:0,rank:1,stake:10,operation:'invalid-cashout',version:x.view().version,...input}));
    assert.deepEqual(x.rooms.state,before);
  }
  for(const kind of ['buy','half','sell']){
    const before=structuredClone(x.rooms.state);fail=true;assert.throws(()=>x.trade(x.a,kind),/disk failed/);fail=false;
    assert.deepEqual(x.rooms.state,before);
  }
  const input={kind:'half',player:0,operation:'duplicate-cashout',version:x.view().version};
  x.rooms.trade(x.code,x.a,input);const before=structuredClone(x.rooms.state);
  assert.equal(x.rooms.trade(x.code,x.a,input).duplicate,true);assert.deepEqual(x.rooms.state,before);
});

test('failed initial migration and failed first new fill on an old holding do not partially upgrade the ledger',()=>{
  let fail=false;const x=fixture({save:()=>{if(fail)throw new Error('disk failed');}});x.trade();
  const r=x.rooms.state.rooms[x.code];delete r.saleBook;delete r.positions[x.a][0].saleBasis;
  const before=structuredClone(x.rooms.state);fail=true;
  assert.throws(()=>x.trade(),/disk failed/);assert.deepEqual(x.rooms.state,before);
  assert.throws(()=>x.rooms.sync(x.code,x.a,x.snapshot),/disk failed/);assert.deepEqual(x.rooms.state,before);
});

test('mixed rights release all units exactly and never mint value through repeated integer halves',()=>{
  for(let legacyClaim=0;legacyClaim<=9;legacyClaim++)for(let claim=legacyClaim+1;claim<=20;claim++){
    const original={claim,saleBasis:{legacyClaim,units:37}},position=structuredClone(original);
    let total=0;
    while(position.claim){
      const removed=position.claim===1?1:Math.floor(position.claim/2),exit=cashout(position,removed,12345,34567);
      total+=exit.returned;position.claim-=removed;position.saleBasis=exit.saleBasis;
    }
    assert.deepEqual(position.saleBasis,{legacyClaim:0,units:0});
    assert.ok(total<=cashout(original,claim,12345,34567).returned);
  }
});

test('own-only randomized portfolios cannot create coin profits through mixed buys and sells across rounds',()=>{
  let seed=17;const random=n=>{seed=(seed*1664525+1013904223)>>>0;return seed%n;};
  for(let run=0;run<40;run++){
    const x=fixture({bonus:run%2?11500:10000});
    for(let round=1;round<=8;round++){
      for(let step=0;step<8;step++){
        const horse=random(8),p=x.view().positions[horse];
        x.trade(x.a,p&&random(3)===0?(p.claim>1&&random(2)?'half':'sell'):'buy',horse,1+random(200));
      }
      if(round<8)x.next();
    }
    for(let horse=0;horse<8;horse++)if(x.view().positions[horse])x.trade(x.a,'sell',horse);
    assert.ok(x.view().balance<=100000);
    const flow=x.rooms.state.rooms[x.code].cashflows[x.a];assert.ok(flow.sold<=flow.invested);
  }
});
