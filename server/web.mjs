import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {RoomError} from './rooms.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
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
  profile(user) { return this.rooms.state.profiles?.[user.subject]??{name:user.name||'观众'}; }
  owned(user) {return Object.entries(this.rooms.state.accounts).filter(([,a])=>a.webOwner===user.subject);}
  bind(user,code) {
    ensure(typeof code==='string'&&/^TP-[A-F0-9]{10}$/.test(code.trim().toUpperCase()),'请输入MOD中显示的绑定码');
    const hash=digest(code.trim().toUpperCase()),row=this.codes.get(hash);
    ensure(row&&row.expires>this.now(),'绑定码已过期或已使用');
    const account=this.rooms.state.accounts[row.key];ensure(account&&(!account.webOwner||account.webOwner===user.subject),'该马币账户已绑定其他身份',409);
    this.rooms.commit(()=>{account.webOwner=user.subject;this.rooms.state.profiles??={};this.rooms.state.profiles[user.subject]??={name:user.name||account.name};});
    this.codes.delete(hash);return this.me(user);
  }
  rename(user,name) {
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
    const status=this.checkInStatus(user),owned=this.owned(user);
    ensure(owned.length>0,'请先绑定MOD马币账户，再领取签到奖励');
    if(status.claimed)return {...this.me(user),checkInReceipt:{duplicate:true,amount:0}};
    this.rooms.commit(()=>{
      this.rooms.state.profiles??={};const profile=this.rooms.state.profiles[user.subject]??={name:user.name||'观众'};
      const target=owned.find(([key])=>key===profile.rewardAccount)??owned.slice().sort(([a],[b])=>a.localeCompare(b))[0];
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
    for(const [key,a]of accounts){const s=stats.get(key);balance+=a.balance;net+=a.balance+s.held-1000-50*(a.reliefCount??0)-(a.checkInGranted??0);games+=s.games;wins+=s.wins;}
    return {id:digest(owner).slice(0,16),name:this.rooms.state.profiles?.[owner]?.name??accounts[0]?.[1].name??'观众',balance,net,games,wins,accounts:accounts.length};
  }
  me(user) {
    const accounts=this.owned(user),row=this.aggregate(user.subject,accounts,this.totals());
    return {...row,name:this.profile(user).name,linked:accounts.length>0,checkIn:this.checkInStatus(user)};
  }
  leaderboard(page=0) {
    ensure(Number.isSafeInteger(page)&&page>=0&&page<=500,'页码无效');
    if(!this.cached || this.cached.revision!==this.rooms.revision || this.now()-this.cached.at>=5000) this.cached={revision:this.rooms.revision,at:this.now(),data:this.buildLeaderboard()};
    const {rows,summary}=this.cached.data;
    return {updatedAt:this.cached.at,page,total:rows.length,items:rows.slice(page*20,page*20+20).map(({balance,accounts,...row},i)=>({...row,rank:page*20+i+1})),summary};
  }
  buildLeaderboard() {
    const groups=new Map();for(const [key,a]of Object.entries(this.rooms.state.accounts)){const group=a.webOwner?'owner:'+a.webOwner:'account:'+key;if(!groups.has(group))groups.set(group,[]);groups.get(group).push([key,a]);}
    const stats=this.totals(),rows=[...groups].map(([group,accounts])=>this.aggregate(group.startsWith('owner:')?group.slice(6):group,accounts,stats));
    rows.sort((a,b)=>b.net-a.net||b.wins-a.wins||a.id.localeCompare(b.id));
    return {rows,summary:{players:rows.length,games:rows.reduce((n,r)=>n+r.games,0),net:rows.reduce((n,r)=>n+r.net,0)}};
  }
}
