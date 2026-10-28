import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Rooms } from './rooms.mjs';
import { createHandler } from './server.mjs';
function setup(save, rules = 1) {
  let time = 100000; const rooms = new Rooms(undefined, save, () => time);
  const a = rooms.register('甲').token, b = rooms.register('乙').token;
  const snapshot = {id:'game:1', round:1, closedThrough:0, open:true, ended:false,
    players:Array.from({length:8},(_,i)=>({uid:String(i),name:'玩家'+i})), ranks:Array(8).fill(0),
    ...(rules === 2 ? {baseRates:Array(64).fill(40000)} : {})};
  const code = rooms.create(a, snapshot).code; rooms.join(code,b,snapshot.id);
  const trade = (key, player, rank, stake, kind='buy', operation='operation-'+String(Math.random()).slice(2)) => rooms.trade(code,key,{kind,player,rank,stake,operation,version:rooms.view(code,key).version});
  return {rooms,a,b,snapshot,code,trade,advance: ms => time += ms};
}

test('bankruptcy relief adds fifty below ten and is stable across views and restart',()=>{
  for(const balance of [0,1,9,10,11,1000]){
    const x=setup();x.rooms.state.accounts[x.a].balance=balance;
    const expected=balance<10?balance+50:balance;
    assert.equal(x.rooms.view(x.code,x.a).balance,expected);
    assert.equal(x.rooms.view(x.code,x.a).reliefCount,balance<10?1:0);
    for(let i=0;i<3;i++)assert.equal(x.rooms.view(x.code,x.a).balance,expected);
    const reloaded=new Rooms(structuredClone(x.rooms.state));
    assert.equal(reloaded.view(x.code,x.a).balance,expected);
    assert.equal(reloaded.view(x.code,x.a).reliefCount,balance<10?1:0);
  }
});
test('all-in wagers block relief and duplicate purchases cannot manufacture points',()=>{
  for(const rules of [1,2]){
    let saves=0;const x=setup(()=>saves++,rules);saves=0;
    const result=x.trade(x.a,0,1,1000,'buy','bankrupt-buy-001');
    assert.equal(result.reliefAmount,50);assert.equal(result.reliefRequiresNoPendingBets,true);
    assert.equal(result.balance,0);assert.equal(result.positions[0].stake,1000);assert.equal(saves,1);
    assert.equal(x.trade(x.a,0,1,1000,'buy','bankrupt-buy-001').balance,0);assert.equal(saves,1);
    assert.throws(()=>x.trade(x.a,0,1,50,'buy','bankrupt-buy-002'),/积分不足/);
    assert.equal(x.rooms.view(x.code,x.a).positions[0].stake,1000);assert.equal(saves,1);
    const reloaded=new Rooms(structuredClone(x.rooms.state));
    assert.equal(reloaded.view(x.code,x.a).balance,0);
  }
});

test('pending bets in another room block account relief through ended snapshots and restart',()=>{
  for(const rules of [1,2]){
    const x=setup(undefined,rules);x.trade(x.a,0,1,1000);
    const other={...x.snapshot,id:'other-room'};const second=x.rooms.create(x.a,other).code;
    assert.equal(x.rooms.view(second,x.a).balance,0);
    x.snapshot.ended=true;x.rooms.sync(x.code,x.a,x.snapshot);
    assert.equal(x.rooms.view(second,x.a).balance,0);assert.equal(x.rooms.state.rooms[x.code].settled,false);
    const restored=new Rooms(structuredClone(x.rooms.state));assert.equal(restored.view(second,x.a).balance,0);
    restored.state.accounts[x.b].balance=9;
    assert.equal(restored.view(x.code,x.b).balance,59); // Another member's bets are not ours.
  }
});

