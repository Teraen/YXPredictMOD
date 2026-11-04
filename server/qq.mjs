import {createHash,timingSafeEqual} from 'node:crypto';
import {RoomError} from './rooms.mjs';
import {publicSummary} from './hourly.mjs';
import {publicPresentation} from './public-build.mjs';
import {syncQqWallet,transferQqCoins} from './qq-wallet.mjs';
import {isRaceGroup,normalizeRaceCommand} from './race-policy.mjs';
import {marketPresentation} from './market.mjs';

export function serviceAccess(header,key){
  if(typeof key!=='string'||key.length<32)throw new RoomError('此服务入口尚未启用',503);
  if(typeof header!=='string'||!timingSafeEqual(createHash('sha256').update(header).digest(),createHash('sha256').update('Bearer '+key).digest()))throw new RoomError('服务身份无效',401);
}
const ensure=(ok,message,status=400)=>{if(!ok)throw new RoomError(message,status)};
const help=[
  '注册 昵称：无需认证，钱包绑定QQ；已认证可只发“注册”。首次开户1000马币，已有钱包不重复赠送。',
  '余额（或马币）：查询现有马币。',
  '帮助：查看全部指令。',
  '签到：每天领200马币，与网站共用记录，北京时间0点刷新。',
  '转账 @某人 200：扣自己的200马币给对方；收款人未开户自动开通。',
  '走势：一张图查看八位角色的奖励倍率、竞猜总额和冠军奖励额度走势。',
  '观战：查看本场；选手 1：查看指定选手的牌阵与仙命，也支持完整昵称。',
  '竞猜 1 200 2 300：一条指令多笔竞猜，可重复选手。',
  '全猜 3：第1～12回合修炼阶段，将当前竞猜钱包的全部可用马币用于3号选手，不填写金额。首回合额外×3，该选手记录锁定至结算，不能减半、撤回或换目标。',
  '减半 1：减半；撤回 1：撤回；查单：核对最近扣款回执。',
  '改名 新昵称：修改上榜ID；绑定 SM-…：确认本人网页上的QQ绑定请求。',
  '全部指令均可带/不带“/”，也可先@机器人。只猜冠军，普通竞猜、减半和撤回从第10回合起截止；全猜从第13回合起截止。第一返锁定权益100%、第二25%、第三10%，包含投入。'
];
const instructions='群内竞猜：注册 昵称 → 走势 查看奖励倍率与参与记录 → 选手 1 查看牌阵 → 竞猜 1 200；全猜 1 使用全部可用马币，减半 1、撤回 1可调整参与记录。帮助 查看全部指令。';
const registrationHelp=['先起一个上榜ID：发送“注册 你的昵称”，例如“注册 小白”。无需游戏认证，钱包绑定你的QQ。','也支持 /注册 昵称，或先@机器人再发送。'];
export function isPredictionCommand(text){return normalizeRaceCommand(text)!==null;}
const ownsReceipt=(user,row)=>row.owner===user.subject||row.owner===user.qqSubject||row.qqOwner&&row.qqOwner===user.qqSubject;
function saveReceipt(web,user,operation,requestDigest,reply,code=null){
  const receipts=web.rooms.state.qqReceipts??={};
  for(const [id,r]of Object.entries(receipts))if(r.at<web.rooms.now()-90*86400000)delete receipts[id];
  ensure(Object.keys(receipts).length<100000,'群操作记录已达容量，请联系维护者',503);
  receipts[operation]={code,at:web.rooms.now(),owner:user.subject,qqOwner:user.qqSubject??null,acknowledged:false,requestDigest,result:reply};
}

