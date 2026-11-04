import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Rooms} from './rooms.mjs';
import {PredictionWeb} from './web.mjs';
const user={subject:'a'.repeat(64),name:'云上观众'};
function fixture(save,horseShuffle=false){let now=100000;const rooms=new Rooms(undefined,save,()=>now);const host=rooms.register('房主').token;
 const snapshot={horseShuffle,id:'web-game',gameRoomId:'native-web',round:2,closedThrough:0,open:true,ended:false,players:Array.from({length:8},(_,i)=>({uid:'private-uid-'+i,name:'选手'+i})),ranks:Array(8).fill(0),active:Array(8).fill(true),baseRates:Array(64).fill(40000),states:Array.from({length:8},(_,i)=>({life:100-i,wins:1,losses:0}))};
 const code=rooms.create(host,snapshot).code;const web=new PredictionWeb(rooms,{now:()=>now});return {rooms,host,snapshot,code,web,time:n=>now=n};}
test('web account opens once per verified identity, reuses MOD binding and rolls back failed grants',()=>{
 const x=fixture();assert.equal(x.web.me(user).accounts,0);x.web.openAccount(user);x.web.openAccount(user);assert.equal(x.web.me(user).balance,1000);assert.equal(x.web.me(user).accounts,1);
 const reloaded=new PredictionWeb(new Rooms(structuredClone(x.rooms.state)));reloaded.openAccount(user);assert.equal(reloaded.me(user).balance,1000);
 const other={...user,subject:'b'.repeat(64)};x.web.bind(other,x.web.issueCode(x.host).code);x.web.openAccount(other);assert.equal(x.web.me(other).accounts,1);
 let fail=false;const failed=fixture(()=>{if(fail)throw Error('disk');});const before=structuredClone(failed.rooms.state);fail=true;
 assert.throws(()=>failed.web.openAccount(user));assert.deepEqual(failed.rooms.state,before);fail=false;assert.equal(failed.web.openAccount(user).balance,1000);
});
test('browser can watch without login, then join, wager and settle against the same MOD wallet',()=>{
 const x=fixture();assert.equal(x.web.listRooms().total,1);const publicData=x.web.watch(x.web.publicRoom(x.code));
 const encoded=JSON.stringify(publicData);assert(!encoded.includes(x.host));assert(!encoded.includes('private-uid'));assert.equal(publicData.players[0].state.life,100);
 x.web.bind(user,x.web.issueCode(x.host).code);let joined=x.web.play(user,{action:'join',code:x.code});assert.equal(joined.wallet.balance,1000);
 const order={action:'trade',kind:'buy',code:x.code,player:0,rank:1,stake:100,version:joined.room.version,operation:'browser-buy-0001'};
 const bought=x.web.play(user,order);assert.equal(bought.wallet.balance,900);assert.equal(x.rooms.view(x.code,x.host).positions[0].claim,400);
 assert.equal(x.web.play(user,order).wallet.balance,900);
 x.snapshot.round=10;x.rooms.sync(x.code,x.host,x.snapshot);assert.throws(()=>x.web.play(user,{...order,version:x.rooms.view(x.code,x.host).version,operation:'late-buy-0002'}));
 x.snapshot.round=17;x.snapshot.ended=true;x.snapshot.ranks=[1,2,3,4,5,6,7,8];x.rooms.sync(x.code,x.host,x.snapshot);
 const final=x.web.play(user,{action:'view',code:x.code});assert.equal(final.wallet.balance,1300);assert.equal(final.wallet.payout,400);assert.equal(x.web.me(user).net,300);
});
test('website shows only one public game; other rooms stay in the game and cannot be joined through web',()=>{
 const x=fixture();x.web.openAccount(user);x.web.play(user,{action:'join',code:x.code});
 const second=x.rooms.create(x.rooms.register('another host').token,{...x.snapshot,id:'another-game',gameRoomId:'another-native'}).code;
 assert.equal(x.rooms.list(x.host).total,2);assert.equal(x.web.listRooms().total,1);assert.equal(x.web.listRooms().rooms[0].code,x.code);
 assert.throws(()=>x.web.publicRoom(second));assert.throws(()=>x.web.play(user,{action:'join',code:second}));
 x.time(120000);assert.equal(x.web.watch(x.web.publicRoom(x.code)).fresh,false);assert.equal(x.web.listRooms().total,1);
 x.snapshot.ended=true;x.rooms.sync(x.code,x.host,x.snapshot);
 const third=x.rooms.create(x.rooms.register('next host').token,{...x.snapshot,id:'next-game',gameRoomId:'next-native',ended:false}).code;
 assert.equal(x.web.listRooms().rooms[0].code,third);assert.equal(x.web.listRooms().total,1);
 assert.equal(x.web.play(user,{action:'view',code:x.code}).room.ended,true);
 assert.throws(()=>x.web.publicRoom(x.code));
});
test('public life history tracks stable UID ordering and has one bounded frame per round',()=>{
 const x=fixture();x.snapshot.players.reverse();x.snapshot.states.reverse();x.rooms.sync(x.code,x.host,x.snapshot);
 assert.equal(x.web.watch(x.rooms.state.rooms[x.code]).players[0].state.life,100);
 for(let round=3;round<=110;round++){x.snapshot.round=round;x.rooms.sync(x.code,x.host,x.snapshot);}
 const room=x.web.watch(x.rooms.state.rooms[x.code]);assert.equal(room.frames.length,100);assert.equal(room.frames[0].round,11);assert.equal(room.frames.at(-1).round,110);
 assert.throws(()=>x.rooms.sync(x.code,x.host,{...x.snapshot,states:[{life:'100'}]}));
});
test('continuous public tables retain exact card order and names, match stable players and close a revealed round',()=>{
 const x=fixture();x.snapshot.battles=[{round:2,first:'private-uid-1',second:'private-uid-0',winner:'private-uid-1',firstCards:[1000011,1000021],secondCards:[1000031,0],firstNames:['云舞诀','清风剑'],secondNames:['飞灵闪',''],firstLife:96,secondLife:88,firstMirror:false,secondMirror:false}];
 x.rooms.sync(x.code,x.host,x.snapshot);let view=x.web.watch(x.web.publicRoom(x.code));assert.equal(view.open,false);assert.equal(view.battles[0].first,0);assert.deepEqual(view.battles[0].firstCards,[1000031,0]);assert.equal(view.battles[0].winner,1);assert.equal(JSON.stringify(view).includes('private-uid'),false);
 const reverse={...x.snapshot.battles[0],first:'private-uid-0',second:'private-uid-1',firstCards:[1000031,0],secondCards:[1000011,1000021],firstNames:['飞灵闪',''],secondNames:['云舞诀','清风剑'],firstLife:88,secondLife:96};
 x.snapshot.battles=[reverse];x.rooms.sync(x.code,x.host,x.snapshot);assert.equal(x.rooms.state.rooms[x.code].battles.length,1);
 x.snapshot.round=3;x.rooms.sync(x.code,x.host,x.snapshot);view=x.web.watch(x.web.publicRoom(x.code));assert.equal(view.open,true);assert.equal(view.battles[0].round,2);
 const again=new Rooms(structuredClone(x.rooms.state));assert.equal(again.websiteRoom().code,x.code);assert.deepEqual(again.state.rooms[x.code].battles,view.battles);
});
test('conflicting battle results, foreign identities, invalid card data and speculative rounds roll back the entire sync',()=>{
 const x=fixture(),battle={round:2,first:'private-uid-0',second:'private-uid-1',winner:'private-uid-0',firstCards:[1000011],secondCards:null,firstLife:100,secondLife:80,firstMirror:false,secondMirror:true};
 x.snapshot.battles=[battle];x.rooms.sync(x.code,x.host,x.snapshot);const before=structuredClone(x.rooms.state);
 for(const bad of [{winner:'private-uid-1'},{first:'foreign'},{firstCards:Array(9).fill(1)},{firstCards:[1],firstNames:['a','b']},{round:3},{firstCards:[1000021]}]){
  assert.throws(()=>x.rooms.sync(x.code,x.host,{...x.snapshot,battles:[{...battle,...bad}]}));assert.deepEqual(x.rooms.state,before);
 }
 assert.equal(x.web.watch(x.web.publicRoom(x.code)).battles[0].secondCards,null);
});
test('the game-wide horse titles stay bound to UID, hide numeric scores and cannot change after the opening quote',()=>{
 const x=fixture(undefined,true);x.snapshot.horseTitles=['特等马','上等马','中等马','中等马','中等马','中等马','牛马','海马'];
 x.rooms.sync(x.code,x.host,x.snapshot);const expected=x.web.watch(x.web.publicRoom(x.code)).players.map(p=>p.horseTitle);
 x.snapshot.players.reverse();x.snapshot.horseTitles.reverse();x.snapshot.states.reverse();x.rooms.sync(x.code,x.host,x.snapshot);
 assert.deepEqual(x.web.watch(x.web.publicRoom(x.code)).players.map(p=>p.horseTitle),expected);assert.equal(x.rooms.view(x.code,x.host).horseShuffle,true);
 const before=structuredClone(x.rooms.state);
 for(const input of [{horseTitles:Array(8).fill('中等马 4000')},{horseTitles:Array(8).fill('上等马')},{horseShuffle:false}]){assert.throws(()=>x.rooms.sync(x.code,x.host,{...x.snapshot,...input}));assert.deepEqual(x.rooms.state,before);}
});
