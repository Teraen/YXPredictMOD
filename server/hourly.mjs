import {RoomError} from './rooms.mjs';
import {randomBytes} from 'node:crypto';
import {buildLines,publicPresentation,publicReportReady,publicBuild} from './public-build.mjs';
import {raceNoticeTargets} from './race-policy.mjs';
import {shuffleReveal} from './shuffle-reveal.mjs';

export const EVENT_BONUS_BPS=11500;
const ensure=(ok,message,status=409)=>{if(!ok)throw new RoomError(message,status)};
export function hourlySlot(now){
  const t=new Date(now+8*3600000),hour=t.getUTCHours();
  if(hour>=2&&hour<=6||t.getUTCMinutes()>=10)return null;
  return t.toISOString().slice(0,13).replace(/[-T:]/g,'');
}
export function hourlySearch(now){
  const slot=hourlySlot(now);if(!slot)return null;
  const fallback=new Date(now+8*3600000).getUTCMinutes()>=5;
  return {slot,searchPhase:fallback?'fallback':'priority',minimumRankScore:fallback?5000:6000,minimumRankScoreExclusive:fallback};
}
export function eligibleLobby(info,minimumRankScore=6000,exclusive=false){
  return !!info&&info.isPrivate===false&&info.playerCount===8&&Number.isSafeInteger(info.round)&&info.round>=1&&info.round<=2
    &&Number.isSafeInteger(info.avgRankScore)&&(exclusive?info.avgRankScore>minimumRankScore:info.avgRankScore>=minimumRankScore)&&typeof info.roomId==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(info.roomId);
}
const rate=n=>(n/10000).toFixed(2)+'倍';
export function publicSummary(view,{round=view.round,player=null,nativeRanks=null}={}){
  const frame=view.frames?.find(f=>f.round===round+1)??view.frames?.find(f=>f.round===round),players=player===null?view.players.map((_,i)=>i):[player];
  const lines=[`整点竞猜 #${view.code} · 第${round}回合${view.settled?' · 已结算':view.tradingClosed?(view.round<13?' · 仅全猜':' · 竞猜已截止'):''}`];
  const reference=publicPresentation(view,{round,player});
  if(reference.closingWarning)lines.unshift(reference.closingWarning);
  if(reference.quoteRange)lines.push(`第${reference.quoteRound}回合冠军参考区间：${rate(reference.quoteRange.minimumRate)}～${rate(reference.quoteRange.maximumRate)}${view.tradingClosed?(view.round<13?(reference.allInOpen?' · 仅全猜可用':' · 全猜等待修炼'):' · 竞猜已截止，仅供参考'):reference.bettingOpen?' · 修炼阶段可竞猜':' · 暂停竞猜，等待修炼'}；以操作确认为准。`);
  for(const i of players){
    const p=view.players[i],state=frame?.states?.[i]??(round===view.round?p.state:null),rank=round>=view.round-1?p.rank:frame?.ranks?.[i]??0;
    const active=frame?(state?state.life>0:rank===0):p.active;
    const build=view.frames?.find(f=>f.round===round)?.builds?.[i]??(round===view.round?p.build:null);
    const quote=reference.players.find(p=>p.index===i)?.quoteRate??0;
    const native=nativeRanks?.[i],nativeText=native?` · ${native.mode==='daoxin'?'道心':'天梯'}${native.score===null?'分未公开':` ${native.score}分`}`:'';
    lines.push(`${i+1}号 ${p.name} · ${p.horseTitle||'马匹档位待同步'}${nativeText}\n${state?`命元${state.life} · ${state.wins}胜${state.losses}负`:'公开战况待同步'}${rank?` · 第${rank}名`:!active?' · 已退出':''}${quote>0?` · 第${reference.quoteRound}回合冠军参考${rate(quote)}`:''}\n${buildLines(build).join('\n')}`);
  }
  for(const b of view.battles??[]){
    if(b.round!==round||player!==null&&b.first!==player&&b.second!==player)continue;
    const a=view.players[b.first],z=view.players[b.second];
    lines.push(`${a.name}${b.firstMirror?'（镜像）':''} 对 ${z.name}${b.secondMirror?'（镜像）':''}\n${a.name}：${b.firstNames?.filter(Boolean).join('、')||'公开牌桌待同步'}\n${z.name}：${b.secondNames?.filter(Boolean).join('、')||'公开牌桌待同步'}\n${b.winner===null?'胜负待确认':view.players[b.winner].name+'胜'}`);
  }
  if(view.settled&&view.settlement){lines.push(view.settlement.closing);for(const r of view.settlement.rows)lines.push(`${r.name}：结算奖励${r.payout}马币${r.known?`，撤回回收${r.sold}，累计投入${r.invested}，净增减${r.net>0?'+':''}${r.net}`:'；历史流水不完整，净增减待核对'}。`);}
  return lines;
}

