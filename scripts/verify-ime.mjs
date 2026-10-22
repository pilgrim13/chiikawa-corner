import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1000,height:752}});
try {
await page.goto('http://127.0.0.1:5179');
await page.getByText('연결되었어',{exact:true}).waitFor();
await page.screenshot({path:`${process.cwd()}/test-results/onboarding-mac-size.png`,fullPage:true});
await page.getByRole('button',{name:'먼저 혼자 둘러보기'}).click();
const input=page.getByLabel('친구에게 보낼 말');
await input.fill('오늘도 같이 있으니까 좋다 ☁️');
await input.dispatchEvent('compositionstart');
await input.press('Enter');
assert.equal(await page.locator('.message-bubble').count(),2,'IME Enter must not send prematurely');
await input.dispatchEvent('compositionend');
await input.press('Enter');
await page.locator('.message-bubble').filter({hasText:'오늘도 같이 있으니까 좋다'}).waitFor();
await page.locator('.message-bubble').filter({hasText:'응응! 친구와는 이렇게 이야기할 수 있어'}).waitFor();
await page.screenshot({path:`${process.cwd()}/test-results/demo-mac-size.png`,fullPage:true});
console.log(JSON.stringify({passed:true,checks:['Korean IME Enter does not send during composition','Enter sends after composition'],screenshots:['onboarding-mac-size.png','demo-mac-size.png']}));
}finally{await browser.close()}
