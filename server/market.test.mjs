import test from 'node:test';
import assert from 'node:assert/strict';
import {Rooms} from './rooms.mjs';
import {PredictionWeb} from './web.mjs';
import {HourlyEvents} from './hourly.mjs';
import {qqCommand} from './qq.mjs';
import {marketPresentation,marketSnapshot} from './market.mjs';
import {normalizeRaceCommand} from './race-policy.mjs';
function fixture(save){const rooms=new Rooms(undefined,save),web=new PredictionWeb(rooms),hourly=new HourlyEvents(rooms,web),key=rooms.register('private-wallet-name').token;
 const snapshot={id:'market-test',round:1,closedThrough:0,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:'private-game-uid-'+i,name:'公开选手'+i})),ranks:Array(8).fill(0),active:Array(8).fill(true),baseRates:Array(64).fill(40000)};
 const code=rooms.create(key,snapshot,true,true,{slot:'2026110317',bonusBps:11500}).code,r=rooms.state.rooms[code];
 const trade=(kind,operation,stake=100)=>rooms.trade(code,key,{kind,operation,stake,player:0,rank:1,version:r.version});return {rooms,web,hourly,key,code,r,snapshot,trade};
}
test('short commands normalize to stable legacy operations so old financial receipts stay valid',()=>{
 for(const [short,long]of [['注册','赛马注册'],['转账','马币转账'],['帮助','马币帮助'],['签到','马币签到'],['改名','赛马改名'],['绑定','赛马绑定'],['余额','马币'],['查单','赛马 查单'],['盘口','盘口']])for(const slash of ['','/'])assert.equal(normalizeRaceCommand(slash+short+' test'),'/'+long+' test');
 for(const s of ['注册啦','转账错误','走势很好看','帮助一下','hello'])assert.equal(normalizeRaceCommand(s),null);
});
test('per-round market history captures actual frozen odds, principal and locked claims without changing quotes',()=>{
 const x=fixture();assert.equal(x.r.marketHistory.length,1);assert.equal(x.r.marketHistory[0].rates[0],46000);
 x.trade('buy','market-buy-1');assert.equal(x.r.marketHistory.length,1);assert.equal(x.r.marketHistory[0].pools[0],100);assert.equal(x.r.marketHistory[0].prizes[0],460);assert.equal(x.r.marketHistory[0].rates[0],46000);
 x.snapshot.round=2;x.rooms.sync(x.code,x.key,x.snapshot);assert.equal(x.r.marketHistory.length,2);assert(x.r.marketHistory[1].rates[0]<46000);const locked=x.r.marketHistory[0];
 x.trade('half','market-half-1');assert.equal(x.r.marketHistory[1].pools[0],50);assert.equal(x.r.marketHistory[1].prizes[0],230);assert.equal(locked.pools[0],100);
 const reloaded=new Rooms(structuredClone(x.rooms.state));assert.deepEqual(reloaded.state.rooms[x.code].marketHistory,x.r.marketHistory);
});
test('read-only chart query requires no registration or complete build assets and exposes no identities',()=>{
 const x=fixture(),user={subject:'a'.repeat(64),qqSubject:'a'.repeat(64),scope:'qq-racing',groupId:'613486881',name:'观众'},before=structuredClone(x.rooms.state);
 const result=qqCommand(x.web,x.hourly,user,{text:'盘口'});assert.equal(result.forward,true);assert.equal(result.market.players.length,8);assert.equal(result.market.kind,'duma-market-v1');assert.deepEqual(x.rooms.state,before);
 const json=JSON.stringify(result);for(const secret of [x.key,user.subject,'private-game-uid','private-wallet-name','webOwner'])assert(!json.includes(secret));assert.throws(()=>qqCommand(x.web,x.hourly,user,{text:'走势 1'}),/用法/);
});
test('a live legacy room starts from a real current snapshot and never invents past odds',()=>{
 const x=fixture();delete x.r.marketHistory;x.r.round=7;const before=structuredClone(x.rooms.state),view=marketPresentation(x.rooms,x.r);assert.equal(view.history.length,1);assert.equal(view.history[0].round,7);assert.deepEqual(x.rooms.state,before);
});
test('withdrawn and paid positions leave the active pools; elimination does not draw a zero quote',()=>{
 const x=fixture();x.trade('buy','market-buy-1');x.snapshot.round=2;x.snapshot.ranks=[8,0,0,0,0,0,0,0];x.snapshot.active[0]=false;x.rooms.sync(x.code,x.key,x.snapshot);
 const current=marketSnapshot(x.r);assert.equal(current.rates[0],null);assert.equal(current.pools[0],0);assert.equal(current.prizes[0],0);
 const y=fixture();y.trade('buy','market-buy-2');y.rooms.abandon(y.code,y.key,y.r.gameId,'market-abandon-1');assert.equal(y.r.marketHistory.at(-1).pools[0],0);
});
test('history is bounded, skips missing rounds and rolls back together with failed trades',()=>{
 let fail=false;const x=fixture(()=>{if(fail)throw Error('disk')});const before=structuredClone(x.rooms.state);fail=true;assert.throws(()=>x.trade('buy','market-failed-1'));assert.deepEqual(x.rooms.state,before);fail=false;
 for(let n=2;n<=110;n++){x.snapshot.round=n;x.rooms.sync(x.code,x.key,x.snapshot);}assert.equal(x.rooms.state.rooms[x.code].marketHistory.length,100);assert.equal(x.rooms.state.rooms[x.code].marketHistory[0].round,11);
});