export class HourlyEvents{
  constructor(rooms,web){this.rooms=rooms;this.web=web;}
  data(){return this.rooms.state.hourly??{slots:{},outbox:[]};}
  status(){
    const active=Object.values(this.rooms.state.rooms).find(r=>r.eventSlot&&!r.settled);
    const search=hourlySearch(this.rooms.now()),slot=search?.slot??null;
    return {slot,bonusBps:EVENT_BONUS_BPS,searchPhase:search?.searchPhase??null,minimumRankScore:search?.minimumRankScore??6000,minimumRankScoreExclusive:search?.minimumRankScoreExclusive??false,maximumStartRound:2,searchMinutes:10,priorityMinutes:5,reports:this.pendingReports(),
      active:active?{code:active.code,gameId:active.gameId,gameRoomId:active.gameRoomId,info:this.data().slots[active.eventSlot]?.info??null,model:this.data().slots[active.eventSlot]?.model??null}:null,
      opened:slot?this.data().slots[slot]?.code??null:null,available:!!slot&&!active};
  }
  pendingReports(){
    return Object.values(this.rooms.state.rooms).filter(r=>r.eventSlot&&r.settled&&this.data().outbox.some(e=>e.code===r.code&&e.kind==='round'&&!e.deliveredAt&&!this.ready(r,'round',e.round))).sort((a,b)=>b.eventSlot.localeCompare(a.eventSlot)).slice(0,3).map(r=>({
      code:r.code,gameId:r.gameId,gameRoomId:r.gameRoomId,round:r.round,recoveryRounds:this.data().outbox.filter(e=>e.code===r.code&&e.kind==='round'&&!e.deliveredAt&&!this.ready(r,'round',e.round)).map(e=>e.round),players:r.players.map((p,i)=>({uid:p.uid,minimum:r.rankMinimum?.[i]??r.ranks[i],maximum:r.rankMaximum?.[i]??r.ranks[i],
        history:(r.battles??[]).flatMap(b=>b.first===i&&!b.firstMirror&&b.firstCards?[{round:b.round,characterId:r.builds?.[i]?.characterId??0,cards:b.firstCards}]:b.second===i&&!b.secondMirror&&b.secondCards?[{round:b.round,characterId:r.builds?.[i]?.characterId??0,cards:b.secondCards}]:[])}))}));
  }
  recoverReport(code,gameId,battles,builds=null){
    const r=this.rooms.state.rooms[code];ensure(r?.eventSlot&&r.host===this.data().hostToken&&r.gameId===gameId&&r.settled,'只允许补全本服务已结算对局的公开战况',403);
    ensure(Array.isArray(battles)&&battles.length>0&&battles.length<=16&&battles.every(b=>b&&Number.isSafeInteger(b.round)&&b.round>=1&&b.round<=r.round),'公开牌桌或战果格式无效',400);
    for(const round of new Set(battles.map(b=>b.round)))this.rooms.snapshot({id:r.gameId,gameRoomId:r.gameRoomId,round,closedThrough:round,open:false,ended:true,players:r.players,ranks:r.ranks,battles:battles.filter(b=>b.round===round)});
    if(builds!==null)this.rooms.snapshot({id:r.gameId,gameRoomId:r.gameRoomId,round:r.round,closedThrough:r.closedThrough,open:false,ended:true,players:r.players,ranks:r.ranks,builds});
    return this.rooms.commit(()=>{
      this.rooms.applyBattles(r,battles);
      if(builds!==null)this.rooms.rememberBuilds(r,builds.map(b=>b===null?null:publicBuild(b,r.round)));
      for(const row of this.data().outbox)if(row.code===code&&row.kind==='round'&&!row.deliveredAt)this.enqueue('round',r,row.round);
      return {reportReady:this.completeReport(r)};
    });
  }
  source(code,gameId,state,round){
    const r=this.rooms.state.rooms[code];ensure(r?.eventSlot&&r.host===this.data().hostToken&&r.gameId===gameId,'观战来源与房间不一致',403);
    ensure(['connecting','reconnecting','verifying'].includes(state)&&Number.isSafeInteger(round)&&round>=1&&round<=100000,'观战连接状态无效',400);
    const previous=this.rooms.sourceHealth.get(code);this.rooms.sourceHealth.set(code,{state,at:this.rooms.now(),round:Math.max(round,r.liveRound??r.round,previous?.round??0)});
    return {ok:true};
  }
  open(info,snapshot,model=null){
    const search=hourlySearch(this.rooms.now()),slot=search?.slot;ensure(slot,'当前不在整点开场时段');
    const previous=this.data().slots[slot];
    if(previous){ensure(previous.gameId===snapshot?.id,'本整点已经开过一场');return this.web.watch(this.rooms.state.rooms[previous.code]);}
    ensure(this.status().available,'上一场公开观战尚未结束');
    ensure(eligibleLobby(info,search.minimumRankScore,search.minimumRankScoreExclusive),search.minimumRankScoreExclusive?'需要刚开始、原生平均段位分大于5000的公开八人对局':'前5分钟需要刚开始、原生平均段位分达到6000的公开八人对局');
    ensure(snapshot?.gameRoomId===info.roomId&&snapshot.round>=1&&snapshot.round<=2&&!snapshot.ended,'观战对局已不符合整点条件');
    ensure(Array.isArray(snapshot.baseRates)&&snapshot.baseRates.length===64&&snapshot.players?.every((_,i)=>snapshot.baseRates[i*8]>0),'等待八人冠军奖励倍率就绪');
    ensure(model===null||(Array.isArray(model)&&model.length===8&&new Set(model.map(p=>p.uid)).size===8&&model.every(p=>snapshot.players.some(q=>q.uid===p.uid)&&typeof p.found==='boolean'&&typeof p.score==='number'&&Number.isFinite(p.score)&&p.score>=0&&p.score<=10000)),'观战报价模型格式无效');
    ensure(info.nativeRanks===undefined||(Array.isArray(info.nativeRanks)&&info.nativeRanks.length===8&&new Set(info.nativeRanks.map(p=>p?.uid)).size===8&&info.nativeRanks.every(p=>p&&snapshot.players.some(q=>q.uid===p.uid)&&['ladder','daoxin'].includes(p.mode)&&(p.score===null||Number.isSafeInteger(p.score)&&p.score>=0&&p.score<=1000000))),'开局公开段位分格式无效');
    return this.rooms.commit(()=>{
      const data=this.rooms.state.hourly??={slots:{},outbox:[]};
      data.hostToken??=this.rooms.register('WHITE整点竞猜').token;
      this.rooms.state.accounts[data.hostToken].systemObserver=true;
      ensure(!Object.values(this.rooms.state.rooms).some(r=>!r.ended&&!r.settled&&(r.gameId===snapshot.id||r.gameRoomId===info.roomId)),'该对局已经有房间');
      const view=this.rooms.create(data.hostToken,snapshot,true,true,{slot,bonusBps:EVENT_BONUS_BPS});
      data.slots[slot]={code:view.code,gameId:snapshot.id,openedAt:this.rooms.now(),info:structuredClone(info),model:structuredClone(model),participants:{[snapshot.round]:snapshot.players.map((_,i)=>!snapshot.states?.[i]||snapshot.states[i].life>0)},noticeWait:{}};
      this.enqueue('start',this.rooms.state.rooms[view.code]);
      const slots=Object.keys(data.slots).sort();for(const old of slots.slice(0,Math.max(0,slots.length-2160)))delete data.slots[old];
      return this.web.watch(this.rooms.state.rooms[view.code]);
    });
  }
  sync(code,snapshot){
    const data=this.data(),r=this.rooms.state.rooms[code];ensure(r&&r.eventSlot&&r.host===data.hostToken,'不是本服务的整点房间',403);
    const withdrawals=new Map();
    if(Array.isArray(snapshot.eliminationRounds))snapshot={...snapshot,eliminationRounds:snapshot.eliminationRounds.map((round,i)=>{
      const at=r.players.findIndex(p=>p.uid===snapshot.players?.[i]?.uid),known=r.eliminationRounds?.[at]??0;
      const rank=snapshot.ranks?.[i],minimum=r.rankMinimum?.[at]||r.ranks[at],maximum=r.rankMaximum?.[at]||r.ranks[at];
      const compatible=rank===0||Number.isSafeInteger(rank)&&rank>=minimum&&rank<=maximum;
      if(at>=0&&snapshot.states?.[i]?.life<=0&&(rank>0||r.ranks[at]>0)&&(!r.ranks[at]||compatible)){
        const exit=this.publicWithdrawalRound(r,snapshot,i,at);
        if(exit!==null){withdrawals.set(at,exit);if(!r.ranks[at])return 0;}
      }
      // A quit player can receive one last native result after its fixed rank
      // has already been accepted. Its win/loss sum is not a new elimination.
      return at>=0&&known>0&&Number.isSafeInteger(round)&&round>known&&round<=snapshot.round&&r.ranks[at]>0&&compatible&&r.states?.[at]?.life<=0&&snapshot.states?.[i]?.life<=0?known:round;
    })};
    if(snapshot.eliminationRounds?.some((round,i)=>{const at=r.players.findIndex(p=>p.uid===snapshot.players?.[i]?.uid);return at>=0&&r.eliminationRounds?.[at]>0&&round>0&&r.eliminationRounds[at]!==round;})){
      if(!this.lastConflictAt||this.rooms.now()-this.lastConflictAt>20000){this.lastConflictAt=this.rooms.now();console.warn('Public elimination conflict',JSON.stringify({round:snapshot.round,previous:r.eliminationRounds,incoming:snapshot.eliminationRounds,ranks:snapshot.ranks,states:snapshot.states}));}
    }
    return this.rooms.commit(()=>{
      const slot=data.slots[r.eventSlot];slot.participants??={};slot.noticeWait??={};
      slot.participants[snapshot.round]??=r.players.map(p=>{const i=snapshot.players.findIndex(q=>q.uid===p.uid);return !snapshot.states?.[i]||snapshot.states[i].life>0;});
      for(const [index,completed]of withdrawals){
        r.observerWithdrawals??=Array(8).fill(null);r.observerWithdrawals[index]=completed;
        for(const [round,participants]of Object.entries(slot.participants))if(Number(round)>completed)participants[index]=false;
      }
      const wasSettled=r.settled;
      this.rooms.sync(code,data.hostToken,snapshot);
      if(!wasSettled&&!slot.shuffleAnnounced){
        const reveal=shuffleReveal(r);
        if(reveal){
          data.outbox.push({id:`${r.eventSlot}:${r.code}:shuffle:0`,kind:'shuffle',code:r.code,round:reveal.round,
            lines:['本局竞猜截止 · 马名互换揭晓'],presentation:reveal,createdAt:this.rooms.now(),deliveredAt:null});
          slot.shuffleAnnounced=true;
        }
      }
      for(const frame of r.frames??[])if(frame.round<=r.closedThrough&&(frame.round<snapshot.round||snapshot.roundComplete!==false)){
        this.enqueue('round',r,frame.round);
      }
      // If an earlier status was rejected, a recovered frame may jump several
      // rounds. Its actual public tables still provide the preceding report.
      for(const round of new Set((snapshot.battles??[]).map(b=>b.round)))if(round<=r.closedThrough){
        const after=r.frames?.find(f=>f.round===round+1)?.states??r.states;
        slot.participants[round]??=r.players.map((_,i)=>after?.[i]?.life>0||(r.eliminationRounds?.[i]??0)>=round||(after?.[i]?.wins??0)+(after?.[i]?.losses??0)>=round);
        this.enqueue('round',r,round);
      }
      if(r.settled)this.enqueue('settled',r);
      return {...this.web.watch(r),reportReady:this.completeReport(r)};
    });
  }
  publicWithdrawalRound(r,snapshot,incoming,index){
    if(r.observerWithdrawals?.[index]!==null&&r.observerWithdrawals?.[index]!==undefined)return r.observerWithdrawals[index];
    const first=(r.frames??[]).find(f=>f.states?.[index]?.life<=0)?.states?.[index]??snapshot.states?.[incoming];
    const completed=(first?.wins??0)+(first?.losses??0);
    if(!Number.isSafeInteger(completed)||completed<0)return null;
    if(completed===0&&snapshot.sourcePhase==='preparation')return 0;
    const tables=[...(r.battles??[]),...(snapshot.battles??[]).map(b=>({...b,first:r.players.findIndex(p=>p.uid===b.first),second:r.players.findIndex(p=>p.uid===b.second),winner:b.winner?r.players.findIndex(p=>p.uid===b.winner):null}))];
    for(const b of tables){
      if(b.round!==completed||b.first===b.second||!b.resultComplete||b.winner===null||!Number.isSafeInteger(b.lifeDamage))continue;
      const side=b.first===index&&!b.firstMirror?'first':b.second===index&&!b.secondMirror?'second':null;
      if(!side)continue;
      const before=b[side+'LifeBefore']??b[side+'Life'];
      // Native BattleResult life is the starting life. Use its explicit damage,
      // never the later win/loss count, to distinguish an out-of-battle exit.
      if(Number.isSafeInteger(before)&&(before<=0||before-(b.winner===index?0:Math.abs(b.lifeDamage))>0))return completed;
    }
    return null;
  }
  startRanks(r){
    const rows=this.data().slots[r.eventSlot]?.info?.nativeRanks;
    return r.players.map(p=>{const row=rows?.find(q=>q.uid===p.uid);return row?{mode:row.mode,score:row.score}:null;});
  }
  presentation(r,kind,round){
    const report=publicPresentation(this.web.watch(r),{round,noticeType:kind});
    if(kind==='start'){const ranks=this.startRanks(r);for(const p of report.players)if(ranks[p.index])p.nativeRank=ranks[p.index];}
    return report;
  }
  enqueue(kind,r,round=r.round){
    const data=this.data(),id=`${r.eventSlot}:${r.code}:${kind}:${kind==='round'?round:0}`;
    const old=data.outbox.find(e=>e.id===id);if(old&&(old.deliveredAt||old.leaseUntil>this.rooms.now()))return;
    const view=this.web.watch(r),lines=kind==='start'
      ?[`整点竞猜开场 #${r.code} · 奖励倍率额外×1.15\n无需认证，先发 观战注册 昵称 开通QQ钱包。只猜冠军，普通竞猜及减半/撤回第10回合截止，全猜第13回合截止。首回合全猜额外×3并锁定至结算，不能减半或撤回；第二25%、第三10%。\n竞猜 选手编号 马币数 · 全猜 选手编号 · 观战 · 选手 编号 · 马币帮助\n指令可省略“/”，也可先@机器人。\nhttps://duma.kaigua.vip/`,...publicSummary(view,{nativeRanks:this.startRanks(r)})]
      :publicSummary(kind==='round'?{...view,settled:false,settlement:null}:view,{round});
    if(old){old.lines=lines;old.presentation=this.presentation(r,kind,round);return;}
    data.outbox.push({id,kind,code:r.code,round,lines,presentation:this.presentation(r,kind,round),createdAt:this.rooms.now(),deliveredAt:null});
    if(data.outbox.length>4000)data.outbox=data.outbox.filter(e=>!e.deliveredAt||e.deliveredAt>this.rooms.now()-7*86400000);
  }
  claim(){
    const queue=this.data().outbox;
    // A missed battle report must not delay the one-time reveal at permanent close.
    const priority=queue.filter(row=>row.kind==='shuffle'&&!row.deliveredAt);
    for(const row of [...priority,...queue]){
      if(row.deliveredAt||row.leaseUntil>this.rooms.now())continue;
      const r=this.rooms.state.rooms[row.code];if(!r)continue;
      if(row.kind==='shuffle'){
        if(!(r.tradingClosed||r.ended||r.settled))continue;
      }else if(!this.ready(r,row.kind,row.round))continue;
      return this.rooms.commit(()=>{if(row.kind!=='shuffle')row.presentation=this.presentation(r,row.kind,row.round);row.deliveryTargets??=raceNoticeTargets(r.eventSlot,row.kind);row.deliveredGroups??={};row.lease=randomBytes(16).toString('hex');row.leaseUntil=this.rooms.now()+60000;return structuredClone({...row,targets:row.deliveryTargets.filter(t=>!row.deliveredGroups[t.groupId])});});
    }
    return null;
  }
  completeReport(r){
    return r.settled&&this.ready(r,'round',r.round)&&!this.data().outbox.some(e=>e.code===r.code&&e.kind==='round'&&!e.deliveredAt&&!this.ready(r,'round',e.round));
  }
  ready(r,kind,round){
    const slot=this.data().slots[r.eventSlot],expected=(slot?.participants?.[round]??r.players.map(()=>false)).map((active,i)=>active||(r.eliminationRounds?.[i]??0)>=round);
    return publicReportReady(publicPresentation(this.web.watch(r),{round,noticeType:kind}),expected);
  }
  ack(id,lease,groupId=null){
    const row=this.data().outbox.find(e=>e.id===id);ensure(row&&row.lease===lease,'通知租约已过期');
    if(row.deliveredAt)return {ok:true};
    return this.rooms.commit(()=>{
      const r=this.rooms.state.rooms[row.code],targets=row.deliveryTargets??raceNoticeTargets(r.eventSlot,row.kind);
      if(groupId===null&&targets.length===1)groupId=targets[0].groupId;
      ensure(targets.some(t=>t.groupId===groupId),'请按目标群分别确认转发');
      row.deliveredGroups??={};row.deliveredGroups[groupId]??=this.rooms.now();
      if(targets.every(t=>row.deliveredGroups[t.groupId]))row.deliveredAt=this.rooms.now();
      return {ok:true,complete:!!row.deliveredAt};
    });
  }
}
