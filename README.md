# Launchpad Mini Scoreboard

A static website controlling a Novation Launchpad Mini MK3 over Web MIDI, with a phone-camera finish judge for a two-lane ball race. No build step, paid service, account, or video upload required.

## Open on a phone

The camera needs **HTTPS** (or localhost on the same device). Opening a laptop’s `http://192.168…` address on a phone will not allow camera access.

After merging this feature, a repository administrator can enable **Settings → Pages → Deploy from a branch → main → /(root)**. Once GitHub reports a successful deployment, open:

https://emmanuel-lopez-uprm.github.io/LaunchPadMiniScoreBoard/

This address only works after Pages is enabled and deployed. Alternatively, put the repository’s HTML, JS, and CSS files on any HTTPS static host. Keep these files together; the HTML is no longer self-contained.

For local desktop development: `python3 -m http.server 8000`, then open `http://localhost:8000`. Run detector tests with `node --test tests/*.test.cjs` (or `npm test`).

For browser integration tests, run `npm ci`, `npx playwright install chromium`, and `npm run test:browser`. The suite starts its own local server, feeds generated ball footage through a real video element, pairs two pages over real WebRTC, and checks one-time scoring, close-finish review, camera errors, cancellation, and phone layouts. Set `BROWSER_EXECUTABLE` to use an existing Chrome installation instead of Playwright’s browser. These are simulated-camera tests; a physical phone, real track, and connected Launchpad still need an on-site trial.

## Camera finish setup

1. Open the site in Safari or Chrome on your phone. Choose **Start rear camera** and allow access. Video is processed locally and is never transmitted.
2. Fix the phone in place. Both lanes must be visible at their finish positions. Aim the camera so the straight digital finish line matches the real finish line for both lanes; an overhead view generally makes alignment easier.
3. Set horizontal/vertical orientation, travel direction, red lane position, finish line, and lane divider. The arrows show travel direction. The shaded outside edges and narrow divider gap are ignored. Red lane maps to the left scoreboard team, blue to the right, regardless of edited team names/colors.
4. With an empty track, press **Calibrate empty track**. Keep the phone and lighting still. Wait for “Calibrated,” then **Arm race** before releasing the balls.
5. The first detected crossing wins and adds exactly one point. The result locks; recalibrate and arm for each subsequent race. If crossing intervals overlap, the site requests a human decision and awards no point until you choose a lane. A tie awards no points.
6. Download the first-crossing frame for reference. Use the existing **Undo** control to reverse an incorrect award on the device that received the point.

The detector compares connected regions against the calibrated track, tracks the leading edge within each lane, and requires an observed approach followed by a crossing in the configured direction. Balls do **not** need to be red or blue. Keep the ball clearly visible before it reaches the line, and use a background with good contrast. Test both lanes at actual race speed; adjust sensitivity if needed.

## Phone camera → computer → Launchpad

Phones can run the camera feature even if they do not support Web MIDI. For the Launchpad, use Chrome or Edge on a computer and connect it there.

1. Open the same website on phone and computer. Prefer the same Wi-Fi network. Keep both tabs open and visible.
2. Open **Pair phone with the Launchpad computer** on both devices.
3. On the computer, choose **Create computer code**. Copy the full generated code and transfer it to the phone (for example with your usual clipboard or messaging app).
4. On the phone, paste it in **Code from the other device** and choose **Create phone reply**. Transfer the generated reply back to the computer.
5. On the computer, paste that reply and choose **Finish pairing**. Wait for “Phone connected” / “Computer connected.”
6. Run the camera race on the phone. The computer receives the winning lane, awards a point using the existing score/sound/LED logic, and acknowledges receipt. The phone says **Computer confirmed the result**. The phone’s own score counters are independent; watch the computer for official scores.

Only result IDs and winning lanes travel over the encrypted WebRTC data channel, not video. Signaling is manual to keep this a static website without credentials or a backend. A public Google STUN service helps establish the connection; there is no TURN relay. Some school/public Wi-Fi and cellular network combinations will block direct connections. Try a different Wi-Fi network if pairing fails. Pair again after reloading either page.

A disconnected phone does not fall back to awarding local points while still in camera pairing mode. If a finished result has no receipt, reconnect and choose **Resend result to scoreboard** before starting another race. Duplicate result IDs do not award another point, including after a computer reload when local storage is available. Only pair devices you trust; the paired phone can submit race outcomes.

## Limits and race fairness

- This is a motion-based prototype, not a certified high-speed timing system. It identifies a lane’s moving foreground, not the semantic identity of a ball. Hands, moving shadows, reflections, or a moving phone can cause false triggers.
- Keep the track empty during calibration. Very small, low-contrast, blurred, occluded, or fast balls may be missed, particularly if they cross between camera frames without a visible approach. Processing uses a 320-pixel-wide image to keep phone usage light.
- Results are frame intervals, not precise millisecond timings. Overlapping intervals require review. The downloaded image is a sampled reference frame, not definitive evidence of an exact tie. No full race video is recorded.
- Large scene changes, frame gaps over 250 ms, camera orientation changes, a hidden camera tab, lost pairing during an armed race, and camera disconnects cancel detection. Recalibrate before retrying. Screen wake lock is requested when available, but keep an eye on the phone.
- Changing detector settings requires calibration again. Normal manual scoreboard controls and Launchpad views remain available.

Browser API references: [camera permissions and HTTPS](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [per-frame callbacks](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback), [WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection), [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
