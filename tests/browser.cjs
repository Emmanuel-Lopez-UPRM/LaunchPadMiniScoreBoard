const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req,res) => {
 const name = req.url.split('?')[0];
 const allowed = ['/', '/launchpad-scoreboard.html','/finish-camera.css','/finish-camera.js','/finish-detector.js'];
 if (!allowed.includes(name)) {res.writeHead(404);res.end();return;}
 const file = name === '/' ? '/launchpad-scoreboard.html' : name;
 res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html');
 res.end(fs.readFileSync(path.join(root,file)));
});
let browser;
(async()=> {
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 const url = `http://localhost:${server.address().port}/launchpad-scoreboard.html`;
 browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch({ ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {}),headless:true });
 fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
 const errors=[];
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 const host=await context.newPage(), phone=await context.newPage();
 for(const p of [host,phone]) {
  p.on('pageerror',e=>errors.push(e.message));
  await p.goto(url);
 }
 async function syntheticCamera(page, mode = 'normal') {
  await page.evaluate(mode=>{
   const canvas=document.createElement('canvas'); canvas.width=640;canvas.height=480;
   const c=canvas.getContext('2d'); window.balls=[];
   function paint(){c.fillStyle='#101010';c.fillRect(0,0,640,480);c.fillStyle='#fff';for(const ball of window.balls)c.fillRect(ball.x,ball.y,24,24);}
   paint();setInterval(paint,33);
   navigator.mediaDevices.getUserMedia=async()=>canvas.captureStream(30);
   const video=document.getElementById('raceVideo');
   const original=video.requestVideoFrameCallback?.bind(video);
   if (mode === 'repeatedTimestamp' && original) {
    video.requestVideoFrameCallback=callback=>original((now,metadata)=>callback(now,{...metadata,mediaTime:0}));
   }
   if (['missingCallbacks','frozen'].includes(mode)) {
    video.requestVideoFrameCallback=()=>1; video.cancelVideoFrameCallback=()=>{};
   }
   if (mode === 'noFrameApi') video.requestVideoFrameCallback=undefined;
   if (mode === 'frozen') Object.defineProperty(video,'currentTime',{get:()=>0});
   if (mode === 'frozen') {
    video.getVideoPlaybackQuality=()=>({totalVideoFrames:0});
   }
  },mode);
 }
 await syntheticCamera(phone);
 await phone.locator('#cameraStart').click();
 await phone.waitForFunction(()=>!document.getElementById('raceCalibrate').disabled);
 await phone.locator('#raceCalibrate').click();
 await phone.waitForFunction(()=>!document.getElementById('raceArm').disabled);
 await phone.locator('#raceArm').click();
 await phone.evaluate(()=>window.balls=[{x:140,y:240}]);
 await phone.waitForTimeout(150);
 await phone.evaluate(()=>window.balls=[{x:140,y:280}]);
 await phone.waitForFunction(()=>document.getElementById('raceWinner').textContent==='Red lane wins!');
 assert.equal(await phone.locator('#scoreA').innerText(),'1');
 assert.ok((await phone.locator('#racePhoto').getAttribute('src')).startsWith('data:image/jpeg'));
 await phone.waitForTimeout(300); assert.equal(await phone.locator('#scoreA').innerText(),'1');
 console.log('PASS standalone red crossing, snapshot, one point only');
 if (!process.env.TEST_CAMERA_ONLY) {
 // Real peer connection between two pages with no mocked network APIs.
 for(const p of [host,phone]) await p.locator('#racePairing').evaluate(el=>el.open=true);
 await host.locator('#pairHost').click();
 await host.waitForFunction(()=>document.getElementById('pairOutput').value.length>100);
 await phone.locator('#pairInput').fill(await host.locator('#pairOutput').inputValue());
 await phone.locator('#pairJoin').click();
 await phone.waitForFunction(()=>document.getElementById('pairOutput').value.length>100);
 await host.locator('#pairInput').fill(await phone.locator('#pairOutput').inputValue());
 await host.locator('#pairFinish').click();
 await host.waitForFunction(()=>document.getElementById('pairStatus').textContent.startsWith('Phone connected'));
 await phone.waitForFunction(()=>document.getElementById('pairStatus').textContent.startsWith('Computer connected'));
 await phone.evaluate(()=>window.balls=[]);
 await phone.locator('#raceCalibrate').click();
 await phone.waitForFunction(()=>!document.getElementById('raceArm').disabled);
 await phone.locator('#raceArm').click();
 await phone.evaluate(()=>window.balls=[{x:440,y:240}]);await phone.waitForTimeout(150);
 await phone.evaluate(()=>window.balls=[{x:440,y:280}]);
 await phone.waitForFunction(()=>document.getElementById('raceDelivery').textContent==='Computer confirmed the result.');
 assert.equal(await host.locator('#scoreB').innerText(),'1');
 assert.equal(await phone.locator('#scoreB').innerText(),'0');
 await phone.locator('#raceResend').evaluate(el=>el.click());await phone.waitForTimeout(150);
 assert.equal(await host.locator('#scoreB').innerText(),'1');
 console.log('PASS real WebRTC phone blue crossing -> host award -> receipt; resend deduplicated');
 // Close crossing needs review; no automatic award, double manual click still one.
 await phone.evaluate(()=>window.balls=[]);await phone.locator('#raceCalibrate').click();
 await phone.waitForFunction(()=>!document.getElementById('raceArm').disabled);await phone.locator('#raceArm').click();
 await phone.evaluate(()=>window.balls=[{x:140,y:240},{x:440,y:240}]);await phone.waitForTimeout(150);
 await phone.evaluate(()=>window.balls=[{x:140,y:280},{x:440,y:280}]);
 await phone.waitForFunction(()=>document.getElementById('raceWinner').textContent==='Too close to call');
 assert.equal(await host.locator('#scoreA').innerText(),'0');assert.equal(await host.locator('#scoreB').innerText(),'1');
 await phone.locator('#raceChooseRed').click();
 await phone.waitForFunction(()=>document.getElementById('raceDelivery').textContent==='Computer confirmed the result.');
 await phone.locator('#raceChooseRed').evaluate(el=>el.click());assert.equal(await host.locator('#scoreA').innerText(),'1');
 console.log('PASS close finish defers scoring to review, manual award once');
 }
 // Mobile sizing, portrait and landscape, camera stop.
 await phone.setViewportSize({width:375,height:812});await phone.screenshot({path:path.join(root,'test-results','mobile.png'),fullPage:true});
 assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await phone.setViewportSize({width:812,height:375});assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await phone.evaluate(()=>window.balls=[]);await phone.locator('#raceCalibrate').click();
 await phone.waitForFunction(()=>!document.getElementById('raceArm').disabled);await phone.locator('#raceArm').click();
 await phone.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 assert.ok((await phone.locator('#raceStatus').innerText()).includes('Race cancelled'));
 assert.equal(await phone.locator('#raceArm').isDisabled(),true);
 console.log('PASS hidden camera page cancels armed race');
 await phone.locator('#cameraStop').click();assert.equal(await phone.locator('#raceArm').isDisabled(),true);
 const denied=await context.newPage();await denied.goto(url);
 await denied.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError')};});
 await denied.locator('#cameraStart').click();assert.ok((await denied.locator('#raceStatus').innerText()).includes('permission denied'));
 console.log('PASS 375px and landscape layouts; camera stop and permission denial');
 // Regression: calibration must not depend on mediaTime advancing, or on
 // requestVideoFrameCallback being delivered. Frozen input must time out safely.
 for (const mode of ['repeatedTimestamp','missingCallbacks','noFrameApi','frozen']) {
  const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await syntheticCamera(page,mode);
  const scoreBefore = Number(await page.locator('#scoreA').innerText());
  await page.locator('#cameraStart').click();
  await page.waitForFunction(()=>!document.getElementById('raceCalibrate').disabled);
  await page.locator('#raceCalibrate').click();
  if (mode === 'frozen') {
   await page.waitForFunction(()=>document.getElementById('raceStatus').textContent.includes('could not read enough'),null,{timeout:11000});
   assert.equal(await page.locator('#raceArm').isDisabled(),true);
   assert.equal(await page.locator('#raceCalibrate').isEnabled(),true);
   assert.equal(Number(await page.locator('#scoreA').innerText()),scoreBefore);
  } else {
   await page.waitForFunction(()=>!document.getElementById('raceArm').disabled,null,{timeout:6000});
   assert.ok((await page.locator('#raceStatus').innerText()).startsWith('Calibrated.'));
   await page.locator('#raceArm').click();
   await page.evaluate(()=>window.balls=[{x:140,y:240}]);await page.waitForTimeout(150);
   await page.evaluate(()=>window.balls=[{x:140,y:280}]);
   await page.waitForFunction(expected=>Number(document.getElementById('scoreA').textContent)===expected,scoreBefore+1);
  }
  await page.locator('#cameraStop').click();await page.close();
  console.log(`PASS calibration regression: ${mode}`);
 }
 assert.deepEqual(errors,[]);console.log('PASS no uncaught browser errors');
 await browser.close(); server.close();
})().catch(async e=>{console.error(e);await browser?.close();server.close();process.exitCode=1;});
