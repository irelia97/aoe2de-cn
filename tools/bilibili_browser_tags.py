"""Read video tags from visible browser pages, with a small per-UP budget."""
import asyncio,json,re,time

def title_matches(title):
 value=re.sub(r'\s+','',title)
 return bool(value) and not re.search(r'帝国(?:时代)?[34]',value) and '帝国' in value

def tags_match(tags):
 return any(re.search(r'帝国时代(?:2|２|二|贰|貳|II|Ⅱ)(?![0-9０-９IVXLCDMⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])',re.sub(r'\s+','',v).upper()) for v in tags)

async def supplement_tags(context,videos,cache_path,known_ids,budget=2,delay=10):
 cache=json.loads(cache_path.read_text()) if cache_path.exists() else {}
 checked=0;pending=0
 for video in videos:
  bvid=video['bvid']
  if bvid in known_ids or title_matches(video['title']):continue
  if bvid in cache:
   video['tagMatches']=tags_match(cache[bvid]['tags']);continue
  if checked>=budget:pending+=1;continue
  # Space detail page visits apart, including the first visit after the UP page.
  await asyncio.sleep(delay);checked+=1
  page=await context.new_page()
  try:
   await page.route('**/*',lambda r:r.abort() if r.request.resource_type=='media' else r.continue_())
   response=await page.goto(video['url'],wait_until='domcontentloaded',timeout=25000)
   if response and response.status in [403,412,429]:return {'status':'verification_required','tagChecks':checked}
   selector='.video-tag-container .tag-link, #v_tag .tag-link, .tag-panel .tag-link'
   try:await page.locator(selector).first.wait_for(state='visible',timeout=20000)
   except Exception:
    text=await page.locator('body').inner_text(timeout=5000)
    if any(t in text for t in ['安全验证','请完成验证','访问受限','请求被拦截','验证码']):return {'status':'verification_required','tagChecks':checked}
    pending+=1;break
   tags=[t.strip() for t in await page.locator(selector).all_text_contents() if t.strip()]
   if not tags:pending+=1;break
   cache[bvid]={'tags':tags,'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
   temp=cache_path.with_suffix('.tmp');temp.write_text(json.dumps(cache,ensure_ascii=False));temp.chmod(0o600);temp.replace(cache_path)
   video['tagMatches']=tags_match(tags)
  finally:await page.close()
 return {'status':'ok','tagChecks':checked,'tagPending':pending}