test('partial settlement unlocks relief only after the last owned bet resolves',()=>{
  const x=setup(undefined,2);x.trade(x.a,0,1,500);x.trade(x.a,1,1,500);
  x.snapshot.round=2;x.snapshot.ranks[0]=8;let result=x.rooms.sync(x.code,x.a,x.snapshot);
  assert.equal(result.balance,0);assert.equal(result.positions[0].resolved,true);assert.equal(result.positions[1].resolved,undefined);
  assert.equal(new Rooms(structuredClone(x.rooms.state)).view(x.code,x.a).balance,0);
  x.snapshot.round=3;x.snapshot.ranks[1]=7;result=x.rooms.sync(x.code,x.a,x.snapshot);
  assert.equal(result.balance,50);assert.equal(result.settled,false);assert.equal(result.payout,0);assert.equal(result.reliefCount,1);
  assert.equal(result.positions[0].payout,0);assert.equal(result.positions[1].payout,0);
  for(let i=0;i<3;i++)assert.equal(x.rooms.sync(x.code,x.a,x.snapshot).balance,50);
  assert.equal(new Rooms(structuredClone(x.rooms.state)).view(x.code,x.a).balance,50);
});

test('half and failed switch keep relief blocked; selling the last zero-value claim grants it once',()=>{
  let saves=0;const x=setup(()=>saves++,2);x.trade(x.a,0,1,1000);
  x.snapshot.round=2;x.snapshot.baseRates[0]=0;x.rooms.sync(x.code,x.a,x.snapshot);
  let result=x.trade(x.a,0,0,0,'half');assert.equal(result.balance,0);assert.ok(result.positions[0].claim>0);
  const before=structuredClone(x.rooms.state);
  assert.throws(()=>x.trade(x.a,0,2,1,'switch'),/积分不足/);assert.deepEqual(x.rooms.state,before);
  saves=0;result=x.trade(x.a,0,0,0,'sell','last-zero-sale');
  assert.equal(result.balance,50);assert.equal(result.positions[0],null);assert.equal(result.payout,0);assert.equal(saves,1);
  assert.equal(x.trade(x.a,0,0,0,'sell','last-zero-sale').balance,50);assert.equal(saves,1);
});

test('settlement and relief save atomically and a new all-in bet blocks another grant',()=>{
  for(const rules of [1,2]){
    let fail=false,saves=0;const x=setup(()=>{if(fail)throw new Error('disk-full');saves++;},rules);
    x.trade(x.a,0,1,1000);x.trade(x.b,0,8,100);
    const before=structuredClone(x.rooms.state);x.snapshot.ended=true;x.snapshot.ranks=[8,2,3,4,5,6,7,1];fail=true;
    assert.throws(()=>x.rooms.sync(x.code,x.a,x.snapshot),/disk-full/);assert.deepEqual(x.rooms.state,before);
    assert.equal(x.rooms.state.accounts[x.a].reliefCount,undefined);
    fail=false;saves=0;assert.equal(x.rooms.sync(x.code,x.a,x.snapshot).balance,50);assert.equal(saves,1);
    assert.equal(x.rooms.view(x.code,x.a).reliefCount,1);
    assert.equal(x.rooms.view(x.code,x.a).payout,0);
    assert.equal(new Rooms(structuredClone(x.rooms.state)).view(x.code,x.a).balance,50);
    const next={...x.snapshot,id:'next-all-in',ended:false,round:1,ranks:Array(8).fill(0)};
    const second=x.rooms.create(x.a,next);
    const result=x.rooms.trade(second.code,x.a,{kind:'buy',player:0,rank:1,stake:50,operation:'next-all-in-buy',version:second.version});
    assert.equal(result.balance,0);assert.equal(result.positions[0].stake,50);assert.equal(result.reliefCount,1);
    const nextFinal={...next,ended:true,ranks:[8,2,3,4,5,6,7,1]};
    if(rules===1){const joined=x.rooms.join(second.code,x.b,next.id);x.rooms.trade(second.code,x.b,{kind:'buy',player:0,rank:8,stake:1,operation:'second-pool-winner',version:joined.version});}
    const settled=x.rooms.sync(second.code,x.a,nextFinal);
    assert.equal(settled.balance,50);assert.equal(settled.reliefCount,2);
  }
});

