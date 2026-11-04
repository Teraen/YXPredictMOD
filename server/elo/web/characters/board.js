(()=>{
"use strict";
const $=id=>document.getElementById(id);
const titles={overall:"总体",mid:"3000–5999",high:"6000及以上"};
const params=new URLSearchParams(location.search);
const reference=document.body.dataset.reference==="true";
let source=reference&&params.get("source")!=="window"||params.get("source")==="live"?"live":"window";
let band=Object.hasOwn(titles,params.get("band"))?params.get("band"):reference?"mid":"overall";
let career=band==="overall"?"":params.get("career")||(reference?"阵法师":"");
let data=null,requestId=0,timer=0;
const fmt=new Intl.NumberFormat("zh-CN");
const points=x=>x.games?x.score.toFixed(1):"待首局";
const provisional=x=>x.games>0&&(x.appearances<20||x.playerCount<8);
const clock=s=>s.slice(0,16).replace("T"," ");
function make(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e}
function current(h,b=band,c=career){if(b==="overall")return h.overall;return c?h.bands[b].careers[c]:h.bands[b]}
function ranking(b,c){return data.heroes.map(h=>({h,x:current(h,b,c)})).sort((a,b)=>
    Number(b.x.games>0)-Number(a.x.games>0)||b.x.score-a.x.score||a.h.name.localeCompare(b.h.name,"zh-CN"))}
function controls(){
 document.querySelectorAll("[data-source]").forEach(n=>n.setAttribute("aria-pressed",String(n.dataset.source===source)));
 document.querySelectorAll("[data-band]").forEach(n=>n.setAttribute("aria-pressed",String(n.dataset.band===band)));
 $("career").disabled=band==="overall";$("career").value=career;
 const q=new URLSearchParams();if(reference||source!=="window")q.set("source",source);if(band!=="overall")q.set("band",band);if(career)q.set("career",career);
 if(location.protocol!=="file:")history.replaceState(null,"",location.pathname+(q.size?"?"+q:""));
}
function chooseBand(b){band=b;if(b==="overall")career="";controls();if(data)renderRows()}
function renderRows(){
 $("tableTitle").textContent=titles[band]+(career?" · "+career:"")+"排名";
 $("aux1").textContent=band==="overall"?titles.mid:"总体 Elo";$("aux2").textContent=band==="overall"?titles.high:"分段综合";
 $("caption").textContent=(band==="overall"?"总体按两个分段各占50%计算。":career?"组合分包含角色、副职及两者的共同影响。":"分段按玩家本人赛前主积分划分。")+" 少于20人次或8位玩家标为初评。";
 const query=$("search").value.trim();const body=$("rows");body.replaceChildren();
 ranking(band,career).forEach(({h,x},i)=>{
  if(query&&!h.name.includes(query))return;
  const row=make("tr");body.append(row);
  const values=[x.games?String(i+1).padStart(2,"0"):"—",h.name,points(x),
    points(band==="overall"?h.bands.mid:h.overall),points(band==="overall"?h.bands.high:h.bands[band]),fmt.format(x.games),fmt.format(x.playerCount)];
  values.forEach((v,j)=>{const cell=make("td",v);row.append(cell);if(j===1&&provisional(x)){const flag=make("small","初评");flag.className="rankFlag";cell.append(flag)}});
 });
 $("empty").hidden=body.children.length>0;
}
function render(){
 const frozen=source==="window";
 $("modeLabel").textContent=frozen?"固定快照 · 平衡调整窗口":"自动更新 · 角色动态分";
 $("period").textContent=frozen?clock(data.start)+" 至 "+clock(data.asOf):"榜单更新于 "+clock(data.asOf);
 $("coverage").textContent=frozen?"北京时间 · 首场可核实多人局为 "+clock(data.first)+"。":"北京时间 · 首场计分，保留小样本。";
 $("games").textContent=fmt.format(data.games);$("players").textContent=fmt.format(data.players);
 $("notes").textContent=frozen?"本窗口从3000重新起算。指定起点至首场可核实多人局之间约9小时，留存的5,484个榜单复盘头缺少可核实的跨局身份。本窗口纳入的对局中，有"+fmt.format(data.earlyGames)+"场早于现网榜原起算点。"
    :"实时数据定期从角色榜的匿名汇总结果刷新。页面列出本次发布的更新时间。";
 $("sample").replaceChildren();
 if(frozen){
  const daily=make("table");daily.className="sample-table";const head=daily.createTHead().insertRow();
  for(const t of ["开局日期（北京时间）","计分对局","真人参与人次"])head.append(make("th",t));
  const body=daily.createTBody();
  data.days.forEach(d=>{const row=body.insertRow();[d.day,fmt.format(d.games),fmt.format(d.events)].forEach(v=>row.append(make("td",v)))});
  $("sample").append(daily);
 }
 $("leads").replaceChildren();
 for(const b of Object.keys(titles)){
   const top=ranking(b,"").find(v=>v.x.games>0),btn=make("button");btn.className="lead";btn.type="button";
   btn.append(make("span",titles[b]+" · 榜首"),make("strong",top?top.h.name:"待首局"),make("b",top?points(top.x):"—"));
   btn.onclick=()=>{career="";chooseBand(b)};$("leads").append(btn);
 }
 const ctl=$("career");ctl.replaceChildren(new Option("全部副职",""));
 for(const c of Object.keys(data.heroes[0].bands.mid.careers))ctl.add(new Option(c,c));
 if(!Array.from(ctl.options).some(o=>o.value===career))career="";
 controls();renderRows();$("board").hidden=false;
}
async function load(next,background=false){
 const embedded=$("frozen-snapshot");
 if(embedded&&next==="live"){location.assign("https://elo.kaigua.vip/elo/characters/?source=live");return}
 clearTimeout(timer);source=next;const id=++requestId;
 if(!background){data=null;$("board").hidden=true;$("status").textContent="正在读取评分…";}
 controls();
 try{
  let incoming;
  if(embedded)incoming=JSON.parse(embedded.textContent);
  else{
   const response=await fetch(next+".json",{cache:next==="live"?"no-store":"default",credentials:"omit",referrerPolicy:"no-referrer"});
   if(!response.ok)throw Error("request");incoming=await response.json();
  }
  if(id!==requestId)return;
  if(incoming.kind!==next||!Array.isArray(incoming.heroes)||!incoming.heroes.length)throw Error("format");
  data=incoming;render();
  const stale=next==="live"&&Date.now()-Date.parse(data.asOf)>15*60*1000;
  $("status").textContent=stale?"最新发布已超过15分钟，以下为最近一次成功更新的分数。":"";
 }catch(e){
  if(id!==requestId)return;
  $("status").replaceChildren(document.createTextNode(data?"刷新失败，保留上次评分。 ":"评分暂时无法读取。 "));
  const retry=make("button","重新读取");retry.type="button";retry.onclick=()=>load(next,Boolean(data));$("status").append(retry);
 }finally{
  if(id===requestId&&next==="live")timer=setTimeout(()=>load("live",true),120000);
 }
}
document.querySelectorAll("[data-source]").forEach(b=>b.onclick=()=>load(b.dataset.source));
document.querySelectorAll("[data-band]").forEach(b=>b.onclick=()=>chooseBand(b.dataset.band));
$("career").onchange=()=>{career=$("career").value;controls();if(data)renderRows()};
$("search").oninput=()=>{if(data)renderRows()};
load(source);
})();