export function qqCommand(web,hourly,user,body){
  body={...body,text:normalizeRaceCommand(body.text)};
  ensure(isRaceGroup(user.groupId)&&(user.scope==='qq-prediction'||user.scope==='qq-racing'||user.scope==='qq-wallet'&&['/马币','/马币帮助'].includes(body.text)),'请从观战群发起命令；旧钱包凭据只能查询，参与竞猜请重新注册，无需游戏认证',403);
  if(body.action==='ack'){
    ensure(['qq-prediction','qq-racing'].includes(user.scope),'旧钱包凭据只能查询',403);
    const receipt=web.rooms.state.qqReceipts?.[body.receiptId];ensure(receipt&&ownsReceipt(user,receipt),'操作回执不属于当前账号',403);
    return web.rooms.commit(()=>{receipt.acknowledged=true;return {acknowledged:true};});
  }
  ensure(isPredictionCommand(body.text),'无法识别观战命令');
  const [command,...args]=body.text.trim().split(/\s+/);
  if(command==='/赛马绑定'){
    ensure(web.browserAuth,'网页绑定服务正在更新',503);ensure(args.length===1,'用法：绑定 网页显示的SM码');
    web.browserAuth.confirmQq(user,args[0]);return {lines:['QQ身份已确认，请返回你刚才打开的观战网页完成登录或绑定。'],forward:false};
  }
  if(command==='/马币帮助'||command==='/赛马'&&args[0]==='帮助')return {lines:help,forward:false};
  const registered=user.scope==='qq-prediction'||!!web.rooms.state.qqRegistrations?.[user.qqSubject];
  if(command==='/赛马注册'){
    ensure(/^[a-f0-9]{64}$/.test(user.qqSubject??''),'注册身份暂不可用，请重新发送',403);
    const previous=web.rooms.state.qqRegistrations?.[user.qqSubject],bound=user.boundAccount===true||user.scope==='qq-prediction',given=args.join(' ').trim();
    if(!previous&&!bound&&!given)return {lines:registrationHelp,forward:false};
    const name=given||previous?.name||user.name;
    ensure(typeof name==='string'&&name.length>=1&&name.length<=24&&!/[\x00-\x1f\x7f]/.test(name),'上榜ID需为1至24字，不能包含控制字符');
    return web.rooms.commit(()=>{
      const opened=syncQqWallet(web,user),owner=web.rooms.state.qqBindings?.[user.qqSubject]??user.subject;
      web.rooms.state.profiles??={};const profile=web.rooms.state.profiles[owner]??={};
      if(!previous||given){profile.name=name;profile.renamedAt=web.now();}
      (web.rooms.state.qqRegistrations??={})[user.qqSubject]={at:previous?.at??web.now(),name:profile.name};
      const me=web.me({...user,subject:owner});
      return {lines:[`${previous?'你已注册观战':'观战注册成功'}，上榜ID：${me.name}。可用${me.playBalance}马币。${opened.created?'首次开户已赠1000马币。':'沿用已有钱包，不重复赠送开户马币。'}`,instructions,'只猜冠军：第1～9回合可普通竞猜，第1～12回合可全猜；第10回合起减半和撤回截止。参与时锁定奖励额度，最终第一返100%、第二25%、第三10%，返还包含投入。','减半/撤回按当前估值回收并扣3%；余额 查看马币，签到 每天领200，转账 @某人 200 转账。','所有指令都可省略“/”，也可先@机器人。之后认证游戏账号，再发 马币 即会核对并同步余额；未结算竞猜记录会保留，结算后再同步。','https://duma.kaigua.vip/'],forward:false};
    });
  }
  if(command==='/赛马改名'){
    ensure(registered,'请先发送“注册 昵称”');
    return web.rooms.commit(()=>{syncQqWallet(web,user);const identity={...user,subject:web.rooms.state.qqBindings?.[user.qqSubject]??user.subject},me=web.rename(identity,args.join(' '));if(web.rooms.state.qqRegistrations?.[user.qqSubject])web.rooms.state.qqRegistrations[user.qqSubject].name=me.name;return {lines:['上榜ID已修改为：'+me.name],forward:false};});
  }
  const unconfirmed=Object.entries(web.rooms.state.qqReceipts??{}).find(([,r])=>ownsReceipt(user,r)&&!r.acknowledged);
  if(command==='/赛马'&&args[0]==='查单'){
    const own=Object.entries(web.rooms.state.qqReceipts??{}).filter(([,r])=>ownsReceipt(user,r)).sort((a,b)=>b[1].at-a[1].at)[0];
    return own?{...own[1].result,receiptId:own[0]}:{lines:['暂无已确认的群内扣款记录。'],forward:false};
  }
  let operation,requestDigest,recipient;
  if(command==='/马币转账'){
    recipient=web.identity(body.recipientTicket);
    ensure(recipient.groupId===user.groupId&&isRaceGroup(recipient.groupId)&&['qq-wallet','qq-prediction','qq-racing'].includes(recipient.scope)&&/^[a-f0-9]{64}$/.test(recipient.qqSubject??''),'收款人身份无效',403);
  }
  if(['/下注','/全猜','/退半','/清仓','/马币签到','/马币转账'].includes(command))ensure(registered,'请先发送“注册 昵称”，无需游戏认证。');
  if(['/下注','/全猜','/退半','/清仓','/马币转账'].includes(command)){
    ensure(typeof body.messageId==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(body.messageId),'群消息标识无效');
    operation='qq-'+createHash('sha256').update((user.scope==='qq-racing'?user.qqSubject:user.subject)+':'+user.groupId+':'+body.messageId).digest('hex');
    requestDigest=createHash('sha256').update(recipient?JSON.stringify([body.text.trim(),recipient.qqSubject]):body.text.trim()).digest('hex');
    const legacy='qq-'+createHash('sha256').update(user.subject+':'+user.groupId+':'+body.messageId).digest('hex'),receipt=web.rooms.state.qqReceipts?.[operation]??web.rooms.state.qqReceipts?.[legacy];
    if(receipt){ensure(receipt.requestDigest===requestDigest,'重复消息的内容不一致',409);return receipt.result;}
    if(unconfirmed)return {...unconfirmed[1].result,receiptId:unconfirmed[0],lines:[...unconfirmed[1].result.lines,'这是上一笔的回执；本条新命令尚未执行。核对后可重新发送新命令。']};
    ensure(Number.isSafeInteger(body.messageAt)&&Math.abs(web.rooms.now()-body.messageAt)<=300000,'消息已过期，请重新发送命令',409);
  }
  if(command==='/马币签到'){
    ensure(args.length===0,'用法：签到');
    return web.rooms.commit(()=>{
      syncQqWallet(web,user);
      const result=web.checkIn({...user,subject:web.rooms.state.qqBindings?.[user.qqSubject]??user.subject});
      return {lines:[`${result.checkInReceipt.duplicate?'今天已签到，网站与群内不能重复领取。':'签到成功，已领取200马币。'}可用${result.playBalance}马币。`],forward:false};
    });
  }
  if(command==='/马币转账'){
    ensure(args.length===1&&/^[1-9][0-9]{0,12}$/.test(args[0]),'用法：转账 @某人 正整数金额');
    return web.rooms.commit(()=>{
      const result=transferQqCoins(web,user,recipient,Number(args[0]),operation);
      const reply={lines:[`转账成功：${result.amount}马币已到账。${result.recipientCreated?'已为收款人自动开通马币账户。':''}你的可用余额${result.balance}马币。`],forward:false,receiptId:operation};
      saveReceipt(web,user,operation,requestDigest,reply);return reply;
    });
  }
  if(command==='/马币'){
    ensure(args.length===0,'用法：/马币');
    if(user.scope==='qq-racing'&&!registered)return {lines:registrationHelp,forward:false};
    const result=syncQqWallet(web,user),me=result.me;
    return {lines:[`${result.created?'已自动开通马币账户。':result.linked||result.synced?'已自动同步游戏马币账户。':''}${me.name}：可用${me.playBalance}马币${me.accounts>1&&me.balance!==me.playBalance?`，名下合计${me.balance}马币`:''}，累计净变化${me.net}马币。${user.scope==='qq-wallet'?(user.boundAccount?'认证已到期，续期后可参与竞猜。':'尚未绑定游戏账号，暂不能竞猜；完成认证后再次发送 /马币 即可自动同步。'):''}`],forward:false};
  }
  const room=web.rooms.websiteRoom();ensure(room?.eventSlot,'目前没有整点竞猜专场',404);
  const view=web.watch(room);
  if(command==='/盘口'){
    ensure(args.length===0,'用法：走势');
    return {lines:['本局走势：各角色奖励倍率、竞猜总额及冠军奖励额度走势。'],market:marketPresentation(web.rooms,room),forward:true};
  }
  if(command==='/赛马')return {lines:[instructions,...publicSummary(view)],presentation:publicPresentation(view),forward:true};
  ensure(args.length>=1,'请提供选手编号1～8或完整昵称');
  const resolve=arg=>{
    if(/^[1-8]$/.test(arg))return Number(arg)-1;
    const found=view.players.map((p,i)=>p.name===arg?i:-1).filter(i=>i>=0);ensure(found.length===1,found.length?'昵称重复，请使用选手编号':'没有找到这位选手，请使用编号1～8');return found[0];
  };
  const index=resolve(args[0]);
  if(command==='/选手')return {lines:publicSummary(view,{player:index}),presentation:publicPresentation(view,{player:index}),forward:true};
  const allIn=command==='/全猜',kind=command==='/下注'||allIn?'buy':command==='/退半'?'half':'sell';
  ensure(allIn?args.length===1:kind==='buy'?args.length>=2&&args.length%2===0:args.length===1,allIn?'用法：全猜 选手编号或完整昵称，不填写金额':kind==='buy'?'用法：/竞猜 选手编号 马币数 [选手编号 马币数 …]':'用法：'+(kind==='half'?'减半':'撤回')+' 选手编号');
  ensure(kind!=='buy'||args.length<=64,'一次最多竞猜32笔');
  const orders=[];
  if(kind==='buy'&&!allIn)for(let at=0;at<args.length;at+=2){
    const stake=/^[1-9][0-9]{0,4}$/.test(args[at+1])?Number(args[at+1]):0;
    ensure(stake>=1&&stake<=10000,'每笔投入1～10000马币');orders.push({index:resolve(args[at]),stake});
  }else orders.push({index,stake:0});
  // One QQ/guide subject has one shared wallet selection. All mutations use the
  // existing room transaction and receipt path, including retries and settlement.
  return web.rooms.commit(()=>{
    if(kind==='buy')syncQqWallet(web,user);
    else ensure(web.owned(user).length,'尚无马币账户或竞猜记录');
    const key=web.playKey(user);
    if(allIn){
      ensure(web.rooms.isOpen(room,true),web.rooms.availability(room,true).message,409);
      const balance=web.rooms.account(key).balance;
      ensure(Number.isSafeInteger(balance)&&balance>0,'当前没有可用马币，无法全猜');
      orders[0].stake=balance;
    }
    if(!room.members.includes(key))web.play(user,{action:'join',code:room.code});
    const total=orders.reduce((sum,o)=>sum+o.stake,0);
    if(kind==='buy')ensure(total<=web.rooms.state.accounts[key].balance,'马币不足，本条共需'+total+'马币');
    const lines=[];let result;
    for(let at=0;at<orders.length;at++){
      const order=orders[at],previous=room.positions[key]?.[order.index]?.claim??0;
      result=web.play(user,{action:'trade',code:room.code,kind,player:order.index,rank:1,stake:order.stake,...(allIn?{allIn:true}:{}),version:room.version,operation:orders.length===1?operation:operation+'-'+(at+1)});
      const p=result.wallet.positions[order.index];
      lines.push(orders.length>1?`${order.index+1}号 ${view.players[order.index].name}：投入${order.stake}马币，本笔冠军锁定奖励${p.claim-previous}马币。`:`${view.players[index].name}：${kind==='buy'?'投入已确认':kind==='half'?'减半已确认':'撤回已确认'}${p?`，剩余冠军锁定奖励${p.claim}马币`:''}。可用${result.wallet.balance}马币。`);
    }
    if(allIn)lines.unshift(`全猜已确认：${index+1}号 ${view.players[index].name}，投入全部可用${total}马币。${web.rooms.allInMultiplier(room)===3?'首回合额外×3，该选手竞猜记录已锁定至结算，不能减半、撤回或换目标。':''}`);
    if(orders.length>1)lines.unshift(`批量竞猜已确认：${orders.length}笔，共投入${total}马币。可用${result.wallet.balance}马币。`);
    const reply={lines,forward:false,receiptId:operation};
    saveReceipt(web,user,operation,requestDigest,reply,room.code);
    return reply;
  });
}
