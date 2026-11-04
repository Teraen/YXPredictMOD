import {createHash,createHmac,randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {RoomError} from './rooms.mjs';
import {ownerOf,mergeOwners} from './identity-links.mjs';
import {syncQqWallet} from './qq-wallet.mjs';
import {isRaceGroup} from './race-policy.mjs';
const scrypt=promisify(scryptCallback),hash=s=>createHash('sha256').update(s).digest('hex');
const ensure=(ok,msg,status=400)=>{if(!ok)throw new RoomError(msg,status)};
const secret=()=>randomBytes(32).toString('hex');
const cookies=req=>Object.fromEntries((req.headers.cookie??'').split(';').map(s=>s.trim().split('=')).filter(p=>p.length===2));
export class BrowserAuth{
 constructor(web,{secureCookies=true}={}){this.web=web;this.rooms=web.rooms;this.secure=secureCookies;web.browserAuth=this;this.limits=new Map();}
 data(){return this.rooms.state.browserAuth??={users:{},sessions:{},challenges:{}};}
 cookie(res,name,value,age){const old=res.getHeader('Set-Cookie')??[];res.setHeader('Set-Cookie',[...(Array.isArray(old)?old:[old]),name+'='+value+'; Path=/; HttpOnly; SameSite=Strict'+(this.secure?'; Secure':'')+'; Max-Age='+age]);}
 limit(ip,kind,max){const id=kind+':'+ip,t=this.web.now(),b=this.limits.get(id);if(this.limits.size>10000)for(const [k,v]of this.limits)if(t-v.at>3600000)this.limits.delete(k);if(!b||t-b.at>3600000)this.limits.set(id,{at:t,n:1});else ensure(++b.n<=max,'尝试过于频繁，请稍后再试',429);}
 session(req){const token=cookies(req).yx_race_session;if(!/^[a-f0-9]{64}$/.test(token??''))return null;const s=this.rooms.state.browserAuth?.sessions?.[hash(token)];if(!s||s.expires<=this.web.now())return null;return {subject:ownerOf(this.rooms.state,s.owner),name:s.name,scope:'browser',method:s.method};}
 require(req){const user=this.session(req);ensure(user,'请先登录',401);return user;}
 async derive(password,salt){ensure((this.hashing??0)<4,'登录服务繁忙，请稍后重试',429);this.hashing=(this.hashing??0)+1;try{return await scrypt(password,salt,64,{maxmem:64*1024*1024})}finally{this.hashing--;}}
 newSession(res,user,method){
  const token=secret(),t=this.web.now(),owner=ownerOf(this.rooms.state,user.subject);
  this.rooms.commit(()=>{const data=this.data();for(const [id,s]of Object.entries(data.sessions))if(s.expires<=t)delete data.sessions[id];const own=Object.entries(data.sessions).filter(([,s])=>ownerOf(this.rooms.state,s.owner)===owner).sort((a,b)=>b[1].created-a[1].created);for(const [id]of own.slice(7))delete data.sessions[id];ensure(Object.keys(data.sessions).length<50000,'登录服务繁忙',503);data.sessions[hash(token)]={owner,method,name:user.name,created:t,expires:t+30*86400000};});
  this.cookie(res,'yx_race_session',token,30*86400);return this.web.me({...user,subject:owner});
 }
 async password(req,res,body,ip,register){
  this.limit(ip,'password',40);if(register)this.limit(ip,'register',5);
  const login=typeof body.login==='string'?body.login.trim().toLowerCase():'';
  ensure(/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(login),'账号需为3～32位字母、数字或下划线');
  ensure(typeof body.password==='string'&&body.password.length>=8&&body.password.length<=128,'密码需为8～128位');
  if(register){
   const name=(body.name??body.login).trim();ensure(name.length>=1&&name.length<=24&&!/[\x00-\x1f\x7f]/.test(name),'昵称需为1～24字');
   ensure(!this.rooms.state.browserAuth?.users?.[login],'此账号已注册',409);
   const salt=secret(),derived=(await this.derive(body.password,salt)).toString('hex'),owner=secret();
   this.rooms.commit(()=>{const data=this.data();ensure(!data.users[login],'此账号已注册',409);ensure(Object.keys(data.users).length<10000,'注册名额已满',503);data.users[login]={owner,salt,password:derived,created:this.web.now()};this.web.openAccount({subject:owner,name});});
   return this.newSession(res,{subject:owner,name},'password');
  }
  const c=this.rooms.state.browserAuth?.users?.[login],salt=c?.salt??'unregistered-account';
  const derived=await this.derive(body.password,salt);
  ensure(c&&timingSafeEqual(derived,Buffer.from(c.password,'hex')),'账号或密码不正确',401);
  return this.newSession(res,{subject:c.owner,name:this.web.profile({subject:c.owner}).name},'password');
 }
 game(req,res,body){
  const hashCode=this.web.codeHash(body.code),row=this.web.codes.get(hashCode);
  ensure(row&&row.expires>this.web.now(),'绑定码已过期或已使用');
  const account=this.rooms.state.accounts[row.key];ensure(account,'游戏账户不存在');
  const current=this.session(req),target=account.webOwner??current?.subject??secret();
  const me=this.rooms.commit(()=>{
   if(current)mergeOwners(this.web,current.subject,target);
   account.webOwner=ownerOf(this.rooms.state,target);
   this.rooms.state.profiles??={};const p=this.rooms.state.profiles[account.webOwner]??={name:account.name};p.playAccount=row.key;
   (this.data().gameLinks??={})[account.webOwner]=true;
   return this.newSession(res,{subject:account.webOwner,name:account.name},'game');
  });
  this.web.codes.delete(hashCode);return me;
 }
 challenge(req,res,body,ip){
  this.limit(ip,'qq',20);ensure(/^[a-f0-9]{64}$/i.test(this.web.key),'QQ绑定服务尚未开启',503);
  ensure(typeof body.qq==='string'&&/^[0-9]{4,15}$/.test(body.qq),'请输入QQ号');
  const code='SM-'+randomBytes(5).toString('hex').toUpperCase(),token=secret(),t=this.web.now();
  const expected=createHmac('sha256',Buffer.from(this.web.key,'hex')).update('prediction-qq:'+body.qq).digest('hex');
  this.rooms.commit(()=>{const data=this.data();for(const [id,c]of Object.entries(data.challenges))if(c.expires<=t)delete data.challenges[id];const old=cookies(req).yx_race_challenge;if(old)delete data.challenges[hash(old)];ensure(Object.keys(data.challenges).length<10000,'绑定请求过多',429);data.challenges[hash(token)]={codeHash:hash(code),expected,owner:this.session(req)?.subject??null,expires:t+300000};});
  this.cookie(res,'yx_race_challenge',token,300);return {command:'绑定 '+code,expiresAt:t+300000,group:'613486881'};
 }
 confirmQq(user,code){
  ensure(isRaceGroup(user.groupId)&&['qq-racing','qq-prediction'].includes(user.scope),'请在观战群操作',403);
  ensure(typeof code==='string'&&/^SM-[A-F0-9]{10}$/.test(code.toUpperCase()),'请复制网页显示的完整绑定指令');
  const c=Object.values(this.rooms.state.browserAuth?.challenges??{}).find(c=>c.codeHash===hash(code.toUpperCase())&&c.expires>this.web.now());
  ensure(c&&c.expected===user.qqSubject,'绑定请求不存在或QQ不符，请在网页重新获取');
  return this.rooms.commit(()=>{if(c.confirmed)return; c.confirmed={...user};});
 }
 finishQq(req,res){
  const token=cookies(req).yx_race_challenge,c=this.rooms.state.browserAuth?.challenges?.[hash(token??'')];
  ensure(c&&c.expires>this.web.now(),'绑定请求已过期，请重新获取');
  if(!c.confirmed)return {pending:true};
  const current=this.session(req);ensure((c.owner===null&&!current)||(current&&ownerOf(this.rooms.state,c.owner)===current.subject),'登录状态已变化，请重新绑定',409);
  const me=this.rooms.commit(()=>{
   const proof=c.confirmed,owner=ownerOf(this.rooms.state,this.rooms.state.qqBindings?.[proof.qqSubject]??proof.subject);
   if(current)ensure(!Object.entries(this.rooms.state.qqBindings??{}).some(([q,o])=>q!==proof.qqSubject&&ownerOf(this.rooms.state,o)===current.subject),'此账户已绑定其他QQ，请使用原QQ登录',409);
   if(current)mergeOwners(this.web,current.subject,owner);
   syncQqWallet(this.web,proof);
   const subject=ownerOf(this.rooms.state,this.rooms.state.qqBindings[proof.qqSubject]);
   const p=this.web.profile({subject}),name=proof.name==='未绑定道友'?'观战道友':proof.name;
   if(!p.name||p.name==='未绑定道友'){this.rooms.state.profiles[subject].name=name;}
   (this.rooms.state.qqRegistrations??={})[proof.qqSubject]??={at:this.web.now(),name:this.web.profile({subject}).name};
   delete this.data().challenges[hash(token)];return this.newSession(res,{subject,name},'qq');
  });
  this.cookie(res,'yx_race_challenge','',0);return {pending:false,me};
 }
 links(user){const owner=ownerOf(this.rooms.state,user.subject),data=this.rooms.state.browserAuth;return {qq:Object.values(this.rooms.state.qqBindings??{}).some(s=>ownerOf(this.rooms.state,s)===owner),game:Object.keys(data?.gameLinks??{}).some(s=>ownerOf(this.rooms.state,s)===owner)||this.web.owned(user).some(([,a])=>a.uid),password:Object.values(data?.users??{}).some(c=>ownerOf(this.rooms.state,c.owner)===owner)};}
 logout(req,res){const token=cookies(req).yx_race_session;if(token)this.rooms.commit(()=>{delete this.data().sessions[hash(token)]});this.cookie(res,'yx_race_session','',0);return {loggedOut:true};}
 async handle(req,res,body,ip){
  switch(req.url){
   case '/session/register':return this.password(req,res,body,ip,true);
   case '/session/login':return this.password(req,res,body,ip,false);
   case '/session/game':this.limit(ip,'game',40);return this.game(req,res,body);
   case '/session/qq/start':return this.challenge(req,res,body,ip);
   case '/session/qq/finish':return this.finishQq(req,res);
   case '/session/logout':return this.logout(req,res);
   default:throw new RoomError('登录接口不存在',404);
  }
 }
}
