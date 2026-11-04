import {createHash,createHmac} from 'node:crypto';
import {RoomError} from './rooms.mjs';
import {isRaceGroup} from './race-policy.mjs';
import {ownerOf,mergeOwners} from './identity-links.mjs';
const ensure=(ok,message,status=409)=>{if(!ok)throw new RoomError(message,status)};
const reference=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function linkCandidates(rooms){
  const uids=[...new Set(Object.values(rooms.state.accounts).map(a=>a.uid).filter(uid=>typeof uid==='string'&&/^[a-f0-9]{24}$/.test(uid)))].sort();
  return {uids,digest:createHash('sha256').update(JSON.stringify(uids)).digest('hex')};
}
export function syncQqWallet(web,user){
  const rooms=web.rooms,qq=user.qqSubject,licensed=user.scope==='qq-prediction',bound=licensed||user.boundAccount===true;
  ensure(licensed||user.scope==='qq-wallet'||user.scope==='qq-racing','QQ身份无效',403);
  if(!reference(qq)){
    ensure(licensed&&web.owned(user).length,'自动开户服务正在更新，请稍后重试',503);
    return {me:web.me(user),created:false,linked:0,synced:0};
  }
  ensure(bound||user.subject===qq,'QQ钱包身份不一致',403);
  if(bound)ensure(user.bindingDigest===linkCandidates(rooms).digest,'绑定数据已更新，请重试');
  ensure(user.gameUidRef===undefined||user.gameUidRef===null||reference(user.gameUidRef),'游戏身份凭据无效',403);
  return rooms.commit(()=>{
    const state=rooms.state,bindings=state.qqBindings??={},previous=bindings[qq];
    if(bound)ensure(!previous||previous===qq||ownerOf(state,previous)===ownerOf(state,user.subject),'QQ已关联其他游戏账号，请核对原绑定');
    const owner=ownerOf(state,bound?user.subject:previous??qq),identity={...user,subject:owner};
    let linked=0,synced=0;
    if(bound&&user.gameUidRef){
      ensure(/^[a-f0-9]{64}$/i.test(web.key),'自动绑定服务尚未配置',503);
      for(const account of Object.values(state.accounts)){
        if(typeof account.uid!=='string'||!/^[a-f0-9]{24}$/.test(account.uid))continue;
        const ref=createHmac('sha256',Buffer.from(web.key,'hex')).update('prediction-game-uid:'+account.uid).digest('hex');
        if(ref!==user.gameUidRef)continue;
        // A TP browser login may predate the guide service's canonical game
        // subject. Reconcile only those explicitly recorded TP owners after
        // the signed bridge proves this exact UID; legacy foreign owners fail closed.
        if(account.webOwner&&ownerOf(state,account.webOwner)!==owner&&account.webOwner!==qq&&Object.keys(state.browserAuth?.gameLinks??{}).some(s=>ownerOf(state,s)===ownerOf(state,account.webOwner)))mergeOwners(web,account.webOwner,owner);
        ensure(!account.webOwner||ownerOf(state,account.webOwner)===owner||account.webOwner===qq,'游戏马币账户已绑定其他身份，请核对原绑定');
        if(account.webOwner!==owner){account.webOwner=owner;linked++;}
      }
    }
    const sourceProfile=state.profiles?.[qq];
    if(bound)mergeOwners(web,qq,owner);
    state.profiles??={};
    let profile=state.profiles[owner]??={...sourceProfile,name:sourceProfile?.renamedAt?sourceProfile.name:user.name||sourceProfile?.name||'未绑定道友'};
    if(sourceProfile?.renamedAt&&!profile.renamedAt){profile.name=sourceProfile.name;profile.renamedAt=sourceProfile.renamedAt;}
    if(sourceProfile?.lastCheckInDay&&(!profile.lastCheckInDay||sourceProfile.lastCheckInDay>profile.lastCheckInDay))profile.lastCheckInDay=sourceProfile.lastCheckInDay;
    let owned=web.owned(identity),created=false;
    if(!owned.length){
      web.openAccount(identity);profile=state.profiles[owner];owned=web.owned(identity);state.accounts[web.playKey(identity)].qqCreated=true;created=true;
    }
    const available=owned.filter(([,a])=>!a.walletRedirect);
    const selected=available.find(([key])=>key===profile.playAccount);
    const gameAccounts=available.filter(([,a])=>a.uid&&!a.qqCreated).sort(([a,x],[b,y])=>y.balance-x.balance||a.localeCompare(b));
    let primary=selected??gameAccounts[0]??available[0];
    ensure(primary,'钱包同步记录需要核对');
    if(primary[1].qqCreated&&gameAccounts.length&&!rooms.hasPendingBets(primary[0]))primary=gameAccounts[0];
    profile.playAccount=primary[0];
    for(const [key,account]of owned){
      if(key===primary[0]||!account.qqCreated||rooms.hasPendingBets(key))continue;
      const amount=account.balance;
      ensure(Number.isSafeInteger(amount)&&amount>=0&&primary[1].balance<=1e12-amount,'钱包余额超过上限，已保留原账户');
      if(amount){
        state.walletEvents??={};const id='qq-sync:'+key+':'+primary[0];
        ensure(!state.walletEvents[id],'钱包同步记录需要核对');
        account.balance=0;primary[1].balance+=amount;synced+=amount;
        state.walletEvents[id]={kind:'qq-wallet-sync',owner,source:key,account:primary[0],amount,at:web.now()};
      }
      for(const field of ['transferIn','transferOut'])if(account[field]){
        ensure(Number.isSafeInteger(account[field])&&account[field]>0&&Number.isSafeInteger((primary[1][field]??0)+account[field]),'转账累计记录需要核对');
        primary[1][field]=(primary[1][field]??0)+account[field];account[field]=0;
      }
      account.walletRedirect=primary[0];
      if(profile.rewardAccount===key)profile.rewardAccount=primary[0];
    }
    bindings[qq]=owner;
    return {me:web.me(identity),created,linked,synced};
  });
}

