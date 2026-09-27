/**
 * curate.js
 * -----------------------------------------------------------------------
 * Runs once a day (via GitHub Actions, see .github/workflows/daily-update.yml)
 * at 00:00 IST. It queries the YouTube Data API v3 for fresh, well-performing
 * Shorts across founder/entrepreneur-relevant topics, filters out anything
 * that isn't actually a Short (<=60s, vertical-friendly), and merges the
 * result into public/data/shorts.json (the active list shown to users),
 * enforcing:
 *   - at least MIN_NEW_PER_DAY items added to today's list
 *   - a rolling cap of MAX_TOTAL active shorts (oldest dropped first)
 *
 * ROTATION: nothing is ever deleted outright. Every Short this script has
 * ever seen lives in data/archive.json (not served publicly). When a Short
 * falls off the active 200, it stays in the archive with a lastShown date.
 * Once it has been out of rotation for COOLDOWN_DAYS, it becomes eligible
 * to be pulled back into the active list again — so a portion of each
 * day's additions are strong shorts resurfacing, not only brand-new finds.
 *
 * Requires env var YOUTUBE_API_KEY (a free YouTube Data API v3 key from
 * Google Cloud Console — quota is 10,000 units/day free, this script uses
 * only a few thousand).
 *
 * Usage: YOUTUBE_API_KEY=xxx node scripts/curate.js
 * -----------------------------------------------------------------------
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_PATH = path.join(__dirname, "..", "public", "data", "shorts.json");
const ARCHIVE_PATH = path.join(__dirname, "..", "data", "archive.json");

const API_KEY = process.env.YOUTUBE_API_KEY;
const MAX_TOTAL = 200;               // active list size shown to users
const MIN_NEW_PER_DAY = 50;          // total additions/day (new + rotated back)
const ROTATE_PER_DAY = 10;           // of those 50, how many are "resurfaced" old shorts
const COOLDOWN_DAYS = 30;            // an old short can't rotate back sooner than this
const MAX_DURATION_SECONDS = 60;

// Search queries grouped by the categories requested for FoundersFeed.
// Multiple phrasings per category improve coverage without blowing quota
// (each search.list call = 100 units; ~20 calls/day = 2000 units, well
// under the 10,000/day free limit).
const CATEGORY_QUERIES = {
  Productivity: ["productivity tips for entrepreneurs shorts", "how to focus deep work shorts"],
  Motivation: ["entrepreneur motivation shorts", "startup mindset motivation shorts"],
  Efficiency: ["work smarter not harder shorts", "time management hack shorts"],
  Learning: ["learn a new skill fast shorts", "business lesson in 60 seconds shorts"],
  "Marketing & Growth": ["marketing strategy tip shorts", "ad strategy that works shorts"],
  "Dev & Ops": ["startup tech stack tip shorts", "hiring hr tip for startups shorts"],
  Lifestyle: ["founder lifestyle shorts", "entrepreneur daily routine shorts"],
  "Launch & Growth": ["how I launched my product shorts", "grow your startup shorts"],
  "Success & Failure": ["startup failure lesson shorts", "success story entrepreneur shorts"],
};

if (!API_KEY) {
  console.error("Missing YOUTUBE_API_KEY environment variable.");
  process.exit(1);
}

async function searchShorts(query) {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.search = new URLSearchParams({
    key: API_KEY,
    part: "snippet",
    type: "video",
    q: query,
    videoDuration: "short", // API bucket: <4 min. We refine to <=60s below.
    order: "viewCount",
    publishedAfter: daysAgoIso(30),
    maxResults: "25",
    safeSearch: "strict",
  }).toString();

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`search.list failed for "${query}": ${res.status}`);
    return [];
  }
  const data = await res.json();
  return (data.items || []).map((item) => ({
    id: item.id.videoId,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
  })).filter((v) => v.id);
}

async function fetchDurationsAndStats(videoIds) {
  const out = new Map();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    if (batch.length === 0) continue;
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.search = new URLSearchParams({
      key: API_KEY,
      part: "contentDetails,statistics,status",
      id: batch.join(","),
    }).toString();

    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`videos.list failed: ${res.status}`);
      continue;
    }
    const data = await res.json();
    for (const item of data.items || []) {
      out.set(item.id, {
        durationSeconds: isoDurationToSeconds(item.contentDetails.duration),
        viewCount: Number(item.statistics?.viewCount || 0),
        embeddable: item.status?.embeddable !== false,
      });
    }
  }
  return out;
}

function isoDurationToSeconds(iso) {
  // e.g. PT45S, PT1M5S
  const m = iso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 9999;
  const minutes = Number(m[1] || 0);
  const seconds = Number(m[2] || 0);
  return minutes * 60 + seconds;
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA);
  const b = new Date(dateStrB);
  return Math.abs(Math.round((b - a) / 86400000));
}

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * The archive is a map keyed by video id:
 *   { id, title, category, firstAdded, lastShown, timesShown }
 * If it doesn't exist yet (first run), it's bootstrapped from whatever is
 * currently in the active list so no history is lost.
 */
async function loadArchive(activeList) {
  const raw = await loadJson(ARCHIVE_PATH, null);
  if (raw && raw.items) return raw.items;

  const bootstrap = {};
  for (const item of activeList) {
    bootstrap[item.id] = {
      id: item.id,
      title: item.title,
      category: item.category,
      firstAdded: item.addedDate || todayStr(),
      lastShown: todayStr(),
      timesShown: 1,
    };
  }
  return bootstrap;
}

