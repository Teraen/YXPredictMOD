export const RACE_GROUP='613486881',LEGACY_GROUP='599092307';
export const TRANSITION_SLOT=process.env.RACE_TRANSITION_SLOT??'2026110314';
export const isRaceGroup=group=>group===RACE_GROUP||group===LEGACY_GROUP;
export function normalizeRaceCommand(value){
 if(typeof value!=='string')return null;
 const input=value.trim(),match=/^\/?(注册|绑定|改名|帮助|签到|转账|余额|查单|全猜|竞猜|助威|观战注册|观战绑定|观战改名|观战|走势|减半|撤回|盘口|赛马注册|赛马绑定|赛马改名|赛马|马币帮助|马币签到|马币转账|马币|下注|选手|退半|清仓|赌马注册|赌马)(?=\s|$)/.exec(input);
 if(!match)return null;
 const aliases={注册:'赛马注册',绑定:'赛马绑定',改名:'赛马改名',帮助:'马币帮助',签到:'马币签到',转账:'马币转账',余额:'马币',查单:'赛马 查单',竞猜:'下注',助威:'下注',观战:'赛马',走势:'盘口',减半:'退半',撤回:'清仓',观战注册:'赛马注册',观战绑定:'赛马绑定',观战改名:'赛马改名'};
 const name=aliases[match[1]]??match[1].replace('赌马','赛马'),args=input.slice(match[0].length).trim();
 return '/'+name+(args?' '+args:'');
}
export function raceNoticeTargets(slot,kind){
 const targets=[{groupId:RACE_GROUP,notice:null}];
 if(typeof slot==='string'&&slot.slice(0,8)===TRANSITION_SLOT.slice(0,8)&&slot<=TRANSITION_SLOT){
  const notice=slot===TRANSITION_SLOT&&['start','settled'].includes(kind)?'迁群提醒：以后整点竞猜将在观战群 '+RACE_GROUP+' 进行。无需认证，加入后发送“注册 昵称”即可参与；钱包绑定QQ，之后认证游戏账号可同步马币。':null;
  targets.push({groupId:LEGACY_GROUP,notice});
 }
 return targets;
}
