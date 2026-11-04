(()=>{
"use strict";
const $=id=>document.getElementById(id);
const params=new URLSearchParams(location.search);
if(params.get("source")==="window"||params.get("career")){
 location.replace("reference.html?"+params.toString());return;
}
const titles={overall:"总体",mid:"3000–5999",high:"6000及以上"};
const periods=["第一期","第二期","第三期"];
let phase=["1","2","3"].includes(params.get("phase"))?Number(params.get("phase")):3;
let band=Object.hasOwn(titles,params.get("band"))?params.get("band"):"overall";
let data=null,loading=false;
const format=new Intl.NumberFormat("zh-CN");
const clock=t=>new Date(t+8*3600000).toISOString().slice(0,16).replace("T"," ");
const el=(tag,value)=>{const n=document.createElement(tag);n.textContent=value;return n};
const value=(h,b)=>b==="overall"?(h.mid.appearances&&h.high.appearances?(h.mid.score+h.high.score)/2:null):h[b].appearances?h[b].score:null;
const points=v=>v===null?"待样本":v.toFixed(1);
const provisional=c=>c.appearances<20||c.players<8;
function sorted(p,b){
 return [...p.heroes].sort((a,h)=>(value(h,b)??-Infinity)-(value(a,b)??-Infinity)||a.name.localeCompare(h.name,"zh-CN"));
}
function controls(){
 document.querySelectorAll("[data-phase]").forEach(n=>n.setAttribute("aria-pressed",String(Number(n.dataset.phase)===phase)));
 document.querySelectorAll("[data-band]").forEach(n=>n.setAttribute("aria-pressed",String(n.dataset.band===band)));
 const query=new URLSearchParams();if(phase!==3)query.set("phase",phase);if(band!=="overall")query.set("band",band);
 history.replaceState(null,"",location.pathname+(query.size?"?"+query:""));
}
function rows(p){
 const all=band==="overall";$("tableTitle").textContent=titles[band]+"排名";
 $("aux1").textContent=all?titles.mid:"总体 Elo";$("aux2").textContent=all?titles.high:"另一分段";
 $("userLabel").textContent=all?"玩家（中 / 高）":"不同玩家";
 $("caption").textContent=all?"总体分等权合并两段，玩家数分段列出。同一人可能在两个分段都出现。":"分段按玩家本人开局积分划分。出场人次和不同玩家数均为本期样本。";
 const body=$("rows");body.replaceChildren();const search=$("search").value.trim();
 sorted(p,band).forEach((h,i)=>{
  if(search&&!h.name.includes(search))return;
  const v=value(h,band);const tr=el("tr","");
  const cells=[v===null?"—":String(i+1).padStart(2,"0"),h.name,points(v),
   points(value(h,all?"mid":"overall")),points(value(h,all?"high":band==="mid"?"high":"mid")),
   format.format(all?h.mid.appearances+h.high.appearances:h[band].appearances),
   all?format.format(h.mid.players)+" / "+format.format(h.high.players):format.format(h[band].players)];
  cells.forEach((s,j)=>{const td=el("td",s);if(j===1&&v!==null&&(all?(provisional(h.mid)||provisional(h.high)):provisional(h[band]))){
   const flag=el("small","初评");flag.className="rankFlag";td.append(flag);
  }tr.append(td)});body.append(tr);
 });$("empty").hidden=body.children.length>0;
}
function render(){
 controls();if(!data)return;
 const p=data.periods[phase-1],ended=p.end!==null;
 $("modeLabel").textContent=periods[phase-1]+" · "+(ended?"已封存":"持续更新")+" · 换角校正 Elo";
 $("period").textContent=clock(p.start)+(ended?" 至 "+clock(p.end):" 起");
 $("coverage").textContent=(ended?"最后计分结算 ":"榜单数据截至 ")+clock(ended?p.settled:p.asOf)+"（北京时间）";
 $("games").textContent=format.format(p.games);$("players").textContent=format.format(p.players);
 $("notes").textContent="首场可核实对局开于 "+clock(p.first)+"，最后计分结算于 "+clock(p.settled)+"。"+
  (phase===1?"第一期有部分修复提前热更，官方未列出精确分钟。":phase===3&&ended?"已达到下一次版本或公告边界，第三期已封存。":"");
 $("leads").replaceChildren();
 for(const b of Object.keys(titles)){
  const h=sorted(p,b).find(h=>value(h,b)!==null),btn=el("button","");btn.className="lead";btn.type="button";
  btn.append(el("span",titles[b]+" · 榜首"),el("strong",h?h.name:"待样本"),el("b",h?points(value(h,b)):"—"));
  btn.onclick=()=>{band=b;render()};$("leads").append(btn);
 }
 rows(p);$("board").hidden=false;
 $("status").textContent=!ended&&Date.now()-p.asOf>20*60000?"更新已延迟，当前展示最近一次成功发布的数据。":"";
}
async function refresh(){
 if(loading)return;loading=true;
 try{
  const response=await fetch("season.json",{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error("fetch");
  const incoming=await response.json();
  if(incoming.schema!=="season11-character-elo-v1"||incoming.model!=="within"||incoming.periods?.length!==3)throw Error("schema");
  data=incoming;render();
 }catch{
  $("status").replaceChildren(document.createTextNode(data?"刷新失败，保留上次评分。 ":"暂时未能读取榜单。 "));
  const btn=el("button","重新读取");btn.onclick=refresh;$("status").append(btn);
 }finally{loading=false}
}
document.querySelectorAll("[data-phase]").forEach(n=>n.onclick=()=>{phase=Number(n.dataset.phase);render()});
document.querySelectorAll("[data-band]").forEach(n=>n.onclick=()=>{band=n.dataset.band;render()});
$("search").oninput=()=>{if(data)rows(data.periods[phase-1])};
controls();refresh();setInterval(()=>{if(!document.hidden)refresh()},60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh()});
})();
