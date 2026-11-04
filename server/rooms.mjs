import { quoteRates, eventQuote, wagerFactorBps, cashout, returnFor } from './odds.mjs';
import { eliminationPlan, intervalReturn, championReturn } from './eliminations.mjs';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import {publicBuild} from './public-build.mjs';
import {rememberMarket} from './market.mjs';

export class RoomError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const requireThat = (ok, message, status) => { if (!ok) throw new RoomError(message, status); };
const integer = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;
const token = () => randomBytes(24).toString('hex');
const clone = x => structuredClone(x);
function frozenWagers(r,round) {
  const totals=Array.from({length:8},()=>Array(8).fill(0)),contributions={};
  for(const [key,ps] of Object.entries(r.positions))if(!r.forfeited?.[key]){
    const rows=ps.map(p=>p&&!p.resolved?{rank:p.rank,stake:p.stake}:null);
    if(rows.some(Boolean))contributions[key]=rows;
    rows.forEach((p,i)=>{if(p)totals[i][p.rank-1]+=p.stake;});
  }
  return {round,totals,contributions};
}
function personalSaleRate(r,key,player,rank) {
  const book=r.saleBook,own=book.contributions[key]??[];
  const selected=book.totals[player][rank-1]-(own[player]?.rank===rank?own[player].stake:0);
  const total=book.totals.reduce((sum,row)=>sum+row[0],0)-own.reduce((sum,p)=>sum+(p?.rank===1?p.stake:0),0);
  return eventQuote(r.baseRates[player*8+rank-1],wagerFactorBps(selected,total),r.bonusBps??10000);
}
export class Rooms {
  constructor(state = { accounts: {}, rooms: {} }, save = () => {}, now = Date.now, { championOnly = true } = {}) {
    this.state = state; this.save = save; this.now = now; this.syncTimes = new Map();this.sourceHealth=new Map(); this.championOnly = championOnly; this.revision = 0;
  }
  commit(fn) {
    if (this.committing) return fn();
    const before = clone(this.state);
    this.committing = true;
    try { const result = fn(); this.save(this.state); this.revision++; return result; }
    catch (e) { this.state = before; throw e; }
    finally { this.committing = false; }
  }
  hasPendingBets(key) {
    // Include stale/ended rooms: only settlement, selling or explicit departure releases a wager.
    return Object.values(this.state.rooms).some(room => !room.settled && !room.forfeited?.[key]
      && (room.positions[key] ?? []).some(p => p && !p.resolved && (p.stake > 0 || p.claim > 0)));
  }
  account(key) {
    requireThat(typeof key === 'string' && /^[a-f0-9]{48}$/.test(key) && this.state.accounts[key], '身份无效，请重新连接', 401);
    const available=this.state.accounts[key],transferredAway=Math.max(0,(available.transferOut??0)-(available.transferIn??0));
    if (!available.walletRedirect && integer(available.balance, 0, 9) && available.balance+transferredAway<10 && !this.hasPendingBets(key)) {
      return this.commit(() => {
        const account = this.state.accounts[key];
        account.balance += 50;
        account.reliefCount = (account.reliefCount ?? 0) + 1;
        return account;
      });
    }
    return this.state.accounts[key];
  }
  register(name) {
    requireThat(typeof name === 'string' && name.trim().length > 0 && name.length <= 24, '昵称须为1至24字');
    requireThat(Object.keys(this.state.accounts).length < 10000, '服务器账号已满');
    return this.commit(() => {
      const key = token(); this.state.accounts[key] = { name: name.trim(), balance: 1000 };
      return { token: key, balance: 1000 };
    });
  }
  identify(key, identity) {
    const account = this.account(key);
    requireThat(identity && typeof identity.name === 'string' && identity.name.trim().length > 0 && identity.name.length <= 64
      && typeof identity.uid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(identity.uid), '游戏身份格式无效');
    if (account.name === identity.name && account.uid === identity.uid) return;
    this.commit(() => { account.name = identity.name.trim(); account.uid = identity.uid; });
  }
  room(code, key) {
    this.account(key);
    requireThat(typeof code === 'string' && /^[0-9]{6}$/.test(code) && this.state.rooms[code], '房间不存在', 404);
    const r = this.state.rooms[code];
    requireThat(r.members.includes(key), '请先加入房间', 403); return r;
  }
  displayName(key) { const a=this.state.accounts[key];return (a.webOwner&&this.state.profiles?.[a.webOwner]?.name)||a.name; }
  observerName(r,key){return r.eventSlot&&r.host===key?'WHITE整点竞猜':'观众'+String(Math.max(1,r.members.indexOf(key)+1));}
  snapshot(s) {
    requireThat(s && typeof s.id === 'string' && s.id.length > 0 && s.id.length <= 1024 && integer(s.round, 1, 100000)
      && integer(s.closedThrough, 0, 100000) && typeof s.open === 'boolean' && typeof s.ended === 'boolean', '对局状态无效');
    requireThat(s.liveRound===undefined||integer(s.liveRound,s.round,100000),'公开观战实际回合无效');
    requireThat(s.sourcePhase===undefined||['preparation','battle','verifying','waiting-lobby','ended'].includes(s.sourcePhase),'观战阶段无效');
    requireThat(Array.isArray(s.players) && s.players.length === 8 && new Set(s.players.map(x => x?.uid)).size === 8
      && s.players.every(x => x && typeof x.uid === 'string' && x.uid.length > 0 && x.uid.length <= 128
      && typeof x.name === 'string' && x.name.length <= 128), '需要完整八人名单');
    requireThat(Array.isArray(s.ranks) && s.ranks.length === 8 && s.ranks.every(x => integer(x, 0, 8)), '名次无效');
    requireThat(s.active === undefined || (Array.isArray(s.active) && s.active.length === 8 && s.active.every(x => typeof x === 'boolean')), '选手状态无效');
    requireThat(s.gameRoomId === undefined || s.gameRoomId === '' || (typeof s.gameRoomId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(s.gameRoomId)), '游戏房间标识无效');
    requireThat(s.baseRates === undefined || (Array.isArray(s.baseRates) && s.baseRates.length === 64 && s.baseRates.every(rate => integer(rate,0,500000))), '基础奖励倍率格式无效');
    requireThat(s.horseShuffle===undefined||typeof s.horseShuffle==='boolean','换档规则格式无效');
    requireThat(s.horseTitles===undefined||(Array.isArray(s.horseTitles)&&s.horseTitles.length===8&&s.horseTitles.every(title=>typeof title==='string'&&title.length<=40&&!/[0-9\x00-\x1f\x7f]/.test(title))),'马匹称号格式无效');
    requireThat(s.states === undefined || (Array.isArray(s.states) && s.states.length === 8 && s.states.every(p => p === null || (p && integer(p.life,-1000000,1000000) && integer(p.wins,0,100000) && integer(p.losses,0,100000)))),'公开战况格式无效');
    if(s.builds!==undefined){requireThat(Array.isArray(s.builds)&&s.builds.length===8,'需要完整八人角色资料');for(const build of s.builds)publicBuild(build,s.round);}
    const cards=value=>value===null||(Array.isArray(value)&&value.length<=8&&value.every(id=>integer(id,0,2147483647)));
    const names=(value,ids)=>value===undefined||value===null||(Array.isArray(value)&&Array.isArray(ids)&&value.length===ids.length&&value.every(name=>typeof name==='string'&&name.length<=80&&!/[\x00-\x1f\x7f]/.test(name)));
    requireThat(s.battles===undefined||(Array.isArray(s.battles)&&s.battles.length<=16&&s.battles.every(b=>b&&integer(b.round,Math.max(1,s.round-1),s.round)
      && s.players.some(p=>p.uid===b.first)&&s.players.some(p=>p.uid===b.second)&&typeof b.winner==='string'&&['',b.first,b.second].includes(b.winner)
      &&typeof b.firstMirror==='boolean'&&typeof b.secondMirror==='boolean'&&cards(b.firstCards)&&cards(b.secondCards)&&names(b.firstNames,b.firstCards)&&names(b.secondNames,b.secondCards)
      &&integer(b.firstLife,-1000000,1000000)&&integer(b.secondLife,-1000000,1000000)
      &&(b.resultComplete===undefined||typeof b.resultComplete==='boolean')
      &&(b.lifeDamage===undefined||integer(b.lifeDamage,-1000000,1000000))&&['firstLifeBefore','secondLifeBefore'].every(k=>b[k]===undefined||b[k]===null||integer(b[k],-1000000,1000000)))),'公开牌桌或战果格式无效');
    requireThat(s.eliminationRounds === undefined || (Array.isArray(s.eliminationRounds) && s.eliminationRounds.length === 8 && s.eliminationRounds.every(round => integer(round,0,s.round)) && typeof s.roundComplete === 'boolean'), '出局轮次格式无效');
    return s;
  }
  findByGame(key, nativeId) {
    this.account(key);
    requireThat(typeof nativeId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(nativeId), '游戏房间标识无效');
    const rooms = Object.values(this.state.rooms).filter(r => r.gameRoomId === nativeId && !r.ended && !r.settled);
    rooms.sort((a,b) => (this.syncTimes.get(b.code) ?? 0) - (this.syncTimes.get(a.code) ?? 0));
    const r = rooms[0];
    if (!r) return { nativeId, exists: false, available: false };
    return { nativeId, exists: true, available: (r.members.includes(key) || r.members.length < 32) && this.now() - (this.syncTimes.get(r.code) ?? -Infinity) <= 15000,
      code: r.code, gameId: r.gameId, gameRoomId: nativeId, round: r.round, members: r.members.length };
  }
  create(key, snapshot, allowMatch = true, isPublic = true, event = null) {
    this.account(key); const s = this.snapshot(snapshot);
    requireThat(typeof allowMatch === 'boolean', '匹配设置无效');
    requireThat(typeof isPublic === 'boolean', '公开设置无效');
    requireThat(event===null||(event&&typeof event.slot==='string'&&/^[0-9]{10}$/.test(event.slot)&&event.bonusBps===11500),'整点专场设置无效');
    requireThat(!s.ended, '已结束的对局不能创建房间');
    const existing = Object.values(this.state.rooms).find(r => !r.ended && !r.settled && (r.gameId === s.id || (s.gameRoomId && r.gameRoomId === s.gameRoomId)));
    if (existing) {
      requireThat(existing.host === key || this.now() - (this.syncTimes.get(existing.code) ?? -Infinity) <= 15000, '本局房间房主离线，请稍后重试', 409);
      return this.join(existing.code, key, s.id);
    }
    requireThat(Object.keys(this.state.rooms).length < 1000, '房间已满');
    return this.commit(() => {
      let code; do { code = String(100000 + randomBytes(4).readUInt32BE() % 900000); } while (this.state.rooms[code]);
      this.state.rooms[code] = { code, host: key, members: [key], gameId: s.id, players: clone(s.players), round: 0,
        closedThrough: 0, open: false, ended: false, settled: false, cashflowVersion:1,cashflows:{},horseShuffle:s.horseShuffle??false, eventSlot:event?.slot??null, bonusBps:event?.bonusBps??10000, allowMatch: isPublic && allowMatch, isPublic, active: Array(8).fill(true), rules: s.baseRates ? (this.championOnly ? 3 : 2) : 1, ranks: Array(8).fill(0), positions: {}, version: 0, receipts: {}, payouts: {} };
      this.apply(this.state.rooms[code], s); this.syncTimes.set(code, this.now());
      const featured=this.websiteRoom();
      if(isPublic&&(event||!featured||featured.ended||featured.settled))this.state.websiteRoomCode=code;
      return this.view(code, key);
    });
  }
  join(code, key, gameId) {
    this.account(key);
    requireThat(typeof code === 'string' && /^[0-9]{6}$/.test(code) && this.state.rooms[code], '房间不存在', 404);
    return this.commit(() => {
      const r = this.state.rooms[code]; requireThat(r.gameId === gameId, '房间与当前观战对局不一致');
      if (!r.members.includes(key)) { requireThat(!r.ended && r.members.length < 32, '房间已结束或已满'); r.members.push(key); r.version++; }
      return this.view(code, key);
    });
  }
  lookup(key, code) {
    this.account(key);
    requireThat(typeof code === 'string' && /^[0-9]{6}$/.test(code) && this.state.rooms[code], '房间不存在', 404);
    const r = this.state.rooms[code];
    requireThat(!r.ended && !r.settled && (r.members.includes(key) || r.members.length < 32)
      && this.now() - (this.syncTimes.get(code) ?? -Infinity) <= 15000
      && typeof r.gameRoomId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(r.gameRoomId), '房间已结束、已满或房主离线', 409);
    return { code: r.code, gameId: r.gameId, gameRoomId: r.gameRoomId, round: r.round, members: r.members.length };
  }
  random(key, excludedCode = '') {
    this.account(key);
    requireThat(typeof excludedCode === 'string' && (excludedCode === '' || /^[0-9]{6}$/.test(excludedCode)), '排除房间号无效');
    const candidates = Object.values(this.state.rooms).filter(r => r.code !== excludedCode && this.publicRoom(r) && r.allowMatch !== false && this.isOpen(r)
      && !r.settled && r.members.length < 32 && typeof r.gameRoomId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(r.gameRoomId)
      && Object.entries(r.positions).some(([key,positions]) => !r.forfeited?.[key] && positions.some(p => p && !p.resolved && p.stake > 0)));
    requireThat(candidates.length > 0, '暂无房主在线、已有人投入且可加入的开放房间', 404);
    const r = candidates[randomInt(candidates.length)];
    // Selection grants no membership and spends nothing. Join verifies the actual observed game later.
    return { code: r.code, gameId: r.gameId, gameRoomId: r.gameRoomId, round: r.round, members: r.members.length };
  }
  apply(r, s) {
    const before = JSON.stringify([r.round, r.closedThrough, r.open, r.allInOpen, r.ended, r.settled, r.ranks, r.active]);
    requireThat(r.gameId === s.id && r.players.every(p => s.players.some(q => q.uid === p.uid)), '房间名单或对局不一致');
    requireThat(s.round >= r.round, '拒绝旧回合状态');
    if(s.horseTitles){
      const titles=r.players.map(p=>s.horseTitles[s.players.findIndex(q=>q.uid===p.uid)]);
      requireThat(!r.horseTitles||JSON.stringify(r.horseTitles)===JSON.stringify(titles),'本局马匹称号已锁定');r.horseTitles=titles;
    }
    if(s.horseShuffle!==undefined){requireThat((r.horseShuffle??false)===s.horseShuffle,'本局换档规则已锁定，请在下一新局使用新规则');r.horseShuffle=s.horseShuffle;}
    if(r.rules>=2 && (r.quoteRound === undefined || s.round>r.round)){
      if(s.baseRates) r.baseRates=r.players.flatMap(player=>{const at=s.players.findIndex(p=>p.uid===player.uid);return s.baseRates.slice(at*8,at*8+8);});
      const book=frozenWagers(r,s.round);
      const quotes=quoteRates(r.baseRates,book.totals,r.rules===3,r.bonusBps??10000);r.factors=quotes.factors;r.quoteRates=quotes.rates;r.quoteRound=s.round;
      if(r.rules===3)r.saleBook=book;
    }
    if(r.rules>=2 && s.baseRates){
      const nextBase=r.players.flatMap(player=>{const at=s.players.findIndex(p=>p.uid===player.uid);return s.baseRates.slice(at*8,at*8+8);});
      if(JSON.stringify(nextBase)!==JSON.stringify(r.baseRates)){
        r.baseRates=nextBase;r.quoteRates=nextBase.map((base,at)=>eventQuote(base,r.factors[at],r.bonusBps??10000));r.version++;
      }
    }
    // Old rooms lack the per-owner frozen book. Seed once without changing
    // public quotes or any existing claims; subsequent rounds freeze together.
    if(r.rules===3&&!r.saleBook)r.saleBook=frozenWagers(r,s.round);
    if (s.gameRoomId) { requireThat(!r.gameRoomId || r.gameRoomId === s.gameRoomId, '游戏房间标识发生冲突'); r.gameRoomId = s.gameRoomId; }
    const ranks = r.players.map(p => s.ranks[s.players.findIndex(q => q.uid === p.uid)]);
    // Any ended message locks permanently, including incomplete final ranks.
    r.round = s.round; r.closedThrough = Math.max(r.closedThrough, s.closedThrough,...(s.battles??[]).map(b=>b.round)); r.ended ||= s.ended;
    r.liveRound=Math.max(r.liveRound??r.round,s.liveRound??s.round);
    if(s.sourcePhase)r.sourcePhase=s.sourcePhase;
    r.tradingClosed ||= r.round >= 10 || r.liveRound >= 10 || r.closedThrough >= 10;
    r.open = !r.ended && !r.tradingClosed && s.open && r.round > r.closedThrough && (r.rules<2 || r.ranks.filter(rank=>rank===0).length>=2);
    r.allInOpen = !r.ended && r.round<13 && r.liveRound<13 && r.closedThrough<r.round && s.roundComplete!==false
      && (s.open||!!r.eventSlot&&s.sourcePhase==='preparation');
    if(s.builds){
      this.rememberBuilds(r,r.builds);
      r.builds=r.players.map(p=>publicBuild(s.builds[s.players.findIndex(q=>q.uid===p.uid)],s.round));
      this.rememberBuilds(r,r.builds);
    }
    if (s.states) {
      r.states = r.players.map(p => clone(s.states[s.players.findIndex(q => q.uid === p.uid)]));
      r.frames ??= [];
      const frame={round:r.round,states:clone(r.states),ranks:[...r.ranks],builds:clone(r.builds??Array(8).fill(null))};
      if(r.frames.at(-1)?.round===r.round)r.frames[r.frames.length-1]=frame;
      else {r.frames.push(frame);if(r.frames.length>100)r.frames.shift();}
    }
    if(s.battles)this.applyBattles(r,s.battles);
    if(r.rules>=2 && (s.eliminationRounds || r.eliminationRounds)) {
      if(s.eliminationRounds && !s.roundComplete && !s.ended) { r.open=false; r.allInOpen=false; if(before!==JSON.stringify([r.round,r.closedThrough,r.open,r.allInOpen,r.ended,r.settled,r.ranks,r.active]))r.version++;rememberMarket(r);return; }
      const rounds = r.players.map(p=>s.eliminationRounds?.[s.players.findIndex(q=>q.uid===p.uid)] ?? 0);
      const dead = ranks.map((rank,i)=>!!rank || rounds[i]>0 || r.ranks[i]>0);
      let plan;
      try { plan=eliminationPlan(ranks,rounds,dead,r.ranks,r.rankMinimum??Array(8).fill(0),r.rankMaximum??Array(8).fill(0),r.eliminationRounds??Array(8).fill(0)); }
      catch(error) { throw new RoomError(error.message); }
      r.ranks=plan.ranks;r.rankMinimum=plan.minimum;r.rankMaximum=plan.maximum;r.eliminationRounds=plan.rounds;
    } else for (let i = 0; i < 8; i++) {
      if (r.ranks[i] && ranks[i] && r.ranks[i] !== ranks[i]) throw new RoomError('确定名次冲突');
      if (ranks[i]) r.ranks[i] = ranks[i];
    }
    r.active ??= Array(8).fill(true);
    for (let i=0;i<8;i++) if(r.ranks[i] || (s.active && !s.active[s.players.findIndex(p=>p.uid===r.players[i].uid)])) r.active[i]=false;
    const known = r.ranks.filter(Boolean); requireThat(new Set(known).size === known.length, '名次重复');
    if(r.rules>=2 && known.length<8) requireThat(known.every(rank=>rank>8-known.length),'淘汰名次尚未对齐');
    if(r.rules>=2 && known.length>=7){r.open=false;r.allInOpen=false;}
    if(r.rules>=2) this.settleKnown(r);
    if (r.ended && !r.settled && known.length === 8) this.settle(r);
    if (before !== JSON.stringify([r.round, r.closedThrough, r.open, r.allInOpen, r.ended, r.settled, r.ranks, r.active])) r.version++;
    rememberMarket(r);
  }
  rememberBuilds(r,builds){
    if(!builds)return;
    r.buildHistory??=r.players.map(()=>[]);
    builds.forEach((build,i)=>{
      if(!build)return;
      const history=r.buildHistory[i],row=clone(build),at=history.findIndex(b=>b.selectionRound===row.selectionRound);
      if(at>=0)history[at]=row;else history.push(row);
      history.sort((a,b)=>a.selectionRound-b.selectionRound);if(history.length>100)history.splice(0,history.length-100);
    });
  }
  applyBattles(r,battles){
      r.battles??=[];
      for(const battle of battles){
        let first=r.players.findIndex(p=>p.uid===battle.first),second=r.players.findIndex(p=>p.uid===battle.second);
        let {firstCards,secondCards,firstLife,secondLife,firstMirror,secondMirror}=battle;
        let firstLifeBefore=battle.firstLifeBefore??null,secondLifeBefore=battle.secondLifeBefore??null,lifeDamage=battle.lifeDamage??null;
        let firstNames=battle.firstNames??null,secondNames=battle.secondNames??null;
        if(first>second||(first===second&&firstMirror&&!secondMirror)){
          [first,second]=[second,first];[firstCards,secondCards]=[secondCards,firstCards];[firstNames,secondNames]=[secondNames,firstNames];[firstLife,secondLife]=[secondLife,firstLife];[firstMirror,secondMirror]=[secondMirror,firstMirror];
          [firstLifeBefore,secondLifeBefore]=[secondLifeBefore,firstLifeBefore];
          if(lifeDamage!==null)lifeDamage=-lifeDamage;
        }
        const id=[battle.round,first,second,firstMirror,secondMirror].join(':');
        const row={id,round:battle.round,first,second,winner:battle.winner&&first!==second?r.players.findIndex(p=>p.uid===battle.winner):null,
          firstCards:clone(firstCards),secondCards:clone(secondCards),firstNames:clone(firstNames),secondNames:clone(secondNames),firstLife,secondLife,firstMirror,secondMirror,lifeDamage,resultComplete:battle.resultComplete??!!battle.winner,firstLifeBefore,secondLifeBefore};
        const at=r.battles.findIndex(b=>b.id===id),old=r.battles[at];
        requireThat(!old||old.winner===null||row.winner===null||old.winner===row.winner,'同轮公开战果冲突');
        for(const field of ['firstCards','secondCards'])requireThat(!old||old[field]===null||row[field]===null||JSON.stringify(old[field])===JSON.stringify(row[field]),'同轮公开牌桌冲突');
        if(old){for(const field of ['winner','firstCards','secondCards','lifeDamage','firstLifeBefore','secondLifeBefore'])if(row[field]===null)row[field]=old[field]??null;r.battles[at]=row;}
        else r.battles.push(row);
      }
      r.battles.sort((a,b)=>a.round-b.round||a.id.localeCompare(b.id));if(r.battles.length>800)r.battles.splice(0,r.battles.length-800);
  }
  sync(code, key, snapshot) {
    const r = this.room(code, key); requireThat(r.host === key, '只有房主可以同步战果', 403);
    const s = this.snapshot(snapshot);
    const result = this.commit(() => { this.apply(r, s); return this.view(code, key); });
    this.syncTimes.set(code, this.now());if(r.eventSlot)this.sourceHealth.set(code,{state:'live',at:this.now(),round:Math.max(this.sourceHealth.get(code)?.round??0,r.liveRound??r.round)});return {...result,open:this.isOpen(r)&&!r.forfeited?.[key]};
  }
  isOpen(r,allIn=false) {
    const monitor=r.eventSlot?this.sourceHealth.get(r.code):null,limit=allIn?13:10;
    const phaseOpen=allIn?(r.allInOpen??(r.round<10&&r.open)):r.open;
    return (!monitor||monitor.state==='live')&&(!monitor||monitor.round<limit)&&phaseOpen
      &&!r.ended&&!r.settled&&(allIn||!r.tradingClosed)&&r.round<limit
      &&(r.liveRound??r.round)<limit&&r.closedThrough<limit
      &&this.now()-(this.syncTimes.get(r.code)??-Infinity)<=15000;
  }
  allInMultiplier(r) {
    return Math.max(r.round,r.liveRound??r.round,this.sourceHealth.get(r.code)?.round??0)===1?3:1;
  }
  availability(r,allIn=false){
    const monitor=r.eventSlot?this.sourceHealth.get(r.code):null,fresh=this.now()-(this.syncTimes.get(r.code)??-Infinity)<=15000,alive=monitor&&this.now()-monitor.at<=30000;
    if(r.settled)return {state:'settled',message:'本局已结算，马币已到账'};
    if(r.ended)return {state:'ended',message:'本局已结束，正在核对最终战果'};
    const round=Math.max(r.round,r.liveRound??r.round,r.closedThrough,monitor?.round??0);
    if(allIn&&round>=13)return {state:'closed',message:'第13回合起全猜已截止，等待本局结算'};
    if(!allIn&&(r.tradingClosed||round>=10))return {state:'closed',message:round<13?'普通竞猜已截止，减半和撤回已停止；第13回合前可在群内发送 全猜 选手编号':'竞猜已截止，减半和撤回已停止，等待本局结算'};
    if(alive&&monitor.state==='verifying')return {state:'verifying',message:'机器人持续观战中，正在核对新战况，操作暂时暂停'};
    if(alive&&['connecting','reconnecting'].includes(monitor.state))return {state:'reconnecting',message:'机器人观战连接正在恢复，操作暂时暂停'};
    if(!fresh)return {state:'offline',message:r.eventSlot?'机器人战况同步暂时中断，正在自动恢复':'房主战况暂未更新，已暂停操作'};
    if(this.isOpen(r,allIn))return {state:'open',message:allIn?'修炼阶段，可以全猜':'修炼阶段，可以竞猜'};
    return {state:'waiting',message:r.eventSlot?(r.sourcePhase==='verifying'?'机器人正在核对本轮战况，操作暂时暂停':r.sourcePhase==='waiting-lobby'?'正在确认公开对局进度，操作暂时暂停':'本轮正在战斗或结算，下一轮修炼阶段恢复竞猜'):'等待下一轮修炼阶段开放操作'};
  }
  abandon(code, key, gameId, operation) {
    const r = this.room(code, key);
    requireThat(r.gameId === gameId, '离场竞猜与当前房间对局不一致');
    requireThat(typeof operation === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(operation), '操作标识无效');
    return this.commit(() => {
      if (!r.settled && !r.forfeited?.[key]) {
        (r.forfeited ??= {})[key] = true; r.version++;
        rememberMarket(r);
      }
      return { ...this.view(code, key), abandonConfirmed: true };
    });
  }
  publicRoom(r) { return r.isPublic ?? r.allowMatch !== false; }
  websiteRoom() {
    const room=this.state.rooms[this.state.websiteRoomCode];
    return room&&this.publicRoom(room)?room:null;
  }
  list(key, page = 0) {
    this.account(key);
    requireThat(integer(page, 0, 166), '房间列表页码无效');
    const rooms = Object.values(this.state.rooms).filter(r => this.publicRoom(r) && !r.ended && !r.settled
      && typeof r.gameRoomId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(r.gameRoomId)
      && this.now() - (this.syncTimes.get(r.code) ?? -Infinity) <= 15000);
    rooms.sort((a,b) => a.code.localeCompare(b.code));
    return { page, total: rooms.length, rooms: rooms.slice(page*6,page*6+6).map(r => ({
      code:r.code, hostName:this.observerName(r,r.host), round:r.round, members:r.members.length,
      available:r.members.includes(key)||r.members.length<32, open:this.isOpen(r)
    })) };
  }
  trade(code, key, input) {
    let r = this.room(code, key);
    requireThat(typeof input.operation === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation), '操作标识无效');
    const receiptKey = key + ':' + input.operation;
    if (r.receipts[receiptKey]) return { ...this.view(code, key), duplicate: true };
    requireThat(!r.forfeited?.[key], '离场已放弃本局未结算竞猜，不能重新竞猜');
    const allIn=input.kind==='buy'&&input.allIn===true;
    requireThat(this.isOpen(r,allIn),this.availability(r,allIn).message);
    requireThat(integer(input.version, 0, 1000000000) && input.version === r.version, '报价已变化，请刷新后重试', 409);
    requireThat(integer(input.player, 0, 7) && !r.ranks[input.player], '该选手已确定名次，停止操作');
    requireThat(!r.active || r.active[input.player] !== false, '该选手已淘汰或退出，停止操作');
    if(r.rules>=2) requireThat((r.actionCounts?.[key]?.[input.player] ?? 0)<512,'该选手本局操作次数已达512次');
    requireThat(['buy', 'half', 'sell', 'switch'].includes(input.kind), '操作无效');
    if (this.championOnly && (input.kind === 'buy' || input.kind === 'switch')) {
      requireThat(r.rules === 3, '旧房间保留原竞猜记录，请在新对局创建冠军预测房间');
      requireThat(input.rank === 1, '仅支持预测冠军');
    }
    return this.commit(() => {
      r = this.state.rooms[code]; const account = this.account(key);
      if(r.rules===3&&!r.saleBook)r.saleBook=frozenWagers(r,r.quoteRound??r.round);
      const positions = r.positions[key] ??= Array(8).fill(null);
      const counts=r.actionCounts?.[key]??[],simple=counts.length>0&&counts.every((n,i)=>n===(positions[i]?1:0));
      const flow=(r.cashflows??={})[key]??={known:r.cashflowVersion===1||simple||!positions.some(Boolean)&&!counts.some(Boolean),invested:simple?positions.reduce((n,p)=>n+(p?.stake??0),0):0,sold:0};
      let p = positions[input.player];
      const sell = input.kind === 'sell' || input.kind === 'half' || input.kind === 'switch';
      if (sell) {
        requireThat(p && (r.rules>=2 ? p.claim>0&&!p.resolved : p.stake>0), '没有可出售的竞猜记录');
        requireThat(!p.cashoutLocked,'首回合全猜已锁定至结算，不能减半、撤回或换目标');
        if(r.rules>=2 && input.kind==='switch')requireThat(p.rank!==input.rank,'预测名次相同，请使用增持');
        if(r.rules>=2){
          const removed=input.kind==='half'?Math.floor(p.claim/2):p.claim;
          requireThat(removed>0,'剩余权益不足减半，请使用撤回');
          const exit=cashout(p,removed,r.quoteRates[input.player*8+p.rank-1],p.saleBasis?personalSaleRate(r,key,input.player,p.rank):0);
          const returned=exit.returned;
          requireThat(account.balance+returned-(input.kind==='switch'&&integer(input.stake,1,10000)?input.stake:0)<=1000000000000,'马币余额已达上限');
          const released=Number(BigInt(p.stake)*BigInt(removed)/BigInt(p.claim));
          if(exit.saleBasis)p.saleBasis=exit.saleBasis;
          p.claim-=removed;p.stake-=released;account.balance+=returned;flow.sold+=returned;
          if(!p.claim)positions[input.player]=p=null;
        }else{
          const amount = input.kind === 'half' ? Math.ceil(p.stake / 2) : p.stake;
          const returned=Math.floor(amount*97/100);account.balance+=returned;flow.sold+=returned;p.stake-=amount;
          if (!p.stake) positions[input.player] = p = null;
        }
      }
      if (input.kind === 'buy' || input.kind === 'switch') {
        requireThat(integer(input.rank, 1, 8) && !r.ranks.includes(input.rank), '请选择仍可能的名次');
        if(r.rules>=2)requireThat(input.rank<=8-r.ranks.filter(Boolean).length&&r.quoteRates[input.player*8+input.rank-1]>0,'该名次已不可能达到');
        const allIn=input.allIn===true;
        if(allIn)requireThat(r.rules===3&&input.kind==='buy'&&input.stake===account.balance,'全猜须使用当前全部可用余额');
        requireThat(integer(input.stake, 1, allIn?Number.MAX_SAFE_INTEGER:10000) && account.balance >= input.stake, '马币不足或投入须为1至10000整数');
        requireThat(!p || p.rank === input.rank, '请使用换预测操作');
        const multiplier=allIn?this.allInMultiplier(r):1;
        const claim=r.rules>=2?Number(BigInt(input.stake)*BigInt(r.quoteRates[input.player*8+input.rank-1])*BigInt(multiplier)/10000n):0;
        requireThat(Number.isSafeInteger((p?.claim??0)+claim),'本笔奖励额度超出安全范围');
        if(allIn){
          const claims=positions.map(q=>q&&!q.resolved?q.claim:0);
          claims[input.player]=(p?.claim??0)+claim;claims.sort((a,b)=>b-a);
          const maximum=claims[0]+Math.floor(claims[1]/4)+Math.floor(claims[2]/10);
          requireThat(Number.isSafeInteger(maximum)&&account.balance-input.stake+maximum<=1000000000000,'全猜奖励额度超过马币余额上限，本次未扣款');
        }
        account.balance -= input.stake;
        flow.invested+=input.stake;
        if(!p)positions[input.player]=p={rank:input.rank,stake:0,...(r.rules>=2?{claim:0}:{})};
        if(multiplier===3)p.cashoutLocked=true;
        if(r.rules===3){
          p.saleBasis??={legacyClaim:p.claim,units:0};
          const units=Number(BigInt(input.stake)*BigInt(personalSaleRate(r,key,input.player,input.rank))/10000n);
          requireThat(Number.isSafeInteger(p.saleBasis.units+units),'本笔回收额度超出安全范围');
          p.saleBasis.units+=units;
        }
        p.stake+=input.stake;
        if(r.rules>=2)p.claim+=claim;
      }
      if(r.rules>=2){const counts=(r.actionCounts??={})[key]??=Array(8).fill(0);counts[input.player]++;}
      requireThat(Object.keys(r.receipts).length < (r.rules>=2?131072:20000), '本房间操作次数已满');
      r.receipts[receiptKey] = true; r.version++;
      rememberMarket(r);
      return this.view(code, key);
    });
  }
  settleKnown(r){
    for(const [key,ps] of Object.entries(r.positions)){
      if(r.forfeited?.[key])continue;
      for(let i=0;i<8;i++){
        const p=ps[i];if(!p||p.resolved||!r.ranks[i])continue;
        const payout=r.rankMinimum?.[i]>0?(r.rules===3?championReturn(p.claim,r.rankMinimum[i],r.rankMaximum[i]):intervalReturn(p.claim,p.rank,r.rankMinimum[i],r.rankMaximum[i])):returnFor(p.claim,p.rank,r.ranks[i],r.rules===3);
        requireThat(this.state.accounts[key].balance+payout<=1000000000000,'积分余额已达上限');
        this.state.accounts[key].balance+=payout;r.payouts[key]=(r.payouts[key]??0)+payout;p.payout=payout;p.resolved=true;
      }
    }
  }
  settle(r) {
    if(r.rules>=2){this.settleKnown(r);r.settled=true;r.open=false;return;}
    for (let i = 0; i < 8; i++) {
      let pool = 0, winnerStake = 0;
      for (const [key,positions] of Object.entries(r.positions)) {
        const p = positions[i]; if (!p) continue; pool += p.stake; if (!r.forfeited?.[key] && p.rank === r.ranks[i]) winnerStake += p.stake;
      }
      for (const [key, positions] of Object.entries(r.positions)) {
        const p = positions[i]; if (!p || r.forfeited?.[key]) continue;
        // No correct guesses: refund that player's pool. Integer dust stays unissued.
        const payout = !winnerStake ? p.stake : p.rank === r.ranks[i]
          ? Number(BigInt(pool) * BigInt(p.stake) / BigInt(winnerStake)) : 0;
        this.state.accounts[key].balance += payout;
        r.payouts[key] = (r.payouts[key] ?? 0) + payout;
      }
    }
    r.settled = true; r.open = false;
  }
  view(code, key) {
    const r = this.room(code, key), totals = Array.from({length: 8}, () => Array(8).fill(0));
    for (const [member,ps] of Object.entries(r.positions)) if(r.rules<2 || !r.forfeited?.[member]) for (let i = 0; i < 8; i++) if (ps[i]) totals[i][ps[i].rank - 1] += ps[i].stake;
    return { code, gameId: r.gameId, host: r.host === key, members: r.members.length, memberDetails: r.members.map(member => ({ id: createHash('sha256').update(r.code+':'+r.gameId+':'+member).digest('hex').slice(0,16), name: this.observerName(r,member) })), round: r.round, version: r.version,
      isPublic:this.publicRoom(r), active:r.active ?? r.ranks.map(rank=>!rank), reliefAmount: 50, reliefRequiresNoPendingBets: true, reliefCount: this.account(key).reliefCount ?? 0, allowMatch: r.allowMatch !== false, rules: r.rules ?? 1, baseRates: r.baseRates ?? [], quoteRates: r.quoteRates ?? [], factors: r.factors ?? [], quoteRound: r.quoteRound ?? r.round, open: this.isOpen(r) && !r.forfeited?.[key], tradingClosed: !!r.tradingClosed || r.round >= 10 || r.closedThrough >= 10, forfeited: !!r.forfeited?.[key], ended: r.ended, settled: r.settled, players: r.players, ranks: r.ranks, rankMinimum: r.rankMinimum ?? r.ranks, rankMaximum: r.rankMaximum ?? r.ranks, totals,
      horseTitles:r.horseTitles??null,horseShuffle:r.horseShuffle??false,eventSlot:r.eventSlot??null,bonusBps:r.bonusBps??10000,positions: r.positions[key] ?? Array(8).fill(null), balance: this.account(key).balance, payout: r.payouts[key] ?? 0 };
  }
}
