# Line Watch: setup (free, about 20 minutes, do it from a personal device)

Three free pieces:

| Piece | What it does | Where |
|---|---|---|
| **ntfy** app | Receives the alert (lock screen + vibration) | iPhone App Store |
| **Cloudflare Worker** | Checks your games every minute, sends the alert | dash.cloudflare.com |
| **Line Watch app** | Pick games and set target lines | GitHub Pages, added to your home screen |

You'll make up two private values along the way. Keep them in your Notes app, not in GitHub:
- **Topic**: your private ntfy channel name. Make it long and random, e.g. `linewatch-k7q2m9xv4t`. Anyone who knows it could see your alerts.
- **App key**: a password between the app and your watcher, e.g. `lw-8hT3pQz1Xc9v`.

---

## 1. ntfy on your iPhone
1. Install **ntfy** from the App Store (free) and allow notifications.
2. Tap **+**, enter your **topic**, and subscribe. Leave the server as `ntfy.sh`.
3. In iPhone **Settings → Notifications → ntfy**, turn on Lock Screen, Banners, Sounds, and **Time Sensitive** if it's listed. Alerts are sent at ntfy's top priority.

## 2. Cloudflare Worker (the watcher)
1. Sign up at **dash.cloudflare.com** (free plan, no card needed).
2. **Workers & Pages → Create → Create Worker**, name it `line-watch`, then **Deploy**.
3. **Edit code**, delete the sample, paste all of `worker/worker.js`, then **Deploy**.
4. **Storage & Databases → KV → Create**, name it `line-watch`.
5. Back on the worker, go to **Settings → Bindings → Add → KV namespace**. Set the variable name to **`WATCH`** (exactly) and pick `line-watch`.
6. **Settings → Variables and Secrets → Add** (type *Secret*):
   - `APP_KEY` = your app key
   - `NTFY_TOPIC` = your topic
7. **Settings → Trigger Events → Add → Cron Triggers**, enter `* * * * *` (every minute).
8. Copy the worker URL shown at the top, like `https://line-watch.<you>.workers.dev`.

## 3. The app on GitHub Pages
1. On github.com (personal account), create a public repo named **`line-watch`**.
2. Upload these files to the repo root: `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icon-180.png`, `icon-192.png`, `icon-512.png`. The `worker` folder isn't needed there.
3. **Settings → Pages → Deploy from branch → main / (root) → Save.**
4. On your iPhone, open `https://dschiemer313.github.io/line-watch/` in **Safari → Share → Add to Home Screen**.

## 4. Connect and test
1. Open Line Watch from the home screen and go to the **Setup** tab. Paste the worker URL and app key, then tap **Save**. It should say *Connected ✓*.
2. Tap **Send test alert**. Lock your phone first and it should buzz.

## Using it
- **Games** tab: pick a league and day, tap a game, tap the team you'd bet on, and set the target, e.g. Celtics **-2**. That means: alert when they're favored by 2 or less.
- The watcher checks every 15 min before the game (catching injury-news moves) and **about every 8 seconds** from 30 min before tip until the final, then closes the watch. (Cloudflare starts it once a minute; each run keeps re-checking until the next one.)
- **Alert again if it bounces back**: after an alert, it re-arms once the line moves 1.5 pts back past your target, so the next run alerts again.
- Each alert shows the score, the injury report (flagging anyone **new** since you set it), and a ⚠️ when the line moved more than the score explains. Tapping it opens the game in DraftKings.

## Good to know
- **First live game, please check:** watch the **Watching** tab during the game. If "Now" changes as the score swings, live lines are flowing. If it never moves until the final, ESPN only gives pre-game lines and we'll switch to the backup (The Odds API free tier).
- ESPN lines can lag DraftKings by up to a minute, and DraftKings pulls lines during reviews and timeouts. Always confirm in DraftKings before betting.
- ESPN's "opened" number is occasionally wrong. The injury warning measures from the line when you set the alert, not from "opened".
- Free-plan limits are well above normal use: the worker saves only when a line moves, staying under KV's 1,000 writes/day for a handful of games a night.
- It never places bets.

To re-run the logic test on a computer with Node: `node worker/test.mjs`.
