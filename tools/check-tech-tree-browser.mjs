// Integration smoke test against the actual SPA shell; APIs are unnecessary for
// this static reference page. Screenshots are optional review artifacts.
import { createServer } from 'node:http';
import { readFile,mkdir,readdir } from 'node:fs/promises';
import { extname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root=fileURLToPath(new URL('../public',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
  const relative=['/','/tech-tree','/civilizations'].includes(pathname)?'index.html':decodeURIComponent(pathname).slice(1);
  const path=resolve(root,relative);
  if (!path.startsWith(root)) {res.writeHead(403);res.end();return;}
  try {const data=await readFile(path);res.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream','cache-control':['.png','.webp'].includes(extname(path))?'public, max-age=604800, immutable':'no-cache'});res.end(data);}
  catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=process.env.TECH_TREE_TEST_BASE_URL || `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND']});
  const context=await browser.newContext({viewport:{width:1600,height:1100},deviceScaleFactor:1,
    userAgent:`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`});
  const page=await context.newPage();
  const errors=[],missing=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(response.status()===404 && response.url().startsWith(base))missing.push(response.url());});
  await page.goto(`${base}/tech-tree?civ=chinese`,{waitUntil:'domcontentloaded'});
  await page.locator('[data-node="Unit_4_87"]').waitFor();
  assert.match(await page.locator('.tt-version').innerText(),/^游戏版本\s+188329/);
  assert.equal(await page.locator('.tt-bonuses').getAttribute('open'),'');
  await page.locator('[data-node="Unit_4_87"]').click();
  await page.locator('dialog[open]').waitFor();
  assert.match(await page.locator('#tt-detail-body').innerText(),/30/);
  assert.match(await page.locator('#tt-detail-body').innerText(),/45/);
  assert.match(await page.locator('.tt-cost-time').innerText(),/训练时间\s*35\s*秒/);
  assert.doesNotMatch(await page.locator('.tt-stats').innerText(),/训练时间/);
  assert.deepEqual(await page.locator('.tt-cost').evaluateAll(items=>items.map(item=>item.className.split(' ').find(name=>name.startsWith('tt-cost-')))),['tt-cost-wood','tt-cost-gold']);
  assert.doesNotMatch(await page.locator('#tt-detail-body').innerText(),/可用民族/);
  assert.equal(await page.locator('.tt-advanced').getAttribute('open'),'');
  assert.doesNotMatch(await page.locator('.tt-advanced').innerText(),/类别\s*\d|待核对/);
  await page.locator('#tt-close').click();
  assert.equal(await page.locator('#tt-scroll').evaluate(scroll=>getComputedStyle(scroll).scrollbarWidth),'none');
  const dragNode=await page.locator('[data-node="Unit_4_87"]').boundingBox();
  const dragStart={x:dragNode.x+dragNode.width/2,y:dragNode.y+dragNode.height/2};
  await page.mouse.move(dragStart.x,dragStart.y);
  await page.mouse.down({button:'left'});
  await page.mouse.move(dragStart.x-120,dragStart.y,{steps:8});
  await page.mouse.up({button:'left'});
  const draggedRight=await page.locator('#tt-scroll').evaluate(scroll=>scroll.scrollLeft);
  assert.ok(draggedRight>50,'left-button drag scrolls the board');
  assert.equal(await page.locator('dialog[open]').count(),0,'dragging a node does not open its details');
  await page.mouse.move(dragStart.x-120,dragStart.y);
  await page.mouse.down({button:'left'});
  await page.mouse.move(dragStart.x-30,dragStart.y,{steps:8});
  await page.mouse.up({button:'left'});
  assert.ok(await page.locator('#tt-scroll').evaluate(scroll=>scroll.scrollLeft)<draggedRight,'dragging right scrolls back left');
  await page.locator('#tt-scroll').evaluate(scroll=>{scroll.scrollLeft=0;});
  await page.locator('[data-node="Unit_4_87"]').click();
  await page.locator('dialog[open]').waitFor();
  await page.locator('#tt-close').click();
  await page.locator('#tt-civ').selectOption('malians');
  await page.waitForFunction(()=>document.querySelector('.tt-civ-banner h3')?.textContent==='马里');
  assert.equal(await page.locator('.tt-bonus-grid section').first().locator('p').count(),3);
  assert.match(await page.locator('.tt-bonus-grid section').first().locator('p').last().innerText(),/兵营单位在封建\/城堡\/帝王时代的远程护甲 \+1\/\+2\/\+3/);
  const maliBonusHeights=await page.locator('.tt-bonus-grid section').first().locator('p').evaluateAll(items=>items.map(item=>item.getBoundingClientRect().height));
  assert.ok(maliBonusHeights[2]<=maliBonusHeights[0]+1,`Malian barracks bonus fits one desktop line: ${maliBonusHeights}`);
  await page.setViewportSize({width:1440,height:1100});
  const maliNarrowHeights=await page.locator('.tt-bonus-grid section').first().locator('p').evaluateAll(items=>items.map(item=>item.getBoundingClientRect().height));
  assert.ok(maliNarrowHeights[2]<=maliNarrowHeights[0]+1,`Malian barracks bonus fits one 1440px line: ${maliNarrowHeights}`);
  await page.setViewportSize({width:1600,height:1100});
  await page.locator('#tt-civ-info').screenshot({path:'.cache/qa/mali-bonus.png'});
  await page.locator('#tt-civ').selectOption('chinese');
  await page.waitForFunction(()=>document.querySelector('.tt-civ-banner h3')?.textContent==='中国');
  assert.equal(await page.locator('.tt-unique-unit').count(),2);
  assert.equal(await page.locator('.tt-unique-unit').first().getAttribute('data-node'),'Unit_73_82');
  assert.equal(await page.locator('.tt-unique-unit').first().innerText(),'');
  await page.waitForFunction(()=>document.querySelectorAll('.tt-unique-unit img[data-color-ready="true"]').length===2);
  await page.locator('.tt-unique-unit img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
  const playerColors=await page.locator('.tt-unique-unit img').evaluateAll(images=>images.map(image=>Number(image.dataset.playerColor)));
  assert.ok(playerColors.every(color=>[1,2,3,4,5,6,8].includes(color)));
  assert.deepEqual(playerColors,[4,4]);
  const artwork=await page.locator('.tt-unique-unit').first().evaluate(button=>({
    height:button.getBoundingClientRect().height,border:getComputedStyle(button).borderTopWidth,
    width:button.querySelector('img').naturalWidth,source:button.querySelector('img').dataset.portrait
  }));
  assert.ok(artwork.height>=140,'banner uses full-size artwork');
  assert.equal(artwork.border,'0px');
  assert.ok(artwork.width>=256);
  assert.match(artwork.source,/\/portraits-fixed\/chinese\/.*\.png(?:\?|$)/);
  await page.locator('#tt-civ').selectOption('franks');
  await page.waitForFunction(()=>document.querySelector('.tt-civ-banner h3')?.textContent==='法兰克');
  for(const key of ['Unit_5_87','Unit_36_49','Unit_420_45']){
    if(key==='Unit_420_45') await page.locator('[data-category="naval"]').click();
    await page.locator(`[data-node="${key}"]`).click();
    await page.locator('.tt-relations [data-detail-node="Tech_47_209"]').click();
    assert.equal(await page.locator('#tt-detail-title').innerText(),'化学');
    await page.locator('#tt-close').click();
  }
  await page.locator('[data-category="military"]').click();
  await page.locator('#tt-civ').selectOption('incas');
  await page.waitForFunction(()=>document.querySelector('.tt-civ-banner h3')?.textContent==='印加');
  const incaPortrait=page.locator('.tt-unique-unit img').first();
  await incaPortrait.evaluate(image=>image.decode());
  assert.match(await incaPortrait.getAttribute('src'),/portraits-fixed\/incas\/97\.png\?v=185872-fixed6$/);
  await page.locator('#tt-civ-info').screenshot({path:'.cache/qa/incas-clean.png'});
  await page.locator('#tt-civ').selectOption('chinese');
  await page.waitForFunction(()=>document.querySelector('.tt-civ-banner h3')?.textContent==='中国');
  await page.locator('.tt-unique-unit[data-node="Unit_73_82"]').click();
  assert.match(await page.locator('#tt-detail-title').innerText(),/诸葛/);
  await page.locator('#tt-close').click();
  await page.locator('#tt-search').fill('hand cannoneer');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.tt-node.is-unavailable').count(),1);
  await page.locator('#tt-unavailable').uncheck();
  await page.locator('.tt-empty').waitFor();
  await page.locator('#tt-reset').click();
  await page.locator('#tt-civ').selectOption('franks');
  await page.waitForFunction(()=>document.querySelector('.tt-civ-banner h3')?.textContent==='法兰克');
  await page.locator('#tt-civ').selectOption('bulgarians');
  await page.waitForFunction(()=>document.querySelector('.tt-civ-banner h3')?.textContent==='保加利亚');
  assert.equal(await page.locator('.tt-unique-unit').count(),1);
  await page.locator('#tt-civ').selectOption('chinese');
  await page.waitForFunction(()=>document.querySelector('.tt-civ-banner h3')?.textContent==='中国');
  await page.locator('[data-category="military"]').click();
  await page.waitForTimeout(150);
  assert.ok(await page.locator('.tt-links path').count()>5);
  const archer=await page.locator('[data-node="Unit_4_87"]').boundingBox();
  const crossbow=await page.locator('[data-node="Unit_24_87"]').boundingBox();
  const skirmisher=await page.locator('[data-node="Unit_6_87"]').boundingBox();
  assert.ok(Math.abs(archer.x-crossbow.x)<1);
  assert.ok(Math.abs(archer.x-skirmisher.x)>50);
  await page.locator('[data-category="naval"]').click();
  await page.waitForTimeout(100);
  const galley=await page.locator('[data-node="Unit_539_45"]').boundingBox();
  const warGalley=await page.locator('[data-node="Unit_21_45"]').boundingBox();
  const hulk=await page.locator('[data-node="Unit_2627_45"]').boundingBox();
  assert.ok(Math.abs(galley.x-warGalley.x)<1);
  assert.ok(Math.abs(galley.x-hulk.x)>50);
  await page.screenshot({path:'.cache/qa/tech-tree-dock.png',fullPage:true});
  await page.locator('[data-category="military"]').click();
  const boardHeight=(await page.locator('#tt-board').boundingBox()).height;
  assert.ok(boardHeight<750,`four-age board is compact: ${boardHeight}`);
  await mkdir('.cache/qa',{recursive:true});
  await page.screenshot({path:'.cache/qa/tech-tree-desktop.png',fullPage:true});
  const overflow=()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth});
  assert.ok((await page.evaluate(overflow)).scroll<=(await page.evaluate(overflow)).width+2,'desktop body overflow');
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(150);
  const mobile=await page.evaluate(overflow);
  assert.ok(mobile.scroll<=mobile.width+2,`mobile body overflow ${JSON.stringify(mobile)}`);
  await page.screenshot({path:'.cache/qa/tech-tree-mobile.png',fullPage:true});
  await page.locator('[data-node="Unit_4_87"]').click();
  const rect=await page.locator('dialog').boundingBox();
  assert.ok(rect.width<=390 && rect.x>=-1,'mobile detail fits viewport');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1600,height:1100});
  await page.locator('[data-page="civilizations"]').click();
  await page.locator('#tech-tree-page[hidden]').waitFor({state:'attached'});
  await page.locator('[data-page="tech-tree"]').click();
  await page.locator('[data-node="Unit_4_87"]').waitFor();
  await page.goto(`${base}/tech-tree?civ=chinese&node=Unit_24_87`,{waitUntil:'domcontentloaded'});
  await page.locator('dialog[open]').waitFor();
  assert.match(await page.locator('#tt-detail-title').innerText(),/弩/);
  assert.equal(await page.locator('#tt-detail-body h4').first().innerText(),'升级至该单位');
  await page.locator('#tt-close').click();
  await page.locator('[data-theme-value="light"]').click();
  await page.screenshot({path:'.cache/qa/tech-tree-light.png',fullPage:true});
  await page.locator('#tt-civ').selectOption('teutons');
  await page.locator('.tt-civ-emblem[src$="/teutons.png"]').waitFor();
  await page.locator('.tt-unique-unit img[data-color-ready="true"]').waitFor();
  const cutout=await page.locator('.tt-unique-unit img').first().evaluate(image=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const pixels=ctx.getImageData(0,0,256,256).data;
    let transparent=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]===0)transparent++;
    return {corner:pixels[3],transparent};
  });
  assert.equal(cutout.corner,0);
  assert.ok(cutout.transparent>20000,'light-theme artwork has transparent background');
  await page.locator('#tt-civ-info').screenshot({path:'.cache/qa/teutons-transparent-light.png'});
  await page.locator('#tt-civ').selectOption('chinese');
  await page.locator('.tt-civ-emblem[src$="/chinese.png"]').waitFor();
  await page.locator('#tt-civ').selectOption('poles');
  await page.locator('.tt-civ-emblem[src$="/poles.png"]').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.tt-unique-unit img[data-color-ready="true"]').length===2);
  await page.locator('#tt-civ-info').screenshot({path:'.cache/qa/poles-transparent-light.png'});
  await page.locator('#tt-civ').selectOption('chinese');
  await page.locator('.tt-civ-emblem[src$="/chinese.png"]').waitFor();
  await page.setViewportSize({width:390,height:844});
  await page.locator('[data-node="Unit_4_87"]').click();
  await page.screenshot({path:'.cache/qa/tech-tree-mobile-detail.png'});
  if (process.env.TECH_TREE_TEST_BASE_URL) {
    await page.locator('#tt-close').click();
    await page.setViewportSize({width:1600,height:1100});
    await page.locator('[data-page="civilizations"]').click();
    await page.locator('.civ-name-button[href]').first().waitFor().catch(async error=>{console.log('Stats diagnostic:',await page.locator('#civilizations-page').innerText());throw error;});
    const target=await page.locator('.civ-name-button[href]').first().getAttribute('href');
    const expected=new URL(target,base).searchParams.get('civ');
    await page.locator('.civ-name-button[href]').first().click();
    await page.waitForURL(`${base}${target}`);
    await page.waitForFunction(id=>document.querySelector('#tt-civ')?.value===id,expected);
    await page.goto(`${base}/civilizations`,{waitUntil:'domcontentloaded'});
    await page.locator('a.civ-opponent').first().waitFor();
    const opponent=await page.locator('a.civ-opponent').first().getAttribute('href');
    assert.match(opponent,/^\/tech-tree\?civ=[a-z]+$/);
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(missing,[]);
  const files=(await readdir(join(root,'assets/tech-tree/portraits-png'))).filter(file=>file.endsWith('.png')).sort((a,b)=>parseInt(a)-parseInt(b));
  const proof=await context.newPage();await proof.setViewportSize({width:960,height:1100});
  for(let batch=0;batch<4;batch++){
    const pictures=files.slice(batch*37,(batch+1)*37);
    await proof.setContent(`<body style="margin:16px;background:#f3f1e9;font:12px sans-serif;display:grid;grid-template-columns:repeat(6,1fr);gap:10px">${pictures.map(file=>`<figure style="margin:0;text-align:center"><img src="${base}/assets/tech-tree/portraits-png/${file}" style="width:140px;height:140px;object-fit:contain"><figcaption>${file}</figcaption></figure>`).join('')}</body>`);
    await proof.evaluate(()=>Promise.all([...document.images].map(image=>image.decode())));
    await proof.screenshot({path:`.cache/qa/portrait-sheet-${batch+1}.png`,fullPage:true});
  }
  await proof.close();
  const warm=await context.newPage();
  await warm.goto(`${base}/tech-tree?civ=chinese`,{waitUntil:'domcontentloaded'});
  await warm.waitForFunction(()=>document.querySelectorAll('.tt-unique-unit img[data-color-ready="true"]').length===2);
  const cached=await warm.evaluate(()=>performance.getEntriesByType('resource')
    .filter(entry=>/\/tech-tree-data\/|\/portraits-fixed\//.test(entry.name))
    .map(entry=>({path:new URL(entry.name).pathname,transfer:entry.transferSize,decoded:entry.decodedBodySize})));
  assert.ok(cached.length>=5);
  assert.ok(cached.every(entry=>entry.transfer===0),`repeat visit uses local cache: ${JSON.stringify(cached)}`);
  assert.ok(!(await warm.evaluate(()=>performance.getEntriesByType('resource').map(e=>e.name))).some(url=>/portraits-rgba|portraits-textures|tech-tree-player-colors/.test(url)));
  console.log('Warm revisit: game data and fixed portraits transferred 0 bytes; no runtime colour assets.');
  await warm.close();
  const coldContext=await browser.newContext({userAgent:`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`});
  const heldFonts=[];
  await coldContext.route('https://fonts.googleapis.com/**',route=>{heldFonts.push(route);});
  const cold=await coldContext.newPage();
  await cold.goto(`${base}/tech-tree?civ=chinese`,{waitUntil:'commit'});
  await cold.waitForFunction(()=>document.querySelectorAll('.tt-unique-unit img[data-color-ready="true"]').length===2,{},{timeout:10000});
  assert.ok(heldFonts.length>0);
  for(const route of heldFonts) await route.fulfill({contentType:'text/css',body:''});
  await coldContext.close();
  console.log('Cold visit: pictures render while the external font stylesheet is still pending.');
  console.log('PASS: details, availability, bilingual search, combined filters, civ switching, upgrade links, desktop/mobile, SPA navigation, deep links, local assets.');
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
