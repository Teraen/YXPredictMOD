import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {RoomError} from './rooms.mjs';
import {settlementReport} from './settlement.mjs';
import {ownerOf} from './identity-links.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
const clonePublic=value=>JSON.parse(JSON.stringify(value));
const ensure=(ok,message,status=400)=>{if(!ok)throw new RoomError(message,status);};
export class PredictionWeb {
  constructor(rooms,{bridgeKey=process.env.YX_PREDICTION_BRIDGE_KEY??'',now=Date.now}={}) {this.rooms=rooms;this.key=bridgeKey;this.now=now;this.codes=new Map();}
  identity(ticket) {
    ensure(/^[a-f0-9]{64}$/i.test(this.key),'网页登录暂未开启',503);
    ensure(typeof ticket==='string'&&ticket.length<2048,'请先登录',401);
    const [payload,signature,...extra]=ticket.split('.');ensure(payload&&signature&&!extra.length,'登录凭据无效',401);
    const expected=createHmac('sha256',Buffer.from(this.key,'hex')).update(payload).digest();
    let actual;try{actual=Buffer.from(signature,'base64url');}catch{throw new RoomError('登录凭据无效',401);}
    ensure(actual.length===expected.length&&timingSafeEqual(actual,expected),'登录凭据无效',401);
    let user;try{user=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{throw new RoomError('登录凭据无效',401);}
    ensure(/^[a-f0-9]{64}$/.test(user.subject)&&Number.isSafeInteger(user.expiresAt)&&user.expiresAt>this.now()&&user.expiresAt<=this.now()+120000,'登录已过期，请重试',401);
    return user;
  }
  issueCode(key) {
    this.rooms.account(key);
    for(const [code,row] of this.codes)if(row.expires<=this.now()||row.key===key)this.codes.delete(code);
    ensure(this.codes.size<10000,'绑定请求过多',429);
    let code;do{code='TP-'+randomBytes(5).toString('hex').toUpperCase();}while(this.codes.has(digest(code)));
    this.codes.set(digest(code),{key,expires:this.now()+300000});return {code,expiresAt:this.now()+300000};
  }
  codeHash(code){ensure(typeof code==='string'&&/^TP-[A-F0-9]{10}$/.test(code.trim().toUpperCase()),'请输入MOD中显示的绑定码');return digest(code.trim().toUpperCase());}
  canonical(user){return {...user,subject:ownerOf(this.rooms.state,user.subject)};}
  profile(user) { return this.rooms.state.profiles?.[ownerOf(this.rooms.state,user.subject)]??{name:user.name||'观众'}; }
  owned(user) {const owner=ownerOf(this.rooms.state,user.subject);return Object.entries(this.rooms.state.accounts).filter(([,a])=>a.webOwner&&ownerOf(this.rooms.state,a.webOwner)===owner);}
  openAccount(user) {
    user=this.canonical(user);
    if(this.owned(user).length)return this.me(user);
    ensure(Object.keys(this.rooms.state.accounts).length<10000,'服务器账户已满');
    this.rooms.commit(()=>{
      const key=randomBytes(24).toString('hex');
      this.rooms.state.accounts[key]={name:this.profile(user).name,balance:1000,webOwner:user.subject,webCreated:true};
      this.rooms.state.profiles??={};
      this.rooms.state.profiles[user.subject]={...this.profile(user),playAccount:key};
    });
    return this.me(user);
  }
  playKey(user) {
    const owned=this.owned(user),profile=this.profile(user);
    ensure(owned.length,'请先开通网页马币，或绑定已有MOD账户',409);
    return (owned.find(([key])=>key===profile.playAccount)||owned.find(([key])=>key===profile.rewardAccount)||owned.slice().sort(([a],[b])=>a.localeCompare(b))[0])[0];
  }
  publicRoom(code) {
    ensure(typeof code==='string'&&/^[0-9]{6}$/.test(code)&&this.rooms.state.rooms[code],'房间不存在',404);
    const r=this.rooms.state.rooms[code];ensure(this.rooms.websiteRoom()?.code===code,'此房间仅在游戏内开放，网站只直播一场公开对局',403);return r;
  }
  watch(r) {
    const fresh=this.rooms.now()-(this.rooms.syncTimes.get(r.code)??-Infinity)<=15000;
    const totals=Array(8).fill(0);
    for(const positions of Object.values(r.positions))for(let i=0;i<8;i++)if(positions[i])totals[i]+=positions[i].stake;
    return {code:r.code,hostName:this.rooms.observerName(r,r.host),round:r.round,version:r.version,rules:r.rules??1,eventSlot:r.eventSlot??null,bonusBps:r.bonusBps??10000,
      members:r.members.length,isPublic:this.rooms.publicRoom(r),fresh,availability:this.rooms.availability(r),open:this.rooms.isOpen(r),allInOpen:this.rooms.isOpen(r,true),allInMultiplier:this.rooms.allInMultiplier(r),ended:r.ended,settled:r.settled,
      updatedAt:this.rooms.syncTimes.get(r.code)??null,players:r.players.map((p,i)=>({name:p.name,rank:r.ranks[i],active:r.active?.[i]??!r.ranks[i],
          horseTitle:r.horseTitles?.[i]??'',rankMinimum:r.rankMinimum?.[i]??r.ranks[i],rankMaximum:r.rankMaximum?.[i]??r.ranks[i],exitRound:r.observerWithdrawals?.[i]??(r.eliminationRounds?.[i]>0?r.eliminationRounds[i]:null),state:r.states?.[i]??null,build:clonePublic(r.builds?.[i]??null),baseRate:r.baseRates?.[i*8]??0,quoteRate:r.quoteRates?.[i*8]??0,factor:r.factors?.[i*8]??10000,total:totals[i]})),
      horseShuffle:r.horseShuffle??false,tradingClosed:r.tradingClosed??false,frames:clonePublic(r.frames??[]),buildHistory:clonePublic(r.buildHistory??[]),battles:clonePublic(r.battles??[]),settlement:settlementReport(this.rooms,r)};
  }
  listRooms(page=0) {
    ensure(Number.isSafeInteger(page)&&page>=0&&page<=166,'房间页码无效');
    const featured=this.rooms.websiteRoom(),rooms=featured?[featured]:[];
    return {page:0,total:rooms.length,rooms:rooms.map(r=>({code:r.code,hostName:this.rooms.observerName(r,r.host),round:r.round,members:r.members.length,open:this.rooms.isOpen(r),names:r.players.map(p=>p.name)}))};
  }
  play(user,body) {
    user=this.canonical(user);
    if(body.action==='openAccount')return {me:this.openAccount(user)};
    if(body.action==='selectAccount'){
      const found=this.owned(user).find(([key])=>digest(key).slice(0,24)===body.wallet);
      ensure(found&&!found[1].walletRedirect,'钱包不存在',404);
      this.rooms.commit(()=>{this.rooms.state.profiles??={};this.rooms.state.profiles[user.subject]={...this.profile(user),playAccount:found[0]};});return {me:this.me(user)};
    }
    let key=this.playKey(user);
    ensure(typeof body.code==='string'&&/^[0-9]{6}$/.test(body.code),'请输入六位房间号');
    const r=this.rooms.state.rooms[body.code];ensure(r,'房间不存在',404);
    ensure(this.rooms.websiteRoom()?.code===r.code||(body.action==='view'&&(r.ended||r.settled)&&r.members.includes(key)),'此房间仅在游戏内开放，网站只直播一场公开对局',403);
    const orderId=body.action==='trade'?body.operation:null,requestDigest=orderId?digest(JSON.stringify([body.code,body.kind,body.player,body.rank,body.stake,body.version])):null;
    if(orderId){
      ensure(typeof orderId==='string'&&/^[a-zA-Z0-9-]{1,128}$/.test(orderId),'操作标识无效');
      const old=this.rooms.state.webOrders?.[orderId];
      if(old){ensure(ownerOf(this.rooms.state,old.owner)===user.subject&&old.requestDigest===requestDigest,'操作标识已被使用',409);key=old.key;}
      else {const legacy=this.owned(user).find(([k])=>r.receipts[k+':'+orderId]);if(legacy)key=legacy[0];}
    }
    if(body.action==='join') {
      ensure(!r.ended&&!r.settled,'本局已结束',409);
      ensure(this.rooms.now()-(this.rooms.syncTimes.get(r.code)??-Infinity)<=15000,this.rooms.availability(r).message,409);
      this.rooms.join(r.code,key,r.gameId);
    } else if(body.action==='trade')this.rooms.commit(()=>{
      this.rooms.trade(r.code,key,body);
      const receipts=this.rooms.state.webOrders??={};
      if(!receipts[orderId]){ensure(Object.keys(receipts).length<500000,'网页操作记录已满，请联系维护者',503);receipts[orderId]={key,owner:user.subject,requestDigest,at:this.now()};}
    });
    else ensure(body.action==='view','操作无效');
    const view=this.rooms.view(r.code,key);
    return {room:this.watch(r),wallet:{name:this.rooms.displayName(key),balance:view.balance,positions:clonePublic(view.positions),payout:view.payout,forfeited:view.forfeited??false},me:this.me(user)};
  }
  bind(user,code) {
    user=this.canonical(user);
    ensure(typeof code==='string'&&/^TP-[A-F0-9]{10}$/.test(code.trim().toUpperCase()),'请输入MOD中显示的绑定码');
    const hash=digest(code.trim().toUpperCase()),row=this.codes.get(hash);
    ensure(row&&row.expires>this.now(),'绑定码已过期或已使用');
    const account=this.rooms.state.accounts[row.key];ensure(account&&(!account.webOwner||account.webOwner===user.subject),'该马币账户已绑定其他身份',409);
    const playAccount=this.owned(user).length?this.playKey(user):row.key;
    this.rooms.commit(()=>{account.webOwner=user.subject;this.rooms.state.profiles??={};const profile=this.rooms.state.profiles[user.subject]??={name:user.name||account.name};profile.playAccount??=playAccount;});
    this.codes.delete(hash);return this.me(user);
  }
  rename(user,name) {
    user=this.canonical(user);
    ensure(typeof name==='string'&&name.trim().length>=1&&name.trim().length<=24&&!/[\x00-\x1f\x7f]/.test(name),'名字需为1至24字，不能包含控制字符');
    const profile=this.profile(user);ensure(!profile.renamedAt||this.now()-profile.renamedAt>=30000,'请等待30秒再改名',429);
    this.rooms.commit(()=>{this.rooms.state.profiles??={};this.rooms.state.profiles[user.subject]={...this.profile(user),name:name.trim(),renamedAt:this.now()};});
    return this.me(user);
  }
  checkInStatus(user) {
    const day=new Date(this.now()+8*3600000).toISOString().slice(0,10),profile=this.profile(user);
    const nextReset=Date.parse(day+'T00:00:00+08:00')+86400000;
    return {day,amount:200,claimed:!!profile.lastCheckInDay&&profile.lastCheckInDay>=day,nextReset,eligible:this.owned(user).length>0};
  }
  checkIn(user) {
    user=this.canonical(user);
    const status=this.checkInStatus(user),owned=this.owned(user);
    ensure(owned.length>0,'请先绑定MOD马币账户，再领取签到奖励');
    if(status.claimed)return {...this.me(user),checkInReceipt:{duplicate:true,amount:0}};
    this.rooms.commit(()=>{
      this.rooms.state.profiles??={};const profile=this.rooms.state.profiles[user.subject]??={name:user.name||'观众'};
      const target=owned.find(([key])=>key===profile.rewardAccount)??owned.find(([key])=>key===profile.playAccount)??owned.slice().sort(([a],[b])=>a.localeCompare(b))[0];
      const [key,account]=target;ensure(Number.isSafeInteger(account.balance)&&account.balance<=1e12-200,'马币余额已达上限');
      ensure(Number.isSafeInteger(account.checkInGranted??0),'签到累计记录无效',500);
      this.rooms.state.walletEvents??={};const id='daily:'+user.subject+':'+status.day;
      ensure(!this.rooms.state.walletEvents[id],'签到记录需要核对，请稍后重试',409);
      account.balance+=200;account.checkInGranted=(account.checkInGranted??0)+200;
      profile.lastCheckInDay=status.day;profile.rewardAccount=key;
      this.rooms.state.walletEvents[id]={kind:'daily-check-in',owner:user.subject,account:key,amount:200,balanceAfter:account.balance,at:this.now(),day:status.day};
    });
    return {...this.me(user),checkInReceipt:{duplicate:false,amount:200}};
  }
  totals() {
    const stats=new Map(Object.keys(this.rooms.state.accounts).map(key=>[key,{held:0,games:0,wins:0}]));
    for(const room of Object.values(this.rooms.state.rooms))for(const key of room.members){
      const row=stats.get(key);if(!row)continue;
      const positions=room.positions[key]??[];
      if(!room.settled&&!room.forfeited?.[key])for(const p of positions)if(p&&!p.resolved)row.held+=p.stake;
      const played=positions.some(p=>p)||room.actionCounts?.[key]?.some(n=>n>0)||Object.keys(room.receipts).some(id=>id.startsWith(key+':'));
      if(played&&room.settled){row.games++;if((room.payouts[key]??0)>0)row.wins++;}
    }
    return stats;
  }
  aggregate(owner,accounts,stats) {
    let balance=0,net=0,games=0,wins=0;
    for(const [key,a]of accounts){const s=stats.get(key);balance+=a.balance;net+=a.balance+s.held-1000-50*(a.reliefCount??0)-(a.checkInGranted??0)-(a.transferIn??0)+(a.transferOut??0);games+=s.games;wins+=s.wins;}
    return {id:digest(owner).slice(0,16),name:this.rooms.state.profiles?.[owner]?.name??accounts[0]?.[1].name??'观众',balance,net,games,wins,accounts:accounts.length};
  }
  me(user) {
    user=this.canonical(user);
    const accounts=this.owned(user),row=this.aggregate(user.subject,accounts,this.totals());
    const play=accounts.length?this.rooms.state.accounts[this.playKey(user)]:null;
    return {...row,name:this.profile(user).name,linked:accounts.length>0,playBalance:play?.balance??null,checkIn:this.checkInStatus(user),links:this.browserAuth?.links(user),wallets:accounts.filter(([,a])=>!a.walletRedirect).map(([key,a])=>({id:digest(key).slice(0,24),name:a.uid?'游戏钱包':a.qqCreated?'QQ钱包':'网页钱包',balance:a.balance,pending:this.rooms.hasPendingBets(key),selected:key===this.playKey(user)}))};
  }
  leaderboard(page=0) {
    ensure(Number.isSafeInteger(page)&&page>=0&&page<=500,'页码无效');
    if(!this.cached || this.cached.revision!==this.rooms.revision || this.now()-this.cached.at>=5000) this.cached={revision:this.rooms.revision,at:this.now(),data:this.buildLeaderboard()};
    const {rows,summary}=this.cached.data;
    return {updatedAt:this.cached.at,page,total:rows.length,items:rows.slice(page*20,page*20+20).map(({balance,accounts,...row},i)=>({...row,rank:page*20+i+1})),summary};
  }
  buildLeaderboard() {
    const groups=new Map();for(const [key,a]of Object.entries(this.rooms.state.accounts)){if(a.systemObserver)continue;const group=a.webOwner?'owner:'+a.webOwner:'account:'+key;if(!groups.has(group))groups.set(group,[]);groups.get(group).push([key,a]);}
    const stats=this.totals(),rows=[...groups].map(([group,accounts])=>this.aggregate(group.startsWith('owner:')?group.slice(6):group,accounts,stats));
    rows.sort((a,b)=>b.net-a.net||b.wins-a.wins||a.id.localeCompare(b.id));
    return {rows,summary:{players:rows.length,games:rows.reduce((n,r)=>n+r.games,0),net:rows.reduce((n,r)=>n+r.net,0)}};
  }
}