export function transferQqCoins(web,sender,recipient,amount,operation){
  ensure(['qq-prediction','qq-racing'].includes(sender.scope),'请先注册观战再转账',403);
  ensure(isRaceGroup(recipient.groupId)&&recipient.groupId===sender.groupId&&['qq-wallet','qq-prediction','qq-racing'].includes(recipient.scope)&&reference(recipient.qqSubject),'收款人身份无效',403);
  ensure(Number.isSafeInteger(amount)&&amount>=1&&amount<=1e12,'转账金额须为1～1000000000000的整数',400);
  ensure(sender.qqSubject!==recipient.qqSubject,'不能给自己转账',400);
  return web.rooms.commit(()=>{
    syncQqWallet(web,sender);
    const identity=user=>({...user,subject:web.rooms.state.qqBindings?.[user.qqSubject]??user.subject});
    const source=web.playKey(identity(sender)),from=web.rooms.state.accounts[source];
    ensure(Number.isSafeInteger(from.balance)&&from.balance>=amount,'马币余额不足，转账未执行',400);
    const opened=syncQqWallet(web,recipient),account=web.playKey(identity(recipient)),to=web.rooms.state.accounts[account];
    ensure(source!==account&&identity(sender).subject!==identity(recipient).subject,'不能给同一账户转账',400);
    ensure(Number.isSafeInteger(to.balance)&&to.balance>=0&&to.balance<=1e12-amount,'收款人马币余额已达上限',400);
    for(const [wallet,field]of [[from,'transferOut'],[to,'transferIn']])ensure(Number.isSafeInteger(wallet[field]??0)&&(wallet[field]??0)>=0&&Number.isSafeInteger((wallet[field]??0)+amount),'转账累计记录无效',500);
    const events=web.rooms.state.walletEvents??={};ensure(!events[operation],'转账记录需要核对，请查询上次回执',409);
    from.balance-=amount;to.balance+=amount;
    from.transferOut=(from.transferOut??0)+amount;to.transferIn=(to.transferIn??0)+amount;
    events[operation]={kind:'qq-transfer',owner:identity(sender).subject,recipient:identity(recipient).subject,source,account,amount,sourceBalanceAfter:from.balance,balanceAfter:to.balance,at:web.now()};
    return {amount,balance:from.balance,recipientCreated:opened.created};
  });
}
