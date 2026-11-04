import test from 'node:test';
import assert from 'node:assert/strict';
import {Rooms} from './rooms.mjs';
import {PredictionWeb} from './web.mjs';
import {publicBuild,buildLines,publicPresentation,publicReportReady} from './public-build.mjs';
import {publicSummary} from './hourly.mjs';
import {settlementReport} from './settlement.mjs';
export const build=(i=0)=>({characterId:1000001+i,characterName:'青松'+i,sectId:1,sectName:'剑宗',careerId:2,careerName:'符师',realmId:3,realmName:'金丹',talents:[{id:10001,name:'筑基 · 凝气'},{id:10002,name:'金丹 · 明心'}],baijia:[{id:1001,name:'百家·清风'}],fates:[{id:21,name:'天衍·静修'}],resonance:{id:4,name:'共鸣·生息'},selectionRound:1,selectionsKnown:true});
export function setup(save){const rooms=new Rooms(undefined,save),web=new PredictionWeb(rooms),key=rooms.register('观战房主').token;
 const snapshot={id:'public-builds',gameRoomId:'native-builds',round:2,closedThrough:1,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:'public-player-'+i,name:'道友'+i})),states:Array.from({length:8},()=>({life:90,wins:1,losses:0})),ranks:Array(8).fill(0),active:Array(8).fill(true),baseRates:Array(64).fill(40000),builds:Array.from({length:8},(_,i)=>build(i))};
 const code=rooms.create(key,snapshot).code;return {rooms,web,key,code,snapshot};}
