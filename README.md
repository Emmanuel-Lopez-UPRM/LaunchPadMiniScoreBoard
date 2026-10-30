# Launchpad Mini Scoreboard

A static website controlling a Novation Launchpad Mini MK3 over Web MIDI, with a phone-camera finish judge for a two-lane ball race. No build step, paid service, account, or video upload required.

## Open on a phone

The camera needs **HTTPS** (or localhost on the same device). Opening a laptop’s `http://192.168…` address on a phone will not allow camera access.

After merging this feature, a repository administrator can enable **Settings → Pages → Deploy from a branch → main → /(root)**. Once GitHub reports a successful deployment, open:

https://emmanuel-lopez-uprm.github.io/LaunchPadMiniScoreBoard/

This address only works after Pages is enabled and deployed. Alternatively, put the repository’s HTML, JS, and CSS files on any HTTPS static host. Keep these files together; the HTML is no longer self-contained.

For local desktop development: `python3 -m http.server 8000`, then open `http://localhost:8000`. Run detector tests with `node --test tests/*.test.cjs` (or `npm test`).

For browser integration tests, run `npm ci`, `npx playwright install chromium`, and `npm run test:browser`. The suite starts its own local web server and a tiny local MQTT relay (`tests/mini-broker.cjs`), feeds generated ball footage through a real video element, pairs two pages with the QR link and the typed code, and checks one-time scoring, close-finish review, camera errors, cancellation, and phone layouts. Set `BROWSER_EXECUTABLE` to use an existing Chrome installation instead of Playwright’s browser. For Safari-engine camera checks, install WebKit with `npx playwright install webkit`, then run `TEST_BROWSER=webkit TEST_CAMERA_ONLY=1 npm run test:browser`. This checks repeated video timestamps, missing frame callbacks, the animation-frame fallback, and frozen-feed recovery without the pairing steps. These are simulated-camera tests; a physical phone, real track, and connected Launchpad still need an on-site trial.

## Camera finish setup

1. Open the site in Safari or Chrome on your phone. Choose **Start rear camera** and allow access. Video is processed locally and is never transmitted.
2. Fix the phone in place. Both lanes must be visible at their finish positions. Aim the camera so the straight digital finish line matches the real finish line for both lanes; an overhead view generally makes alignment easier.
3. Set horizontal/vertical orientation, travel direction, red lane position, finish line, and lane divider. The arrows show travel direction. The shaded outside edges and narrow divider gap are ignored. Red lane maps to the left scoreboard team, blue to the right, regardless of edited team names/colors.
4. With an empty track, press **Calibrate empty track**. Keep the phone and lighting still. Wait for “Calibrated,” then **Arm race** before releasing the balls. Calibration shows frame/progress updates and normally finishes in about two seconds. On iPhone Safari, keep the camera preview visible. If it cannot read enough frames within eight seconds, it stops with a recovery message; stop/restart the camera and try again.
5. The first detected crossing wins and adds exactly one point. The result locks; recalibrate and arm for each subsequent race. If crossing intervals overlap, the site requests a human decision and awards no point until you choose a lane. A tie awards no points.
6. Download the first-crossing frame for reference. Use the existing **Undo** control to reverse an incorrect award on the device that received the point.

The detector compares connected regions against the calibrated track, tracks the leading edge within each lane, and requires an observed approach followed by a crossing in the configured direction. Balls do **not** need to be red or blue. Keep the ball clearly visible before it reaches the line, and use a background with good contrast. Test both lanes at actual race speed; adjust sensitivity if needed.

## Phone camera → computer → Launchpad

Phones can run the camera even though they can't control the Launchpad. Let the computer keep the official score:

1. On the computer (Chrome or Edge, Launchpad plugged in), open the site and press **Show pairing QR code**.
2. On the phone, point the regular camera app at the QR code and open the link. It connects by itself. If the phone can't scan, type the 6-character code under the QR code and press **Connect to computer**.
3. Wait for **Phone connected** on the computer and **Computer connected** on the phone. Then run races on the phone as usual.

While connected, the score is shared live: race results, +/−, Undo and Reset on either device (and the Launchpad buttons) update the other device within a moment. When the phone connects it first takes the computer's score.

The computer remembers its code. If either page is reloaded, or the internet drops for a moment, both sides reconnect by themselves, so there's no need to scan again. Use **Make a new code** to stop an old phone from sending results.

How it works: both pages join a private "room" (the code) on a free public MQTT relay (HiveMQ's public broker, with EMQX's as a backup) over a secure WebSocket. Only tiny JSON messages travel: pings, a result ID with the winning lane, and the computer's receipt. No video is sent. There is no account, server or library to install. The QR generator (`qr.js`) and relay client (`relay-link.js`) are small dependency-free files in this repo.

Both devices need internet access, but they don't have to be on the same network: phone on cellular and computer on school Wi-Fi works. A finished result is kept on the phone and sent again automatically until the computer confirms it. Duplicate result IDs never add another point, even after a computer reload.

Public relays are shared: anyone who learns your code could send a fake result during the event. That's fine for an open house. Make a new code if you suspect a problem, and use **Undo** on the computer to fix a wrong point.

## Limits and race fairness

- This is a motion-based prototype, not a certified high-speed timing system. It identifies a lane’s moving foreground, not the semantic identity of a ball. Hands, moving shadows, reflections, or a moving phone can cause false triggers.
- Keep the track empty during calibration. Very small, low-contrast, blurred, occluded, or fast balls may be missed, particularly if they cross between camera frames without a visible approach. Processing uses a 320-pixel-wide image to keep phone usage light.
- Results are frame intervals, not precise millisecond timings. Overlapping intervals require review. The downloaded image is a sampled reference frame, not definitive evidence of an exact tie. No full race video is recorded.
- Large scene changes, frame gaps over 250 ms, camera orientation changes, a hidden camera tab, and camera disconnects cancel detection. Recalibrate before retrying. Screen wake lock is requested when available, but keep an eye on the phone.
- Changing detector settings requires calibration again. Normal manual scoreboard controls and Launchpad views remain available.

Browser API references: [camera permissions and HTTPS](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [per-frame callbacks](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback), [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket), [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
