/* Anonymous presentation adapter for the existing data site's EloTab entry. */
(()=>{
let ticket=0;
const host=()=>document.getElementById('view-elo');
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node}
const points=value=>value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
async function render(){
 const root=host();if(!root)return;
 const mine=++ticket;root.replaceChildren();root.classList.add('anon-elo');
 const heading=el('div',undefined,'anon-heading'),copy=el('div');copy.append(el('h2','匿名 Elo 榜'));
 const characters=el('a','角色强度榜 →','anon-character-link');characters.href='/elo/characters/';
 heading.append(copy,characters);root.append(heading);
 const state=el('p','正在读取榜单…','anon-state');state.setAttribute('role','status');root.append(state);
 try{
  const response=await fetch('/elo/public/leaderboard.json',{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('榜单暂时无法读取');const data=await response.json();if(mine!==ticket)return;
  if(!Array.isArray(data.rows)||data.rows.some(row=>!['conservative','uncertainty','technical'].every(key=>Number.isFinite(row[key]))))throw Error('榜单格式异常');
  state.remove();
  const frame=el('div',undefined,'anon-frame'),table=el('table'),cols=el('colgroup');
  for(const cls of ['anon-col-place','anon-col-conservative','anon-col-uncertainty','anon-col-technical'])cols.append(el('col',undefined,cls));table.append(cols);
  const head=el('thead'),tr=el('tr'),keyHeading=el('th','保守分 ↓','anon-key-heading');keyHeading.setAttribute('aria-sort','descending');tr.append(el('th','名次'),keyHeading,el('th','不确定性'),el('th','技术分'));head.append(tr);table.append(head);const rows=el('tbody');
  data.rows.forEach((values,index)=>{const row=el('tr');if(data.offset+index<3)row.className='anon-podium';row.append(el('td',String(data.offset+index+1).padStart(2,'0'),'anon-place'),el('td',points(values.conservative),'anon-score anon-conservative'),el('td',points(values.uncertainty),'anon-secondary anon-uncertainty'),el('td',points(values.technical),'anon-secondary anon-technical'));rows.append(row)});table.append(rows);frame.append(table);root.append(frame);
  if(!data.rows.length)root.append(el('p','暂无分数。','anon-state'));
 }catch(error){if(mine!==ticket)return;state.textContent='榜单暂时无法读取，请稍后重试。';const retry=el('button','重新读取','anon-retry');retry.type='button';retry.onclick=()=>void render();root.append(retry)}
}
window.EloTab={render,tab:()=> '匿名 Elo',sub:()=> ''};
if(host()&&(!host().hidden||host().hasAttribute('data-anonymous-elo')))void render();
})();