test('public metadata follows UID reordering and retains each round without exposing producer extras',()=>{
 const x=setup();x.snapshot.builds[0].elo=9876;x.snapshot.builds[0].hand=['private-hand'];x.snapshot.builds[0].uid='secret-uid';
 x.rooms.sync(x.code,x.key,x.snapshot);x.snapshot.players.reverse();x.snapshot.states.reverse();x.snapshot.builds.reverse();x.rooms.sync(x.code,x.key,x.snapshot);
 let view=x.web.watch(x.rooms.state.rooms[x.code]);assert.equal(view.players[0].build.characterName,'青松0');assert.equal(view.players[7].build.characterName,'青松7');
 const encoded=JSON.stringify(view);assert(!/9876|private-hand|secret-uid/.test(encoded));
 x.snapshot.round=3;x.snapshot.builds[7].baijia.push({id:1002,name:'百家·明月'});x.rooms.sync(x.code,x.key,x.snapshot);view=x.web.watch(x.rooms.state.rooms[x.code]);
 assert.equal(view.frames[0].builds[0].baijia.length,1);assert.equal(view.players[0].build.baijia.length,2);assert.equal(view.frames.at(-1).builds[0].baijia.length,2);
});
test('public build validation rejects malformed selections and future disclosure, while old sources remain compatible',()=>{
 const x=setup();for(const patch of [{characterId:0},{careerId:'2'},{selectionRound:3},{baijia:[{id:0,name:'bad'}]},{talents:Array(33).fill({id:1,name:'overflow'})},{characterName:'bad'+String.fromCharCode(10)},{resonance:{id:1,name:''}}])assert.throws(()=>publicBuild({...build(),...patch},2));
 assert.equal(publicBuild(null),null);delete x.snapshot.builds;x.rooms.sync(x.code,x.key,x.snapshot);assert.equal(x.web.watch(x.rooms.state.rooms[x.code]).players[0].build.characterName,'青松0');
 assert(buildLines(null)[0].includes('待同步'));const pending={...build(),selectionRound:0,selectionsKnown:false,baijia:[]};assert(buildLines(pending).some(s=>s.includes('等待公开')));
});
test('QQ per-round and individual public summaries include role, career, talents and public Baijia choices',()=>{
 const x=setup(),view=x.web.watch(x.rooms.state.rooms[x.code]),lines=publicSummary(view,{player:0}).join('\n');
 for(const text of ['青松0','符师','筑基 · 凝气','百家·清风','共鸣·生息','天衍·静修','公开至第1回合'])assert(lines.includes(text));
 assert(!lines.includes('青松1'));const historical=publicSummary(view,{round:2,player:0}).join('\n');assert(historical.includes('百家·清风'));
});
test('metadata persistence failures roll back alongside holdings and balances',()=>{
 let fail=false;const x=setup(()=>{if(fail)throw Error('disk failure')});x.rooms.trade(x.code,x.key,{kind:'buy',player:0,rank:1,stake:100,operation:'metadata-buy-001',version:x.rooms.state.rooms[x.code].version});
 const before=structuredClone(x.rooms.state);x.snapshot.builds[0].baijia.push({id:1002,name:'百家·明月'});fail=true;assert.throws(()=>x.rooms.sync(x.code,x.key,x.snapshot));assert.deepEqual(x.rooms.state,before);
});
test('illustrated public reports retain actual board rounds, selected players and mirror matchup markers without identities',()=>{
 const x=setup(),r=x.rooms.state.rooms[x.code];r.builds[0].cards=[101];r.builds[0].cardNames=['上次公开牌'];
 r.battles=[{round:1,first:0,second:1,firstMirror:false,secondMirror:true,winner:1,firstCards:[201],firstNames:['公开剑'],secondCards:[301],secondNames:['公开符'],firstLife:90,secondLife:95}];
 const view=x.web.watch(r),report=publicPresentation(view,{player:0});assert.equal(report.players.length,1);assert.equal(report.players[0].board.round,1);assert.deepEqual(report.players[0].board.cards,[201]);
 assert.equal(report.battles[0].secondMirror,true);assert.equal(report.battles[0].winnerName,view.players[1].name);assert.equal(report.battles[0].firstCharacterId,1000001);assert(!JSON.stringify(report).includes('public-player-'));
 const other=publicPresentation(view,{player:7});assert.equal(other.battles.length,0);assert.equal(other.players[0].index,7);
 view.battles.push({...view.battles[0],round:2,first:2,second:3});const full=publicPresentation(view);assert.equal(full.battles[0].round,2);assert.equal(full.players[0].board.round,1);
});
test('final player returns and net profit account for partial sales, repeat buys and idempotent orders, excluding grants',()=>{
 const x=setup(),order={kind:'buy',player:0,rank:1,stake:100,operation:'settlement-buy-001',version:x.rooms.state.rooms[x.code].version};
 x.rooms.trade(x.code,x.key,order);x.rooms.trade(x.code,x.key,order);
 x.rooms.trade(x.code,x.key,{kind:'half',player:0,operation:'settlement-sale-001',version:x.rooms.state.rooms[x.code].version});
 x.rooms.trade(x.code,x.key,{kind:'buy',player:0,rank:1,stake:100,operation:'settlement-buy-002',version:x.rooms.state.rooms[x.code].version});
 x.rooms.state.accounts[x.key].balance+=200;x.rooms.state.accounts[x.key].checkInGranted=200;
 x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];x.rooms.sync(x.code,x.key,x.snapshot);
 const report=settlementReport(x.rooms,x.rooms.state.rooms[x.code]),r=report.rows[0];assert.equal(r.invested,200);assert.equal(r.sold,48);assert.equal(r.payout,600);assert.equal(r.net,448);assert.equal(x.rooms.state.accounts[x.key].balance,1648);
 assert(!JSON.stringify(report).includes(x.key));assert(publicSummary(x.web.watch(x.rooms.state.rooms[x.code])).join(' ').includes('净增减+448'));
 const old=x.rooms.state.rooms[x.code];delete old.cashflows;delete old.cashflowVersion;assert.equal(settlementReport(x.rooms,old).rows[0].net,null);
});
test('signed native life damage accepts either side, and canonical player swaps reverse its direction',()=>{
 const x=setup();x.snapshot.battles=[{round:2,first:x.snapshot.players[0].uid,second:x.snapshot.players[1].uid,winner:x.snapshot.players[1].uid,firstMirror:false,secondMirror:false,firstCards:[101],secondCards:[201],firstNames:['剑'],secondNames:['符'],firstLife:89,secondLife:98,firstLifeBefore:97,secondLifeBefore:98,lifeDamage:-8,resultComplete:true}];
 x.rooms.sync(x.code,x.key,x.snapshot);let b=x.rooms.state.rooms[x.code].battles[0];assert.equal(b.lifeDamage,-8);
 const raw=x.snapshot.battles[0];[raw.first,raw.second]=[raw.second,raw.first];[raw.firstCards,raw.secondCards]=[raw.secondCards,raw.firstCards];[raw.firstNames,raw.secondNames]=[raw.secondNames,raw.firstNames];raw.lifeDamage=8;
 x.rooms.sync(x.code,x.key,x.snapshot);b=x.rooms.state.rooms[x.code].battles[0];assert.equal(b.lifeDamage,-8);assert.equal(b.winner,1);
});
test('newer authoritative public boards take precedence over older focused battles',()=>{
 const x=setup(),r=x.rooms.state.rooms[x.code];r.builds[0]={...build(),selectionRound:2,cards:[301],cardNames:['末轮公开牌']};
 r.battles=[{round:1,first:0,second:1,firstMirror:false,secondMirror:false,winner:1,firstCards:[201],firstNames:['上轮公开牌']}];
 const p=publicPresentation(x.web.watch(r)).players[0];assert.equal(p.board.round,2);assert.deepEqual(p.board.cards,[301]);
});
test('players eliminated this round retain their cards; subsequent and historical reports use the actual elimination round',()=>{
 const x=setup(),r=x.rooms.state.rooms[x.code];r.states[0]={life:-1,wins:1,losses:1};r.states[1]={life:0,wins:0,losses:1};
 let p=publicPresentation(x.web.watch(r),{noticeType:'round'});assert.equal(p.players[0].showBoard,true);assert.equal(p.players[1].showBoard,false);
 r.round=3;p=publicPresentation(x.web.watch(r),{noticeType:'round'});assert.equal(p.players[0].showBoard,false);assert.equal(p.players[2].showBoard,true);
 assert.equal(publicPresentation(x.web.watch(r),{round:2,noticeType:'round'}).players[0].showBoard,true);
 assert.equal(publicPresentation(x.web.watch(r),{player:0}).players[0].showBoard,true);
});
test('authoritative settlement can be announced independently of incomplete round pictures, without changing money',()=>{
 const x=setup();x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];x.rooms.sync(x.code,x.key,x.snapshot);
 const before=structuredClone(x.rooms.state),view=x.web.watch(x.rooms.state.rooms[x.code]);
 const final=publicPresentation(view,{noticeType:'settled'}),round=publicPresentation(view,{noticeType:'round'});
 assert(publicReportReady(final,Array(8).fill(true)));assert(!publicReportReady(round,Array(8).fill(true)));
 assert(!publicReportReady({...final,players:final.players.map(p=>({...p,rank:0}))}));assert(!publicReportReady({...final,settlement:null}));
 assert.deepEqual(x.rooms.state,before);
});
test('round notifications carry current round quotes and the real cross-horse range instead of zeroing previous round prices',()=>{
 const x=setup(),view=x.web.watch(x.rooms.state.rooms[x.code]);
 view.players[0].quoteRate=575000;view.players[1].quoteRate=17000;view.players[2].state.life=-1;view.players[2].quoteRate=999999;
 const report=publicPresentation(view,{round:1,noticeType:'round'});
 assert.equal(report.round,1);assert.equal(report.quoteRound,2);assert.equal(report.players[0].quoteRate,575000);assert.equal(report.players[2].quoteRate,0);
 assert.deepEqual(report.quoteRange,{minimumRate:17000,maximumRate:575000});assert.equal(report.bettingOpen,true);
 const summary=publicSummary(view,{round:1}).join('\n');assert(summary.includes('第2回合冠军参考区间：1.70倍～57.50倍'));assert(summary.includes('第2回合冠军参考57.50倍'));
 view.tradingClosed=true;view.round=10;const closed=publicPresentation(view,{round:9,noticeType:'round'});
 assert.equal(closed.bettingOpen,false);assert.equal(closed.quoteRound,10);assert.equal(closed.players[0].quoteRate,575000);assert.deepEqual(closed.quoteRange,report.quoteRange);
 view.settled=true;const final=publicPresentation(view,{noticeType:'settled'});assert.equal(final.quoteRange,null);assert(final.players.every(p=>p.quoteRate===0));
});


