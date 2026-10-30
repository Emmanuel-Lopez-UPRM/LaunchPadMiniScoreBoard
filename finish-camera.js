/* Camera controller and optional serverless WebRTC result link. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const video = $('raceVideo'), overlay = $('raceOverlay');
  const sample = document.createElement('canvas'), ctx = sample.getContext('2d', { willReadFrequently:true });
  let stream = null, detector = null, phase = 'off', calibrationStart = null;
  let lastWallFrame = null, videoCallback = null, animationCallback = null;
  let lastPlaybackTime = null, lastDecodedFrames = null, lastVideoSignal = null;
  let race = null, evidence = null, wakeLock = null, starting = false;
  let peer = null, channel = null, role = null, pairingBusy = false;
  let deliveryTimer = null;
  const receipts = new Set();
  try { JSON.parse(localStorage.getItem('raceReceipts') || '[]').forEach(id => receipts.add(id)); } catch (_) {}
  const status = (message, state = '') => { $('raceStatus').textContent = message; $('raceStatus').dataset.state = state; };
  const paired = () => channel?.readyState === 'open';
  const teamForLane = lane => (lane === 0) === ($('raceRedLane').value === 'first') ? 'a' : 'b';
  const laneName = team => team === 'a' ? 'Red' : 'Blue';
  function settings() {
    return { axis:$('raceAxis').value, reverse:$('raceDirection').value === 'reverse', line:+$('raceLine').value / 100,
      split:+$('raceSplit').value / 100, margin:+$('raceMargin').value / 100, threshold:+$('raceSensitivity').value, minPixels:6 };
  }
  function controls() {
    const live = !!stream, busy = phase === 'armed' || phase === 'calibrating';
    $('cameraStart').disabled = live || starting;
    $('cameraStop').disabled = !live;
    $('raceCalibrate').disabled = !live || busy;
    $('raceArm').disabled = !live || phase !== 'ready' || (role === 'camera' && !paired());
    $('raceCancel').disabled = !busy;
    $('raceSettings').querySelectorAll('input,select').forEach(el => { el.disabled = busy; });
  }
  function resetCalibration(message = 'Settings changed. Calibrate the empty track again.') {
    detector = null; phase = stream ? 'preview' : 'off';
    status(message); controls(); drawOverlay(); releaseWakeLock();
  }
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
  async function startCamera() {
    if (starting || stream) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      status('Camera access requires an HTTPS website (or localhost on this device). Open the hosted site in Safari or Chrome.', 'error'); return;
    }
    starting = true; controls(); status('Requesting rear camera…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 }, frameRate:{ ideal:60 } }, audio:false });
      video.srcObject = stream;
      await video.play();
      if (!video.videoWidth) throw new Error('Camera did not provide video.');
      sample.width = 320; sample.height = Math.round(320 * video.videoHeight / video.videoWidth);
      overlay.width = video.videoWidth; overlay.height = video.videoHeight;
      $('cameraStage').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      $('cameraPlaceholder').hidden = true;
      stream.getVideoTracks()[0].addEventListener('ended', () => stopCamera('Camera disconnected. Race cancelled.'));
      video.addEventListener('resize', cameraResize);
      resetCalibration('Camera ready. Align the finish and lane divider, then calibrate the empty track.');
      scheduleFrame();
    } catch (error) {
      stopCamera();
      status(error.name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access in your browser settings and try again.' : `Could not start camera: ${error.message}`, 'error');
    } finally { starting = false; controls(); }
  }
  function cameraResize() {
    if (!stream || !video.videoWidth) return;
    const height = Math.round(320 * video.videoHeight / video.videoWidth);
    if (height !== sample.height) {
      sample.height = height; overlay.width = video.videoWidth; overlay.height = video.videoHeight;
      $('cameraStage').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      resetCalibration('Camera orientation changed. Race cancelled; recalibrate.');
    }
  }
  function stopCamera(message = 'Camera stopped. Start it again to set up a new race.') {
    if (videoCallback !== null) video.cancelVideoFrameCallback(videoCallback);
    if (animationCallback !== null) cancelAnimationFrame(animationCallback);
    videoCallback = null; animationCallback = null;
    const oldStream = stream; stream = null;
    oldStream?.getTracks().forEach(track => track.stop());
    video.removeEventListener('resize', cameraResize); video.srcObject = null;
    $('cameraPlaceholder').hidden = false;
    lastWallFrame = null; lastPlaybackTime = null; lastDecodedFrames = null; lastVideoSignal = null; resetCalibration(message);
  }
  function scheduleFrame() {
    // Frame callbacks are preferred, but some mobile video pipelines stop calling
    // them while the media clock/decoded frames continue. Keep an independent poll.
    function onVideoFrame(now) {
      videoCallback = null;
      if (!stream) return;
      lastVideoSignal = now;
      frame();
      videoCallback = video.requestVideoFrameCallback(onVideoFrame);
    }
    function poll(now) {
      animationCallback = null;
      if (!stream) return;
      const decoded = video.getVideoPlaybackQuality?.().totalVideoFrames;
      const advanced = video.currentTime !== lastPlaybackTime ||
        (Number.isFinite(decoded) && decoded > (lastDecodedFrames ?? 0));
      if ((lastVideoSignal === null || now - lastVideoSignal > 120) && advanced) frame();
      animationCallback = requestAnimationFrame(poll);
    }
    if (video.requestVideoFrameCallback) videoCallback = video.requestVideoFrameCallback(onVideoFrame);
    animationCallback = requestAnimationFrame(poll);
  }
  function frame() {
    const wallTime = performance.now();
    if (!stream || video.readyState < 2) return;
    try {
      // Use one monotonic clock across both scheduling paths. A delivered video
      // callback proves a fresh frame even when Safari reports a repeated mediaTime.
      const gap = lastWallFrame === null ? 0 : wallTime - lastWallFrame;
      if (phase === 'armed' && gap > 250) {
        resetCalibration('Video frames were interrupted. Race cancelled; recalibrate and retry.');
      }
      lastWallFrame = wallTime;
      lastPlaybackTime = video.currentTime;
      lastDecodedFrames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
      ctx.drawImage(video, 0, 0, sample.width, sample.height);
      const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
      if (phase === 'calibrating') {
        detector.calibrate(data);
        const elapsed = wallTime - calibrationStart;
        const progress = Math.min(99, Math.floor(100 * Math.min(elapsed / 1200, detector.samples / 15)));
        status(`Calibrating empty track… ${progress}% (${detector.samples} frames). Keep the phone still.`);
        if (elapsed >= 1200 && detector.samples >= 15) {
          phase = 'ready'; status('Calibrated. Keep the phone still; arm before releasing the balls.'); controls(); releaseWakeLock();
        }
      } else if (phase === 'armed') {
        const before = detector.crossings.some(Boolean);
        const result = detector.process(data, wallTime / 1000);
        if (result.unstable) { resetCalibration('Large scene change detected. Race cancelled; keep the phone and lighting steady, then recalibrate.'); }
        else {
          if (!before && result.crossings.some(Boolean)) evidence = captureFrame();
          const decision = RaceVision.decide(result.crossings, wallTime / 1000);
          if (decision) finishRace(decision);
        }
      }
      drawOverlay();
    } catch (error) { resetCalibration(`Detection stopped: ${error.message}. Recalibrate to retry.`); }
  }
  function drawOverlay(target = overlay) {
    const c = target.getContext('2d'), w = target.width, h = target.height, s = settings();
    if (target === overlay) c.clearRect(0, 0, w, h);
    c.save();
    // Rotate the drawing coordinate system for left-to-right courses.
    if (s.axis === 'vertical') { c.transform(0, 1, 1, 0, 0, 0); }
    const width = s.axis === 'vertical' ? h : w, height = s.axis === 'vertical' ? w : h;
    const split = width * s.split, line = height * s.line;
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(0,0,width*s.margin,height); c.fillRect(width*(1-s.margin),0,width*s.margin,height);
    c.fillStyle = $('raceRedLane').value === 'first' ? 'rgba(255,50,70,.12)' : 'rgba(60,120,255,.12)'; c.fillRect(width*s.margin,0,split-width*s.margin,height);
    c.fillStyle = $('raceRedLane').value === 'first' ? 'rgba(60,120,255,.12)' : 'rgba(255,50,70,.12)'; c.fillRect(split,0,width*(1-s.margin)-split,height);
    c.lineWidth = Math.max(2, width / 250); c.strokeStyle = '#fff';
    c.setLineDash([width / 50, width / 70]); c.beginPath(); c.moveTo(split,0); c.lineTo(split,height); c.stroke(); c.setLineDash([]);
    c.strokeStyle = phase === 'armed' ? '#72ffad' : '#fff'; c.lineWidth *= 2;
    c.beginPath(); c.moveTo(width*s.margin,line); c.lineTo(width*(1-s.margin),line); c.stroke();
    c.strokeStyle = '#fff'; c.lineWidth /= 2;
    const arrowY = line + (s.reverse ? .16 : -.16) * height, endY = arrowY + (s.reverse ? -.06 : .06) * height;
    c.beginPath(); c.moveTo(width*.5,arrowY); c.lineTo(width*.5,endY); c.lineTo(width*.48,endY + (s.reverse ? .025 : -.025)*height); c.moveTo(width*.5,endY); c.lineTo(width*.52,endY + (s.reverse ? .025 : -.025)*height); c.stroke();
    c.restore();
    c.font = `bold ${Math.max(16, w / 35)}px system-ui`; c.textBaseline = 'top';
    const label = (text, x, y, color) => { c.fillStyle = '#08090c'; c.fillRect(x-4,y-2,c.measureText(text).width+8,Math.max(22,w/28)); c.fillStyle=color; c.fillText(text,x,y); };
    if (s.axis === 'horizontal') {
      label($('raceRedLane').value === 'first' ? 'RED' : 'BLUE', w*(s.margin+.02),h*.04,$('raceRedLane').value === 'first' ? '#ff8995' : '#8eb8ff');
      label($('raceRedLane').value === 'first' ? 'BLUE' : 'RED',w*(s.split+.03),h*.04,$('raceRedLane').value === 'first' ? '#8eb8ff' : '#ff8995');
    } else {
      label($('raceRedLane').value === 'first' ? 'RED' : 'BLUE',w*.03,h*(s.margin+.02), '#fff');
      label($('raceRedLane').value === 'first' ? 'BLUE' : 'RED',w*.03,h*(s.split+.03), '#fff');
    }
  }
  function captureFrame() {
    const photo = document.createElement('canvas'); photo.width = video.videoWidth; photo.height = video.videoHeight;
    photo.getContext('2d').drawImage(video,0,0); drawOverlay(photo);
    return photo.toDataURL('image/jpeg', .85);
  }
  function calibrate() {
    if (!stream) return;
    phase = 'calibrating'; calibrationStart = performance.now();
    detector = new RaceVision.FinishDetector(sample.width, sample.height, settings());
    status('Calibrating empty track… 0%. Keep balls and hands away for two seconds.'); requestWakeLock(); controls();
    // Safari may suspend offscreen inline video. Bring the preview into view and
    // resume playback within the user's tap rather than waiting on a frozen clock.
    $('raceStatus').scrollIntoView({ block:'start' });
    video.play().catch(() => {
      if (phase === 'calibrating') resetCalibration('Camera playback paused. Stop and restart the camera, then calibrate with the preview visible.');
    });
  }
  function arm() {
    if (phase !== 'ready') return;
    // Retain the calibrated background; clear every prior race track.
    detector.previous = [null,null]; detector.crossings = [null,null];
    if (race && !race.delivered && !confirm('The previous result is unresolved or has not been confirmed by the computer. Discard it and start a new race?')) return;
    race = { id:crypto.randomUUID(), winner:null, resolved:false, delivered:false };
    evidence = null; phase = 'armed'; lastWallFrame = performance.now();
    $('raceResult').hidden = true; $('raceResend').hidden = true;
    status('ARMED · release the balls. Watching both lanes.', 'armed'); requestWakeLock(); controls();
  }
  function finishRace(decision) {
    phase = 'finished'; controls(); releaseWakeLock();
    $('raceResult').hidden = false; $('raceReview').hidden = !decision.close;
    $('racePhoto').src = evidence; $('raceDownload').href = evidence;
    $('raceWinner').textContent = decision.close ? 'Too close to call' : `${laneName(teamForLane(decision.winner === 'a' ? 0 : 1))} lane wins!`;
    $('raceResultDetail').textContent = decision.close ? 'Both crossing intervals overlap. Review the finish and choose a lane, or declare a tie. No point awarded yet.' : 'The leading edge crossed first in this lane. One point per race; calibrate again for the next race.';
    $('raceDelivery').textContent = decision.close ? 'Waiting for your decision.' : '';
    status(decision.close ? 'Close finish · human review required.' : 'Finish detected. Result locked until the next race.');
    if (!decision.close) resolveRace(teamForLane(decision.winner === 'a' ? 0 : 1));
  }
  function awardOnce(result) {
    if (receipts.has(result.id)) return;
    receipts.add(result.id);
    // Keep ids for this session too; bound only persisted history.
    try { localStorage.setItem('raceReceipts',JSON.stringify([...receipts].slice(-500))); } catch (_) {}
    if (result.winner) window.raceScoreboard.award(result.winner);
  }
  function resolveRace(winner) {
    if (!race || race.resolved) return;
    race.resolved = true; race.winner = winner;
    $('raceReview').hidden = true;
    $('raceResultDetail').textContent = winner ? 'Result locked. One point for the winning lane; recalibrate for the next race.' : 'Tie confirmed. Recalibrate for the next race.';
    status(winner ? 'Finish confirmed. Result locked until the next race.' : 'Tie confirmed. No point awarded.');
    $('raceWinner').textContent = winner ? `${laneName(winner)} lane wins!` : 'Tie · no point awarded';
    if (role === 'camera') sendResult();
    else { awardOnce(race); race.delivered = true; $('raceDelivery').textContent = winner ? 'One point added to this scoreboard.' : 'Tie recorded; scores unchanged.'; }
  }
  function sendResult() {
    if (!race?.resolved || role !== 'camera') return;
    $('raceResend').hidden = false;
    if (!paired()) { $('raceDelivery').textContent = 'Computer disconnected. Result saved on this page; reconnect and resend. No local point added.'; return; }
    channel.send(JSON.stringify({ type:'result', id:race.id, winner:race.winner }));
    $('raceDelivery').textContent = 'Sending result to computer…';
    clearTimeout(deliveryTimer);
    deliveryTimer = setTimeout(() => { $('raceDelivery').textContent = 'No receipt yet. Resend the result; repeated sends never add another point.'; }, 3000);
  }
  // Manual signaling avoids a hosted signaling/database dependency or account setup.
  function disconnect() {
    const oldPeer = peer; peer = null; channel = null; role = null; oldPeer?.close();
    clearTimeout(deliveryTimer); $('pairOutput').value = '';
    $('pairStatus').textContent = 'Not paired. Standalone camera results update this page’s scoreboard.'; controls();
  }
  function setupPeer(newRole) {
    if (phase === 'armed' || phase === 'calibrating') resetCalibration('Pairing changed. Race cancelled; recalibrate.');
    disconnect(); role = newRole;
    peer = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }] });
    const current = peer;
    peer.onconnectionstatechange = () => {
      if (peer !== current) return;
      if (['failed','disconnected','closed'].includes(peer.connectionState)) {
        $('pairStatus').textContent = 'Link interrupted. Re-pair both devices before the next race. Pending results can be resent.';
        if (phase === 'armed') resetCalibration('Computer link lost. Race cancelled; reconnect and recalibrate.');
        controls();
      }
    };
    peer.ondatachannel = event => wireChannel(event.channel);
    return peer;
  }
  function wireChannel(dataChannel) {
    channel = dataChannel;
    dataChannel.onopen = () => {
      $('pairStatus').textContent = role === 'host' ? 'Phone connected. Camera results will add points here and update the Launchpad.' : 'Computer connected. Camera results will score on the computer.'; controls();
    };
    dataChannel.onclose = () => {
      if (channel !== dataChannel) return;
      $('pairStatus').textContent = 'Disconnected. Re-pair before the next race; resend a pending result after reconnecting.';
      if (phase === 'armed') resetCalibration('Computer link lost. Race cancelled; reconnect and recalibrate.'); controls();
    };
    dataChannel.onmessage = event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 2048) return;
        const message = JSON.parse(event.data);
        if (role === 'host' && message.type === 'result' && /^[a-f0-9-]{36}$/i.test(message.id) && ['a','b',null].includes(message.winner)) {
          awardOnce(message);
          $('pairStatus').textContent = message.winner ? `${laneName(message.winner)} lane won. Point received from phone.` : 'Tie received. Scores unchanged.';
          dataChannel.send(JSON.stringify({ type:'receipt', id:message.id }));
        } else if (role === 'camera' && message.type === 'receipt' && message.id === race?.id) {
          race.delivered = true; clearTimeout(deliveryTimer); $('raceDelivery').textContent = 'Computer confirmed the result.'; $('raceResend').hidden = true;
        }
      } catch (_) { $('pairStatus').textContent = 'Could not process a result. Check the score and resend from the phone.'; }
    };
  }
  async function codeFor(current) {
    if (current.iceGatheringState !== 'complete') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Network setup timed out. Try again on the same Wi-Fi.')); },15000);
        const check = () => { if (current.iceGatheringState === 'complete') { cleanup(); resolve(); } };
        function cleanup() { clearTimeout(timer); current.removeEventListener('icegatheringstatechange',check); }
        current.addEventListener('icegatheringstatechange',check); check();
      });
    }
    if (peer !== current) throw new Error('Pairing was cancelled.');
    return btoa(JSON.stringify({ version:1, description:current.localDescription }));
  }
  function readCode(type) {
    const input = $('pairInput').value.replace(/\s/g,'');
    if (input.length > 50000) throw new Error('Setup code is too long.');
    const code = JSON.parse(atob(input));
    if (code.version !== 1 || code.description?.type !== type || typeof code.description.sdp !== 'string') throw new Error(`Paste the ${type === 'offer' ? 'computer code' : 'phone reply'}.`);
    return code.description;
  }
  async function pairing(action) {
    if (pairingBusy) return;
    pairingBusy = true;
    ['pairHost','pairJoin','pairFinish','pairDisconnect'].forEach(id => { $(id).disabled = true; });
    $('pairStatus').textContent = 'Preparing connection…';
    try {
      if (action === 'host') {
        const current = setupPeer('host'); wireChannel(current.createDataChannel('race-results'));
        await current.setLocalDescription(await current.createOffer()); $('pairOutput').value = await codeFor(current);
        $('pairStatus').textContent = 'Computer code ready. Send it to the phone, then paste the phone reply and finish pairing here.';
      } else if (action === 'join') {
        const description = readCode('offer'), current = setupPeer('camera');
        await current.setRemoteDescription(description); await current.setLocalDescription(await current.createAnswer());
        $('pairOutput').value = await codeFor(current);
        $('pairStatus').textContent = 'Phone reply ready. Send it to the computer and finish pairing there.';
      } else {
        if (!peer || role !== 'host') throw new Error('Create a computer code first.');
        await peer.setRemoteDescription(readCode('answer')); $('pairStatus').textContent = 'Connecting… If it fails, try the same Wi-Fi and create new codes.';
      }
    } catch (error) { $('pairStatus').textContent = `Pairing failed: ${error.message}`; }
    finally { pairingBusy = false; ['pairHost','pairJoin','pairFinish','pairDisconnect'].forEach(id => { $(id).disabled = false; }); controls(); }
  }
  $('cameraStart').onclick = startCamera; $('cameraStop').onclick = () => stopCamera();
  $('raceCalibrate').onclick = calibrate; $('raceArm').onclick = arm;
  $('raceCancel').onclick = () => resetCalibration('Race cancelled. Calibrate the empty track to start again.');
  $('raceSettings').querySelectorAll('input,select').forEach(el => el.addEventListener('input', () => {
    for (const name of ['Line','Split','Margin']) $('race'+name+'Value').textContent = $('race'+name).value+'%';
    resetCalibration();
  }));
  $('raceChooseRed').onclick = () => resolveRace('a'); $('raceChooseBlue').onclick = () => resolveRace('b'); $('raceChooseTie').onclick = () => resolveRace(null);
  $('raceResend').onclick = sendResult;
  $('pairHost').onclick = () => pairing('host'); $('pairJoin').onclick = () => pairing('join'); $('pairFinish').onclick = () => pairing('finish');
  $('pairDisconnect').onclick = () => { if (phase === 'armed') resetCalibration('Link disconnected. Race cancelled; recalibrate.'); disconnect(); };
  $('pairCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('pairOutput').value); $('pairStatus').textContent = 'Code copied. Paste it on the other device.'; }
    catch (_) { $('pairOutput').select(); $('pairStatus').textContent = 'Select and copy the generated code, then paste it on the other device.'; }
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden && ['armed','calibrating'].includes(phase)) resetCalibration('Page was hidden. Race cancelled; recalibrate before racing.'); });
  window.addEventListener('scoreboard-reset', () => { if (['armed','calibrating'].includes(phase)) resetCalibration('Scoreboard reset. Race cancelled; recalibrate.'); });
  window.addEventListener('pagehide', () => { stopCamera(); disconnect(); });
  setInterval(() => {
    if (phase === 'calibrating' && performance.now() - calibrationStart > 8000) {
      resetCalibration('Calibration could not read enough camera frames. Keep the preview visible, stop and restart the camera, then try again.');
      $('raceStatus').dataset.state = 'error';
    }
    if (phase === 'armed' && lastWallFrame !== null && performance.now() - lastWallFrame > 500) resetCalibration('Camera stopped delivering frames. Race cancelled; recalibrate.');
  },250);
  drawOverlay(); controls();
})();
