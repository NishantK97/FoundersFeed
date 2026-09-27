# CLAUDE.md

Context for Claude Code working in this repo. Read this before making changes.

## What this is

**FoundersFeed** — a no-signup, full-screen vertical feed of YouTube Shorts
for founders/entrepreneurs (productivity, motivation, marketing, launches,
success/failure stories, etc.). Same interaction model as YouTube/Instagram
Shorts: open the URL, start scrolling, one video per screen.

Two halves:
1. **Frontend** (`public/`) — static HTML/CSS/JS, no framework, no build
   step. Deployed to Firebase Hosting free (Spark) plan.
2. **Curation** (`scripts/curate.js`) — a Node script that queries the
   YouTube Data API v3, runs once a day via a free GitHub Actions cron
   (`.github/workflows/daily-update.yml`), and updates the JSON the
   frontend reads.

There is deliberately **no backend, no database, no paid Firebase plan,
no Cloud Functions**. All "automation" happens in GitHub's free CI runner,
which commits updated JSON files and redeploys.

## Architecture / data flow

```
GitHub Actions (00:00 IST daily, cron "30 18 * * *" UTC)
  → scripts/curate.js
      reads  public/data/shorts.json   (today's active list, ≤200 items)
      reads  data/archive.json         (full history, never served publicly)
      calls  YouTube Data API v3 (search.list + videos.list)
      writes public/data/shorts.json   (new active list)
      writes data/archive.json         (updated history)
  → git commit + push
  → firebase deploy --only hosting (via FirebaseExtended/action-hosting-deploy)

Browser
  → public/index.html + style.css + app.js
      fetch public/data/shorts.json (cache-busted per day)
      render scroll-snap feed, virtualize iframes (only active ± 1 mounted)
      play via YouTube embed postMessage API
```

## Key files

| Path | Purpose |
|---|---|
| `public/index.html` | page shell |
| `public/style.css` | dark, full-screen, scroll-snap UI |
| `public/app.js` | feed rendering, IntersectionObserver-driven virtualization, mute/play control via YouTube iframe postMessage API |
| `public/data/shorts.json` | **the only file the frontend fetches.** `{ lastUpdated, count, shorts: [{id, title, category, addedDate}] }` |
| `data/archive.json` | full history of every short ever curated, keyed by video id: `{firstAdded, lastShown, timesShown}`. Lives outside `public/` on purpose — never hosted, never fetched by the browser. |
| `scripts/curate.js` | the only piece of "business logic" in the repo. See below. |
| `.github/workflows/daily-update.yml` | cron: curate → commit → deploy |
| `firebase.json` | Hosting config. **No SPA rewrite** — this app has no client routes, and a catch-all rewrite would intercept the `data/shorts.json` fetch and break the app. Don't add one back without excluding `/data/**`. |

## Curation logic (`scripts/curate.js`) — important constants

```js
const MAX_TOTAL = 200;         // active list size shown to users
const MIN_NEW_PER_DAY = 50;    // total additions/day (new + rotated back)
const ROTATE_PER_DAY = 10;     // of those 50, how many are resurfaced old shorts
const COOLDOWN_DAYS = 30;      // an old short can't rotate back sooner than this
const MAX_DURATION_SECONDS = 60;
```

Flow:
1. Search YouTube for each phrase in `CATEGORY_QUERIES` (9 categories, 2
   phrasings each), skip anything already in the archive.
2. Fetch real duration + view count + embeddable status via `videos.list`
   (`videoDuration: "short"` from search only guarantees <4 min — this
   step filters down to true ≤60s Shorts).
3. Pick rotation candidates from the archive: not currently active, past
   `COOLDOWN_DAYS`, longest-resting first.
4. Split today's ~50 additions into new-from-API + rotated-from-archive.
   If one pool is short, borrow from the other to still hit the target.
5. Build the new active list (today's additions + carried-over existing),
   slice to `MAX_TOTAL`. Anything that falls off just stays in the
   archive with `lastShown` stamped — **nothing is ever deleted**.
6. Write both `public/data/shorts.json` and `data/archive.json`.

Ranking within a day is by view count over the trailing 30 days — a proxy
for "top," since Shorts-specific view counts aren't otherwise exposed
cleanly via the public API.

## Conventions / constraints to respect

- **No build step, on purpose.** Keep `public/` as plain HTML/CSS/JS
  unless there's a real reason to introduce a bundler — the whole point
  was zero-friction free hosting.
- **No signup, no login, no user accounts.** Don't add auth.
- **Stay inside free tiers.** YouTube Data API: 10k units/day (script uses
  ~1,800–2,500). Firebase: Spark (free) plan only — no Cloud Functions, no
  Firestore requirement. GitHub Actions: public repo free minutes.
- `data/archive.json` must **never** be moved into `public/` or referenced
  by `app.js` — it's not meant to be public (it's just operational
  history, low sensitivity, but no reason to expose it either).
- The frontend virtualizes iframes deliberately (`RENDER_WINDOW = 1` in
  `app.js`) — don't mount all 200 iframes at once, it'll crush mobile
  browsers.
- Autoplay is muted by default (browser policy); there's a per-slide
  unmute button. Don't try to force unmuted autoplay — it'll just fail
  silently in most browsers.
- `firebase.json` intentionally has no SPA rewrite (see table above).

## Setup / secrets needed (not in repo)

- `YOUTUBE_API_KEY` — GitHub Actions secret, from Google Cloud Console
  (YouTube Data API v3 enabled).
- `FIREBASE_SERVICE_ACCOUNT` — GitHub Actions secret, generated via
  `firebase init hosting:github` or manually from Firebase Console →
  Project Settings → Service Accounts.
- `your-firebase-project-id` placeholder appears in `.firebaserc` and
  `.github/workflows/daily-update.yml` — replace both with the real
  project id before first deploy.

Full walkthrough is in `README.md`.

## Current status

- Frontend is complete and functional (tested locally via
  `python3 -m http.server` in `public/`).
- `public/data/shorts.json` ships with 8 real, manually-verified seed
  Shorts so the app isn't empty before the first automated run.
- `data/archive.json` does not exist yet in a fresh checkout — the script
  bootstraps it from `public/data/shorts.json` on first run.
- Not yet deployed to a real Firebase project or wired to real GitHub
  secrets — that's a manual one-time setup step for whoever owns the
  Firebase/YouTube accounts (see README).

## Likely next steps / open questions

- Ranking is pure view-count. Could shift to a recency-weighted score if
  "top 200" should favor freshness over raw popularity.
- No analytics of any kind currently (matches the "no signup, no
  tracking" brief) — if engagement data is ever wanted, it'd need to be
  client-side only (e.g., a lightweight privacy-friendly pageview counter)
  since there's no backend.
- `CATEGORY_QUERIES` phrasing is a first pass — worth reviewing after a
  few days of real output to see which phrasings surface good vs. junk
  content, and tightening `safeSearch`/filtering if low-quality shorts
  slip through.
