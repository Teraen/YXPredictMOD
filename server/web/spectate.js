/* Browser spectating uses the room engine; no game client or game credentials here. */
(()=>{
const P=window.Prediction,$=id=>document.getElementById(id);
let page=0,room=null,wallet=null,selected=0,joined=false,visible='hall',polling=false,busy=false,pending=null,roundChoice='live';
try{pending=JSON.parse(sessionStorage.getItem('prediction-pending-order')||'null')}catch{}
const fmt=n=>Number(n).toLocaleString('zh-CN'),rate=n=>(n/10000).toFixed(2)+'×';
function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e}
function art(kind,id,alt,cls=''){const img=node('img',undefined,cls);img.src='/art/'+kind+'/'+id+'.png';img.alt=alt;img.loading='lazy';img.onerror=()=>{img.hidden=true};return img}
function cardArt(id,name){const c=node('div',undefined,'native-card'+(id?'':' empty-card'));c.title=name||'空位';if(id)c.append(art('cards',id,name||'卡牌'));c.append(node('span',id?name||'卡牌':'空位'));return c}
function inspector(p){
 const root=$('character-inspector');root.replaceChildren();const b=p.build,main=node('div',undefined,'character-main');main.append(node('h2',p.name,'character-title'),node('p',b?[b.characterName,b.careerName,b.realmName].join(' · '):'角色资料待同步','character-info'));
 const orbit=node('div',undefined,'talent-orbit');if(b)orbit.append(art('characters',b.characterId,b.characterName,'character-portrait'));
 for(const t of (b?.talents??[]).slice(0,5)){const item=node('div',undefined,'orbit-talent');item.title=t.name;item.append(art('talents',t.id,t.name),node('span',t.name));orbit.append(item)}main.append(orbit);
 const life=node('div',undefined,'inspector-life');for(const [v,label]of [[p.state?.life??'—','命元'],[p.state?p.state.wins+' / '+p.state.losses:'—','胜 / 负']]){const n=node('div');n.append(node('strong',String(v)),node('small',label));life.append(n)}main.append(life);root.append(main);
 const choices=(title,values,kind)=>{const section=node('section',undefined,'inspector-block');section.append(node('h3',title));const list=node('div',undefined,'build-choices');for(const t of values??[]){const icon=node('div',undefined,'choice-icon');icon.title=t.name;icon.append(art(kind,t.id,t.name),node('span',t.name));list.append(icon)}if(!list.children.length)list.append(node('small','暂无公开选取'));section.append(list);root.append(section)};
 choices('百家仙命',b?.baijia,'baijia');if(b?.resonance)choices('共鸣仙命',[b.resonance],'resonances');if(b?.fates?.length)choices('天衍仙命',b.fates,'fates');
 const last=(room.battles??[]).filter(x=>(x.first===selected&&!x.firstMirror)||(x.second===selected&&!x.secondMirror)).sort((a,b)=>b.round-a.round)[0],side=last?.first===selected?'first':'second';
 const cards=b?.cards??last?.[side+'Cards'],names=b?.cardNames??last?.[side+'Names'];const deck=node('section',undefined,'inspector-block');deck.append(node('h3','公开牌阵'));const board=node('div',undefined,'selected-deck');if(cards)for(let i=0;i<8;i++)board.append(cardArt(cards[i]??0,names?.[i]));else board.append(node('small','等待牌阵同步'));deck.append(board);root.append(deck);
}
function setPending(value){pending=value;if(value)sessionStorage.setItem('prediction-pending-order',JSON.stringify(value));else sessionStorage.removeItem('prediction-pending-order')}
async function rooms(auto=false){
 $('rooms-refresh').disabled=true;
 try{const data=await P.api('/web/rooms');$('rooms-count').textContent=data.total?'当前公开对局':'等待下一场公开对局';$('room-list').replaceChildren();
  if(!data.rooms.length){const e=node('div',undefined,'hall-empty');e.append(node('strong','暂无正在进行的公开对局'),node('p','整点专场开始后会自动显示。'));$('room-list').append(e)}
  for(const r of data.rooms){const c=node('article',undefined,'room-card'),info=node('div');info.append(node('h2',r.hostName+' · 第'+r.round+'回合'),node('p',r.names.join(' · ')),node('p','#'+r.code+' · '+(r.open?'修炼阶段，可竞猜':'观战中')));const button=node('button','进入房间','primary');button.onclick=()=>void enter(r.code);c.append(info,button);$('room-list').append(c)}
  if(auto&&data.rooms[0])await enter(data.rooms[0].code);
 }catch(e){P.note(e.message);$('rooms-count').textContent='读取失败，请刷新'}finally{$('rooms-refresh').disabled=false}
}
async function enter(code){
 if(busy)return;joined=false;wallet=null;selected=0;roundChoice='live';
 try{room=await P.api('/web/room?code='+encodeURIComponent(code));P.tab('watch');draw();if(window.predictionMe?.linked)await join()}
 catch(e){if(window.predictionMe?.linked){try{const data=await P.api('/web/play',{privateRequest:true,body:{action:'join',code}});accept(data);P.tab('watch');return}catch(inner){P.note(inner.message);return}}P.note(e.message);if(!window.predictionMe)void P.openLogin()}
}
function accept(data){room=data.room;wallet=data.wallet;joined=true;if(data.me)P.renderMe(data.me);draw()}
async function join(){
 if(!window.predictionMe){await P.openLogin();return}
 if(!window.predictionMe.linked){const opened=await P.api('/web/play',{privateRequest:true,body:{action:'openAccount'}});P.renderMe(opened.me)}
 if(!room)return;try{accept(await P.api('/web/play',{privateRequest:true,body:{action:'join',code:room.code}}))}catch(e){P.note(e.message)}
}
const stakes=Array(8).fill('10');
function draw(){
 if(!room)return;
 $('watch-code').textContent='仙府观战 · #'+room.code;$('watch-title').textContent=(room.eventSlot?'整点竞猜':'天机竞猜')+' · 第'+room.round+'回合';
 $('watch-live').textContent=room.availability?.message??(room.settled?'本局已结算':room.open?'修炼阶段 · 可竞猜':'观战中 · 暂停操作');
 $('watch-rule').textContent='只猜冠军 · 第10回合竞猜截止'+(room.bonusBps>10000?' · 整点场 ×1.15':'');
 const focus=document.activeElement,editing=focus?.classList.contains('row-stake'),idx=editing?Number(focus.dataset.player):-1;
 if(!editing){$('horse-grid').replaceChildren();room.players.forEach((p,i)=>{
  const position=wallet?.positions[i],row=node('article',undefined,'horse-row c'+i+(i===selected?' selected':'')+(!p.active||p.rank?' eliminated':''));row.setAttribute('role','listitem');
  row.onclick=()=>{selected=i;$('bet-amount').value=stakes[i];draw()};const who=node('div',undefined,'racer');if(p.build)who.append(art('characters',p.build.characterId,p.build.characterName));const info=node('div');info.append(node('span',(i+1)+'. '+p.name,'name'),node('small',p.rank?'第'+p.rank+'名':p.active?'命元 '+(p.state?.life??'—'):'已退出'));who.append(info);
  const tier=node('div',undefined,'horse-tier'),tiers=['特等马','上等马','中等马','牛马','海马','机械马','黑马'];if(tiers.includes(p.horseTitle))tier.append(art('ui','horse-'+tiers.indexOf(p.horseTitle),''));tier.append(node('span',p.horseTitle||'待同步'));
  const quote=node('div',p.quoteRate?rate(p.quoteRate):'—','row-rate');quote.append(node('small',p.rank||!p.active?'已淘汰':room.round>=10?'竞猜截止参考':p.baseRate?'基'+(p.baseRate/10000).toFixed(2)+'×系'+(p.factor/10000).toFixed(2):'冠军奖励倍率'));
  const amount=node('input',undefined,'row-stake');amount.type='number';amount.min='1';amount.max='10000';amount.step='1';amount.inputMode='numeric';amount.value=stakes[i];amount.dataset.player=i;amount.setAttribute('aria-label',p.name+' 投入马币');amount.onclick=e=>e.stopPropagation();amount.oninput=()=>{stakes[i]=amount.value;if(selected===i){$('bet-amount').value=amount.value;drawBet()}};
  const actions=node('div',undefined,'row-actions');for(const [label,kind,cls]of [['追加竞猜','buy','primary'],['减半','half','caution'],['撤回','sell','danger']]){const button=node('button',label,cls);button.setAttribute('aria-label',p.name+' '+label);button.disabled=busy||!!pending||!room.open||!p.active||!!p.rank||room.rules!==3||(kind!=='buy'&&(!joined||!position||position.resolved||position.cashoutLocked||wallet?.forfeited));button.onclick=e=>{e.stopPropagation();selected=i;$('bet-amount').value=stakes[i];if(!joined)void join();else void trade(kind)};actions.append(button)}
  const held=node('div',position?'已投 '+fmt(position.stake):'暂无预测','row-position');if(position)held.append(node('small','冠军返 '+fmt(position.claim)+(position.resolved?' · 已结算':position.cashoutLocked?' · 已锁定至结算':'')));row.append(who,tier,quote,amount,actions,held);$('horse-grid').append(row);
 });}
 inspector(room.players[selected]);drawBattles();drawChart();drawNotes();drawBet();
}
function drawBattles(){
 const rounds=[...new Set((room.battles||[]).map(b=>b.round))].sort((a,b)=>b-a),select=$('battle-round');select.replaceChildren();const follow=node('option','跟随最新回合');follow.value='live';select.append(follow);
 for(const number of rounds){const option=node('option','第 '+number+' 回合');option.value=String(number);select.append(option)}
 if(roundChoice!=='live'&&!rounds.includes(Number(roundChoice)))roundChoice='live';select.value=roundChoice;
 const chosen=roundChoice==='live'?rounds[0]:Number(roundChoice),battles=(room.battles||[]).filter(b=>b.round===chosen),target=$('battle-tables');target.replaceChildren();
 $('battle-summary').textContent=battles.length?'第 '+chosen+' 回合 · 已同步 '+battles.length+' 场对战':'等待观战端同步牌桌与战果。';
 if(!battles.length){target.append(node('p','战斗数据到达后会自动显示，可持续跟随，也可回看已同步回合。','chart-empty'));return}
 for(const battle of battles){const table=node('article',undefined,'duel-table'),winner=battle.winner;
  const title=node('div',undefined,'duel-title');title.append(node('span',room.players[battle.first].name+(battle.firstMirror?'（镜像）':'')),node('span',winner===null?'胜负待确认':room.players[winner].name+' 胜','duel-result'),node('span',room.players[battle.second].name+(battle.secondMirror?'（镜像）':'')));table.append(title);
  for(const side of ['first','second']){const line=node('div',undefined,'duel-side'),who=battle[side],cards=battle[side+'Cards'],names=battle[side+'Names'];
   const name=node('div',undefined,'duel-player');name.append(node('strong',room.players[who].name),node('small',(battle[side+'Mirror']?'镜像 · ':'')+'战后命元 '+battle[side+'Life']+((battle[side+'LifeBefore']??null)!==null?' · 扣命 '+Math.max(0,battle[side+'LifeBefore']-battle[side+'Life']):'')));line.append(name);
   const board=node('div',undefined,'card-board');if(cards===null){board.append(node('p','该方公开牌阵尚未同步','muted'))}else for(let i=0;i<8;i++)board.append(cardArt(cards[i]??0,names?.[i]));line.append(board);table.append(line);
  }target.append(table);
 }
}
function drawChart(){
 const target=$('life-chart');target.replaceChildren();$('chart-legend').replaceChildren();
 const frames=room.frames.filter(f=>f.states.some(Boolean));
 if(!frames.length){target.append(node('p','等待房主同步命元数据。旧版本房主仍可提供奖励倍率与竞猜。','chart-empty'));return}
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 800 240');svg.setAttribute('role','img');svg.setAttribute('aria-label','八位选手的命元随回合变化');
 const max=Math.max(100,...frames.flatMap(f=>f.states.filter(Boolean).map(s=>s.life))),minRound=frames[0].round,maxRound=Math.max(minRound+1,frames.at(-1).round);
 for(let i=0;i<5;i++){const y=20+i*46,line=document.createElementNS(ns,'line');line.setAttribute('x1','40');line.setAttribute('x2','780');line.setAttribute('y1',y);line.setAttribute('y2',y);line.setAttribute('class','chart-grid');svg.append(line);const label=document.createElementNS(ns,'text');label.setAttribute('x','4');label.setAttribute('y',y+4);label.textContent=Math.round(max*(1-i/4));svg.append(label)}
 room.players.forEach((p,i)=>{let segments=[],segment=[];for(const frame of frames){const state=frame.states[i];if(!state){if(segment.length)segments.push(segment);segment=[];continue}segment.push((40+(frame.round-minRound)/(maxRound-minRound)*740).toFixed(1)+','+(204-Math.max(0,state.life)/max*184).toFixed(1))}if(segment.length)segments.push(segment);for(const points of segments){const line=document.createElementNS(ns,'polyline');line.setAttribute('points',points.join(' '));line.setAttribute('class','life-line c'+i);svg.append(line)}const label=node('span',p.name,'legend-item c'+i);$('chart-legend').append(label)});
 for(const [round,x]of [[minRound,40],[frames.at(-1).round,730]]){const label=document.createElementNS(ns,'text');label.setAttribute('x',x);label.setAttribute('y','233');label.textContent='第'+round+'回合';svg.append(label)}target.append(svg);
}
function drawNotes(){
 const list=$('round-notes');list.replaceChildren();const last=room.frames.at(-1),prev=room.frames.at(-2);
 room.players.forEach((p,i)=>{if(p.rank)list.append(node('li',p.name+' 已确定第 '+p.rank+' 名'));else if(last?.states[i]){const state=last.states[i],before=prev?.states[i];list.append(node('li',p.name+'：命元 '+(before?before.life+' → ':'')+state.life+'，累计 '+state.wins+'胜 '+state.losses+'负'))}});
 if(!list.children.length)list.append(node('li','尚未收到本轮公开战况。'));
}
function drawBet(){
 const p=room.players[selected],position=wallet?.positions[selected],amount=Number($('bet-amount').value);
 $('selected-horse').textContent=p.name;$('play-balance').textContent=wallet?fmt(wallet.balance):window.predictionMe?.playBalance!=null?fmt(window.predictionMe.playBalance):'登录后查看';$('play-account').textContent=wallet?'当前账户：'+wallet.name:'';
 $('watch-join').hidden=joined;$('watch-join').textContent=!window.predictionMe?'登录并入席':window.predictionMe.linked?'加入此房间':'开通马币后入席';$('bet-controls').hidden=!joined;
 $('bet-quote').textContent=p.quoteRate?rate(p.quoteRate):'—';const claim=Number.isSafeInteger(amount)&&amount>0?Math.floor(amount*p.quoteRate/10000):0;
 $('bet-return').textContent=fmt(claim)+' 马币';$('bet-partial').textContent=fmt(Math.floor(claim/4))+' / '+fmt(Math.floor(claim/10));
 $('held-position').textContent=position?fmt(position.stake)+' 马币':'暂无投入';$('held-claim').textContent=position?(wallet?.forfeited?'已离场放弃，不再返还':'锁定冠军奖励 '+fmt(position.claim??0)+' 马币'+(position.resolved?' · 已结算':position.cashoutLocked?' · 已锁定至结算':'')):'';
 let reason=wallet?.forfeited?'已离场放弃本局竞猜记录，仅可查看，不再返还。':!room.open?(room.availability?.message??(room.settled?'本局已结算，返还已进入账户。':room.ended?'本局已结束，等待最终战果确认。':(room.round>=10||room.tradingClosed)?'第10回合起竞猜已截止，等待本局结算。':!room.fresh?'机器人同步正在恢复，已暂停操作。':'等待下一修炼阶段开放操作。')):!p.active||p.rank?'这位选手已退出或确定名次，无法继续投入。':room.rules!==3?'旧房间仅保留原有竞猜记录，请加入新的冠军预测房间。':'';
 if(pending)reason='上笔操作尚待确认，请先确认结果，避免重复投入。';$('bet-reason').textContent=reason;$('bet-retry').hidden=!pending||!window.predictionMe;
 $('bet-buy').disabled=busy||!!reason||!Number.isSafeInteger(amount)||amount<1||amount>10000||amount>(wallet?.balance??0);
 $('bet-half').disabled=$('bet-sell').disabled=busy||!!reason||!position||position.resolved||position.cashoutLocked;
}
async function trade(kind,retry=false){
 if(busy||!joined)return;
 let order=pending;
 if(retry){if(!order||!window.predictionMe){P.note('请用发起该笔操作的账户登录');return}}
 else{if(pending){P.note('请先确认上一笔操作');return}order={owner:window.predictionMe.id,action:'trade',code:room.code,kind,rank:1,player:selected,stake:Number($('bet-amount').value),version:room.version,operation:crypto.randomUUID()};setPending(order)}
 busy=true;drawBet();try{const {owner,...body}=order;const data=await P.api('/web/play',{privateRequest:true,body});setPending(null);accept(data);P.note('操作已确认，余额已更新')}
 catch(e){if([400,409].includes(e.status)){setPending(null);P.note(e.message+'，本笔未成交');void poll()}else P.note(e.message+'。请点击“确认上一笔操作”核对结果。')}
 finally{busy=false;draw()}
}
async function poll(){
 if(polling||document.hidden||busy)return;polling=true;
 try{if(visible==='hall')await rooms();else if(visible==='watch'&&room){if(joined)accept(await P.api('/web/play',{privateRequest:true,body:{action:'view',code:room.code}}));else{room=await P.api('/web/room?code='+room.code);draw()}}}catch(e){if(room){room.fresh=false;room.open=false;draw()}P.note(e.message)}finally{polling=false}
}
 $('rooms-refresh').onclick=()=>void rooms();$('rooms-prev').onclick=()=>{if(page){page--;void rooms()}};$('rooms-next').onclick=()=>{page++;void rooms()};
 $('watch-back').onclick=()=>{P.tab('hall');void rooms()};$('watch-join').onclick=()=>void join();
 $('battle-round').onchange=()=>{roundChoice=$('battle-round').value;drawBattles()};$('bet-amount').oninput=()=>{stakes[selected]=$('bet-amount').value;const input=document.querySelector('.row-stake[data-player="'+selected+'"]');if(input)input.value=stakes[selected];drawBet()};$('bet-buy').onclick=()=>void trade('buy');$('bet-half').onclick=()=>void trade('half');$('bet-sell').onclick=()=>void trade('sell');$('bet-retry').onclick=()=>void trade('',true);
 for(const b of document.querySelectorAll('[data-stake]'))b.onclick=()=>{$('bet-amount').value=b.dataset.stake==='half'?Math.max(1,Math.floor((wallet?.balance??0)/2)):b.dataset.stake;drawBet()};
 window.addEventListener('prediction-tab',e=>{visible=e.detail;if(visible==='hall')void rooms()});
 window.addEventListener('prediction-wallet',()=>{joined=false;wallet=null;if(room){P.tab('watch');void join()}});window.addEventListener('prediction-login',()=>{if(room){P.tab('watch');void join()}});window.addEventListener('prediction-logout',()=>{joined=false;wallet=null;if(room)draw()});
 for(const [button,panel]of [['toggle-chart','chart-panel'],['toggle-battles','battle-panel']])$(button).onclick=()=>{$(panel).hidden=!$(panel).hidden;$(button).setAttribute('aria-expanded',String(!$(panel).hidden));if(!$(panel).hidden)$(panel).scrollIntoView({behavior:'smooth',block:'nearest'})};setInterval(()=>void poll(),4000);void (async()=>{await window.predictionReady;await rooms(true)})();
})();