async function main() {
  const active = (await loadJson(ACTIVE_PATH, { shorts: [] })).shorts || [];
  const archive = await loadArchive(active);
  const activeIds = new Set(active.map((s) => s.id));

  console.log(`Active list: ${active.length}. Archive: ${Object.keys(archive).length} shorts ever seen.`);

  // ---- 1. Find brand-new candidates from the API (skip anything already archived) ----
  const candidates = new Map();
  for (const [category, queries] of Object.entries(CATEGORY_QUERIES)) {
    for (const q of queries) {
      const results = await searchShorts(q);
      for (const r of results) {
        if (archive[r.id] || candidates.has(r.id)) continue;
        candidates.set(r.id, { ...r, category });
      }
    }
  }
  console.log(`Found ${candidates.size} raw brand-new candidates.`);

  const ids = [...candidates.keys()];
  const details = await fetchDurationsAndStats(ids);

  const qualifiedNew = [...candidates.values()]
    .map((c) => ({ ...c, ...details.get(c.id) }))
    .filter((c) => c.durationSeconds && c.durationSeconds <= MAX_DURATION_SECONDS)
    .filter((c) => c.embeddable !== false)
    .sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));

  console.log(`Qualified brand-new shorts (<=60s, embeddable): ${qualifiedNew.length}`);

  // ---- 2. Pick rotation candidates: archived, not currently active, cooldown passed ----
  const rotationEligible = Object.values(archive)
    .filter((a) => !activeIds.has(a.id))
    .filter((a) => daysBetween(a.lastShown, todayStr()) >= COOLDOWN_DAYS)
    // prefer shorts that have been out longest, so rotation is fair/even
    .sort((a, b) => daysBetween(b.lastShown, todayStr()) - daysBetween(a.lastShown, todayStr()));

  console.log(`Rotation-eligible (cooldown of ${COOLDOWN_DAYS}+ days passed): ${rotationEligible.length}`);

  let rotateCount = Math.min(ROTATE_PER_DAY, rotationEligible.length);
  let newCount = MIN_NEW_PER_DAY - rotateCount;

  // If we didn't find enough brand-new ones, backfill with more rotations (and vice versa)
  if (qualifiedNew.length < newCount) {
    const shortfall = newCount - qualifiedNew.length;
    newCount = qualifiedNew.length;
    rotateCount = Math.min(rotateCount + shortfall, rotationEligible.length);
  }

  const rotatedToday = rotationEligible.slice(0, rotateCount).map((a) => ({
    id: a.id,
    title: a.title,
    category: a.category,
    addedDate: todayStr(),
    rotatedBack: true,
  }));

  const newToday = qualifiedNew.slice(0, newCount).map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    addedDate: todayStr(),
  }));

  const totalAddedToday = rotatedToday.length + newToday.length;
  if (totalAddedToday < MIN_NEW_PER_DAY) {
    console.warn(
      `Only added ${totalAddedToday} today (target ${MIN_NEW_PER_DAY}: ${newToday.length} new + ${rotatedToday.length} rotated). ` +
      `Not enough qualifying new shorts or rotation-eligible archive yet.`
    );
  }

  // ---- 3. Build today's active list: today's additions first, then existing behind them ----
  const todaysAdditions = [...newToday, ...rotatedToday];
  const additionIds = new Set(todaysAdditions.map((a) => a.id));
  const carriedOver = active.filter((a) => !additionIds.has(a.id));

  const finalActive = [...todaysAdditions, ...carriedOver].slice(0, MAX_TOTAL);
  const finalActiveIds = new Set(finalActive.map((a) => a.id));

  // ---- 4. Update the archive: everyone shown today gets lastShown=today; ----
  //         anyone who just fell off the active list also gets lastShown=today
  //         (the last day they were actually shown), so their cooldown starts now.
  const touchedIds = new Set([...active.map((a) => a.id), ...finalActive.map((a) => a.id)]);
  for (const id of touchedIds) {
    const wasActiveToday = finalActiveIds.has(id);
    const existingRecord = archive[id];
    const fallbackMeta = finalActive.find((a) => a.id === id) || active.find((a) => a.id === id) || {};

    archive[id] = {
      id,
      title: existingRecord?.title || fallbackMeta.title || "",
      category: existingRecord?.category || fallbackMeta.category || "",
      firstAdded: existingRecord?.firstAdded || fallbackMeta.addedDate || todayStr(),
      lastShown: wasActiveToday ? todayStr() : (existingRecord?.lastShown || todayStr()),
      timesShown: (existingRecord?.timesShown || 0) + (additionIds.has(id) ? 1 : 0),
    };
  }

  await fs.mkdir(path.dirname(ARCHIVE_PATH), { recursive: true });
  await fs.writeFile(ARCHIVE_PATH, JSON.stringify({ updatedAt: todayStr(), items: archive }, null, 2), "utf-8");

  const output = {
    lastUpdated: istNowIso(),
    count: finalActive.length,
    shorts: finalActive.map(({ id, title, category, addedDate }) => ({ id, title, category, addedDate })),
  };
  await fs.writeFile(ACTIVE_PATH, JSON.stringify(output, null, 2), "utf-8");

  console.log(
    `Done. Active list: ${finalActive.length} shorts. ` +
    `Added today: ${newToday.length} new + ${rotatedToday.length} rotated back = ${totalAddedToday}.`
  );
}

function istNowIso() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utcMs + 5.5 * 60 * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())}T${pad(ist.getHours())}:${pad(ist.getMinutes())}:00+05:30`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