test('same-round terminal updates retain the previous public choices for pending historical reports',()=>{
 const x=setup();x.snapshot.round=3;x.snapshot.builds=x.snapshot.builds.map(b=>({...b,selectionRound:2,cards:[301],cardNames:['第2轮公开牌'],baijia:[{id:1002,name:'第二轮仙命'}]}));
 x.rooms.sync(x.code,x.key,x.snapshot);
 x.snapshot.builds=x.snapshot.builds.map(b=>({...b,selectionRound:3,cards:[401],cardNames:['第3轮公开牌'],baijia:[{id:1003,name:'第三轮仙命'}]}));x.rooms.sync(x.code,x.key,x.snapshot);
 const restored=new Rooms(structuredClone(x.rooms.state)),view=new PredictionWeb(restored).watch(restored.state.rooms[x.code]);
 const old=publicPresentation(view,{round:2}).players[0];assert.equal(old.build.selectionRound,2);assert.equal(old.build.baijia[0].name,'第二轮仙命');assert.deepEqual(old.board.cards,[301]);
 const latest=publicPresentation(view,{round:3}).players[0];assert.equal(latest.build.selectionRound,3);assert.equal(latest.build.baijia[0].name,'第三轮仙命');
 assert(!JSON.stringify(view.buildHistory).includes('public-player-'));
});

test('all native baijia skip IDs use the common skip icon, while real missing strategy art still returns 404',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync,rmdirSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),http=await import('node:http'),{createHandler}=await import('./server.mjs');
 const folder=mkdtempSync(join(tmpdir(),'yx-skip-art-'));mkdirSync(join(folder,'baijia'));mkdirSync(join(folder,'talents'));
 const png=Buffer.from('89504e470d0a1a0a','hex');writeFileSync(join(folder,'baijia','skip.png'),png);
 const server=http.createServer(createHandler(new Rooms(),{artDirectory:folder}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const request=path=>new Promise((resolve,reject)=>http.get(base+path,r=>{const chunks=[];r.on('data',chunk=>chunks.push(chunk));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(chunks)}));r.on('error',reject);}).on('error',reject));
 try{
  for(const id of [1,7,12,999]){const r=await request('/art/baijia/'+id+'.png');assert.equal(r.status,200);assert.equal(r.headers['content-type'],'image/png');assert.deepEqual(r.body,png);}
  for(const path of ['/art/baijia/0.png','/art/baijia/1000.png','/art/baijia/1001.png','/art/talents/7.png'])assert.equal((await request(path)).status,404);
  rmSync(join(folder,'baijia','skip.png'));assert.equal((await request('/art/baijia/7.png')).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));rmSync(join(folder,'baijia','skip.png'),{force:true});rmdirSync(join(folder,'baijia'));rmdirSync(join(folder,'talents'));rmdirSync(folder);}
});
