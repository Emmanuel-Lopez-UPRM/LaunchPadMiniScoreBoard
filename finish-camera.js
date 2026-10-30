/* Camera controller and optional phone → computer result link (QR-code pairing). */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const video = $('raceVideo'), overlay = $('raceOverlay');
  const sample = document.createElement('canvas'), ctx = sample.getContext('2d', { willReadFrequently:true });
  let stream = null, detector = null, phase = 'off', calibrationStart = null;
  let lastWallFrame = null, videoCallback = null, animationCallback = null;
  let lastPlaybackTime = null, lastDecodedFrames = null, lastVideoSignal = null;
  let race = null, evidence = null, wakeLock = null, starting = false;
  let role = null;
  let deliveryTimer = null;
  const receipts = new Set();
  try { JSON.parse(localStorage.getItem('raceReceipts') || '[]').forEach(id => receipts.add(id)); } catch (_) {}
  const status = (message, state = '') => { $('raceStatus').textContent = message; $('raceStatus').dataset.state = state; };
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
  function sendResult(quiet = false) {
    if (!race?.resolved || role !== 'camera') return;
    $('raceResend').hidden = race.delivered;
    if (race.delivered) return;
    if (!paired()) { $('raceDelivery').textContent = 'Computer not connected. The result is saved and will be sent automatically when it reconnects. No local point added.'; return; }
    send({ type:'result', id:race.id, winner:race.winner });
    if (quiet) return;
    $('raceDelivery').textContent = 'Sending result to computer…';
    clearTimeout(deliveryTimer);
    deliveryTimer = setTimeout(() => { if (!race?.delivered) $('raceDelivery').textContent = 'No receipt yet. Retrying automatically; repeated sends never add another point.'; }, 4000);
  }
  // ---------- Phone ↔ computer link ----------
  // The computer shows a QR code; the phone scans it and both pages join the same
  // private "room" on a free public MQTT relay. Only tiny JSON messages are sent.
  const query = new URLSearchParams(location.search);
  const BROKERS = query.get('broker') ? [query.get('broker')] : ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let link = null, room = null, peerSeen = -1e9, onlineAt = 0, tickTimer = null, wasPaired = false;
  // Live score sync: every score change bumps a version number; the higher version wins.
  // When a phone (re)connects it first adopts the computer's score ("synced").
  let scoreVersion = 0, synced = false;
  function scoreMsg(type) { const st = window.raceScoreboard.state(); return { type, role, a:st.a, b:st.b, v:scoreVersion, synced: role === 'host' || synced }; }
  window.raceScoreboard.onChange = () => { scoreVersion++; if (link?.online) send(scoreMsg('score')); };
  const okScore = n => Number.isInteger(n) && n >= 0 && n <= 9999;
  function applyScore(message, adopt) {
    if (!okScore(message.a) || !okScore(message.b) || !Number.isInteger(message.v) || message.v < 0) return;
    const st = window.raceScoreboard.state();
    if (adopt) { scoreVersion = message.v; synced = true; }
    else if (message.v > scoreVersion) scoreVersion = message.v;
    else if (!(message.v === scoreVersion && role === 'camera')) return;   // ties: computer wins
    if (st.a !== message.a || st.b !== message.b) window.raceScoreboard.set(message.a, message.b);
  }
  const topic = to => `lpsb/v1/${room}/${to}`;
  function paired() { return !!link?.online && performance.now() - peerSeen < 9000; }
  const newCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map(v => CODE_CHARS[v % 32]).join('');
  const cleanCode = text => String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const validCode = code => /^[A-HJ-NP-Z2-9]{6}$/.test(code);
  function send(obj) { return !!link && link.publish(topic(role === 'host' ? 'cam' : 'host'), obj); }
  function pairUrl() {
    const u = new URL(location.href); u.search = ''; u.hash = '';
    u.searchParams.set('pair', room); u.searchParams.set('b', String(link?.index ?? 0));
    if (query.get('broker')) u.searchParams.set('broker', query.get('broker'));
    return u.href;
  }
  function setPageCode(code) {
    try { const u = new URL(location.href); if (code) u.searchParams.set('pair', code); else { u.searchParams.delete('pair'); u.searchParams.delete('b'); } history.replaceState(null, '', u.href); } catch (_) {}
  }
  function startLink(newRole, code, brokerIndex = 0) {
    if (phase === 'armed' || phase === 'calibrating') resetCalibration('Pairing changed. Race cancelled; recalibrate.');
    stopLink(false);
    role = newRole; room = code; peerSeen = -1e9; wasPaired = false; synced = false;
    link = new RelayLink(BROKERS, { onState: linkState, onMessage: linkMessage });
    link.subscribe(topic(role === 'host' ? 'host' : 'cam'));
    link.start(Math.max(0, Math.min(brokerIndex | 0, BROKERS.length - 1)));
    tickTimer = setInterval(tick, 2500);
    try { if (role === 'host') localStorage.setItem('lpsbHostRoom', room); } catch (_) {}
    if (role === 'camera') setPageCode(room);
    showPairing(); updatePairStatus(); controls();
  }
  function stopLink(forget = true) {
    clearInterval(tickTimer); link?.stop(); link = null;
    if (forget) {
      if (role === 'host') { try { localStorage.removeItem('lpsbHostRoom'); } catch (_) {} }
      if (role === 'camera') setPageCode(null);
      role = null; room = null; wasPaired = false;
      showPairing(); updatePairStatus(); controls();
    }
  }
  function tick() {
    if (!link) return;
    send(scoreMsg('ping'));
    // If the phone reaches a relay but never hears the computer, the computer may
    // be on the other public relay: switch and keep looking.
    if (role === 'camera' && link.online && !paired() && performance.now() - onlineAt > 12000 && BROKERS.length > 1) { onlineAt = performance.now(); link.useNext(); }
    checkPaired();
    if (role === 'camera' && paired() && race?.resolved && !race.delivered) sendResult(true);
  }
  function checkPaired() {
    const now = paired();
    if (now === wasPaired) return;
    wasPaired = now; if (!now) synced = false; updatePairStatus(); controls();
    if (now && role === 'camera' && race?.resolved && !race.delivered) sendResult();
  }
  function linkState(state) {
    if (state === 'online') { onlineAt = performance.now(); send(scoreMsg('ping')); if (role === 'host') showPairing(); }
    checkPaired(); updatePairStatus();
  }
  function linkMessage(_topic, message) {
    if (!message || typeof message !== 'object') return;
    const fromOther = message.role ? message.role !== role : true;
    if (!fromOther) return;
    peerSeen = performance.now();
    if (!wasPaired) { send(scoreMsg('ping')); checkPaired(); }
    if ('a' in message && 'v' in message) {
      if (role === 'camera') applyScore(message, !synced);          // phone: first adopt the computer's score
      else if (message.synced === true) applyScore(message, false); // computer: only trust a phone that has synced
    }
    if (role === 'host' && message.type === 'result' && /^[a-f0-9-]{36}$/i.test(message.id) && ['a','b',null].includes(message.winner)) {
      awardOnce(message);
      $('pairStatus').textContent = message.winner ? `${laneName(message.winner)} lane won. Point received from the phone.` : 'Tie received from the phone. Scores unchanged.';
      send({ type:'receipt', id:message.id });
    } else if (role === 'camera' && message.type === 'receipt' && message.id === race?.id && !race.delivered) {
      race.delivered = true; clearTimeout(deliveryTimer);
      $('raceDelivery').textContent = 'Computer confirmed the result.'; $('raceResend').hidden = true;
    }
  }
  function showPairing() {
    const hosting = role === 'host' && !!room;
    $('pairHostView').hidden = !hosting;
    if (hosting) {
      try { $('pairQr').innerHTML = QR.svg(pairUrl()); } catch (_) { $('pairQr').textContent = ''; }
      $('pairCode').textContent = room.slice(0, 3) + ' ' + room.slice(3);
    }
    $('pairHost').textContent = hosting ? 'Showing pairing code' : 'Show pairing QR code';
    $('pairDisconnect').hidden = !role;
    if (role === 'camera') $('pairInput').value = room;
  }
  function updatePairStatus() {
    let text;
    if (!role) text = 'Not connected. Camera results on this page score on this page’s scoreboard.';
    else if (!link?.online) text = 'Connecting to the internet relay… Both devices need internet access.';
    else if (role === 'host') text = paired() ? 'Phone connected. Camera results will add points here and update the Launchpad.' : 'Waiting for the phone. Scan the QR code with the phone’s camera app and open the link.';
    else text = paired() ? 'Computer connected. Race results will score on the computer.' : `Looking for the computer (code ${room})… Keep the scoreboard page open on the computer.`;
    $('pairStatus').textContent = text;
    $('pairStatus').dataset.state = role && paired() ? 'ok' : '';
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
  $('pairHost').onclick = () => { if (role !== 'host') startLink('host', newCode()); };
  $('pairNew').onclick = () => startLink('host', newCode());
  $('pairJoin').onclick = () => {
    const code = cleanCode($('pairInput').value);
    if (!validCode(code)) { $('pairStatus').textContent = 'Type the 6-character code shown on the computer.'; return; }
    startLink('camera', code, 0);
  };
  $('pairInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('pairJoin').click(); });
  $('pairDisconnect').onclick = () => stopLink(true);
  document.addEventListener('visibilitychange', () => { if (document.hidden && ['armed','calibrating'].includes(phase)) resetCalibration('Page was hidden. Race cancelled; recalibrate before racing.'); });
  window.addEventListener('scoreboard-reset', () => { if (['armed','calibrating'].includes(phase)) resetCalibration('Scoreboard reset. Race cancelled; recalibrate.'); });
  window.addEventListener('pagehide', () => { stopCamera(); link?.stop(); });
  setInterval(() => {
    if (phase === 'calibrating' && performance.now() - calibrationStart > 8000) {
      resetCalibration('Calibration could not read enough camera frames. Keep the preview visible, stop and restart the camera, then try again.');
      $('raceStatus').dataset.state = 'error';
    }
    if (phase === 'armed' && lastWallFrame !== null && performance.now() - lastWallFrame > 500) resetCalibration('Camera stopped delivering frames. Race cancelled; recalibrate.');
  },250);
  // Phone opened from the QR code → join automatically. Computer that was showing
  // a code before a reload → keep the same code so the phone reconnects by itself.
  const linkedCode = cleanCode(query.get('pair'));
  let savedHostRoom = null; try { savedHostRoom = localStorage.getItem('lpsbHostRoom'); } catch (_) {}
  if (validCode(linkedCode)) {
    startLink('camera', linkedCode, +query.get('b') || 0);
    $('racePairing').open = true;
    setTimeout(() => $('finish-camera').scrollIntoView({ block:'start' }), 300);
  } else if (validCode(savedHostRoom || '')) startLink('host', savedHostRoom);
  updatePairStatus(); drawOverlay(); controls();
})();
