import {RoomError} from './rooms.mjs';
const valid=(ok)=>{if(!ok)throw new RoomError('公开角色或仙命资料格式无效')};
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const text=s=>typeof s==='string'&&s.length>0&&s.length<=80&&!/[\x00-\x1f\x7f]/.test(s);
const choice=p=>{valid(p&&integer(p.id,1,2147483647)&&text(p.name));return {id:p.id,name:p.name};};
export function publicBuild(value,round=100000){
  if(value===null)return null;
  valid(value&&integer(value.characterId,1,2147483647)&&integer(value.careerId,0,32)&&integer(value.sectId,0,32)&&integer(value.realmId,0,16));
  for(const key of ['characterName','careerName','sectName','realmName'])valid(text(value[key]));
  for(const key of ['talents','baijia','fates'])valid(Array.isArray(value[key])&&value[key].length<=32);
  valid(integer(value.selectionRound,0,round)&&typeof value.selectionsKnown==='boolean');
  const cards=value.cards??null,cardNames=value.cardNames??null;
  valid(cards===null&&cardNames===null||Array.isArray(cards)&&cards.length<=8&&cards.every(id=>integer(id,0,2147483647))&&Array.isArray(cardNames)&&cardNames.length===cards.length&&cardNames.every(text));
  return {characterId:value.characterId,characterName:value.characterName,careerId:value.careerId,careerName:value.careerName,
    sectId:value.sectId,sectName:value.sectName,realmId:value.realmId,realmName:value.realmName,
    talents:value.talents.map(choice),baijia:value.baijia.map(choice),fates:value.fates.map(choice),resonance:value.resonance===null?null:choice(value.resonance),
    selectionRound:value.selectionRound,selectionsKnown:value.selectionsKnown,cards:cards&&[...cards],cardNames:cardNames&&[...cardNames]};
}
export function publicPresentation(view,{round=view.round,player=null,noticeType='query'}={}){
  const frame=view.frames?.find(f=>f.round===round),after=view.frames?.find(f=>f.round===round+1);
  const available=(view.battles??[]).filter(b=>b.round<=round&&(player===null||b.first===player||b.second===player));
  const battleRound=available.some(b=>b.round===round)?round:Math.max(0,...available.map(b=>b.round));
  const battles=available.filter(b=>b.round===battleRound);
  const eligibleQuote=p=>!view.ended&&!view.settled&&!p.rank&&p.active!==false&&!(p.state&&p.state.life<=0)&&integer(p.quoteRate,1,575000);
  const quoted=view.players.filter(eligibleQuote).map(p=>p.quoteRate);
  const quoteRange=quoted.length?{minimumRate:Math.min(...quoted),maximumRate:Math.max(...quoted)}:null;
  const closingWarning=view.ended||view.settled?null:view.round===12?'提醒：下回合（第13回合）起全猜截止，这是最后一个可全猜回合。':view.round===9&&!view.tradingClosed?'提醒：下回合（第10回合）起普通竞猜、减半和撤回截止；全猜可用至第12回合。':null;
  const players=(player===null?view.players.map((_,i)=>i):[player]).map(index=>{
    const p=view.players[index],build=[after?.builds?.[index],frame?.builds?.[index],p.build,...(view.buildHistory?.[index]??[])].filter(b=>b&&b.selectionRound<=round).sort((a,b)=>b.selectionRound-a.selectionRound)[0]??null;
    const battle=available.filter(b=>b.first===index&&!b.firstMirror||b.second===index&&!b.secondMirror).sort((a,z)=>z.round-a.round)[0],side=battle?.first===index?'first':'second';
    const battleBoard=battle&&battle[side+'Cards']?{round:battle.round,cards:battle[side+'Cards'],names:battle[side+'Names']??battle[side+'Cards'].map(id=>id?'未知牌':'空位')}:null;
    const buildBoard=build?.cards&&build.selectionRound>0&&build.selectionRound<=round?{round:build.selectionRound,cards:build.cards,names:build.cardNames}:null;
    const board=buildBoard&&(!battleBoard||buildBoard.round>battleBoard.round)?buildBoard:battleBoard;
    const eliminatedRound=integer(p.exitRound,0,100000)?p.exitRound:p.state&&p.state.life<=0?p.state.wins+p.state.losses:null;
    return {index,name:p.name,horseTitle:p.horseTitle,rank:round===view.round?p.rank:after?.ranks?.[index]??frame?.ranks?.[index]??0,
      state:after?.states?.[index]??frame?.states?.[index]??(round===view.round?p.state:null),quoteRate:eligibleQuote(p)?p.quoteRate:0,build,board,showBoard:noticeType==='query'||eliminatedRound===null||round<=eliminatedRound};
  });
  const finalReport=view.settled&&(noticeType==='settled'||noticeType==='query'&&round===view.round);
  return structuredClone({kind:'duma-public-v1',noticeType,code:view.code,round,settled:finalReport,tradingClosed:view.tradingClosed,
    quoteRound:view.round,quoteRange,closingWarning,bettingOpen:!!view.open&&!view.tradingClosed&&view.round<10&&!view.ended&&!view.settled,allInOpen:!!view.allInOpen&&!view.ended&&!view.settled&&view.round<13,allInMultiplier:view.allInMultiplier??1,
    bettingState:view.availability?.state??(view.open?'open':view.tradingClosed?'closed':'waiting'),settlement:finalReport?view.settlement??null:null,players,
    battles:battles.map(b=>({...b,firstName:view.players[b.first].name,secondName:view.players[b.second].name,firstCharacterId:view.players[b.first].build?.characterId??0,secondCharacterId:view.players[b.second].build?.characterId??0,winnerName:b.winner===null?null:view.players[b.winner].name}))});
}
export function publicReportReady(report,expected=null){
  const known=s=>typeof s==='string'&&s.length>0&&!/待同步|待识别|未知牌/.test(s),start=report.noticeType==='start';
  if(report.players.length!==8)return false;
  // Final cash accounting is authoritative independently of the last battle pictures.
  if(report.noticeType==='settled')return report.settled&&new Set(report.players.map(p=>p.rank)).size===8&&report.players.every(p=>integer(p.rank,1,8))&&!!report.settlement;
  for(const p of report.players){
    const b=p.build;if(!b||![p.name,p.horseTitle,b.characterName,b.sectName,b.realmName,b.careerName].every(known))return false;
    if([...b.talents,...b.baijia,...b.fates,...(b.resonance?[b.resonance]:[])].some(c=>!known(c.name)))return false;
    if(start)continue;
    const required=expected?expected[p.index]:p.state?.life>0;
    if((required||p.state&&p.state.wins+p.state.losses>0)&&(!p.board||p.board.names.some(s=>!known(s))))return false;
    if(required&&(p.board.round!==report.round||b.selectionRound<report.round))return false;
  }
  if(start)return true;
  const covered=new Set();for(const b of report.battles){
    if(b.round!==report.round||b.winner===null&&!b.resultComplete||b.lifeDamage==null)return false;
    if(!b.firstMirror)covered.add(b.first);if(!b.secondMirror)covered.add(b.second);
  }
  return report.players.every(p=>!(expected?expected[p.index]:p.state?.life>0)||covered.has(p.index));
}
export function buildLines(build){
  if(!build)return ['角色、职业及仙命资料待同步'];
  const names=rows=>rows.map(p=>p.name).join('、'),lines=[`角色：${build.characterName} · ${build.sectName} · ${build.realmName} · 副职：${build.careerName}`,
    '仙命：'+(names(build.talents)||'暂无公开仙命'),
    `百家仙命${build.selectionRound?'（公开至第'+build.selectionRound+'回合）':''}：`+(names(build.baijia)||(build.selectionsKnown?'暂无公开选取':'等待公开'))];
  if(build.resonance)lines.push('共鸣仙命：'+build.resonance.name);
  if(build.fates.length)lines.push('天衍仙命：'+names(build.fates));
  return lines;
}
