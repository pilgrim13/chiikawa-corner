import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Run with `npm run dev` active. Override CORNER_UI_URL and CHROME_EXECUTABLE if needed.
const appUrl = process.env.CORNER_UI_URL || 'http://127.0.0.1:5179';
const root = fileURLToPath(new URL('..', import.meta.url));
const results = join(root, 'test-results');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined)});
const errors=[];
try {
 const page=await browser.newPage({viewport:{width:1000,height:752}});
 page.on('pageerror',err=>errors.push(err.message));
 await page.addInitScript((serverUrl)=>{
   const data={phase:'idle',currentVersion:'0.1.0'};
   window.__updateState=data;window.__updateCalls={check:0,download:0,install:0,subscribers:0};window.__updateListeners=new Set();
   window.__updateEmit=(state)=>{window.__updateState=state;for(const cb of window.__updateListeners)cb(state);};
   window.corner={getConfig:async()=>({serverUrl,version:'0.1.0',isDesktop:true}),setOverlay:()=>{},getDisplays:async()=>[],
     getUpdateState:async()=>window.__updateState,onUpdateState:(cb)=>{window.__updateListeners.add(cb);window.__updateCalls.subscribers++;return()=>{window.__updateListeners.delete(cb);window.__updateCalls.subscribers--;};},
     checkForUpdate:async()=>{window.__updateCalls.check++;if(window.__failCheck){window.__failCheck=false;throw new Error('test failure');}const next={phase:'available',currentVersion:'0.1.0',latestVersion:'0.2.0',releaseNotes:'산책이 더 부드러워졌어.\n<script>window.__bad=true</script>'};window.__updateEmit(next);return next;},
     downloadUpdate:()=>{window.__updateCalls.download++;window.__updateEmit({...window.__updateState,phase:'downloading',progress:0});return new Promise(resolve=>{window.__finishDownload=()=>{const next={...window.__updateState,phase:'ready',progress:100};window.__updateEmit(next);resolve(next);};});},
     installUpdate:async()=>{window.__updateCalls.install++;const next={...window.__updateState,phase:'installing'};window.__updateEmit(next);return next;},
   };
 }, appUrl);
 await page.goto(appUrl);
 const trigger=page.getByRole('button',{name:'업데이트',exact:true});await trigger.waitFor();await trigger.click();
 const dialog=page.getByRole('dialog');await dialog.waitFor();
 assert.equal(await page.evaluate(()=>window.__updateCalls.check),0,'opening must not start a network check');
 assert.equal(await page.evaluate(()=>window.__updateCalls.subscribers),1,'strict effect cleanup must leave one subscriber');
 assert.equal(await page.getByRole('button',{name:'업데이트 창 닫기'}).evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('Shift+Tab');assert.equal(await page.getByRole('button',{name:'업데이트 확인',exact:true}).evaluate(el=>el===document.activeElement),true,'focus must stay in modal');
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await trigger.evaluate(el=>el===document.activeElement),true,'focus should return to trigger');
 await trigger.click();await page.evaluate(()=>{window.__failCheck=true;});await page.getByRole('button',{name:'업데이트 확인',exact:true}).click();
 await page.getByRole('heading',{name:'업데이트를 마치지 못했어'}).waitFor();await page.getByRole('button',{name:'다시 시도',exact:true}).click();
 await page.getByRole('heading',{name:'새 버전이 도착했어'}).waitFor();assert.equal(await page.evaluate(()=>window.__updateCalls.check),2);
 await page.getByText('<script>window.__bad=true</script>',{exact:false}).waitFor();assert.equal(await page.evaluate(()=>window.__bad),undefined);
 await page.getByRole('button',{name:'업데이트 다운로드'}).click();await page.evaluate(()=>window.__updateEmit({...window.__updateState,phase:'downloading',progress:47}));
 await page.getByText('47%',{exact:true}).waitFor();assert.equal(await page.getByRole('progressbar').getAttribute('value'),'47');
 await page.getByRole('button',{name:'업데이트 창 닫기'}).click();await dialog.waitFor({state:'hidden'});
 await page.evaluate(()=>window.__finishDownload());await page.getByRole('button',{name:'업데이트: 새 버전이 있어'}).click();
 await page.getByRole('heading',{name:'업데이트 준비가 끝났어'}).waitFor();assert.equal(await page.evaluate(()=>window.__updateCalls.install),0,'ready must not install automatically');
 await mkdir(results,{recursive:true});
 await page.screenshot({path:join(results,'update-ready.png')});
 await page.getByRole('button',{name:'재시작하고 적용',exact:true}).click();
 await page.getByRole('heading',{name:'새 버전으로 다시 만날게'}).waitFor();assert.equal(await page.evaluate(()=>window.__updateCalls.install),1);
 const web=await browser.newPage({viewport:{width:680,height:650}});web.on('pageerror',err=>errors.push(err.message));await web.goto(appUrl);
 await web.getByRole('button',{name:'업데이트',exact:true}).click();await web.getByText('업데이트는 설치된 앱에서 할 수 있어.',{exact:false}).waitFor();
 await web.getByRole('button',{name:'알겠어'}).click();await web.getByRole('dialog').waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['no automatic check/install','subscription cleanup','focus trap','Escape closes and restores focus','check failure/retry','plaintext release notes','download progress','download continues when dialog closed','explicit restart install','browser guidance'],pageErrors:errors}));
}finally{await browser.close()}
