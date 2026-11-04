const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const url=process.env.CHARACTER_BOARD_URL||'https://elo.kaigua.vip/elo/characters/';
const origin=new URL(url).origin;
const starts=[1792033200000,1792648800000,1793253600000];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.WEB_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:950}}),requests=[],errors=[];
  page.on('request',r=>requests.push(r.url()));page.on('pageerror',e=>errors.push(e.message));
  const got=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/season.json'));
  assert.equal((await page.goto(url)).status(),200);
  const feed=await (await got).json();assert.equal(feed.model,'within');assert.equal(feed.periods.length,3);
  assert(!/"(?:uid|gameId|codeId|roomId|nickname|replay|rows)"\s*:|"[a-f0-9]{16,24}"/i.test(JSON.stringify(feed)));
  const ready=()=>page.locator('#rows tr').first().waitFor();
  await ready();assert.match(await page.locator('#modeLabel').innerText(),/第三期.*换角校正 Elo/);
  assert.equal(await page.locator('[data-phase="3"]').getAttribute('aria-pressed'),'true');
  for(const phase of [3,1,2,3]){
   const p=feed.periods[phase-1];assert.equal(p.start,starts[phase-1]);assert.equal(p.heroes.length,24);
   await page.locator('[data-phase="'+phase+'"]').click();
   assert.equal(await page.locator('#games').innerText(),p.games.toLocaleString('zh-CN'));
   assert.equal(await page.locator('#players').innerText(),p.players.toLocaleString('zh-CN'));
   for(const band of ['overall','mid','high']){
    await page.locator('[data-band="'+band+'"]').click();
    const score=h=>band==='overall'?(h.mid.appearances&&h.high.appearances?(h.mid.score+h.high.score)/2:null):h[band].appearances?h[band].score:null;
    const rows=await page.locator('#rows tr').allTextContents();assert.equal(rows.length,24);
    const displayed=await page.locator('#rows tr').evaluateAll(trs=>trs.map(tr=>[tr.children[1].firstChild.textContent,tr.children[2].textContent]));
    let last=Infinity;
    for(const [name,text] of displayed){
     const hero=p.heroes.find(h=>h.name===name);assert(hero);const s=score(hero);
     assert.equal(text,s==null?'待样本':s.toFixed(1));assert((s??-Infinity)<=last);last=s??-Infinity;
     for(const b of ['mid','high']) assert.deepEqual(Object.keys(hero[b]).sort(),['appearances','players','score']);
    }
   }
  }
  await page.locator('#search').fill('祁忘忧');assert.equal(await page.locator('#rows tr').count(),1);
  await page.locator('#search').fill('不存在的角色');assert(await page.locator('#empty').isVisible());
  await page.locator('#search').fill('');await page.reload();await ready();
  assert.equal(await page.locator('[data-band="high"]').getAttribute('aria-pressed'),'true');
  for(const width of [320,390]){await page.setViewportSize({width,height:850});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  assert(!requests.some(s=>/\/(live|window)\.json/.test(new URL(s).pathname)));
  await page.locator('#careerLink').click();await ready();assert.match(await page.title(),/旧版/);
  assert.equal(await page.locator('#career').inputValue(),'阵法师');
  await page.goto(url+'?source=window&band=high&career='+encodeURIComponent('阵法师'));await ready();assert.match(page.url(),/reference\.html/);
  await page.goto(url+'?source=live');await ready();assert.match(await page.locator('#modeLabel').innerText(),/第三期/);
  assert(requests.every(s=>new URL(s).origin===origin));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({defaultPhase:3,model:feed.model,games:feed.periods.map(p=>p.games),heroCount:24,allScoresMatch:true,legacy:true,mobile:true}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
