const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { startBroker } = require('./mini-broker.cjs');
const server = http.createServer((req,res) => {
 const name = req.url.split('?')[0];
 const allowed = ['/', '/launchpad-scoreboard.html','/finish-camera.css','/finish-camera.js','/finish-detector.js','/qr.js','/relay-link.js'];
 if (!allowed.includes(name)) {res.writeHead(404);res.end();return;}
 const file = name === '/' ? '/launchpad-scoreboard.html' : name;
 res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html');
 res.end(fs.readFileSync(path.join(root,file)));
});
let browser, broker;
(async()=> {
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 broker = await startBroker();
 const url = `http://localhost:${server.address().port}/launchpad-scoreboard.html`;
 const relay = `broker=${encodeURIComponent(broker.url)}`;
 browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch({ ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {}),headless:true });
 fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
 const errors=[];
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 // Separate contexts = separate devices (no shared storage).
 const phoneContext=await browser.newContext({viewport:{width:1280,height:900}});
 const host=await context.newPage(), phone=await phoneContext.newPage();
 for(const p of [host,phone]) p.on('pageerror',e=>errors.push(e.message));
 await host.goto(`${url}?${relay}`); await phone.goto(url);
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
 // QR pairing: computer shows a code, phone opens the QR link and joins by itself.
 await host.locator('#pairHost').click();
 await host.waitForFunction(()=>!!document.querySelector('#pairQr svg'));
 const code=(await host.locator('#pairCode').innerText()).replace(/\s/g,'');
 assert.match(code,/^[A-HJ-NP-Z2-9]{6}$/);
 await phone.goto(`${url}?pair=${code}&b=0&${relay}`);
 await host.waitForFunction(()=>document.getElementById('pairStatus').textContent.startsWith('Phone connected'));
 await phone.waitForFunction(()=>document.getElementById('pairStatus').textContent.startsWith('Computer connected'));
 // Phone had 1 point from its standalone race; on pairing it takes the computer's score.
 await phone.waitForFunction(()=>document.getElementById('scoreA').textContent==='0');
 console.log('PASS QR link pairing connects both devices with no copy/paste; phone adopts computer score');
 await syntheticCamera(phone);
 await phone.locator('#cameraStart').click();
 await phone.waitForFunction(()=>!document.getElementById('raceCalibrate').disabled);
 await phone.locator('#raceCalibrate').click();
 await phone.waitForFunction(()=>!document.getElementById('raceArm').disabled);
 await phone.locator('#raceArm').click();
 await phone.evaluate(()=>window.balls=[{x:440,y:240}]);await phone.waitForTimeout(150);
 await phone.evaluate(()=>window.balls=[{x:440,y:280}]);
 await phone.waitForFunction(()=>document.getElementById('raceDelivery').textContent==='Computer confirmed the result.');
 assert.equal(await host.locator('#scoreB').innerText(),'1');
 await phone.waitForFunction(()=>document.getElementById('scoreB').textContent==='1');
 await phone.locator('#raceResend').evaluate(el=>el.click());await phone.waitForTimeout(300);
 assert.equal(await host.locator('#scoreB').innerText(),'1');
 console.log('PASS relay phone blue crossing -> host award -> receipt; resend deduplicated');
 // Relay drop: both sides reconnect by themselves.
 broker.dropAll();
 await host.waitForFunction(()=>document.getElementById('pairStatus').textContent.startsWith('Phone connected'),null,{timeout:15000});
 await phone.waitForFunction(()=>document.getElementById('pairStatus').textContent.startsWith('Computer connected'),null,{timeout:15000});
 // Computer reload keeps the same code, so the phone reconnects without rescanning.
 await host.reload();
 assert.equal((await host.locator('#pairCode').innerText()).replace(/\s/g,''),code);
 await host.waitForFunction(()=>document.getElementById('pairStatus').textContent.startsWith('Phone connected'),null,{timeout:15000});
 console.log('PASS automatic reconnect after relay drop and computer reload');
 // Close crossing needs review; no automatic award, double manual click still one.
 await phone.evaluate(()=>window.balls=[]);await phone.locator('#raceCalibrate').click();
 await phone.waitForFunction(()=>!document.getElementById('raceArm').disabled);await phone.locator('#raceArm').click();
 await phone.evaluate(()=>window.balls=[{x:140,y:240},{x:440,y:240}]);await phone.waitForTimeout(150);
 await phone.evaluate(()=>window.balls=[{x:140,y:280},{x:440,y:280}]);
 await phone.waitForFunction(()=>document.getElementById('raceWinner').textContent==='Too close to call');
 assert.equal(await host.locator('#scoreA').innerText(),'0');assert.equal(await host.locator('#scoreB').innerText(),'1');
 await phone.locator('#raceChooseRed').click();
 await phone.waitForFunction(()=>document.getElementById('raceDelivery').textContent==='Computer confirmed the result.');
 await phone.locator('#raceChooseRed').evaluate(el=>el.click());await phone.waitForTimeout(300);assert.equal(await host.locator('#scoreA').innerText(),'1');
 console.log('PASS close finish defers scoring to review, manual award once');
 // Live two-way score sync for manual changes.
 await phone.locator('[data-t=a][data-d="1"]').click();
 await host.waitForFunction(()=>document.getElementById('scoreA').textContent==='2');
 await host.locator('[data-t=b][data-d="-1"]').click();
 await phone.waitForFunction(()=>document.getElementById('scoreB').textContent==='0');
 await phone.locator('#undoBtn').click();
 await host.waitForFunction(()=>document.getElementById('scoreB').textContent==='1');
 await phone.waitForTimeout(3000);
 assert.deepEqual([await host.locator('#scoreA').innerText(),await host.locator('#scoreB').innerText()],['2','1']);
 assert.deepEqual([await phone.locator('#scoreA').innerText(),await phone.locator('#scoreB').innerText()],['2','1']);
 console.log('PASS live score sync phone -> computer and computer -> phone, stable after pings');
 // Typed code path (no QR scanner) on a third device.
 const typedContext=await browser.newContext(); const typed=await typedContext.newPage();
 typed.on('pageerror',e=>errors.push(e.message));
 await typed.goto(`${url}?${relay}`);
 await typed.locator('#pairInput').fill(code.slice(0,3).toLowerCase()+' '+code.slice(3));
 await typed.locator('#pairJoin').click();
 await typed.waitForFunction(()=>document.getElementById('pairStatus').textContent.startsWith('Computer connected'),null,{timeout:15000});
 assert.ok(typed.url().includes(`pair=${code}`));
 await typed.locator('#pairDisconnect').click();
 assert.ok((await typed.locator('#pairStatus').innerText()).startsWith('Not connected'));
 await typedContext.close();
 await host.locator('#pairDisconnect').click();
 console.log('PASS typed pairing code and disconnect');
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
 await browser.close(); server.close(); broker.close();
})().catch(async e=>{console.error(e);await browser?.close();server.close();broker?.close();process.exitCode=1;});
