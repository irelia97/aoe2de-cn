#!/usr/bin/env python3
"""Check an UP's dynamic page with a saved browser session; no direct API crawl."""
import argparse,asyncio,calendar,json,re,time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.async_api import async_playwright,TimeoutError
from bilibili_browser_tags import supplement_tags
ROOT=Path(__file__).resolve().parents[1]

def extract_own_videos(items,mid,limit=12):
 videos=[];seen=set()
 for item in items:
  modules=item.get('modules') or {};author=modules.get('module_author') or {}
  if item.get('type')!='DYNAMIC_TYPE_AV' or str(author.get('mid'))!=str(mid):continue
  archive=((modules.get('module_dynamic') or {}).get('major') or {}).get('archive') or {}
  bvid=archive.get('bvid','')
  if not re.fullmatch(r'BV[0-9A-Za-z]{10}',bvid) or bvid in seen:continue
  seen.add(bvid)
  try:stamp=int(author.get('pub_ts') or item.get('pub_ts') or archive.get('pubdate') or 0)
  except (ValueError,TypeError):stamp=0
  videos.append({'bvid':bvid,'title':archive.get('title') or '', 'url':'https://www.bilibili.com/video/'+bvid,'thumbnail':archive.get('cover') or '', 'publishedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(stamp)) if isinstance(stamp,(int,float)) and stamp>0 else None})
  if len(videos)>=limit:break
 return videos

def filter_baseline(videos,bvid,published_at):
 if not bvid or not published_at:return videos
 return [v for v in videos if v['bvid']==bvid or (v.get('publishedAt') and calendar.timegm(time.strptime(v['publishedAt'],'%Y-%m-%dT%H:%M:%SZ'))>published_at)]

async def run(args):
 folder=ROOT/'.cache/bilibili-browser-check';folder.mkdir(parents=True,exist_ok=True);folder.chmod(0o700)
 session=ROOT/'.cache/danmaku/bilibili_storage_state.json'
 if not session.exists():raise RuntimeError('Server login state missing')
 snapshot=folder/(args.mid+'-dynamic.json');previous=json.loads(snapshot.read_text()) if snapshot.exists() else {}
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=not args.headed)
  context=await browser.new_context(storage_state=str(session),viewport={'width':1440,'height':1000},locale='zh-CN',timezone_id='Asia/Shanghai')
  page=await context.new_page();page.set_default_timeout(args.timeout*1000)
  future=asyncio.get_running_loop().create_future();tasks=[]
  async def observe(response):
   u=urlsplit(response.url)
   if u.hostname!='api.bilibili.com' or u.path!='/x/polymer/web-dynamic/v1/feed/space':return
   try:
    result={'http':response.status,'path':u.path}
    if response.ok:result['payload']=await response.json()
    if not future.done():future.set_result(result)
   except Exception:pass
  page.on('response',lambda r:tasks.append(asyncio.create_task(observe(r))))
  try:
   await page.goto('https://space.bilibili.com/'+args.mid+'/dynamic',wait_until='domcontentloaded',timeout=args.timeout*1000)
   try:response=await asyncio.wait_for(asyncio.shield(future),timeout=args.timeout)
   except asyncio.TimeoutError:response={}
   payload=response.get('payload') or {};code=payload.get('code');data=payload.get('data') or {};items=data.get('items') or []
   videos=filter_baseline(extract_own_videos(items,args.mid,args.limit),args.baseline_bvid,args.baseline_published_at)
   text=await page.locator('body').inner_text(timeout=5000)
   risk=response.get('http') in [403,412,429] or code in [-403,-352,-412] or any(t in text for t in ['安全验证','请完成验证','访问受限','请求被拦截'])
   if risk:status='verification_required'
   elif response.get('http')!=200 or code!=0:status='response_error'
   else:status='ok'
   result={'mid':args.mid,'pageUrl':page.url,'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'status':status,'videos':videos,'diagnostic':{'http':response.get('http'),'code':code,'message':payload.get('message'),'items':len(items)}}
   if status=='ok' and args.check_tags:
    cache=ROOT/'.cache/media-videos.json';known={str(v.get('id','')) for v in json.loads(cache.read_text()).get('videos',[])} if cache.exists() else set()
    result.update(await supplement_tags(context,videos,folder/'tags.json',known))
   if result['status']=='ok':
    known={v['bvid'] for v in previous.get('videos',[])}
    result['comparison']='compared_to_previous_check' if previous else 'first_check_baseline'
    result['newVideos']=[v for v in videos if v['bvid'] not in known] if previous else []
    temp=snapshot.with_suffix('.tmp');temp.write_text(json.dumps(result,ensure_ascii=False,indent=2));temp.chmod(0o600);temp.replace(snapshot)
   else:
    screenshot=folder/(args.mid+'-dynamic-error.png')
    try:await page.screenshot(path=str(screenshot),timeout=5000);screenshot.chmod(0o600)
    except TimeoutError:pass
   print(json.dumps(result,ensure_ascii=False,indent=2),flush=True)
  finally:
   if tasks:await asyncio.gather(*tasks,return_exceptions=True)
   await browser.close()

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--mid',required=True);p.add_argument('--limit',type=int,default=12);p.add_argument('--timeout',type=int,default=35);p.add_argument('--check-tags',action='store_true');p.add_argument('--headed',action='store_true');p.add_argument('--baseline-bvid',default='');p.add_argument('--baseline-published-at',type=int,default=0);args=p.parse_args()
 if not args.mid.isdigit() or not 1<=args.limit<=30:p.error('Invalid mid or limit')
 asyncio.run(run(args))
if __name__=='__main__':main()
