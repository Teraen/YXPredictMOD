import { quoteRates, sale, returnFor } from './odds.mjs';
import { eliminationPlan, intervalReturn } from './eliminations.mjs';
import { randomBytes, randomInt, createHash } from 'node:crypto';

export class RoomError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const requireThat = (ok, message, status) => { if (!ok) throw new RoomError(message, status); };
const integer = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;
const token = () => randomBytes(24).toString('hex');
const clone = x => structuredClone(x);
export class Rooms {
  constructor(state = { accounts: {}, rooms: {} }, save = () => {}, now = Date.now) {
    this.state = state; this.save = save; this.now = now; this.syncTimes = new Map();
  }
  commit(fn) {
    if (this.committing) return fn();
    const before = clone(this.state);
    this.committing = true;
    try { const result = fn(); this.save(this.state); return result; }
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
    if (integer(this.state.accounts[key].balance, 0, 9) && !this.hasPendingBets(key)) {
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
  snapshot(s) {
    requireThat(s && typeof s.id === 'string' && s.id.length > 0 && s.id.length <= 1024 && integer(s.round, 1, 100000)
      && integer(s.closedThrough, 0, 100000) && typeof s.open === 'boolean' && typeof s.ended === 'boolean', '对局状态无效');
    requireThat(Array.isArray(s.players) && s.players.length === 8 && new Set(s.players.map(x => x?.uid)).size === 8
      && s.players.every(x => x && typeof x.uid === 'string' && x.uid.length > 0 && x.uid.length <= 128
      && typeof x.name === 'string' && x.name.length <= 128), '需要完整八人名单');
    requireThat(Array.isArray(s.ranks) && s.ranks.length === 8 && s.ranks.every(x => integer(x, 0, 8)), '名次无效');
    requireThat(s.gameRoomId === undefined || s.gameRoomId === '' || (typeof s.gameRoomId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(s.gameRoomId)), '游戏房间标识无效');
    requireThat(s.baseRates === undefined || (Array.isArray(s.baseRates) && s.baseRates.length === 64 && s.baseRates.every(rate => integer(rate,0,500000))), '基础倍率格式无效');
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
  create(key, snapshot, allowMatch = true) {
    this.account(key); const s = this.snapshot(snapshot);
    requireThat(typeof allowMatch === 'boolean', '匹配设置无效');
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
        closedThrough: 0, open: false, ended: false, settled: false, allowMatch, rules: s.baseRates ? 2 : 1, ranks: Array(8).fill(0), positions: {}, version: 0, receipts: {}, payouts: {} };
      this.apply(this.state.rooms[code], s); this.syncTimes.set(code, this.now());
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
    const candidates = Object.values(this.state.rooms).filter(r => r.code !== excludedCode && r.allowMatch !== false && this.isOpen(r)
      && !r.settled && r.members.length < 32 && typeof r.gameRoomId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(r.gameRoomId)
      && Object.entries(r.positions).some(([key,positions]) => !r.forfeited?.[key] && positions.some(p => p && !p.resolved && p.stake > 0)));
    requireThat(candidates.length > 0, '暂无房主在线、已有人投入且可加入的开放房间', 404);
    const r = candidates[randomInt(candidates.length)];
    // Selection grants no membership and spends nothing. Join verifies the actual observed game later.
    return { code: r.code, gameId: r.gameId, gameRoomId: r.gameRoomId, round: r.round, members: r.members.length };
  }
  apply(r, s) {
    const before = JSON.stringify([r.round, r.closedThrough, r.open, r.ended, r.settled, r.ranks]);
    requireThat(r.gameId === s.id && r.players.every(p => s.players.some(q => q.uid === p.uid)), '房间名单或对局不一致');
    requireThat(s.round >= r.round, '拒绝旧回合状态');
    if(r.rules===2 && (r.quoteRound === undefined || s.round>r.round)){
      if(s.baseRates) r.baseRates=r.players.flatMap(player=>{const at=s.players.findIndex(p=>p.uid===player.uid);return s.baseRates.slice(at*8,at*8+8);});
      const totals=Array.from({length:8},()=>Array(8).fill(0));
      for(const [key,ps] of Object.entries(r.positions)) if(!r.forfeited?.[key]) for(let i=0;i<8;i++) if(ps[i]&&!ps[i].resolved)totals[i][ps[i].rank-1]+=ps[i].stake;
      const quotes=quoteRates(r.baseRates,totals);r.factors=quotes.factors;r.quoteRates=quotes.rates;r.quoteRound=s.round;
    }
    if(r.rules===2 && s.baseRates){
      const nextBase=r.players.flatMap(player=>{const at=s.players.findIndex(p=>p.uid===player.uid);return s.baseRates.slice(at*8,at*8+8);});
      if(JSON.stringify(nextBase)!==JSON.stringify(r.baseRates)){
        r.baseRates=nextBase;r.quoteRates=nextBase.map((base,at)=>base<=0?0:Math.max(10100,Math.min(500000,Math.floor(base*r.factors[at]/10000))));r.version++;
      }
    }
    if (s.gameRoomId) { requireThat(!r.gameRoomId || r.gameRoomId === s.gameRoomId, '游戏房间标识发生冲突'); r.gameRoomId = s.gameRoomId; }
    const ranks = r.players.map(p => s.ranks[s.players.findIndex(q => q.uid === p.uid)]);
    // Any ended message locks permanently, including incomplete final ranks.
    r.round = s.round; r.closedThrough = Math.max(r.closedThrough, s.closedThrough); r.ended ||= s.ended;
    r.tradingClosed ||= r.round > 10 || r.closedThrough >= 10;
    r.open = !r.ended && !r.tradingClosed && s.open && r.round > r.closedThrough && (r.rules!==2 || r.ranks.filter(rank=>rank===0).length>=2);
    if(r.rules===2 && (s.eliminationRounds || r.eliminationRounds)) {
      if(s.eliminationRounds && !s.roundComplete && !s.ended) { r.open=false; if(before!==JSON.stringify([r.round,r.closedThrough,r.open,r.ended,r.settled,r.ranks]))r.version++;return; }
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
    const known = r.ranks.filter(Boolean); requireThat(new Set(known).size === known.length, '名次重复');
    if(r.rules===2 && known.length<8) requireThat(known.every(rank=>rank>8-known.length),'淘汰名次尚未对齐');
    if(r.rules===2 && known.length>=7)r.open=false;
    if(r.rules===2) this.settleKnown(r);
    if (r.ended && !r.settled && known.length === 8) this.settle(r);
    if (before !== JSON.stringify([r.round, r.closedThrough, r.open, r.ended, r.settled, r.ranks])) r.version++;
  }
  sync(code, key, snapshot) {
    const r = this.room(code, key); requireThat(r.host === key, '只有房主可以同步战果', 403);
    const s = this.snapshot(snapshot);
    const result = this.commit(() => { this.apply(r, s); return this.view(code, key); });
    this.syncTimes.set(code, this.now()); return { ...result, open: r.open && !r.settled && !r.forfeited?.[key] };
  }
  isOpen(r) { return r.open && !r.ended && !r.tradingClosed && r.round <= 10 && r.closedThrough < 10 && this.now() - (this.syncTimes.get(r.code) ?? -Infinity) <= 15000; }
  abandon(code, key, gameId, operation) {
    const r = this.room(code, key);
    requireThat(r.gameId === gameId, '离场投注与当前房间对局不一致');
    requireThat(typeof operation === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(operation), '操作标识无效');
    return this.commit(() => {
      if (!r.settled && !r.forfeited?.[key]) {
        (r.forfeited ??= {})[key] = true; r.version++;
      }
      return { ...this.view(code, key), abandonConfirmed: true };
    });
  }
  trade(code, key, input) {
    let r = this.room(code, key);
    requireThat(typeof input.operation === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation), '操作标识无效');
    const receiptKey = key + ':' + input.operation;
    if (r.receipts[receiptKey]) return { ...this.view(code, key), duplicate: true };
    requireThat(!r.forfeited?.[key], '离场已放弃本局未结算投注，不能重新下注');
    requireThat(this.isOpen(r), r.tradingClosed || r.round > 10 || r.closedThrough >= 10 ? '第10轮结束，已封盘' : '交易暂停：等待房主同步下一轮修炼状态');
    requireThat(integer(input.version, 0, 1000000000) && input.version === r.version, '报价已变化，请刷新后重试', 409);
    requireThat(integer(input.player, 0, 7) && !r.ranks[input.player], '该选手已确定名次，停止交易');
    if(r.rules===2) requireThat((r.actionCounts?.[key]?.[input.player] ?? 0)<512,'该选手本局操作次数已达512次');
    requireThat(['buy', 'half', 'sell', 'switch'].includes(input.kind), '操作无效');
    return this.commit(() => {
      r = this.state.rooms[code]; const account = this.account(key);
      const positions = r.positions[key] ??= Array(8).fill(null);
      let p = positions[input.player];
      const sell = input.kind === 'sell' || input.kind === 'half' || input.kind === 'switch';
      if (sell) {
        requireThat(p && (r.rules===2 ? p.claim>0&&!p.resolved : p.stake>0), '没有可出售的持仓');
        if(r.rules===2 && input.kind==='switch')requireThat(p.rank!==input.rank,'预测名次相同，请使用增持');
        if(r.rules===2){
          const removed=input.kind==='half'?Math.floor(p.claim/2):p.claim;
          requireThat(removed>0,'剩余权益不足减半，请使用清仓');
          const returned=sale(p.claim,r.quoteRates[input.player*8+p.rank-1],input.kind==='half');
          requireThat(account.balance+returned-(input.kind==='switch'&&integer(input.stake,1,10000)?input.stake:0)<=1000000000000,'积分余额已达上限');
          const released=Number(BigInt(p.stake)*BigInt(removed)/BigInt(p.claim));
          p.claim-=removed;p.stake-=released;account.balance+=returned;
          if(!p.claim)positions[input.player]=p=null;
        }else{
          const amount = input.kind === 'half' ? Math.ceil(p.stake / 2) : p.stake;
          account.balance += Math.floor(amount * 97 / 100); p.stake -= amount;
          if (!p.stake) positions[input.player] = p = null;
        }
      }
      if (input.kind === 'buy' || input.kind === 'switch') {
        requireThat(integer(input.rank, 1, 8) && !r.ranks.includes(input.rank), '请选择仍可能的名次');
        if(r.rules===2)requireThat(input.rank<=8-r.ranks.filter(Boolean).length&&r.quoteRates[input.player*8+input.rank-1]>0,'该名次已不可能达到');
        requireThat(integer(input.stake, 1, 10000) && account.balance >= input.stake, '积分不足或投入须为1至10000整数');
        requireThat(!p || p.rank === input.rank, '请使用换预测操作');
        account.balance -= input.stake;
        if (p) {p.stake += input.stake;if(r.rules===2)p.claim+=Math.floor(input.stake*r.quoteRates[input.player*8+input.rank-1]/10000);}
        else {positions[input.player] = { rank: input.rank, stake: input.stake };if(r.rules===2)positions[input.player].claim=Math.floor(input.stake*r.quoteRates[input.player*8+input.rank-1]/10000);}
      }
      if(r.rules===2){const counts=(r.actionCounts??={})[key]??=Array(8).fill(0);counts[input.player]++;}
      requireThat(Object.keys(r.receipts).length < (r.rules===2?131072:20000), '本房间操作次数已满');
      r.receipts[receiptKey] = true; r.version++;
      return this.view(code, key);
    });
  }
  settleKnown(r){
    for(const [key,ps] of Object.entries(r.positions)){
      if(r.forfeited?.[key])continue;
      for(let i=0;i<8;i++){
        const p=ps[i];if(!p||p.resolved||!r.ranks[i])continue;
        const payout=r.rankMinimum?.[i]>0?intervalReturn(p.claim,p.rank,r.rankMinimum[i],r.rankMaximum[i]):returnFor(p.claim,p.rank,r.ranks[i]);
        requireThat(this.state.accounts[key].balance+payout<=1000000000000,'积分余额已达上限');
        this.state.accounts[key].balance+=payout;r.payouts[key]=(r.payouts[key]??0)+payout;p.payout=payout;p.resolved=true;
      }
    }
  }
  settle(r) {
    if(r.rules===2){this.settleKnown(r);r.settled=true;r.open=false;return;}
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
    for (const [member,ps] of Object.entries(r.positions)) if(r.rules!==2 || !r.forfeited?.[member]) for (let i = 0; i < 8; i++) if (ps[i]) totals[i][ps[i].rank - 1] += ps[i].stake;
    return { code, gameId: r.gameId, host: r.host === key, members: r.members.length, memberDetails: r.members.map(member => ({ id: createHash('sha256').update(member).digest('hex').slice(0,16), name: this.state.accounts[member].name, uid: this.state.accounts[member].uid ?? '' })), round: r.round, version: r.version,
      reliefAmount: 50, reliefRequiresNoPendingBets: true, reliefCount: this.account(key).reliefCount ?? 0, allowMatch: r.allowMatch !== false, rules: r.rules ?? 1, baseRates: r.baseRates ?? [], quoteRates: r.quoteRates ?? [], factors: r.factors ?? [], quoteRound: r.quoteRound ?? r.round, open: this.isOpen(r) && !r.forfeited?.[key], tradingClosed: !!r.tradingClosed || r.round > 10 || r.closedThrough >= 10, forfeited: !!r.forfeited?.[key], ended: r.ended, settled: r.settled, players: r.players, ranks: r.ranks, rankMinimum: r.rankMinimum ?? r.ranks, rankMaximum: r.rankMaximum ?? r.ranks, totals,
      positions: r.positions[key] ?? Array(8).fill(null), balance: this.account(key).balance, payout: r.payouts[key] ?? 0 };
  }
}
