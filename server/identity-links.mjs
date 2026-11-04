import {RoomError} from './rooms.mjs';

export function ownerOf(state,subject){
 const seen=new Set();
 while(state.identityAliases?.[subject]){
  if(seen.has(subject)||seen.size>=32)throw new RoomError('账户关联记录需要核对',409);
  seen.add(subject);subject=state.identityAliases[subject];
 }
 return subject;
}
// Move ownership only. Existing position keys, locked claims and receipts remain intact.
// The user can select each original wallet; never silently abandon an active position.
export function mergeOwners(web,source,target){
 const s=web.rooms.state;source=ownerOf(s,source);target=ownerOf(s,target);
 if(source===target)return target;
 const credentials=Object.values(s.browserAuth?.users??{});
 if(credentials.some(c=>ownerOf(s,c.owner)===source)&&credentials.some(c=>ownerOf(s,c.owner)===target))throw new RoomError('两个账户各有独立登录账号，请先使用原账号登录',409);
 const qqs=Object.entries(s.qqBindings??{}),a=qqs.filter(([,o])=>ownerOf(s,o)===source),b=qqs.filter(([,o])=>ownerOf(s,o)===target);
 if(a.length&&b.length&&a.some(([q])=>!b.some(([p])=>p===q)))throw new RoomError('两个账户已分别绑定QQ，请核对原绑定',409);
 s.profiles??={};const from=s.profiles[source]??{},to=s.profiles[target]??{};
 const p={...from,...to};
 if(from.renamedAt&&!to.renamedAt){p.name=from.name;p.renamedAt=from.renamedAt;}
 p.lastCheckInDay=[from.lastCheckInDay,to.lastCheckInDay].filter(Boolean).sort().at(-1);
 s.profiles[target]=p;
 for(const account of Object.values(s.accounts))if(account.webOwner&&ownerOf(s,account.webOwner)===source)account.webOwner=target;
 for(const [q,o]of qqs)if(ownerOf(s,o)===source)s.qqBindings[q]=target;
 (s.identityAliases??={})[source]=target;
 return target;
}