test('failed writes roll back purchases and eligible relief before retry',()=>{
  let fail=false;const x=setup(()=>{if(fail)throw new Error('disk-full');});
  const before=structuredClone(x.rooms.state);fail=true;
  assert.throws(()=>x.trade(x.a,0,1,1000,'buy','relief-rollback'),/disk-full/);
  assert.deepEqual(x.rooms.state,before);fail=false;
  assert.equal(x.trade(x.a,0,1,1000,'buy','relief-rollback').balance,0);
  x.rooms.state.accounts[x.b].balance=9;const low=structuredClone(x.rooms.state);fail=true;
  assert.throws(()=>x.rooms.view(x.code,x.b),/disk-full/);assert.deepEqual(x.rooms.state,low);
  fail=false;assert.equal(x.rooms.view(x.code,x.b).balance,59);
});

test('matching preference excludes private rooms but keeps direct discovery and invitation joining',()=>{
  const x=setup();const {rooms,a,b,snapshot}=x;
  const s={...snapshot,id:'private-game',gameRoomId:'private-native'};
  const code=rooms.create(a,s,false).code;
  rooms.trade(code,a,{kind:'buy',player:0,rank:1,stake:10,operation:'private-wager',version:rooms.view(code,a).version});
  assert.throws(()=>rooms.random(b),/暂无/);
  assert.equal(rooms.findByGame(b,'private-native').code,code);
  assert.equal(rooms.lookup(b,code).code,code);
  assert.equal(rooms.join(code,b,s.id).code,code);
  const saved=structuredClone(rooms.state);const reloaded=new Rooms(saved);
  reloaded.sync(code,a,s);assert.throws(()=>reloaded.random(b),/暂无/);
  rooms.create(b,s,true);assert.equal(rooms.state.rooms[code].allowMatch,false);
});
test('legacy/default rooms remain matchable and matching settings are boolean-only',()=>{
  const x=setup();const {rooms,a,b,snapshot,code}=x;
  snapshot.gameRoomId='public-native';rooms.sync(code,a,snapshot);x.trade(a,0,1,10);
  assert.equal(rooms.random(b).code,code);
  delete rooms.state.rooms[code].allowMatch;assert.equal(rooms.random(b).code,code);
  assert.throws(()=>rooms.create(a,{...snapshot,id:'bad'},'false'),/匹配设置/);
  assert.throws(()=>rooms.create(a,{...snapshot,id:'bad'},null),/匹配设置/);
});
test('shared pools fluctuate and final settlement conserves all points',()=>{
  const x=setup(); const {rooms,a,b,code,snapshot,trade}=x;
  trade(a,0,1,100); trade(b,0,2,300);
  assert.deepEqual(rooms.view(code,a).totals[0],[100,300,0,0,0,0,0,0]);
  snapshot.ended=true; snapshot.ranks=[1,2,3,4,5,6,7,8];rooms.sync(code,a,snapshot);
  assert.equal(rooms.view(code,a).balance,1300);assert.equal(rooms.view(code,b).balance,700);
  rooms.sync(code,a,snapshot);assert.equal(rooms.view(code,a).balance,1300);
});
test('round close, heartbeat timeout, restart and rewind cannot reopen trades',()=>{
  const x=setup();x.advance(15001);assert.throws(()=>x.trade(x.a,0,1,10));
  x.rooms.sync(x.code,x.a,x.snapshot);x.trade(x.a,0,1,10);
  x.snapshot.closedThrough=1;x.rooms.sync(x.code,x.a,x.snapshot);assert.throws(()=>x.trade(x.a,1,2,10));
  x.snapshot.closedThrough=0;x.rooms.sync(x.code,x.a,x.snapshot);assert.throws(()=>x.trade(x.a,1,2,10));
  x.snapshot.round=2;x.rooms.sync(x.code,x.a,x.snapshot);x.trade(x.a,1,2,10);
  const reloaded=new Rooms(structuredClone(x.rooms.state));assert.equal(reloaded.view(x.code,x.a).open,false);
  assert.throws(()=>x.rooms.sync(x.code,x.a,{...x.snapshot,round:1}));
});
test('host authorization, same game, unique ranks and member authorization',()=>{
  const x=setup();assert.throws(()=>x.rooms.sync(x.code,x.b,x.snapshot));
  const c=x.rooms.register('丙').token;assert.throws(()=>x.rooms.view(x.code,c));
  assert.throws(()=>x.rooms.join(x.code,c,'other'));
  assert.throws(()=>x.rooms.sync(x.code,x.a,{...x.snapshot,ranks:[1,1,0,0,0,0,0,0]}));
  assert.equal(x.rooms.view(x.code,x.a).ranks[0],0);
});
test('stale quotes reject; operation retries cannot charge twice',()=>{
  const x=setup();const version=x.rooms.view(x.code,x.a).version;
  const input={operation:'repeat-123',kind:'buy',player:0,rank:1,stake:10,version};
  x.rooms.trade(x.code,x.a,input);x.rooms.trade(x.code,x.a,input);
  assert.equal(x.rooms.view(x.code,x.a).balance,990);
  assert.throws(()=>x.rooms.trade(x.code,x.a,{...input,operation:'another-123'}));
});
test('switch rolls back refund and balances if replacement purchase fails',()=>{
  const x=setup();x.trade(x.a,0,1,100);assert.throws(()=>x.trade(x.a,0,2,10000,'switch'));
  assert.equal(x.rooms.view(x.code,x.a).positions[0].stake,100);assert.equal(x.rooms.view(x.code,x.a).balance,900);
  x.trade(x.a,0,2,100,'switch');assert.equal(x.rooms.view(x.code,x.a).balance,897);
  assert.equal(x.rooms.view(x.code,x.a).positions[0].rank,2);
});
test('half/full refunds do not create points; unknown winners refund pools',()=>{
  const x=setup();x.trade(x.a,0,2,101);x.trade(x.a,0,0,0,'half');x.trade(x.a,0,0,0,'sell');
  assert.equal(x.rooms.view(x.code,x.a).balance,996);
  x.trade(x.a,1,1,100);x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];x.rooms.sync(x.code,x.a,x.snapshot);
  assert.equal(x.rooms.view(x.code,x.a).balance,996);
});
test('incomplete final state locks and waits, then settles once with reordered UID roster',()=>{
  const x=setup();x.trade(x.a,0,1,50);x.snapshot.ended=true;x.rooms.sync(x.code,x.a,x.snapshot);
  assert.equal(x.rooms.view(x.code,x.a).settled,false);assert.throws(()=>x.trade(x.a,0,1,50));
  x.snapshot.players.reverse();x.snapshot.ranks=[8,7,6,5,4,3,2,1];x.rooms.sync(x.code,x.a,x.snapshot);
  assert.equal(x.rooms.view(x.code,x.a).settled,true);assert.equal(x.rooms.view(x.code,x.a).balance,1000);
});
test('failed durable save rolls back entire mutation',()=>{
  let fail=false;const x=setup(()=>{if(fail)throw Error('disk full');});fail=true;
  assert.throws(()=>x.trade(x.a,0,1,100));assert.equal(x.rooms.view(x.code,x.a).balance,1000);
  assert.equal(x.rooms.view(x.code,x.a).positions[0],null);
});
test('HTTP two clients join and trade with bearer credentials',async()=>{
  const x=setup();const server=http.createServer(createHandler(x.rooms));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/v1/room`;
  try {
    const call=async(token,body)=>{const r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
    const r=await call(x.a,{action:'trade',code:x.code,kind:'buy',player:0,rank:1,stake:10,operation:'http-test-123',version:x.rooms.view(x.code,x.a).version});assert.equal(r.body.ok,true);
    const v=await call(x.b,{action:'view',code:x.code});assert.equal(v.body.data.totals[0][0],10);
    assert.equal((await call('wrong',{action:'view',code:x.code})).status,401);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

// Verify actual disk storage and process lock, not only the in-memory engine.
test('disk restart preserves account and room, resets trading heartbeat, rejects a second writer',async()=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const {start}=await import('./server.mjs');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'yxp-room-test-'));
  let server;
  try {
    server=start({directory,port:0});await new Promise(resolve=>server.once('listening',resolve));
    assert.throws(()=>start({directory,port:0}),/already in use/);
    let url=`http://127.0.0.1:${server.address().port}/v1/room`;
    const request=async(body,token)=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+(token??'')},body:JSON.stringify(body)});return (await response.json()).data;};
    const user=await request({action:'register',name:'restart'});
    const snapshot={id:'disk-game',round:1,closedThrough:0,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:String(i),name:String(i)})),ranks:Array(8).fill(0)};
    const room=await request({action:'create',snapshot},user.token);
    await request({action:'trade',code:room.code,kind:'buy',player:0,rank:1,stake:100,version:room.version,operation:'disk-trade-001'},user.token);
    await new Promise(resolve=>server.close(resolve));server=null;
    server=start({directory,port:0});await new Promise(resolve=>server.once('listening',resolve));url=`http://127.0.0.1:${server.address().port}/v1/room`;
    const view=await request({action:'view',code:room.code},user.token);assert.equal(view.balance,900);assert.equal(view.positions[0].stake,100);assert.equal(view.open,false);
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    for(const name of ['rooms.json','rooms.json.tmp','server.lock']){const file=path.join(directory,name);if(fs.existsSync(file))fs.unlinkSync(file);}fs.rmdirSync(directory);
  }
});
test('retired rank stops new positions while remaining final ranks wait',()=>{
  const x=setup();x.snapshot.ranks[7]=8;x.rooms.sync(x.code,x.a,x.snapshot);
  assert.throws(()=>x.trade(x.a,7,8,10));assert.throws(()=>x.trade(x.a,0,8,10));
  x.trade(x.a,0,1,10);
});
test('unchanged host heartbeat does not invalidate member quotes',()=>{
  const x=setup();const before=x.rooms.view(x.code,x.b).version;
  x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(x.rooms.view(x.code,x.b).version,before);
  x.rooms.trade(x.code,x.b,{kind:'buy',player:0,rank:1,stake:10,operation:'stable-heartbeat',version:before});
});
test('random selects a funded fresh open room, discloses no credentials and does not join or spend',()=>{
  const x=setup();const visitor=x.rooms.register('visitor').token;
  assert.throws(()=>x.rooms.random(visitor));
  x.snapshot.gameRoomId='native-room_123';x.rooms.sync(x.code,x.a,x.snapshot);
  assert.throws(()=>x.rooms.random(visitor));x.trade(x.a,0,1,10);
  const before=structuredClone(x.rooms.state);const selected=x.rooms.random(visitor);
  assert.equal(selected.code,x.code);assert.equal(selected.gameRoomId,'native-room_123');
  assert.deepEqual(Object.keys(selected).sort(),['code','gameId','gameRoomId','members','round']);
  assert.deepEqual(x.rooms.state,before);assert.throws(()=>x.rooms.view(x.code,visitor));
  assert.throws(()=>x.rooms.join(selected.code,visitor,'different-game'));
  x.rooms.join(selected.code,visitor,selected.gameId);assert.equal(x.rooms.view(x.code,visitor).balance,1000);
});
test('random excludes stale, closed, settled, full and explicitly excluded rooms',()=>{
  const x=setup();x.snapshot.gameRoomId='native-room';x.rooms.sync(x.code,x.a,x.snapshot);x.trade(x.a,0,1,10);
  assert.throws(()=>x.rooms.random(x.b,x.code));x.advance(15001);assert.throws(()=>x.rooms.random(x.b));
  x.rooms.sync(x.code,x.a,x.snapshot);x.snapshot.open=false;x.rooms.sync(x.code,x.a,x.snapshot);assert.throws(()=>x.rooms.random(x.b));
  x.snapshot.open=true;x.rooms.sync(x.code,x.a,x.snapshot);
  for(let i=2;i<32;i++){const key=x.rooms.register('guest'+i).token;x.rooms.join(x.code,key,x.snapshot.id);}
  assert.throws(()=>x.rooms.random(x.b));x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];x.rooms.sync(x.code,x.a,x.snapshot);assert.throws(()=>x.rooms.random(x.b));
});
test('random chooses across multiple eligible rooms and native room identity cannot be replaced',()=>{
  const x=setup();x.snapshot.gameRoomId='native-one';x.rooms.sync(x.code,x.a,x.snapshot);x.trade(x.a,0,1,10);
  const second={...x.snapshot,id:'game:2',gameRoomId:'native-two'};const room=x.rooms.create(x.b,second);
  x.rooms.trade(room.code,x.b,{kind:'buy',player:0,rank:1,stake:10,operation:'random-second-pool',version:room.version});
  assert.equal(x.rooms.random(x.a,x.code).code,room.code);assert.equal(x.rooms.random(x.a,room.code).code,x.code);
  assert.throws(()=>x.rooms.sync(x.code,x.a,{...x.snapshot,gameRoomId:'another-native-room'}));
  assert.equal(x.rooms.state.rooms[x.code].gameRoomId,'native-one');
});
test('random discovery endpoint requires bearer auth and cannot bypass same-game join',async()=>{
  const x=setup();x.snapshot.gameRoomId='native-http-room';x.rooms.sync(x.code,x.a,x.snapshot);x.trade(x.a,0,1,10);
  const key=x.rooms.register('random-http-visitor').token;const server=http.createServer(createHandler(x.rooms));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/v1/room`;
  try{
    const request=(body,token=key)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});
    assert.equal((await request({action:'random'},'wrong')).status,401);
    const selected=(await (await request({action:'random'})).json()).data;assert.equal(selected.gameRoomId,'native-http-room');
    assert.equal((await request({action:'join',code:selected.code,gameId:'wrong-game'})).status,400);
    assert.throws(()=>x.rooms.view(x.code,key));
    assert.equal((await request({action:'join',code:selected.code,gameId:selected.gameId})).status,200);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('manual lookup discovers unfunded rooms without membership or spending and hides credentials',()=>{
  const x=setup();const visitor=x.rooms.register('lookup-guest').token;
  assert.throws(()=>x.rooms.lookup(visitor,x.code));
  x.snapshot.gameRoomId='lookup-native';x.rooms.sync(x.code,x.a,x.snapshot);
  const before=structuredClone(x.rooms.state);const found=x.rooms.lookup(visitor,x.code);
  assert.equal(found.gameRoomId,'lookup-native');assert.deepEqual(Object.keys(found).sort(),['code','gameId','gameRoomId','members','round']);
  assert.deepEqual(x.rooms.state,before);assert.throws(()=>x.rooms.view(x.code,visitor));
  x.snapshot.open=false;x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(x.rooms.lookup(visitor,x.code).code,x.code);
  x.advance(15001);assert.throws(()=>x.rooms.lookup(visitor,x.code));
});
test('lookup HTTP route authenticates and never bypasses normal join checks',async()=>{
  const x=setup();x.snapshot.gameRoomId='lookup-http';x.rooms.sync(x.code,x.a,x.snapshot);
  const key=x.rooms.register('lookup-http-guest').token;const server=http.createServer(createHandler(x.rooms));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/v1/room`;
  try{
    const request=token=>fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action:'lookup',code:x.code})});
    assert.equal((await request('invalid')).status,401);
    const response=await request(key);assert.equal(response.status,200);const data=(await response.json()).data;assert.equal(data.gameId,x.snapshot.id);
    assert.throws(()=>x.rooms.view(x.code,key));assert.equal(x.rooms.account(key).balance,1000);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('member views identify arrivals without exposing bearer keys; repeat join is idempotent',()=>{
 const x=setup();x.rooms.identify(x.a,{name:'游戏甲',uid:'uid-a'});x.rooms.identify(x.b,{name:'游戏乙',uid:'uid-b'});
 const view=x.rooms.view(x.code,x.a);assert.equal(view.memberDetails.length,2);assert.equal(view.memberDetails[1].name,'游戏乙');assert.equal(view.memberDetails[1].uid,'uid-b');
 assert.ok(!JSON.stringify(view).includes(x.a));assert.ok(!JSON.stringify(view).includes(x.b));
 x.rooms.join(x.code,x.b,x.snapshot.id);assert.equal(x.rooms.view(x.code,x.a).memberDetails.length,2);
 assert.throws(()=>x.rooms.identify(x.b,{name:'x',uid:'bad id'}));
 const restored=new Rooms(structuredClone(x.rooms.state));assert.deepEqual(restored.view(x.code,x.a).memberDetails,view.memberDetails);
});
test('selected game discovery hides create when room exists and create reuses it atomically',()=>{
 const x=setup();x.snapshot.gameRoomId='selected-native';x.rooms.sync(x.code,x.a,x.snapshot);
 const found=x.rooms.findByGame(x.b,'selected-native');assert.equal(found.exists,true);assert.equal(found.code,x.code);assert.equal(found.available,true);
 assert.equal(x.rooms.findByGame(x.b,'absent-native').exists,false);
 const again=x.rooms.create(x.b,x.snapshot);assert.equal(again.code,x.code);assert.equal(Object.keys(x.rooms.state.rooms).length,1);assert.equal(again.balance,1000);
 x.advance(15001);assert.equal(x.rooms.findByGame(x.b,'selected-native').available,false);
 x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(x.rooms.findByGame(x.b,'selected-native').exists,false);
});
test('leaving forfeits unresolved bets without refund, unblocks relief once and survives restart',()=>{
  for(const rules of [1,2]){
    const x=setup(undefined,rules);x.trade(x.a,0,1,1000);
    let view=x.rooms.abandon(x.code,x.a,x.snapshot.id,'depart-game-0001');
    assert.equal(view.forfeited,true);assert.equal(view.abandonConfirmed,true);assert.equal(view.open,false);
    assert.equal(view.balance,50);assert.equal(view.reliefCount,1);assert.equal(view.positions[0].stake,1000);
    view=x.rooms.abandon(x.code,x.a,x.snapshot.id,'depart-game-0001');assert.equal(view.balance,50);assert.equal(view.reliefCount,1);
    assert.throws(()=>x.trade(x.a,0,1,10),/放弃/);
    x.rooms.join(x.code,x.a,x.snapshot.id);assert.throws(()=>x.trade(x.a,0,1,10),/放弃/);
    const restored=new Rooms(structuredClone(x.rooms.state));
    x.snapshot.ended=true;x.snapshot.round=15;x.snapshot.ranks=[1,2,3,4,5,6,7,8];
    view=restored.sync(x.code,x.a,x.snapshot);assert.equal(view.balance,50);assert.equal(view.payout,0);assert.equal(view.reliefCount,1);
  }
});
test('forfeiting one room cannot grant relief while another owned wager is pending',()=>{
  const x=setup(undefined,2);x.trade(x.a,0,1,500);
  const second=x.rooms.create(x.a,{...x.snapshot,id:'second-pending'});
  x.rooms.trade(second.code,x.a,{kind:'buy',player:0,rank:1,stake:500,operation:'second-room-bet',version:second.version});
  assert.equal(x.rooms.abandon(x.code,x.a,x.snapshot.id,'depart-one-room').balance,0);
  assert.equal(x.rooms.abandon(second.code,x.a,'second-pending','depart-last-room').balance,50);
});
test('departure keeps previously paid results and does not forfeit another member',()=>{
  const x=setup(undefined,2);x.trade(x.a,7,8,100);x.trade(x.a,0,1,900);x.trade(x.b,0,1,10);
  x.snapshot.round=2;x.snapshot.ranks[7]=8;x.rooms.sync(x.code,x.a,x.snapshot);
  const paid=x.rooms.view(x.code,x.a);assert.equal(paid.payout,400);assert.equal(paid.balance,400);
  x.rooms.abandon(x.code,x.a,x.snapshot.id,'departure-partial');
  x.snapshot.round=16;x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];x.rooms.sync(x.code,x.a,x.snapshot);
  assert.equal(x.rooms.view(x.code,x.a).balance,400);assert.equal(x.rooms.view(x.code,x.a).payout,400);
  assert.equal(x.rooms.view(x.code,x.b).balance,1030);assert.equal(x.rooms.view(x.code,x.b).forfeited,false);
});
test('forfeiture and relief roll back together on storage failure',()=>{
  let fail=false;const x=setup(()=>{if(fail)throw Error('disk full');},2);x.trade(x.a,0,1,1000);
  const before=structuredClone(x.rooms.state);fail=true;
  assert.throws(()=>x.rooms.abandon(x.code,x.a,x.snapshot.id,'departure-failure'),/disk full/);
  assert.deepEqual(x.rooms.state,before);fail=false;
  assert.equal(x.rooms.abandon(x.code,x.a,x.snapshot.id,'departure-failure').balance,50);
});
test('round ten result or round eleven permanently closes all trades while keeping settlement alive',()=>{
  for(const nextRound of [false,true]){
    const x=setup(undefined,2);x.snapshot.round=10;x.rooms.sync(x.code,x.a,x.snapshot);x.trade(x.a,0,1,100);
    if(nextRound)x.snapshot.round=11;else x.snapshot.closedThrough=10;
    let view=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(view.tradingClosed,true);assert.equal(view.open,false);
    for(const kind of ['buy','half','sell','switch'])assert.throws(()=>x.trade(x.a,0,2,10,kind),/封盘/);
    const restored=new Rooms(structuredClone(x.rooms.state));
    const stale={...x.snapshot,closedThrough:0};restored.sync(x.code,x.a,stale);assert.equal(restored.view(x.code,x.a).open,false);
    x.snapshot.round=20;x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];view=restored.sync(x.code,x.a,x.snapshot);
    assert.equal(view.balance,1300);assert.equal(view.settled,true);assert.equal(restored.sync(x.code,x.a,x.snapshot).balance,1300);
  }
});
test('old room saves without cutoff flag cannot trade beyond round ten',()=>{
  const x=setup(undefined,2);const r=x.rooms.state.rooms[x.code];r.round=11;r.open=true;delete r.tradingClosed;
  assert.equal(x.rooms.view(x.code,x.a).open,false);assert.throws(()=>x.trade(x.a,0,1,10),/封盘/);
});
test('same-round elimination rejects gaps atomically, then settles exact adjacent and losing claims by UID once',()=>{
  const x=setup(undefined,2);x.trade(x.a,7,8,100);x.trade(x.a,6,6,100);x.trade(x.a,5,1,100);
  const before=structuredClone(x.rooms.state);x.snapshot.round=2;x.snapshot.ranks[6]=7;
  assert.throws(()=>x.rooms.sync(x.code,x.a,x.snapshot),/对齐/);assert.deepEqual(x.rooms.state,before);
  x.snapshot.ranks[7]=8;x.snapshot.ranks[5]=6;x.snapshot.players.reverse();x.snapshot.ranks.reverse();
  let v=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(v.balance,1200);assert.equal(v.payout,500);
  v=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(v.balance,1200);
  x.snapshot.ended=true;x.snapshot.round=16;x.snapshot.ranks=[8,7,6,5,4,3,2,1];v=x.rooms.sync(x.code,x.a,x.snapshot);assert.equal(v.balance,1200);
});
test('abandon HTTP route authenticates the member and game, confirms only its account',async()=>{
  const x=setup(undefined,2);x.trade(x.a,0,1,1000);
  const server=http.createServer(createHandler(x.rooms));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/v1/room`;
  try{
    const req=(token,gameId=x.snapshot.id)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action:'abandon',code:x.code,gameId,operation:'http-departure'})});
    assert.equal((await req('invalid')).status,401);assert.equal((await req(x.a,'other-game')).status,400);
    const reply=await req(x.a);assert.equal(reply.status,200);const data=(await reply.json()).data;
    assert.equal(data.abandonConfirmed,true);assert.equal(data.balance,50);assert.equal(data.forfeited,true);
    assert.equal(x.rooms.view(x.code,x.b).forfeited,false);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('incomplete ended snapshots also wait for aligned simultaneous elimination ranks',()=>{
  const x=setup(undefined,2);x.trade(x.a,6,7,100);const before=structuredClone(x.rooms.state);
  const partial={...x.snapshot,ended:true,ranks:[0,0,0,0,0,0,7,0]};
  assert.throws(()=>x.rooms.sync(x.code,x.a,partial),/对齐/);assert.deepEqual(x.rooms.state,before);
  partial.ranks[7]=8;const result=x.rooms.sync(x.code,x.a,partial);assert.equal(result.balance,1300);assert.equal(result.settled,false);
});
