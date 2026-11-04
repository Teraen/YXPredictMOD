const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const url=process.env.ELO_WEB_URL||'http://127.0.0.1:8138/',origin=new URL(url).origin;
 const browser=await chromium.launch({headless:true,executablePath:process.env.WEB_TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),requests=[],errors=[],payloads=[];
  page.on('request',r=>requests.push(r.url()));page.on('pageerror',e=>errors.push(e.message));
  page.on('response',async r=>{if(new URL(r.url()).pathname==='/elo/public/leaderboard.json')payloads.push(await r.json())});
  assert.equal((await page.goto(url)).status(),200);await page.waitForSelector('.anon-score');assert.equal(await page.locator('.anon-score').count(),100);
  assert.deepEqual(await page.locator('#view-elo thead th').allTextContents(),['名次','保守分 ↓','不确定性','技术分']);
  assert.equal(await page.locator('.anon-uncertainty').count(),100);assert.equal(await page.locator('.anon-technical').count(),100);
  assert.equal(await page.locator('.anon-key-heading').getAttribute('aria-sort'),'descending');
  assert.equal(await page.locator('#view-elo input').count(),0);assert.equal(await page.locator('#view-elo .anon-subtitle,#view-elo .anon-badge,#view-elo .anon-note').count(),0);assert(!(await page.locator('#view-elo').innerText()).includes('不见姓名'));assert.equal(await page.locator('#view-elo tbody a').count(),0);
  assert(!await page.locator('#view-elo').evaluate(e=>e.textContent.includes('NeverReveal')));
  await page.screenshot({path:path.join(process.cwd(),'.cache/anonymous-elo-desktop.png'),fullPage:true});
  assert.equal(await page.locator('.anon-pager').count(),0);assert.equal(await page.locator('.anon-place').last().innerText(),'100');
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow');
  await page.screenshot({path:path.join(process.cwd(),'.cache/anonymous-elo-mobile.png'),fullPage:true});
  for(const data of payloads){assert.deepEqual(Object.keys(data).sort(),['rows','scores','total','offset','limit','updatedAt','minGames','activeDays'].sort());assert(data.total<=100);assert(data.rows.length<=100);assert(data.scores.every(Number.isFinite));assert(!JSON.stringify(data).includes('NeverReveal'));for(const row of data.rows){assert.deepEqual(Object.keys(row).sort(),['conservative','uncertainty','technical'].sort());assert(Object.values(row).every(Number.isFinite))}}
  const shown=payloads.at(-1).rows[0],format=n=>n.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
  assert.equal(await page.locator('.anon-conservative').first().innerText(),format(shown.conservative));assert.equal(await page.locator('.anon-uncertainty').first().innerText(),format(shown.uncertainty));assert.equal(await page.locator('.anon-technical').first().innerText(),format(shown.technical));
  assert(await page.locator('#view-elo tbody tr').first().evaluate(row=>parseFloat(getComputedStyle(row.querySelector('.anon-conservative')).fontSize)>parseFloat(getComputedStyle(row.querySelector('.anon-technical')).fontSize)));
  assert(payloads.length>=1);assert(!requests.some(u=>new URL(u).pathname.startsWith('/data/elo/')));assert(!requests.some(u=>new URL(u).pathname.startsWith('/api/v1/')));
  assert.deepEqual((await (await page.request.get(origin+'/api/v1/leaderboard?offset=100&limit=100')).json()).scores,[]);
  assert.equal((await page.request.get(origin+'/data/elo/names.json')).status(),404);assert.equal((await page.request.get(origin+'/data/elo/top.json')).status(),404);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({anonymousPayloads:payloads.length,threeNumericColumns:true,conservativeEmphasized:true,noPlayerSearchOrLinks:true,noLegacyIdentityRequests:true,top100Only:true,noPagination:true,desktopMobile:true,scriptErrors:0}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
