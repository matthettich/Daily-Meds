// Daily meds browser tests.
// Run:  npm i -D playwright && npx playwright install chromium   (once)
//       node tests/app.test.mjs
// Opens the app in a phone-sized Chromium (Galaxy Z Fold folded width) with fake weather and pollen servers,
// so nothing real is fetched and no data leaves the machine.
process.env.TZ = "America/Denver";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { ({ chromium } = await import(process.env.PLAYWRIGHT_PATH || "/opt/npm-tools/node_modules/playwright/index.mjs")); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const f = path.join(ROOT, p === "/" ? "index.html" : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const URL0 = `http://127.0.0.1:${server.address().port}/`;

/* ---------- tiny test runner ---------- */
let passed = 0, failed = 0;
const results = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

/* ---------- dates ---------- */
const keyOf = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const today = keyOf(new Date());
const shift = (k, n) => { const [y, m, d] = k.split("-").map(Number); return keyOf(new Date(y, m - 1, d + n)); };
const at = (k, h, min = 0) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d, h, min).getTime(); };

/* ---------- fake weather / pollen ---------- */
let pollenMode = "ok", weatherCalls = 0, gapDay = null;
function weatherJSON(u) {
  const past = +u.searchParams.get("past_days") || 0, days = [];
  for (let i = past; i >= 0; i--) days.push(shift(today, -i));
  const hours = []; for (const k of days) for (let h = 0; h < 24; h++) hours.push(`${k}T${String(h).padStart(2, "0")}:00`);
  if (u.hostname.startsWith("air-quality")) return { hourly: { time: hours, us_aqi: hours.map(() => 40), pm2_5: hours.map(() => 6) } };
  weatherCalls++;
  return {
    daily: { time: days, temperature_2m_max: days.map(k => k === gapDay ? null : 20), temperature_2m_min: days.map(() => 8),
      precipitation_sum: days.map(() => 0), weather_code: days.map(() => 1) },
    hourly: { time: hours, relative_humidity_2m: hours.map(() => 50), pressure_msl: hours.map(t => t.slice(0, 10) === gapDay ? null : 1015) }
  };
}

const browser = await chromium.launch();
let elevation = 1600;
async function open(seed, { width = 412, height = 900, geo = null, clock = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, timezoneId: "America/Denver", locale: "en-US", serviceWorkers: "block",
    ...(geo ? { geolocation: geo, permissions: ["geolocation"] } : {}) });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: "" }));
  await ctx.route(/open-meteo\.com/, r => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith("/elevation")) return r.fulfill({ json: { elevation: [elevation] } });
    if (u.hostname.startsWith("geocoding")) return r.fulfill({ json: { results: [{ name: "Denver", admin1: "Colorado", latitude: 39.74, longitude: -104.99 }] } });
    return r.fulfill({ json: weatherJSON(u) });
  });
  await ctx.route(/pollen\.googleapis\.com/, r => pollenMode === "ok"
    ? r.fulfill({ json: { dailyInfo: [{ pollenTypeInfo: [{ code: "TREE", indexInfo: { value: 2 } }, { code: "GRASS", indexInfo: { value: 1 } }, { code: "WEED", indexInfo: { value: 0 } }] }] } })
    : r.fulfill({ status: 403, json: { error: { code: 403, message: "API key not valid. Please pass a valid API key." } } }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  // Any browser confirm()/alert() would show the website address; the app must never use them.
  page.on("dialog", d => { errors.push("native browser dialog: " + d.message()); d.dismiss(); });
  if (clock) await page.clock.install({ time: clock });   // a set time of day, e.g. just after midnight
  await page.addInitScript(s => { if (!sessionStorage.getItem("seeded")) { localStorage.clear(); localStorage.setItem("daily-meds-welcomed", "1"); if (s) localStorage.setItem("daily-meds-v1", JSON.stringify(s)); sessionStorage.setItem("seeded", "1"); } }, seed || null);
  await page.goto(URL0);
  page.state = () => page.evaluate(() => JSON.parse(JSON.stringify(state)));
  page.saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("daily-meds-v1")));
  page.errors = errors;
  page.close2 = () => ctx.close();
  return page;
}
async function test(name, fn, seed, opts) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;   // ONLY="part of a name" node tests/app.test.mjs
  const page = await open(seed, opts);
  try { await fn(page); eq(page.errors, [], "page errors"); passed++; results.push("  ok   " + name); }
  catch (e) { failed++; results.push("  FAIL " + name + "\n       " + e.message); await page.screenshot({ path: path.join(ROOT, "tests", "fail-" + name.replace(/\W+/g, "-") + ".png"), fullPage: true }).catch(() => {}); }
  finally { await page.close2(); }
}
const base = { meds: [{ id: "m1", name: "Lisinopril", dose: "10 mg", slots: ["morning"] }], symptoms: [{ id: "s1", name: "Headache" }, { id: "s2", name: "Nausea" }],
  moods: [{ id: "md1", name: "Anxious" }, { id: "md2", name: "Calm" }], log: {}, slog: {}, updated: 1 };
async function swipe(page, dx) {
  await page.evaluate(dx => {
    const el = document.querySelector("#slots .sect") || document.body, x0 = 200, y0 = 400;
    const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y0 });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [t(x0)], changedTouches: [t(x0)] }));
    el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [t(x0 + dx)] }));
  }, dx);
}
function parseCSVLine(l) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
}
const askText =page => page.locator("#askDlg[open] #askMsg").textContent();

/* ---------- 1. Pop-ups and app name ---------- */
await test("manifest names the app Daily meds (not Meds)", async page => {
  const m = await page.evaluate(() => fetch("manifest.webmanifest").then(r => r.json()));
  eq(m.short_name, "Daily meds", "short_name"); eq(m.name, "Daily meds", "name");
  assert(m.icons.some(i => i.purpose === "maskable"), "maskable icon");
});
await test("privacy page is linked from the app and the help page, and works offline", async page => {
  eq(await page.getAttribute('.helpfoot a[href="privacy.html"]', "href"), "privacy.html", "footer link");
  const [help, sw] = await page.evaluate(() => Promise.all(["help.html", "sw.js"].map(f => fetch(f).then(r => r.text()))));
  assert(help.includes('href="privacy.html"'), "help page links it");
  assert(sw.includes('"privacy.html"'), "offline worker caches it");
  await page.click('.helpfoot a[href="privacy.html"]');
  await page.waitForSelector("h1");
  assert((await page.textContent("h1")).includes("Privacy"), "page opens");
  eq(page.errors, [], "privacy page errors");
});
await test("deleting asks in the app's own pop-up titled Daily meds", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  await page.click('[data-edit-sym="s2"]');
  await page.click("#delItem");
  await page.waitForSelector("#askDlg[open]");
  eq(await page.textContent("#askTitle"), "Daily meds", "pop-up title");
  assert((await askText(page)).includes("Delete Nausea?"), "question text");
  await page.click("#askNo");
  eq((await page.state()).symptoms.length, 2, "cancel keeps it");
  await page.click("#delItem"); await page.click("#askYes");
  eq((await page.state()).symptoms.map(s => s.name), ["Headache"], "OK deletes it");
}, base);

/* ---------- 2. Swipe between days ---------- */
await test("swiping right goes back a day, left goes forward, never past today", async page => {
  const title = () => page.textContent("#dayTitle small");
  await swipe(page, -150); assert((await title()).startsWith("Today"), "can't swipe past today");
  await swipe(page, 150); assert((await title()).startsWith("Yesterday"), "swipe right = previous day");
  await swipe(page, 150); eq(await page.evaluate(() => viewDate), shift(today, -2), "two days back");
  await swipe(page, -150); assert((await title()).startsWith("Yesterday"), "swipe left = next day");
  await swipe(page, 30); assert((await title()).startsWith("Yesterday"), "short drags ignored");
  await page.click('[data-tab="sum"][role="tab"]'); await swipe(page, 150);
  eq(await page.evaluate(() => viewDate), shift(today, -1), "no day change from other pages");
}, base);

await test("swiping forward to today keeps the page screen-width, today's color and tappable box names", async page => {
  await swipe(page, 150); eq(await page.evaluate(() => viewDate), shift(today, -1), "back a day");
  // Mid-slide (the column starts 36px to the right) the page must not get wider than the screen
  const w = await page.evaluate(() => { goDay(1); return [document.documentElement.scrollWidth, innerWidth]; });
  eq(w, [412, 412], "page width while today slides in");
  eq(await page.evaluate(() => document.body.dataset.day), String(new Date().getDay()), "today's color");
  await page.waitForTimeout(300);
  await page.locator('[data-copy="supp"]').tap();
  assert(await page.evaluate(() => cmenu.open), "Supplements name opens the copy menu");
  assert((await page.textContent("#cmText")).startsWith("Copy Yesterday's"), "copies from yesterday");
}, base);

/* ---------- 3. Symptoms: repeats and intensity ---------- */
await test("same symptom logs twice with two timestamps and shows ×2", async page => {
  await page.selectOption('select[data-pick="sym"]', "s1");
  await page.selectOption('select[data-pick="sym"]', "s1");
  const L = (await page.state()).slog[today].s1;
  eq(L.length, 2, "two entries"); assert(L.every(e => e.t > 1e11), "each has a timestamp");
  eq(await page.textContent(".box.l-sym .chip .qty"), "×2", "chip count");
  await page.click('.box.l-sym [data-rmsym="s1"]');
  eq((await page.state()).slog[today].s1.length, 1, "× removes one");
  await page.click('.box.l-sym [data-rmsym="s1"]');
  eq((await page.state()).slog[today], undefined, "last one clears the day");
}, base);
await test("tap a symptom to set 1–10 intensity per time", async page => {
  await page.selectOption('select[data-pick="sym"]', "s1");
  await page.click('[data-symd="s1"]');
  await page.waitForSelector("#sdlg[open]");
  eq(await page.locator("#sdlg .scale button").count(), 10, "ten levels");
  await page.click('#sdlg [data-lv="7"]');
  await page.click("#sAgain");
  await page.click('#sdlg [data-oi="1"][data-lv="3"]');
  await page.click('#sform button[type="submit"]');
  const L = (await page.state()).slog[today].s1;
  eq(L.map(e => e.i), [7, 3], "intensities saved");
  eq(await page.textContent('.box.l-sym .lvl'), "7", "chip shows strongest");
  await page.click('[data-symd="s1"]'); await page.click('#sdlg [data-oi="0"][data-lv="7"]'); await page.click('#sform button[type="submit"]');
  eq((await page.state()).slog[today].s1[0].i, undefined, "tapping the chosen level again clears it");
}, base);
await test("old one-per-day symptom data is converted", async page => {
  const s = await page.state();
  eq(s.slog[shift(today, -1)], { s1: [{ t: "all" }], s2: [{ t: at(shift(today, -1), 9) }] }, "converted");
  const csv = await page.evaluate(k => buildCSV(k, k), shift(today, -1));
  assert(csv.includes("Headache: all day"), "csv text: " + csv.split("\r\n")[1]);
}, { ...base, slog: { [shift(today, -1)]: { s1: "all", s2: at(shift(today, -1), 9) } } });
await test("spreadsheet has symptom counts and intensity", async page => {
  const csv = await page.evaluate(k => buildCSV(k, k), today);
  const [head, row] = csv.replace(/^﻿/, "").split("\r\n").map(parseCSVLine);
  const col = n => row[head.indexOf(n)];
  eq(col("symptom: Headache"), "2", "count"); eq(col("intensity: Headache"), "8", "max intensity");
  assert(csv.includes("Headache x2: 8:00 AM (8/10)"), "text");
}, { ...base, slog: { [today]: { s1: [{ t: at(today, 8), i: 8 }, { t: at(today, 15), i: 4 }] } } });

/* ---------- 4. Moods repeat too ---------- */
await test("same mood logs twice in one part of the day and shows ×2", async page => {
  const sel = 'select[data-pick="mood"][data-mt="morning"]';
  await page.selectOption(sel, "md1"); await page.selectOption(sel, "md1");
  let s = await page.state();
  eq(s.mlog[today].morning, ["md1", "md1"], "two entries");
  assert(s.mtlog[today].morning.md1 > 1e11 && s.mxlog[today].morning.md1.length === 1, "both timestamps kept");
  eq(await page.textContent(".box.mood.l-mmorning .qty"), "×2", "chip count");
  await page.click('[data-rmmood="md1"][data-mt="morning"]');
  s = await page.state();
  eq(s.mlog[today].morning, ["md1"], "× removes one"); eq(s.mxlog[today], undefined, "extra time removed");
}, base);

/* ---------- 5. Appointments ---------- */
await test("appointments: at the bottom of Today, log one, hide from Settings", async page => {
  const order = await page.$$eval("[data-sec]", l => l.map(x => x.dataset.sec));
  eq(order.slice(-3), ["appts", "notes", "night"], "appointments near the bottom, above Notes (Overnight & dreams comes last)");
  await page.selectOption('select[data-pick="ev"][data-ev="appt"]', "__new");
  await page.fill('#itemForm [name="name"]', "GI follow-up");
  await page.fill("#whoRows input", "Dr. Lee");
  await page.click("#saveItem");
  const s = await page.state();
  eq(s.appts[0].name, "GI follow-up", "saved to list"); eq(s.alog[today].length, 1, "logged today");
  assert((await page.textContent('[data-evbox="appt"]')).includes("Dr. Lee"), "shows who");
  await page.click('[data-tab="set"][role="tab"]');
  assert(await page.isVisible("#apptBox"), "settings list visible");
  await page.uncheck('[data-show="appts"]');
  eq((await page.state()).layout.find(e => e.id === "appts").show, false, "hidden");
  eq(await page.locator('[data-evbox="appt"]').count(), 0, "gone from Today");
  const csv = await page.evaluate(k => buildCSV(k, k), today);
  assert(csv.includes("GI follow-up (Dr. Lee) at"), "in spreadsheet");
}, base);

/* ---------- 6. Other logger ---------- */
await test("Other logger in Smells & Other logs things like air travel", async page => {
  await page.selectOption('select[data-pick="ev"][data-ev="other"]', "__new");
  await page.fill('#itemForm [name="name"]', "Air travel");
  await page.click("#saveItem");
  await page.selectOption('select[data-pick="ev"][data-ev="other"]', { label: "Air travel" });
  const s = await page.state();
  eq(s.olog[today].length, 2, "logged twice");
  eq(await page.textContent('[data-evbox="other"] .qty'), "×2", "chip count");
  await page.click('[data-evbox="other"] button.t');
  await page.fill("#xtime", "06:30"); await page.click('#xform button[type="submit"]');
  eq(new Date((await page.state()).olog[today][0].t).getHours(), 6, "time edited");
  const csv = await page.evaluate(k => buildCSV(k, k), today);
  assert(/Air travel x2 at 6:30 AM/.test(csv), "in spreadsheet");
  await page.click('[data-tab="sum"][role="tab"]');
  assert((await page.textContent("#sumBody")).includes("Air travel"), "on Recap");
}, base);
await test("supplements and smells still work through the shared log", async page => {
  await page.selectOption('select[data-pick="ev"][data-ev="supp"]', "sp1");
  await page.selectOption('select[data-pick="ev"][data-ev="smell"]', "sm1");
  const s = await page.state();
  eq([s.suplog[today].length, s.smlog[today].length], [1, 1], "logged");
  await page.click('[data-evrm="supp"]');
  eq((await page.state()).suplog[today], undefined, "removed");
}, { ...base, suppMode: "log", supps: [{ id: "sp1", name: "Vitamin D", dose: "1000 IU" }], smells: [{ id: "sm1", name: "Smoke" }], trackSmells: true });

/* ---------- 7. Year calendar ---------- */
await test("year calendar below the month, 12 colored months, toggle in Settings", async page => {
  await page.click('[data-tab="sum"][role="tab"]');
  const titles = await page.$$eval("#sumBody .box .lid", l => l.map(x => x.textContent));
  const ci = titles.findIndex(t => t.startsWith("Calendar")), yi = titles.findIndex(t => t.startsWith("Year calendar"));
  assert(ci >= 0 && yi === ci + 1, "year calendar right below month calendar: " + titles.join(" | "));
  eq(await page.locator(".ygrid .ym").count(), 12, "twelve months");
  const colors = await page.$$eval(".ym", l => l.map(x => x.style.getPropertyValue("--mh")));
  eq(new Set(colors).size, 12, "each month its own color");
  const dayBtn = page.locator(`.ycal button[data-goto="${shift(today, -1)}"]`);
  assert((await dayBtn.getAttribute("style")).includes("hsl"), "shaded");
  await page.click('[data-tab="sum"][role="tab"]'); await page.click("#sumYear");
  eq(await page.locator(".ygrid").count(), 1, "also in Year view");
  await page.click('[data-tab="set"][role="tab"]');
  assert(await page.isChecked("#showYearCal"), "on by default");
  await page.uncheck("#showYearCal");
  eq(await page.locator(".ygrid").count(), 0, "hidden");
}, { ...base, slog: { [shift(today, -1)]: { s1: [{ t: at(shift(today, -1), 9) }] } } });

/* ---------- 8. Weather and pollen ---------- */
await test("weather is saved for every day since starting, gaps retried", async page => {
  gapDay = shift(today, -3);
  await page.click('[data-tab="set"][role="tab"]');
  await page.fill("#wxCity", "Denver"); await page.click('#wxCityForm button');
  // The coverage line shows at once ("0 of 11"); wait for the fetched weather itself, or this races on a busy machine
  await page.waitForFunction(() => /Weather saved for/.test(document.getElementById("wxCover").textContent) && !wxBusy && (state.weather[todayKey()] || {}).hi != null);
  let s = await page.state();
  for (let i = 0; i <= 10; i++) { const k = shift(today, -i); assert(s.weather[k] && (k === gapDay || s.weather[k].hi === 20), "day " + k); }
  eq(s.weather[shift(today, -1)].final, true, "full past day is final");
  eq((await page.saved()).weather[shift(today, -1)].hi, 20, "written to storage");
  eq(s.weather[gapDay].final, false, "a day missing data is not final, so it's fetched again");
  eq(s.weather[today].final, false, "today is not final");
  assert((await page.textContent("#wxCover")).includes("Missing:"), "missing day is listed");
  gapDay = null;
  await page.evaluate(() => { wxLast = 0; return fetchWeather(); });
  await page.waitForFunction(k => JSON.parse(localStorage.getItem("daily-meds-v1")).weather[k].hi === 20, shift(today, -3));
  s = await page.state();
  eq(s.weather[shift(today, -3)].final, true, "gap filled on the next open");
  assert(/saved for 11 of the last 11 days/.test(await page.textContent("#wxCover")), "coverage: " + await page.textContent("#wxCover"));
}, { ...base, log: { [shift(today, -10)]: { "m1|morning": at(shift(today, -10), 8) } } });
await test("pollen key: pop-up says it works and the section shows today's pollen", async page => {
  pollenMode = "ok";
  await page.click('[data-tab="set"][role="tab"]');
  await page.fill("#wxKey", "AIzaGOODKEY1234"); await page.click('#wxKeyForm button');
  await page.waitForSelector("#askDlg[open]");
  const msg = await askText(page);
  assert(msg.includes("Pollen key works") && msg.includes("tree Low (2)"), msg);
  await page.click("#askYes");
  assert((await page.textContent("#pollenStatus")).includes("Pollen is on"), "status line");
  eq((await page.state()).weather[today].pollen, { tree: 2, grass: 1, weed: 0 }, "saved today");
  eq(await page.inputValue("#wxKey"), "••••••••1234", "key masked");
}, { ...base, wxloc: { lat: 39.74, lon: -104.99, label: "Denver, Colorado" } });
await test("pollen key: a bad key says so, with Google's reason", async page => {
  pollenMode = "bad";
  await page.click('[data-tab="set"][role="tab"]');
  await page.fill("#wxKey", "nope"); await page.click('#wxKeyForm button');
  await page.waitForSelector("#askDlg[open]");
  const msg = await askText(page);
  assert(msg.includes("didn't work") && msg.includes("API key not valid"), msg);
  await page.click("#askYes");
  assert((await page.textContent("#pollenStatus")).includes("isn't working"), "status line");
  pollenMode = "ok";
}, { ...base, wxloc: { lat: 39.74, lon: -104.99, label: "Denver, Colorado" } });
await test("pollen key without a location asks for one", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  await page.fill("#wxKey", "AIzaGOODKEY1234"); await page.click('#wxKeyForm button');
  await page.waitForSelector("#askDlg[open]");
  assert((await askText(page)).includes("Set your location"), "asks for location");
}, base);
/* Google lets pollen readings be kept for 365 days; older ones are dropped but that day's weather stays */
const oldPollen = { tree: 3, grass: 2, weed: 1 };
const pollenHistory = { [shift(today, -365)]: { hi: 10, lo: 2, pollen: oldPollen, final: true }, [shift(today, -364)]: { hi: 11, lo: 3, pollen: oldPollen, final: true } };
await test("pollen older than 365 days is dropped on load and on restore; weather stays", async page => {
  let s = await page.state();
  eq(s.weather[shift(today, -365)].pollen, undefined, "366th day back: pollen dropped");
  eq(s.weather[shift(today, -365)].hi, 10, "366th day back: weather kept");
  eq(s.weather[shift(today, -364)].pollen, oldPollen, "365th day back: pollen kept");
  await page.click('[data-tab="set"][role="tab"]');
  await page.setInputFiles("#importFile", { name: "b.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...base, weather: pollenHistory })) });
  await page.waitForSelector("#askDlg[open]"); await page.click("#askYes");
  await page.waitForFunction(() => /restored/.test(document.getElementById("backupMsg").textContent));
  const saved = await page.saved();
  eq(saved.weather[shift(today, -365)].pollen, undefined, "restored backup: old pollen not saved");
  eq(saved.weather[shift(today, -364)].pollen, oldPollen, "restored backup: recent pollen saved");
}, { ...base, weather: pollenHistory });
await test("weather, air quality, pollen and elevation show their data credits", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  const set = await page.innerHTML("#wxCredit");
  assert(set.includes('href="https://open-meteo.com/"') && set.includes("creativecommons.org/licenses/by/4.0") && set.includes("Copernicus"), "Settings credit: " + set);
  assert(set.includes("Includes data from Google Maps"), "Settings credit names Google Maps when pollen is on");
  await page.click('[data-tab="sum"][role="tab"]');
  const credits = await page.$$eval("#sumBody .credit", l => l.map(x => x.textContent));
  assert(credits.some(t => /Weather data by Open-Meteo\.com/.test(t) && /Google Maps/.test(t)), "Recap weather credit: " + credits.join(" | "));
  assert(credits.some(t => /Elevation from Open-Meteo\.com/.test(t)), "Recap travel credit: " + credits.join(" | "));
}, { ...base, wxloc: { lat: 39.74, lon: -104.99, label: "Denver, Colorado" }, pollenKey: "AIzaGOODKEY1234", trackLoc: false,
     weather: { [today]: { hi: 20, lo: 8, code: 1, pollen: { tree: 2, grass: 1, weed: 0 } } },
     geo: { [shift(today, -1)]: { lat: 39.74, lon: -104.99, el: 1600 }, [today]: { lat: 39.74, lon: -104.99, el: 1600 } } });

/* ---------- 9. Backups round-trip the new data ---------- */
await test("backup restore keeps new data and uses the in-app pop-up", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  const data = { ...base, appts: [{ id: "a1", name: "PT" }], alog: { [today]: [{ id: "a1", t: at(today, 10) }] }, slog: { [today]: { s1: [{ t: at(today, 9), i: 5 }] } } };
  await page.setInputFiles("#importFile", { name: "b.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });
  await page.waitForSelector("#askDlg[open]"); await page.click("#askYes");
  await page.waitForFunction(() => /restored/.test(document.getElementById("backupMsg").textContent));
  const s = await page.state();
  eq(s.alog[today].length, 1, "appointments"); eq(s.slog[today].s1[0].i, 5, "intensity");
}, base);

/* ---------- Today page sections: order, fold, reorder, hide ---------- */
await test("Today sections default to the day's story order", async page => {
  eq(await page.$$eval("[data-sec]", l => l.map(x => x.dataset.sec)), ["meds", "food", "smells", "activity", "mood", "syms", "appts", "notes", "night"], "order");
  eq(await page.textContent('[data-fold="syms"] .sl'), "Symptoms", "heading");
}, base);
await test("tap a heading to fold a section; it stays folded and shows a count", async page => {
  await page.selectOption('select[data-pick="sym"]', "s1");
  await page.click('[data-fold="syms"]');
  eq(await page.locator('[data-sec="syms"] .tbody').count(), 0, "folded");
  eq(await page.getAttribute('[data-fold="syms"]', "aria-expanded"), "false", "aria");
  eq(await page.textContent('[data-fold="syms"] .ssum'), "1", "count while folded");
  await page.reload();
  eq(await page.locator('[data-sec="syms"] .tbody').count(), 0, "still folded after reopening");
  await page.click('[data-fold="syms"]');
  eq(await page.locator('[data-sec="syms"] select[data-pick="sym"]').count(), 1, "unfolded");
}, base);
await test("Settings reorders and hides Today sections", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  eq(await page.locator("#layoutList .lrow").count(), 9, "one row per section");
  assert(await page.isDisabled('[data-move="meds"][data-dir="-1"]'), "first can't move up");
  await page.click('[data-move="syms"][data-dir="-1"]');
  await page.click('[data-move="syms"][data-dir="-1"]');
  eq((await page.state()).layout.map(e => e.id), ["meds", "food", "smells", "syms", "activity", "mood", "appts", "notes", "night"], "moved up twice");
  await page.uncheck('[data-show="food"]');
  eq(await page.$$eval("[data-sec]", l => l.map(x => x.dataset.sec)), ["meds", "smells", "syms", "activity", "mood", "appts", "notes", "night"], "Today follows");
  await page.click("#layoutReset");
  const L = (await page.state()).layout;
  eq(L.map(e => e.id), ["meds", "food", "smells", "activity", "mood", "syms", "appts", "notes", "night"], "reset order");
  eq(L.find(e => e.id === "food").show, false, "reset keeps what's hidden");
}, base);
await test("older saved data gets the new layout; hidden appointments stay hidden", async page => {
  const L = (await page.state()).layout;
  eq(L.length, 9, "all sections"); eq(L[8].id, "night", "the new section goes last"); eq(L.find(e => e.id === "appts").show, false, "carried over");
  eq(await page.locator('[data-sec="appts"]').count(), 0, "not on Today");
}, { ...base, trackAppts: false });

/* ---------- Food servings each get their own time ---------- */
await test("Coffee ×2: tap the time to give each serving its own time", async page => {
  const sel = 'select[data-pick="food"][data-meal="breakfast"]';
  await page.selectOption(sel, "f2"); await page.selectOption(sel, "f2");
  eq(await page.textContent('.box.meal.l-waking .qty'), "×2", "shows ×2");
  await page.click('.box.meal.l-waking [data-editf="f2"]');
  await page.waitForSelector("#pdlg[open]");
  eq(await page.locator("#pdlg [data-ptime]").count(), 2, "one row per serving");
  await page.fill('#pdlg [data-ptime="0"]', "07:15");
  await page.fill('#pdlg [data-ptime="1"]', "10:40");
  await page.click('#pform button[type="submit"]');
  let m = (await page.state()).meals[today].breakfast;
  eq(m.foods, ["f2", "f2"], "still two servings");
  eq([m.ft.f2, ...m.fx.f2].map(t => new Date(t).getHours() + ":" + new Date(t).getMinutes()), ["7:15", "10:40"], "each time saved");
  eq(await page.textContent('.box.meal.l-waking .qty'), "×2", "still displays ×2");
  const csv = await page.evaluate(k => buildCSV(k, k), today);
  assert(csv.includes("Coffee x2 at 7:15 AM, 10:40 AM"), "both times in spreadsheet");
  await page.click('.box.meal.l-waking [data-editf="f2"]');
  await page.click("#pAgain"); await page.fill('#pdlg [data-ptime="2"]', "13:05");
  await page.click('#pform button[type="submit"]');
  m = (await page.state()).meals[today].breakfast;
  eq(m.foods.length, 3, "another serving added"); eq(await page.textContent('.box.meal.l-waking .qty'), "×3", "×3");
  await page.click('.box.meal.l-waking [data-editf="f2"]');
  await page.click('#pdlg [data-prm="0"]'); await page.click('#pform button[type="submit"]');
  m = (await page.state()).meals[today].breakfast;
  eq(m.foods.length, 2, "serving removed"); eq(new Date(m.ft.f2).getHours(), 10, "the 7:15 one was removed");
  await page.click('.box.meal.l-waking [data-editf="f2"]'); await page.fill('#pdlg [data-ptime="0"]', "09:00"); await page.click("#pcancel");
  eq(new Date((await page.state()).meals[today].breakfast.ft.f2).getHours(), 10, "cancel changes nothing");
}, { ...base, foods: [{ id: "f1", name: "Oatmeal" }, { id: "f2", name: "Coffee" }] });

/* ---------- Location tracking ---------- */
await test("track location saves today's spot and elevation, and weather follows", async page => {
  await page.click('.tab[data-tab="set"]').catch(() => {});
  await page.evaluate(() => document.getElementById("trackLoc").click());
  await page.waitForFunction(() => state.geo[todayKey()] && state.geo[todayKey()].el != null);
  const st = await page.saved();
  eq(st.trackLoc, true, "setting saved");
  eq(st.geo[today], { lat: 38.84, lon: -106.13, el: 1600 }, "position rounded to ~1 km, with elevation");
  eq([st.wxloc.lat, st.wxloc.lon], [38.84, -106.13], "weather follows the tracked spot");
  assert(/Today's spot is saved/.test(await page.textContent("#trackMsg")), "status line says it's on");
}, base, { geo: { latitude: 38.8412, longitude: -106.1311 } });

await test("only once a day: reopening doesn't overwrite today's spot", async page => {
  await page.evaluate(() => trackToday());
  eq((await page.state()).geo[today], { lat: 39.74, lon: -104.99, el: 1609 }, "kept the first reading");
}, { ...base, trackLoc: true, geo: { [today]: { lat: 39.74, lon: -104.99, el: 1609 } }, wxloc: { lat: 39.74, lon: -104.99, label: "your location" } },
   { geo: { latitude: 38.84, longitude: -106.13 } });

await test("Recap Travel box finds 50+ mile and 2,000+ ft moves and compares symptoms after them", async page => {
  const html = await page.textContent("#sumBody");
  assert(/Travel & symptoms/.test(html), "travel box shows");
  const moves = await page.evaluate(k => [geoMove(k.d1), geoMove(k.d2), geoMove(k.d3)], { d1: shift(today, -6), d2: shift(today, -4), d3: shift(today, -2) });
  assert(moves[0].far && moves[0].mi > 50, "Denver to Colorado Springs is a big move (~60 mi)");
  assert(!moves[1].far && moves[1].high, "short drive with a big climb counts as an altitude move");
  assert(!moves[2].far && !moves[2].high, "small hop is not a big move");
  assert(/After a move/.test(html) && /2 big moves/.test(html), "two big moves listed: " + html.match(/Travel[^]{0,200}/)[0]);
}, (() => {
  const g = {}, slog = {}, set = (n, lat, lon, el) => g[shift(today, -n)] = { lat, lon, el };
  for (let n = 12; n >= 7; n--) set(n, 39.74, -104.99, 1609);   // Denver
  set(6, 38.83, -104.82, 1839);                                 // Colorado Springs, ~60 mi
  set(5, 38.83, -104.82, 1839);
  set(4, 38.84, -105.04, 4302);                                 // Pikes Peak, ~12 mi but +8,000 ft
  set(3, 38.84, -105.04, 4302);
  set(2, 38.90, -105.04, 4250);                                 // small hop
  set(1, 38.90, -105.04, 4250); set(0, 38.90, -105.04, 4250);
  slog[shift(today, -5)] = { s1: [{ t: "all" }] };
  return { ...base, trackLoc: true, geo: g, slog, log: { [shift(today, -12)]: {} } };
})());

await test("export includes location columns", async page => {
  const csv = await page.evaluate(([a, b]) => buildCSV(a, b), [shift(today, -1), today]);
  const lines = csv.replace(/^\ufeff/, "").split("\r\n"), head = parseCSVLine(lines[0]);
  const row = parseCSVLine(lines.find(l => l.startsWith(today)));
  const col = n => row[head.indexOf(n)];
  eq([col("latitude"), col("elevation_ft"), col("distance_from_last_mi"), col("big_move")], ["38.83", "6033", "64", "1"], "today's location columns");
}, { ...base, trackLoc: true, geo: { [shift(today, -1)]: { lat: 39.74, lon: -104.99, el: 1609 }, [today]: { lat: 38.83, lon: -104.82, el: 1839 } } });

/* ---------- Archived restaurants ---------- */
const travelSeed = { ...base, places: [{ id: "p1", name: "Chipotle" }, { id: "p2", name: "Franklin BBQ" }],
  meals: { [shift(today, -1)]: { lunch: { place: "p2" } }, [today]: { dinner: { place: "p2" } } } };
const placeOpts = (page, meal) => page.$$eval(`select[data-pick="place"][data-meal="${meal}"] option`, os => os.map(o => o.value + (o.defaultSelected ? "*" : "")));
await test("Settings archives a restaurant: off the Today list, history and export kept, Unarchive brings it back", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  await page.click('[data-arch="place"][data-id="p2"]');
  eq((await page.saved()).places.find(p => p.id === "p2").archived, today, "saved as archived today");
  eq(await page.textContent("#placeList .psub"), "Archived · hidden from Today, history kept", "archived group label");
  eq(await page.textContent("#placeList .prow.arch .nm"), "Franklin BBQ", "listed under Archived");
  eq(await page.textContent('[data-arch="place"][data-id="p2"]'), "Unarchive", "button flips");
  eq(await page.evaluate(() => document.activeElement.dataset.id), "p2", "focus stays on the restaurant");
  await page.click('[role="tab"][data-tab="today"]');
  eq(await placeOpts(page, "lunch"), ["", "p1", "__new"], "lunch picker hides the archived restaurant");
  eq(await placeOpts(page, "dinner"), ["", "p1", "p2*", "__new"], "a meal already at the archived place still shows it");
  assert((await page.textContent(".box.meal.l-afternoon .lid")).includes("at Franklin BBQ"), "dinner still says where you ate");
  const csv = await page.evaluate(([a, b]) => buildCSV(a, b), [shift(today, -1), today]);
  assert(csv.includes("ate at: Franklin BBQ"), "export keeps its column");
  await page.click('[data-tab="set"][role="tab"]');
  await page.click('[data-arch="place"][data-id="p2"]');
  assert(!("archived" in (await page.state()).places.find(p => p.id === "p2")), "unarchived");
  eq(await page.$("#placeList .psub"), null, "archived group gone");
  await page.click('[role="tab"][data-tab="today"]');
  eq(await placeOpts(page, "lunch"), ["", "p1", "p2", "__new"], "back on the lunch picker");
}, travelSeed);

await test("adding a restaurant with an archived name brings it back instead of duplicating", async page => {
  await page.selectOption('select[data-pick="place"][data-meal="lunch"]', "__new");
  await page.fill('#itemForm [name="name"]', "franklin bbq");
  await page.click("#saveItem");
  const s = await page.state();
  eq(s.places.length, 2, "no duplicate");
  assert(!s.places.find(p => p.id === "p2").archived, "unarchived");
  eq(s.meals[today].lunch.place, "p2", "lunch set to it");
}, { ...travelSeed, places: [{ id: "p1", name: "Chipotle" }, { id: "p2", name: "Franklin BBQ", archived: true }] });

await test("every restaurant archived shows a clear empty message", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  eq(await page.textContent("#placeList .empty-row"), "Every restaurant is archived. Tap Add for a new one.", "empty message");
  eq(await placeOpts(page, "lunch"), ["", "__new"], "Today picker only offers New");
}, { ...base, places: [{ id: "p1", name: "Chipotle", archived: true }] });

/* ---------- Archiving any list item ---------- */
const optVals = (page, sel) => page.$$eval(sel + " option", os => os.map(o => o.value));
await test("archive works on every Settings list, and Today's pickers skip archived items", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  const lists = { sym: "s2", food: "f1", mood: "md1", extra: "x1", supp: "u1", appt: "a1", place: "p1" };
  for (const [kind, id] of Object.entries(lists)) await page.click(`[data-arch="${kind}"][data-id="${id}"]`);
  const s = await page.saved();
  for (const [kind, list] of [["sym", "symptoms"], ["food", "foods"], ["mood", "moods"], ["extra", "extras"], ["supp", "supps"], ["appt", "appts"], ["place", "places"]])
    eq(s[list].find(x => x.id === lists[kind]).archived, today, kind + " archived");
  eq(await page.$$eval("#symList .prow.arch .nm", e => e.map(x => x.textContent)), ["Nausea"], "symptom under Archived");
  assert(/^archived\s/.test(await page.textContent("#symList .prow.arch .ds")), "shows when it was archived");
  await page.click('[role="tab"][data-tab="today"]');
  eq(await optVals(page, 'select[data-pick="sym"]'), ["", "s1", "__new"], "symptom picker");
  eq(await optVals(page, 'select[data-pick="food"][data-meal="lunch"]'), ["", "f2", "__new"], "food picker");
  eq(await optVals(page, 'select[data-pick="mood"][data-mt="morning"]'), ["", "md2", "__new"], "mood picker");
  eq(await optVals(page, 'select[data-pick="xmed"]'), ["", "x2", "m1", "__new"], "additional med picker");
  eq(await optVals(page, 'select[data-pick="ev"][data-ev="supp"]'), ["", "u2", "__new"], "supplement picker");
  eq(await optVals(page, 'select[data-pick="ev"][data-ev="appt"]'), ["", "__new"], "appointment picker");
  // things already logged today still show, even though they're archived
  assert((await page.textContent(".box.l-sym .chips")).includes("Nausea"), "logged symptom still shows");
  assert((await page.textContent(".box.meal.l-morning .chips")).includes("Oatmeal"), "logged food still shows");
  // and backfilling a day before it was archived still offers it
  await page.click("#prevDay");
  assert((await optVals(page, 'select[data-pick="food"][data-meal="lunch"]')).includes("f1"), "yesterday's picker still has it");
}, { ...base, foods: [{ id: "f1", name: "Oatmeal" }, { id: "f2", name: "Toast" }], places: [{ id: "p1", name: "Chipotle" }],
     extras: [{ id: "x1", name: "Tylenol" }, { id: "x2", name: "Aspirin" }], supps: [{ id: "u1", name: "Iron" }, { id: "u2", name: "Vitamin D" }], suppMode: "log",
     appts: [{ id: "a1", name: "GI follow-up" }],
     slog: { [today]: { s2: [{ t: "all" }] } }, meals: { [today]: { lunch: { foods: ["f1"] } } } });

await test("archived med leaves the checklist from that day; earlier days still count it, unarchive doesn't fill the gap with misses", async page => {
  const csvRow = async k => { const csv = await page.evaluate(([a, b]) => buildCSV(a, b), [shift(today, -6), today]);
    const lines = csv.replace(/^\ufeff/, "").split("\r\n"), head = parseCSVLine(lines[0]), row = parseCSVLine(lines.find(l => l.startsWith(k)));
    return [row[head.indexOf("doses_scheduled")], row[head.indexOf("missed_doses")]]; };
  eq(await page.$('.row.med[data-k="m1|morning"]'), null, "archived med not on today's checklist");
  eq(await page.$('.row.med[data-k="m2|morning"]') !== null, true, "other med still there");
  eq(await csvRow(shift(today, -5)), ["2", "Lisinopril (Morning); Metformin (Morning)"], "before archiving: both due");
  eq(await csvRow(shift(today, -3)), ["1", "Metformin (Morning)"], "after archiving: only the active med is due");
  eq(await csvRow(shift(today, -2)), ["2", "Metformin (Morning)"], "a dose checked off while archived still counts");
  await page.click('[data-tab="set"][role="tab"]');
  assert((await page.textContent("#medList .prow.arch")).includes("Lisinopril"), "under Archived");
  await page.click('[data-arch="med"][data-id="m1"]');
  const m1 = (await page.state()).meds.find(m => m.id === "m1");
  eq([m1.archived, m1.off], [undefined, [[shift(today, -4), today]]], "archive spell kept");
  eq(await csvRow(shift(today, -3)), ["1", "Metformin (Morning)"], "gap days are not counted as missed");
  await page.click('[role="tab"][data-tab="today"]');
  assert(await page.$('.row.med[data-k="m1|morning"]'), "back on today's checklist");
}, { ...base, meds: [{ id: "m1", name: "Lisinopril", dose: "10 mg", slots: ["morning"], archived: shift(today, -4) }, { id: "m2", name: "Metformin", slots: ["morning"] }],
     log: { [shift(today, -6)]: {}, [shift(today, -2)]: { "m1|morning": at(shift(today, -2), 8) } } });

await test("a med checked off on the day it's archived stays on that day's list", async page => {
  assert(await page.$('.row.med[aria-checked="true"][data-k="m1|morning"]'), "still shows, checked");
}, { ...base, meds: [{ id: "m1", name: "Lisinopril", slots: ["morning"], archived: today }], log: { [today]: { "m1|morning": at(today, 8) } } });

await test("adding a med with an archived med's name brings that med back", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  await page.click("#addMed");
  await page.fill('#itemForm [name="name"]', "lisinopril");
  await page.click('#slotPick input[value="evening"]', { force: true });
  await page.click("#saveItem");
  const meds = (await page.state()).meds;
  eq(meds.length, 1, "no duplicate");
  eq([meds[0].id, meds[0].archived, meds[0].slots], ["m1", undefined, ["evening"]], "same med, new time, unarchived");
}, { ...base, meds: [{ id: "m1", name: "Lisinopril", slots: ["morning"], archived: shift(today, -1) }] });

/* ---------- Copy yesterday: tap a box's name on Today ---------- */
const yday = shift(today, -1);
const copyFoods = { ...base, foods: [{ id: "f1", name: "Coffee" }, { id: "f2", name: "Oatmeal" }, { id: "f3", name: "Toast", archived: yday }],
  places: [{ id: "p1", name: "Snooze" }] };
async function copyFrom(page, sel) {
  await page.click(sel);
  await page.waitForSelector("#cmenu[open]");
  const out = { text: await page.textContent("#cmText"), sub: await page.textContent("#cmSub"), disabled: await page.isDisabled("#cmCopy") };
  if (!out.disabled) await page.click("#cmCopy");
  return out;
}
await test("tap Breakfast → Copy Yesterday's Meal copies foods, servings, ingredients and restaurant, then asks the time", async page => {
  const m = await copyFrom(page, '[data-copy="meal"][data-key="breakfast"]');
  eq(m.text, "Copy Yesterday's Meal", "menu text");
  eq(m.sub, "Coffee ×2, Oatmeal · at Snooze", "preview skips the archived food");
  await page.waitForSelector("#xdlg[open]");
  eq(await page.textContent("#xdlgTitle"), "Breakfast", "time pop-up title");
  eq(await page.textContent("#xnote"), "Copied yesterday's meal. When did you eat?", "time pop-up question");
  eq(await page.isVisible("#xalldayRow"), false, "no All day for meals");
  await page.fill("#xtime", "08:15");
  await page.click('#xform [type="submit"]');
  const s = await page.state(), t = at(today, 8, 15);
  eq(s.meals[today].breakfast, { foods: ["f1", "f1", "f2"], place: "p1", ft: { f1: t, f2: t }, fi: { f2: { ings: ["oats", "banana"] } } }, "today's breakfast");
  eq(s.meals[yday].breakfast.fx, { f1: [at(yday, 9)] }, "yesterday untouched");
  assert(await page.evaluate(() => state.meals[todayKey()].breakfast.fi.f2 !== state.meals[shiftKey(todayKey(), -1)].breakfast.fi.f2), "ingredients are a copy, not shared");
  eq(await page.isVisible("#cmenu"), false, "menu closed");
}, { ...copyFoods, meals: { [yday]: { breakfast: { foods: ["f1", "f1", "f2", "f3"], place: "p1", ft: { f1: at(yday, 8, 5), f2: at(yday, 8, 10) },
  fx: { f1: [at(yday, 9)] }, fi: { f2: { ings: ["oats", "banana"] } } } } } });

await test("copying over a meal asks first; Undo copy puts it back; Cancel keeps the copy at the current time", async page => {
  const before = (await page.state()).meals[today].breakfast;
  await copyFrom(page, '[data-copy="meal"][data-key="breakfast"]');
  eq(await askText(page), "Breakfast already has something logged. Replace it with yesterday's meal?", "asks before replacing");
  await page.click("#askNo");
  eq((await page.state()).meals[today].breakfast, before, "No leaves it alone");
  eq(await page.isVisible("#xdlg"), false, "no time pop-up");
  await copyFrom(page, '[data-copy="meal"][data-key="breakfast"]');
  await page.click("#askYes");
  await page.waitForSelector("#xdlg[open]");
  eq((await page.state()).meals[today].breakfast.foods, ["f1"], "replaced while the time pop-up is open");
  eq(await page.textContent("#xremove"), "Undo copy", "undo button");
  await page.click("#xremove");
  eq((await page.state()).meals[today].breakfast, before, "Undo copy restores it");
  eq((await page.saved()).meals[today].breakfast, before, "and that's saved");
  await copyFrom(page, '[data-copy="meal"][data-key="breakfast"]');
  await page.click("#askYes");
  await page.click("#xcancel");
  const b = (await page.state()).meals[today].breakfast;
  eq(b.foods, ["f1"], "Cancel keeps the copy");
  assert(Math.abs(b.ft.f1 - Date.now()) < 120000, "with the current time");
  eq(b.place, undefined, "the old restaurant went with the old meal");
}, { ...copyFoods, meals: { [today]: { breakfast: { foods: ["f2"], place: "p1", ft: { f2: at(today, 7) } } }, [yday]: { breakfast: { foods: ["f1"] } } } });

await test("Copy Yesterday's Moods and Symptoms (with All day) keep counts and intensity", async page => {
  const m = await copyFrom(page, '[data-copy="mood"][data-key="morning"]');
  eq([m.text, m.sub], ["Copy Yesterday's Moods", "Anxious ×2, Calm"], "mood menu");
  eq(await page.textContent("#xdlgTitle"), "Morning", "mood time title");
  await page.fill("#xtime", "09:30");
  await page.click('#xform [type="submit"]');
  let s = await page.state(); const t = at(today, 9, 30);
  eq([s.mlog[today], s.mtlog[today], s.mxlog[today]], [{ morning: ["md1", "md1", "md2"] }, { morning: { md1: t, md2: t } }, undefined], "moods copied with one time");
  const y = await copyFrom(page, '[data-copy="syms"]');
  eq([y.text, y.sub], ["Copy Yesterday's Symptoms", "Headache ×2, Nausea"], "symptom menu");
  eq(await page.isVisible("#xalldayRow"), true, "All day offered for symptoms");
  await page.check("#xallday");
  await page.click('#xform [type="submit"]');
  s = await page.state();
  eq(s.slog[today], { s1: [{ t: "all", i: 7 }, { t: "all" }], s2: [{ t: "all" }] }, "symptoms copied all day, intensity kept");
  eq(s.slog[yday].s1[0].t, at(yday, 9), "yesterday's symptoms untouched");
}, { ...base, moods: [{ id: "md1", name: "Anxious" }, { id: "md2", name: "Calm" }],
  mlog: { [yday]: { morning: ["md1", "md1", "md2"] } }, mtlog: { [yday]: { morning: { md1: at(yday, 9) } } }, mxlog: { [yday]: { morning: { md1: [at(yday, 11)] } } },
  slog: { [yday]: { s2: [{ t: "all" }], s1: [{ t: at(yday, 9), i: 7 }, { t: at(yday, 15) }] } } });

await test("Smells, Other and Appointments copy too; Medications has no copy menu; an empty or past day says so", async page => {
  const sm = await copyFrom(page, '[data-copy="smell"]');
  eq([sm.text, sm.sub], ["Copy Yesterday's Smells", "Smoke"], "smells menu");
  await page.fill("#xtime", "10:00"); await page.click('#xform [type="submit"]');
  const ot = await copyFrom(page, '[data-copy="other"]');
  eq([ot.text, ot.sub], ["Copy Yesterday's Entries", "Hot tub ×2"], "other menu");
  await page.fill("#xtime", "20:00"); await page.click('#xform [type="submit"]');
  const ap = await copyFrom(page, '[data-copy="appt"]');
  eq([ap.text, ap.sub], ["Copy Yesterday's Appointments", "Dr. Lee · Clinic"], "appointments menu (an older save's Who or where became its practitioner)");
  await page.fill("#xtime", "14:00"); await page.click('#xform [type="submit"]');
  const s = await page.state();
  eq(s.smlog[today], [{ id: "sm1", t: at(today, 10) }], "smell copied");
  eq(s.olog[today], [{ id: "o1", t: at(today, 20) }, { id: "o1", t: at(today, 20) }], "other copied ×2");
  eq(s.alog[today].map(e => [e.id, e.t, s.appts[0].who.find(w => w.id === e.w).name]), [["a1", at(today, 14), "Clinic"]], "appointment copied with its practitioner");
  eq(await page.locator('.tsec[data-sec="meds"] [data-copy]').evaluateAll(els => els.map(e => e.dataset.copy)), ["supp"], "in Medications & supplements, only Supplements has the copy menu");
  const lunch = await copyFrom(page, '[data-copy="meal"][data-key="lunch"]');
  eq([lunch.sub, lunch.disabled], ["Nothing logged yesterday", true], "nothing to copy");
  await page.keyboard.press("Escape");
  eq(await page.isVisible("#cmenu"), false, "Escape closes the menu");
  await page.click("#prevDay");
  const past = await copyFrom(page, '[data-copy="mood"][data-key="evening"]');
  eq([past.text, past.sub], ["Copy Previous Day's Moods", "Nothing logged the previous day"], "wording on a past day");
  await page.mouse.click(5, 5);
  eq(await page.isVisible("#cmenu"), false, "tapping outside closes the menu");
}, { ...base, smells: [{ id: "sm1", name: "Smoke" }], trackSmells: true, others: [{ id: "o1", name: "Hot tub" }],
  appts: [{ id: "a1", name: "Dr. Lee", dose: "Clinic" }],
  smlog: { [yday]: [{ id: "sm1", t: at(yday, 10) }] }, olog: { [yday]: [{ id: "o1", t: at(yday, 20) }, { id: "o1", t: at(yday, 21) }] },
  alog: { [yday]: [{ id: "a1", t: at(yday, 14) }] } });

await test("Snacks & Other Meals sits between Lunch and Dinner; logs foods, copies and exports", async page => {
  const order = await page.$$eval('.tsec[data-sec="food"] .box .lid', els => els.map(e => e.querySelector(".cpn,label").textContent));
  eq(order, ["Breakfast", "Lunch", "Snacks & Other Meals", "Dinner", "After dinner", "Food notes"], "box order");
  await page.selectOption('select[data-pick="food"][data-meal="snacks"]', "f1");
  eq((await page.state()).meals[today].snacks.foods, ["f1"], "food logged to snacks");
  const m = await copyFrom(page, '[data-copy="meal"][data-key="snacks"]');
  eq([m.text, m.sub], ["Copy Yesterday's Snacks", "Oatmeal"], "copy menu names it");
  await page.click("#askYes");
  eq(await page.textContent("#xnote"), "Copied yesterday's snacks. When did you eat?", "time question");
  await page.fill("#xtime", "15:30"); await page.click('#xform [type="submit"]');
  eq((await page.state()).meals[today].snacks.ft, { f2: at(today, 15, 30) }, "copied with the time");
  const csv = await page.evaluate(([a, b]) => buildCSV(a, b), [yday, today]);
  const lines = csv.replace(/^﻿/, "").split("\r\n"), head = parseCSVLine(lines[0]), row = parseCSVLine(lines.find(l => l.startsWith(today)));
  assert(head.includes("after_dinner_foods"), "existing column names unchanged");
  eq(["snacks_other_meals_time", "snacks_other_meals_foods", "snacks_other_meals_restaurant"].map(n => head.includes(n)), [true, true, true], "snack columns");
  assert(row[head.indexOf("snacks_other_meals_foods")].includes("Oatmeal"), "snack foods exported");
}, { ...copyFoods, meals: { [yday]: { snacks: { foods: ["f2"] } } } });

await test("Show snacks and Show after dinner (Settings → Food) hide and show those boxes, on by default, keeping their foods", async page => {
  const boxes = () => page.$$eval('.tsec[data-sec="food"] [data-copy="meal"]', els => els.map(e => e.textContent));
  eq(await boxes(), ["Breakfast", "Lunch", "Snacks & Other Meals", "Dinner", "After dinner"], "both on for an older save");
  await page.click('[data-tab="set"][role="tab"]');
  eq([await page.isChecked("#showSnacks"), await page.isChecked("#showAfter")], [true, true], "checkboxes on by default");
  await page.uncheck("#showSnacks");
  await page.uncheck("#showAfter");
  await page.click('[role="tab"][data-tab="today"]');
  eq(await boxes(), ["Breakfast", "Lunch", "Dinner"], "both hidden");
  const saved = await page.saved();
  eq([saved.showSnacks, saved.showAfter], [false, false], "saved");
  eq(saved.meals[today].snacks.foods, ["f1"], "hidden snack foods are kept");
  await page.click('[data-tab="set"][role="tab"]');
  await page.check("#showSnacks");
  await page.click('[role="tab"][data-tab="today"]');
  eq(await boxes(), ["Breakfast", "Lunch", "Snacks & Other Meals", "Dinner"], "snacks back, after dinner still hidden");
  assert(await page.isVisible('.chip:has-text("Coffee")'), "with its food");
}, { ...copyFoods, meals: { [today]: { snacks: { foods: ["f1"] } } } });

/* ---------- Suspected triggers ---------- */
const trigCol = csv => { const lines = csv.replace(/^﻿/, "").split("\r\n"), head = parseCSVLine(lines[0]), i = head.findIndex(h => h.startsWith("suspected_triggers"));
  return { head: head[i], val: parseCSVLine(lines.find(l => l.startsWith(today)))[i] }; };
await test("Suspected trigger: tick it in a box's menu; tagged on Today, saved, and listed in the export", async page => {
  await page.click('[data-copy="meal"][data-key="breakfast"]');
  await page.waitForSelector("#cmenu[open]");
  eq([await page.isVisible("#cmTrig"), await page.isChecked("#cmTrig")], [true, false], "checkbox shown, unticked");
  await page.check("#cmTrig");
  eq((await page.state()).trig, { [today]: { breakfast: true } }, "marked");
  eq(await page.isVisible("#cmenu"), true, "menu stays open");
  await page.keyboard.press("Escape");
  eq(await page.textContent('.box:has([data-key="breakfast"]) .trig'), "Trigger?", "tag on Breakfast");
  eq(await page.locator(".lid .trig").count(), 1, "only on Breakfast");
  for (const sel of ['[data-copy="mood"][data-key="morning"]', '[data-copy="smell"]']) {
    await page.click(sel); await page.check("#cmTrig"); await page.keyboard.press("Escape");
  }
  eq((await page.saved()).trig[today], { breakfast: true, "mood-morning": true, smell: true }, "saved, one key per box");
  await page.click('[data-copy="smell"]');
  assert(await page.isChecked("#cmTrig"), "ticked when reopened");
  await page.uncheck("#cmTrig"); await page.keyboard.press("Escape");
  eq((await page.state()).trig[today], { breakfast: true, "mood-morning": true }, "unticking clears it");
  const c = trigCol(await page.evaluate(([a, b]) => buildCSV(a, b), [today, today]));
  assert(/possibly triggering/.test(c.head), "column header says what it means: " + c.head);
  eq(c.val, "Breakfast: Coffee x2, Oatmeal · at Snooze | Morning mood: Calm", "export lists each marked box and what was in it");
}, { ...copyFoods, smells: [{ id: "sm1", name: "Smoke" }], trackSmells: true,
  meals: { [today]: { breakfast: { foods: ["f1", "f1", "f2"], place: "p1" } } }, mlog: { [today]: { morning: ["md2"] } } });

await test("Symptoms box says Suspected Flare and tags Flare?; other boxes keep Suspected trigger", async page => {
  await page.click('[data-copy="syms"]');
  await page.waitForSelector("#cmenu[open]");
  eq(await page.textContent("#cmTrigLbl"), "Suspected Flare", "label on Symptoms");
  await page.check("#cmTrig"); await page.keyboard.press("Escape");
  eq((await page.state()).trig, { [today]: { syms: true } }, "same mark as before");
  eq(await page.textContent('.box:has([data-copy="syms"]) .trig'), "Flare?", "tag on Symptoms");
  await page.click('[data-copy="meal"][data-key="breakfast"]');
  eq(await page.textContent("#cmTrigLbl"), "Suspected trigger", "label back on Breakfast");
  await page.check("#cmTrig"); await page.keyboard.press("Escape");
  const csv = await page.evaluate(([a, b]) => buildCSV(a, b), [today, today]), lines = csv.replace(/^﻿/, "").split("\r\n"),
    head = parseCSVLine(lines[0]), row = parseCSVLine(lines.find(l => l.startsWith(today))), col = p => row[head.findIndex(h => h.startsWith(p))];
  eq(head.findIndex(h => h.startsWith("suspected_flare")), head.findIndex(h => h.startsWith("suspected_triggers")) + 1, "flare column right after triggers");
  eq([col("suspected_flare"), col("suspected_triggers")], ["1", "Breakfast: nothing logged"], "flare in its own column, not in triggers");
  await page.click('[data-copy="syms"]'); await page.uncheck("#cmTrig"); await page.keyboard.press("Escape");
  const csv2 = await page.evaluate(([a, b]) => buildCSV(a, b), [today, today]), head2 = parseCSVLine(csv2.replace(/^﻿/, "").split("\r\n")[0]);
  eq(parseCSVLine(csv2.replace(/^﻿/, "").split("\r\n").find(l => l.startsWith(today)))[head2.findIndex(h => h.startsWith("suspected_flare"))], "0", "0 when not marked");
});

await test("Suspected triggers setting (Settings → Today page): off hides the checkbox and tags, keeps the marks and export", async page => {
  assert(await page.isVisible(".lid .trig"), "on by default for an older save");
  await page.click('[data-tab="set"][role="tab"]');
  assert(await page.isChecked("#trackTrig"), "setting on");
  await page.uncheck("#trackTrig");
  await page.click('[role="tab"][data-tab="today"]');
  eq(await page.locator(".lid .trig").count(), 0, "no tags");
  await page.click('[data-copy="meal"][data-key="breakfast"]');
  eq(await page.isVisible("#cmTrig"), false, "no checkbox in the menu");
  await page.keyboard.press("Escape");
  const saved = await page.saved();
  eq([saved.trackTrig, saved.trig], [false, { [today]: { breakfast: true } }], "setting saved, mark kept");
  eq(trigCol(await page.evaluate(([a, b]) => buildCSV(a, b), [today, today])).val, "Breakfast: Oatmeal", "still exported");
  await page.click('[data-tab="set"][role="tab"]'); await page.check("#trackTrig"); await page.click('[role="tab"][data-tab="today"]');
  assert(await page.isVisible(".lid .trig"), "back when turned on");
}, { ...copyFoods, meals: { [today]: { breakfast: { foods: ["f2"] } } }, trig: { [today]: { breakfast: true } } });

await test("Today's sections alternate inverted / regular, and keep alternating when one is hidden", async page => {
  const looks = () => page.$$eval(".tsec", l => l.map(x => x.dataset.sec + ":" + (x.classList.contains("inv") ? "inv" : x.classList.contains("reg") ? "reg" : "?")));
  eq(await looks(), ["meds:inv", "food:reg", "smells:inv", "activity:reg", "mood:inv", "syms:reg", "appts:inv", "notes:reg", "night:inv"], "default order (the sections above Overnight keep their look)");
  const bg = sel => page.$eval(sel, e => getComputedStyle(e).backgroundColor);
  eq(await bg('.tsec[data-sec="food"] .box .lid'), "rgb(255, 255, 255)", "regular: white title bar");
  assert(await bg('.tsec[data-sec="food"] .box') !== "rgb(255, 255, 255)", "regular: colored box");
  eq(await bg('.tsec[data-sec="smells"] .box'), "rgb(255, 255, 255)", "inverted: white box");
  assert(await bg('.tsec[data-sec="smells"] .box .lid') !== "rgb(255, 255, 255)", "inverted: colored title bar");
  await page.click('[data-tab="set"][role="tab"]');
  await page.uncheck('#layoutList [data-show="smells"]');
  await page.click('[role="tab"][data-tab="today"]');
  eq(await looks(), ["meds:inv", "food:reg", "activity:inv", "mood:reg", "syms:inv", "appts:reg", "notes:inv", "night:reg"], "re-alternates without Smells");
}, { ...base, trackSmells: true });

await test("Recap and Settings alternate like Today, and one switch in Personalize brings the old look back", async page => {
  const WHITE = "rgb(255, 255, 255)", bg = (sel, i) => page.$$eval(sel, (l, i) => getComputedStyle(l[i]).backgroundColor, i);
  assert(await page.evaluate(() => document.body.classList.contains("alt-look")), "on by default for an older save");
  await page.click('[role="tab"][data-tab="sum"]');
  eq([await bg("#sumBody > .box", 0), await bg("#sumBody > .box .lid", 0)].map(c => c === WHITE), [true, false], "Recap box 1 inverted");
  eq([await bg("#sumBody > .box", 1), await bg("#sumBody > .box .lid", 1)].map(c => c === WHITE), [false, true], "Recap box 2 regular");
  await page.click('[data-tab="set"][role="tab"]');
  eq(await page.$$eval(".sset", l => l.map(x => x.classList.contains("lk-inv") ? "inv" : "reg")), ["inv", "reg", "inv", "reg", "inv", "reg", "inv", "reg", "inv", "reg", "inv"], "Settings sections alternate");
  const smellBox = () => page.$eval(".pg-smo .box:has(#smellList)", e => getComputedStyle(e).backgroundColor);
  assert(await smellBox() !== WHITE, "Smells in Settings is regular in the new look");
  assert(await page.isChecked("#altLook"), "switch on");
  await page.uncheck("#altLook");
  eq((await page.saved()).altLook, false, "saved");
  assert(!(await page.evaluate(() => document.body.classList.contains("alt-look"))), "class removed");
  eq(await smellBox(), WHITE, "old look: Smells inverted again");
  await page.click('[role="tab"][data-tab="sum"]');
  eq(await bg("#sumBody > .box", 1), WHITE, "old look: every Recap box white");
}, { ...base, trackSmells: true, smells: [{ id: "sm1", name: "Smoke" }] });

/* ---------- Time boxes open the picker when tapped anywhere ---------- */
await test("tapping the time in a pop-up opens the time picker, not just the clock icon", async page => {
  await page.evaluate(() => { window.__picked = []; HTMLInputElement.prototype.showPicker = function () { window.__picked.push(this.id || this.dataset.otime || this.dataset.ptime || "?"); }; });
  await page.click('.row.med[data-k="m1|morning"]');
  await page.click(".medrow button.when");
  await page.waitForSelector("#xdlg[open]");
  await page.click("#xtime", { position: { x: 12, y: 10 } });   // on the digits, far from the clock icon
  eq(await page.evaluate(() => window.__picked), ["xtime"], "picker opened from the time text");
  await page.click("#xlabel");                                 // the label above it too
  eq(await page.evaluate(() => window.__picked.length), 2, "label tap opens it as well");
  await page.evaluate(() => { const i = document.getElementById("xtime"); i.disabled = true; i.click(); i.disabled = false; });
  eq(await page.evaluate(() => window.__picked.length), 2, "a disabled time box doesn't open");
}, base);
await test("real time picker: tapping a time box raises no errors", async page => {
  await page.click('.row.med[data-k="m1|morning"]');
  await page.click(".medrow button.when");
  await page.click("#xtime", { position: { x: 12, y: 10 } });
  await page.keyboard.press("Escape");
}, base);

/* ---------- End of day: a bedtime dose ends the day, even after midnight ---------- */
const NIGHT = "2026-10-19", NEXT = "2026-10-20";   // Monday, and the small hours of Tuesday
const lateSeed = { ...base, meds: [{ id: "c1", name: "Cromolyn Sodium Ampule", slots: ["waking", "bedtime"] }, { id: "z1", name: "Zyrtec", slots: ["bedtime"] }],
  log: { [NIGHT]: { "c1|waking": at(NIGHT, 7) } } };
await test("after midnight the day stays open until bedtime Cromolyn; late doses get their real time, then the new day starts", async page => {
  eq(await page.evaluate(() => [viewDate, todayKey()]), [NIGHT, NIGHT], "still Monday at 12:30 AM");
  assert(/past midnight/.test(await page.textContent("#dayTitle")), "header says past midnight");
  await page.click('.row.med[data-k="z1|bedtime"]');
  const z = new Date((await page.state()).log[NIGHT]["z1|bedtime"]);
  eq([keyOf(z), z.getHours()], [NEXT, 0], "Zyrtec on Monday's list, stamped Tuesday 12:30 AM");
  await page.click('.row.med[data-k="c1|bedtime"]');
  eq(await page.evaluate(() => [todayKey(), viewDate]), [NEXT, NEXT], "checking Cromolyn ends Monday and opens Tuesday");
  const s = await page.state();
  eq(keyOf(new Date(s.log[NIGHT]["c1|bedtime"])), NEXT, "Cromolyn kept on Monday with its real time");
  eq(s.log[NEXT], undefined, "Tuesday's checklist starts empty");
  const csv = await page.evaluate(k => buildCSV(k, k), NIGHT);
  assert(/Zyrtec \(Bedtime\) at 12:30 AM/.test(csv), "export lists the late dose on Monday");
}, lateSeed, { clock: new Date(2026, 9, 20, 0, 30) });

await test("bedtime Cromolyn forgotten: at 3 AM the new day starts", async page => {
  eq(await page.evaluate(() => todayKey()), NEXT, "Tuesday");
  assert(!/past midnight/.test(await page.textContent("#dayTitle")), "plain Today");
}, lateSeed, { clock: new Date(2026, 9, 20, 3, 5) });

await test("bedtime Cromolyn checked before midnight: Tuesday starts at midnight; a dose checked on Monday after midnight keeps its real time", async page => {
  eq(await page.evaluate(() => todayKey()), NEXT, "Tuesday after midnight");
  await page.click("#prevDay");
  await page.click('.row.med[data-k="z1|bedtime"]');
  eq(keyOf(new Date((await page.state()).log[NIGHT]["z1|bedtime"])), NEXT, "Tuesday 12:40 AM, not Monday 12:40 AM");
}, { ...lateSeed, log: { [NIGHT]: { "c1|waking": at(NIGHT, 7), "c1|bedtime": at(NIGHT, 23) } } }, { clock: new Date(2026, 9, 20, 0, 40) });

await test("editing times on a day that ran past midnight: 12:15 AM is that night, 3:30 PM is the day itself", async page => {
  await page.evaluate(k => { viewDate = k; render(); }, NIGHT);
  await page.click('button[data-editsym="s2"]');
  await page.fill("#xtime", "00:15"); await page.click('#xform button[type="submit"]');
  let t = new Date((await page.state()).slog[NIGHT].s2[0].t);
  eq([keyOf(t), t.getHours(), t.getMinutes()], [NEXT, 0, 15], "before the 12:33 AM Cromolyn: Tuesday 12:15 AM");
  await page.click('button[data-editsym="s2"]');
  await page.fill("#xtime", "15:30"); await page.click('#xform button[type="submit"]');
  t = new Date((await page.state()).slog[NIGHT].s2[0].t);
  eq([keyOf(t), t.getHours()], [NIGHT, 15], "an afternoon time stays on Monday");
  await page.click('button[data-editk="c1|bedtime"]');
  await page.fill("#xtime", "00:50"); await page.click('#xform button[type="submit"]');
  t = new Date((await page.state()).log[NIGHT]["c1|bedtime"]);
  eq([keyOf(t), t.getMinutes()], [NEXT, 50], "moving the Cromolyn itself later keeps it in that night");
}, { ...lateSeed, log: { [NIGHT]: { "c1|waking": at(NIGHT, 7), "c1|bedtime": at(NEXT, 0, 33) } }, slog: { [NIGHT]: { s2: [{ t: at(NIGHT, 16) }] } } },
   { clock: new Date(2026, 9, 20, 10, 0) });

await test("End of day setting: bedtime Cromolyn by default, At midnight turns it off", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  eq(await page.inputValue("#dayEnd"), "c1", "Cromolyn picked");
  await page.selectOption("#dayEnd", "");
  eq(await page.evaluate(() => [todayKey(), viewDate]), [NEXT, NEXT], "midnight ends the day again");
  eq((await page.saved()).dayEnd, "", "choice saved");
}, lateSeed, { clock: new Date(2026, 9, 20, 0, 30) });

/* ---------- Activity and exertion ---------- */
const csvCols = csv => { const lines = csv.replace(/^\ufeff/, "").split("\r\n"), head = parseCSVLine(lines[0]), row = parseCSVLine(lines[1]); return n => row[head.indexOf(n)]; };
await test("Activity: log one, tap its name to set minutes and exertion; the chip, Recap and export show them", async page => {
  await page.selectOption('select[data-pick="ev"][data-ev="act"]', "a1");
  await page.click('button[data-actd="a1"]');
  await page.waitForSelector("#sdlg[open]");
  eq(await page.textContent("#sdlg .scalelab"), "EasyAll-out", "exertion scale");
  eq(await page.locator("#sdlg [data-oall]").count(), 0, "no All day for activities");
  await page.fill('#sdlg [data-omin="0"]', "45");
  await page.click('#sdlg [data-lv="7"]');
  eq(await page.inputValue('#sdlg [data-omin="0"]'), "45", "minutes kept when tapping the scale");
  await page.click('#sform button[type="submit"]');
  const e = (await page.state()).aclog[today][0];
  eq([e.id, e.x, e.min], ["a1", 7, 45], "saved with exertion and minutes");
  const chip = await page.textContent('[data-evbox="act"] .chip');
  assert(/^Walk745m/.test(chip), "chip shows exertion and minutes: " + chip);
  const col = csvCols(await page.evaluate(k => buildCSV(k, k), today));
  assert(/^Walk at \d+:\d\d [AP]M \(45 min, exertion 7\/10\)$/.test(col("activities")), "activities: " + col("activities"));
  eq([col("activity_count"), col("activity_minutes"), col("max_exertion"), col("activity: Walk"), col("exertion: Walk")], ["1", "45", "7", "1", "7"], "columns");
  await page.click('[data-tab="sum"][role="tab"]');
  const sum = await page.textContent("#sumBody");
  assert(sum.includes("Exertion & symptoms") && /Walk\s*1 day/.test(sum), "Recap shows the activity and the exertion box");
}, { ...base, acts: [{ id: "a1", name: "Walk" }] });

await test("Activity is its own Settings list; + New activity… adds and logs it", async page => {
  await page.selectOption('select[data-pick="ev"][data-ev="act"]', "__new");
  await page.fill('#itemForm [name="name"]', "Yoga");
  await page.click("#saveItem");
  const s = await page.state();
  eq([s.acts.map(x => x.name), s.aclog[today].length], [["Yoga"], 1], "added and logged");
  await page.click('[data-tab="set"][role="tab"]');
  assert((await page.textContent("#actList")).includes("Yoga"), "listed in Settings");
}, base);

await test("Got overheated starts in Other, is added once to an older list, and deleting it sticks", async page => {
  eq((await page.state()).others.map(x => x.name), ["Hot tub", "Got overheated"], "added to an older list");
  await page.selectOption('select[data-pick="ev"][data-ev="other"]', { label: "Got overheated" });
  eq((await page.state()).olog[today].length, 1, "logged");
  await page.evaluate(() => { state.others = state.others.filter(x => !/overheat/i.test(x.name)); persist(); });
  await page.reload();
  eq((await page.state()).others.map(x => x.name), ["Hot tub"], "deleting it sticks");
}, { ...base, others: [{ id: "o1", name: "Hot tub" }] });

await test("Recap Exertion & symptoms: harder vs easier activities, symptoms within 6 hours, unrated ones left out", async page => {
  const vals = h => [...h.matchAll(/class="v[^"]*">([^<]+)</g)].map(m => m[1]);
  const box = await page.evaluate(([a, b]) => exertionSummary(a, b), [shift(today, -6), today]);
  assert(/3 rated/.test(box), "three rated; the unrated one is left out");
  assert(/Exertion 6–10 \(2\)/.test(box) && /1–5 \(1\)/.test(box), "split by exertion");
  eq(vals(box), ["50%", "0%"], "the hard walk followed by nausea at 1 PM counts");
  eq(vals(await page.evaluate(([a, b]) => { exSym = "s1"; return exertionSummary(a, b); }, [shift(today, -6), today])), ["0%", "0%"], "a headache at 8 PM is past the 6 hours");
}, { ...base, acts: [{ id: "a1", name: "Walk" }],
  aclog: { [shift(today, -4)]: [{ id: "a1", t: at(shift(today, -4), 10) }], [shift(today, -3)]: [{ id: "a1", t: at(shift(today, -3), 10), x: 8, min: 30 }],
           [shift(today, -2)]: [{ id: "a1", t: at(shift(today, -2), 10), x: 3 }], [shift(today, -1)]: [{ id: "a1", t: at(shift(today, -1), 10), x: 7 }] },
  slog: { [shift(today, -3)]: { s2: [{ t: at(shift(today, -3), 13) }] }, [shift(today, -1)]: { s1: [{ t: at(shift(today, -1), 20) }] } } });

await test("Copy Yesterday's Activities keeps minutes and exertion, then asks the start time", async page => {
  const m = await copyFrom(page, '[data-copy="act"]');
  eq([m.text, m.sub], ["Copy Yesterday's Activities", "Yoga"], "menu");
  await page.waitForSelector("#xdlg[open]");
  await page.fill("#xtime", "07:30"); await page.click('#xform [type="submit"]');
  const e = (await page.state()).aclog[today][0];
  eq([e.x, e.min, new Date(e.t).getHours()], [6, 20, 7], "copied with its details at 7:30");
}, { ...base, acts: [{ id: "a1", name: "Yoga" }], aclog: { [shift(today, -1)]: [{ id: "a1", t: at(shift(today, -1), 8), x: 6, min: 20 }] } });

await test("Copy Yesterday's Supplements copies them with one time and can be a suspected trigger", async page => {
  const m = await copyFrom(page, '[data-copy="supp"]');
  eq([m.text, m.sub], ["Copy Yesterday's Supplements", "Magnesium ×2, Vitamin D"], "menu");
  eq(await page.textContent("#xnote"), "Copied yesterday's supplements. When did you take them?", "time question");
  await page.fill("#xtime", "08:15"); await page.click('#xform [type="submit"]');
  eq((await page.state()).suplog[today].map(e => [e.id, e.t]), [["sp1", at(today, 8, 15)], ["sp1", at(today, 8, 15)], ["sp2", at(today, 8, 15)]], "copied at 8:15");
  await page.click('[data-copy="supp"]'); await page.check("#cmTrig");
  assert(await page.evaluate(() => trigText(todayKey()).startsWith("Supplements: Magnesium x2, Vitamin D")), "trigger exported with the box");
  eq(await page.$eval(".lid", el => getComputedStyle(el).userSelect), "none", "titles aren't selectable text");
}, { ...base, supps: [{ id: "sp1", name: "Magnesium" }, { id: "sp2", name: "Vitamin D" }],
  suplog: { [yday]: [{ id: "sp1", t: at(yday, 8) }, { id: "sp1", t: at(yday, 20) }, { id: "sp2", t: at(yday, 8) }] } });

await test("every section's notes box copies yesterday's text (not Medication notes); asks before replacing; no time or trigger", async page => {
  eq(await page.locator('[data-copy="note"]').count(), 7, "Symptoms, Food, Mood, Smells & other, Activity, Appointments and the day's Notes");
  eq(await page.locator('[data-copy="note"][data-key="meds"]').count(), 0, "Medication notes has no copy menu");
  const f = await copyFrom(page, '[data-copy="note"][data-key="food"]');
  eq([f.text, f.sub], ["Copy Yesterday's Notes", "Oatmeal sat badly."], "food notes menu");
  eq(await page.isVisible("#xdlg"), false, "no time asked");
  eq(await page.inputValue("#n-food"), "Oatmeal sat badly.", "text copied into the box");
  eq((await page.state()).pnotes.food[today], "Oatmeal sat badly.", "and saved");
  await page.click('[data-copy="note"][data-key="today"]');
  eq(await page.isVisible("#cmTrigRow"), false, "no Suspected trigger on notes");
  eq(await page.textContent("#cmSub"), "Long day. Slept well.", "day notes preview");
  await page.click("#cmCopy");
  eq(await page.textContent("#askMsg"), "Notes already has something written. Replace it with yesterday's notes?", "asks first");
  await page.click("#askNo");
  eq((await page.state()).notes[today], "Already wrote today", "Cancel keeps today's text");
  await page.click('[data-copy="note"][data-key="today"]'); await page.click("#cmCopy"); await page.click("#askYes");
  eq(await page.inputValue("#n-today"), "Long day.\nSlept well.", "Replace copies it, line breaks kept");
  const m = await copyFrom(page, '[data-copy="note"][data-key="mood"]');
  eq([m.sub, m.disabled], ["Nothing written yesterday", true], "nothing to copy");
}, { ...base, trackTrig: true, notes: { [yday]: "Long day.\nSlept well.", [today]: "Already wrote today" },
  pnotes: { food: { [yday]: "Oatmeal sat badly." }, meds: { [yday]: "Dose changed" } } });

await test("one appointment, two therapists: each visit keeps its own practitioner and time", async page => {
  /* The bug: + New appointment… with Therapy again replaced the first therapist, and both visits merged into one chip */
  await page.selectOption('select[data-pick="ev"][data-ev="appt"]', "a1|w1");
  await page.selectOption('select[data-pick="ev"][data-ev="appt"]', "__new");
  await page.fill('#itemForm [name="name"]', "therapy");
  await page.fill("#whoRows input", "Dr. Kim");
  await page.click("#saveItem");
  let s = await page.state();
  eq([s.appts.length, s.appts[0].name], [1, "Therapy"], "same appointment, not a duplicate or a rename");
  eq(s.appts[0].who.map(w => w.name), ["Dr. Lee", "Dr. Kim"], "Dr. Lee kept, Dr. Kim added");
  const kim = s.appts[0].who[1].id;
  eq(s.alog[today].map(e => e.w), ["w1", kim], "each visit has its own");
  eq(await page.$$eval('[data-evbox="appt"] .chip', c => c.map(x => x.querySelector(".who").textContent)), ["Dr. Lee", "Dr. Kim"], "two chips");
  eq(await optVals(page, 'select[data-pick="ev"][data-ev="appt"]'), ["", "a1|w1", "a1|" + kim, "__new"], "picker lists each therapist");
  /* Tap a practitioner to change that visit only, and its time */
  await page.click('[data-evbox="appt"] .chip >> nth=0 >> button.who');
  eq(await page.isVisible("#xwhoRow"), true, "Who or where in the pop-up");
  await page.selectOption("#xwho", kim); await page.fill("#xtime", "09:00"); await page.click('#xform [type="submit"]');
  s = await page.state();
  eq(s.alog[today].map(e => e.w), [kim, kim], "first visit changed, second untouched");
  eq(s.appts[0].who.map(w => w.name), ["Dr. Lee", "Dr. Kim"], "the list itself is unchanged");
  await page.click('[data-evbox="appt"] .chip >> nth=0 >> button.t');
  await page.selectOption("#xwho", "w1"); await page.click('#xform [type="submit"]');
  /* Settings: rename one, remove the other (kept for its past visit, gone from the picker) */
  await page.evaluate(() => openEditor("appt", "a1"));
  eq(await page.$$eval("#whoRows input", l => l.map(i => i.value)), ["Dr. Lee", "Dr. Kim"], "editor lists both");
  await page.fill("#whoRows input >> nth=0", "Dr. Lee-Park");
  await page.click("#whoRows .whorow >> nth=1 >> button");
  await page.click("#saveItem");
  s = await page.state();
  eq(s.appts[0].who.map(w => [w.name, !!w.gone]), [["Dr. Lee-Park", false], ["Dr. Kim", true]], "renamed; removed one kept for history");
  eq(await optVals(page, 'select[data-pick="ev"][data-ev="appt"]'), ["", "a1|w1", "__new"], "removed one leaves the picker");
  const csv = await page.evaluate(k => buildCSV(k, k), today);
  assert(csv.includes("Therapy (Dr. Lee-Park) at") && csv.includes("Therapy (Dr. Kim) at"), "spreadsheet names each visit's practitioner");
  const c = await copyFrom(page, '[data-copy="appt"]');
  eq(c.sub, "Nothing logged yesterday", "copy menu still works");
}, { ...base, appts: [{ id: "a1", name: "Therapy", who: [{ id: "w1", name: "Dr. Lee" }] }] });

await test("+ Add practitioner… in a visit's pop-up opens the appointment's editor; the new one goes on that visit", async page => {
  await page.click('[data-evbox="appt"] .chip >> nth=0 >> button.t');   // Dr. Lee ×2: acts on the later visit
  eq(await optVals(page, "#xwho"), ["w1", "__new"], "no Not listed; Add practitioner last");
  eq(await page.$eval('#xwho option[value="__new"]', o => o.textContent), "+ Add practitioner…", "label");
  await page.fill("#xtime", "15:45");
  await page.selectOption("#xwho", "__new");
  await page.waitForSelector("#dlg[open]");
  eq(await page.isVisible("#xdlg"), false, "time pop-up closed");
  eq(await page.textContent("#dlgTitle"), "Edit appointment", "appointment editor");
  eq(await page.$$eval("#whoRows input", l => l.map(i => i.value)), ["Dr. Lee", ""], "a blank row to type in");
  eq(await page.evaluate(() => document.activeElement === document.querySelector("#whoRows .whorow:last-child input")), true, "focused");
  await page.fill("#whoRows .whorow:last-child input", "Dr. Patel");
  await page.click("#saveItem");
  const s = await page.state(), patel = s.appts[0].who.find(w => w.name === "Dr. Patel");
  assert(patel, "added to the list");
  eq(s.alog[today].map(e => [e.w || "", new Date(e.t).getHours()]), [["w1", 9], [patel.id, 15], ["", 18]], "on that visit only, its time change kept");
  /* A visit with no practitioner yet starts on Choose… */
  await page.click('[data-evbox="appt"] .chip >> nth=2 >> button.t');
  eq([await optVals(page, "#xwho"), await page.inputValue("#xwho")], [["", "w1", patel.id, "__new"], ""], "Choose… first when none");
  /* Cancelling the editor leaves the visit as it was */
  await page.selectOption("#xwho", "__new"); await page.waitForSelector("#dlg[open]"); await page.click("#cancel");
  eq((await page.state()).alog[today][2].w, undefined, "cancel changes nothing");
}, { ...base, appts: [{ id: "a1", name: "Therapy", who: [{ id: "w1", name: "Dr. Lee" }] }],
  alog: { [today]: [{ id: "a1", t: at(today, 9), w: "w1" }, { id: "a1", t: at(today, 15), w: "w1" }, { id: "a1", t: at(today, 18) }] } });

await test("an older save's single Who or where becomes the practitioner of every past visit", async page => {
  const s = await page.state(), a = s.appts[0];
  eq([a.dose, a.who.map(w => w.name)], [undefined, ["City Clinic"]], "converted");
  eq(s.alog[yday][0].w, a.who[0].id, "past visit points to it");
  eq(s.appts[1].who, [], "one without stays empty");
}, { ...base, appts: [{ id: "a1", name: "GI", dose: "City Clinic" }, { id: "a2", name: "Labs" }], alog: { [yday]: [{ id: "a1", t: at(yday, 9) }] } });

/* ---------- 11. Types, skip, comments and links, flare-ups ---------- */
const csvRowOf = (csv, k = today) => { const lines = csv.replace(/^﻿/, "").split("\r\n"), head = parseCSVLine(lines[0]), row = parseCSVLine(lines.find(l => l.startsWith(k)));
  return p => row[head.findIndex(h => h === p || h.startsWith(p + " "))]; };
const typedMed = { ...base, meds: [...base.meds, { id: "ah", name: "Antihistamine", slots: ["morning"], lastOpt: "o2",
  opts: [{ id: "o1", name: "Allegra", dose: "180 mg" }, { id: "o2", name: "Zyrtec", dose: "10 mg" }] }] };
await test("a med with types: Take all uses the last one; checking it asks which one; the row, time pop-up and export show it", async page => {
  await page.click('[data-all="morning"]');
  let s = await page.state();
  eq([!!s.log[today]["m1|morning"], !!s.log[today]["ah|morning"], s.ldet[today]["ah|morning"]], [true, true, { o: "o2" }], "Take all uses the one taken last");
  await page.click('.row.med[data-k="ah|morning"]');
  eq((await page.state()).ldet[today], undefined, "unchecking clears which one");
  await page.click('.row.med[data-k="ah|morning"]');
  await page.waitForSelector("#odlg[open]");
  assert((await page.textContent("#odlgTitle")).includes("Antihistamine"), "asks about Antihistamine");
  eq(await page.$$eval("#oList [data-oid]", b => b.map(x => x.textContent)), ["Allegra180 mg", "Zyrtec10 mg" + "last time"], "both types, last one marked");
  await page.click("#oCancel");
  eq((await page.state()).log[today]["ah|morning"], undefined, "Cancel checks nothing");
  await page.click('.row.med[data-k="ah|morning"]'); await page.click('#oList [data-oid="o1"]');
  s = await page.state();
  eq([s.log[today]["ah|morning"] > 1e11, s.ldet[today]["ah|morning"], s.meds[1].lastOpt], [true, { o: "o1" }, "o1"], "checked with Allegra");
  assert((await page.textContent('.medrow:has([data-k="ah|morning"]) .ds')).includes("Allegra 180 mg"), "row shows the one taken");
  await page.click('.medrow:has([data-k="ah|morning"]) .when');
  assert(await page.isVisible("#xoptRow"), "time pop-up can change which one");
  eq(await page.isVisible("#xsymRow"), false, "no linked symptom on a checked med");
  await page.selectOption("#xopt", "o2"); await page.click('#xform button[type="submit"]');
  eq((await page.state()).ldet[today]["ah|morning"].o, "o2", "changed to Zyrtec");
  const col = csvRowOf(await page.evaluate(k => buildCSV(k, k), today));
  assert(/Antihistamine: Zyrtec 10 mg \(Morning\) at/.test(col("doses_taken_list")), "export names the type: " + col("doses_taken_list"));
}, typedMed);

await test("types are added in the editor; + New type… in Which one? adds one and logs it; a used type removed is kept for history", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  await page.click("#addExtra");
  assert(await page.isVisible("#addOpt"), "Types section in the editor");
  await page.fill('#itemForm [name="name"]', "Antihistamine");
  await page.click("#addOpt"); await page.fill("#optRows .optrow:nth-child(1) input:not(.od)", "Allegra"); await page.fill("#optRows .optrow:nth-child(1) input.od", "180 mg");
  await page.click("#addOpt"); await page.fill("#optRows .optrow:nth-child(2) input:not(.od)", "Zyrtec");
  await page.click("#saveItem");
  let s = await page.state();
  eq(s.extras[0].opts.map(o => [o.name, o.dose]), [["Allegra", "180 mg"], ["Zyrtec", undefined]], "types saved with details");
  assert((await page.textContent("#extraList")).includes("Allegra / Zyrtec"), "Settings row lists them");
  await page.click('[data-edit-sym="s1"]');
  eq(await page.isVisible("#addOpt"), false, "symptoms have no types");
  await page.click("#cancel");
  await page.click('[role="tab"][data-tab="today"]');
  const xid = s.extras[0].id;
  await page.selectOption('select[data-pick="xmed"]', xid);
  await page.waitForSelector("#odlg[open]");
  await page.click("#oNew");
  await page.waitForSelector("#dlg[open]");
  await page.fill("#optRows .optrow:last-child input:not(.od)", "Claritin");
  await page.click("#saveItem");
  s = await page.state();
  const cl = s.extras[0].opts.find(o => o.name === "Claritin");
  assert(cl, "Claritin added");
  eq(s.xlog[today].map(e => e.o), [cl.id], "and logged as the one taken");
  assert((await page.textContent(".box.l-extra .chips")).includes("Claritin"), "chip shows it");
  await page.click('[data-tab="set"][role="tab"]');
  await page.click(`[data-edit-extra="${xid}"]`);
  for (const n of ["Claritin", "Zyrtec"]) await page.click(`#optRows .optrow:has(input[value="${n}"]) .whorm`);
  await page.click("#saveItem");
  s = await page.state();
  eq(s.extras[0].opts.map(o => [o.name, !!o.gone]), [["Allegra", false], ["Claritin", true]], "used one kept (hidden), unused one dropped");
  assert(/Antihistamine \(Claritin\) at/.test(await page.evaluate(k => buildCSV(k, k), today)), "export still names it");
}, base);

await test("a food with types (Rice → jasmine, brown) asks which one, with Just Rice; the picker lists Rice once", async page => {
  eq(await optVals(page, 'select[data-pick="food"][data-meal="lunch"]'), ["", "r", "__new"], "one Rice in the picker");
  await page.selectOption('select[data-pick="food"][data-meal="lunch"]', "r");
  await page.waitForSelector("#odlg[open]");
  eq(await page.$$eval("#oList [data-oid]", b => b.map(x => x.dataset.oid)), ["", "v1", "v2"], "Just Rice, then each type");
  await page.click('#oList [data-oid="v1"]');
  let s = await page.state();
  eq(s.meals[today].lunch.fi.r, { v: "v1", ings: ["jasmine rice"] }, "jasmine with its ingredients");
  assert((await page.textContent(".box.meal.l-morning .chips")).includes("· jasmine"), "chip shows the type");
  await page.selectOption('select[data-pick="food"][data-meal="dinner"]', "r");
  await page.click('#oList [data-oid=""]');
  s = await page.state();
  eq([s.meals[today].dinner.foods, s.meals[today].dinner.fi], [["r"], undefined], "Just Rice");
  await page.click('[data-tab="set"][role="tab"]'); await page.click('[data-edit-food="r"]');
  eq(await page.$$eval("#optRows input", i => i.map(x => x.value)), ["jasmine", "jasmine rice", "brown", ""], "editor shows types and ingredients");
}, { ...base, foods: [{ id: "r", name: "Rice", versions: [{ id: "v1", name: "jasmine", ings: ["jasmine rice"] }, { id: "v2", name: "brown", ings: [] }] }] });

async function longPress(page, sel) {
  const b = await page.locator(sel).boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height / 2); await page.mouse.down();
  await page.waitForSelector("#askDlg[open]", { timeout: 2000 }); await page.mouse.up();
}
await test("long-press a med to skip it: counts as done, Recap and export say skipped; long-press again to undo", async page => {
  await longPress(page, '.row.med[data-k="m1|morning"]');
  assert((await askText(page)).includes("Skip Lisinopril (morning)?"), "asks: " + await askText(page));
  await page.click("#askYes");
  let s = await page.state();
  eq([s.log[today]["m1|morning"] > 1e11, s.ldet[today]["m1|morning"]], [true, { skip: true }], "checked, marked skipped");
  eq(await page.textContent(".medrow.skipped .sk"), "Skipped", "tagged on Today");
  eq(await page.textContent(".progress .count"), "1/1", "counts as done");
  const col = csvRowOf(await page.evaluate(k => buildCSV(k, k), today));
  eq([col("doses_taken"), col("skipped_doses"), col("missed_doses"), col("doses_not_yet_taken"), col("doses_taken_list")], ["0", "Lisinopril (Morning)", "", "", ""], "exported as skipped, not taken");
  await page.click('[data-tab="sum"][role="tab"]');
  assert((await page.textContent("#sumBody")).includes("1 skipped"), "Recap counts it");
  await page.click('[role="tab"][data-tab="today"]');
  await page.click('.row.med[data-k="m1|morning"]', { button: "right" });
  await page.waitForSelector("#askDlg[open]");
  eq(await page.textContent("#askYes"), "Undo skip", "right-click / long-press again offers undo");
  await page.click("#askYes");
  s = await page.state();
  eq([s.log[today], s.ldet[today]], [undefined, undefined], "back to unchecked");
  await page.click('.row.med[data-k="m1|morning"]');
  eq((await page.state()).ldet[today], undefined, "a normal tap is still a plain check");
}, base);

await test("comments and linked symptoms: tap an Other entry, an additional med, a food; shown on chips and exported", async page => {
  await page.selectOption('select[data-pick="ev"][data-ev="other"]', "o1");
  await page.click('[data-evbox="other"] button.nm');
  assert(await page.isVisible("#xcRow") && await page.isVisible("#xsymRow"), "comment and symptom in the pop-up");
  await page.fill("#xc", "Window seat, 3 hours"); await page.selectOption("#xsym", "s1");
  await page.click('#xform button[type="submit"]');
  let s = await page.state();
  eq([s.olog[today][0].c, s.olog[today][0].sym], ["Window seat, 3 hours", "s1"], "saved on the entry");
  eq(await page.textContent('[data-evbox="other"] .lnk'), "→ Headache", "chip shows the link");
  eq(await page.textContent('[data-evbox="other"] .cmt'), "Window seat, 3 hours", "and the comment");
  await page.selectOption('select[data-pick="ev"][data-ev="other"]', "o1");
  eq(await page.locator('[data-evbox="other"] .chip').count(), 2, "a plain second entry gets its own chip");
  await page.selectOption('select[data-pick="xmed"]', "x1");
  await page.click(".box.l-extra button.nm"); await page.selectOption("#xsym", "s1"); await page.click('#xform button[type="submit"]');
  eq((await page.state()).xlog[today][0].sym, "s1", "Tylenol → Headache");
  await page.selectOption('select[data-pick="food"][data-meal="lunch"]', "f1");
  await page.click('.box.meal.l-morning [data-ings="f1"]');
  await page.selectOption("#fsym", "s2"); await page.fill("#fc", "extra spicy");
  await page.click('#fform button[type="submit"]');
  s = await page.state();
  eq(s.meals[today].lunch.fi.f1, { ings: [], sym: "s2", c: "extra spicy" }, "food entry linked and commented");
  const col = csvRowOf(await page.evaluate(k => buildCSV(k, k), today));
  assert(col("other").includes("(linked to Headache; note: Window seat, 3 hours)"), "other: " + col("other"));
  assert(col("additional_meds").includes("Tylenol at") && col("additional_meds").includes("linked to Headache"), "meds: " + col("additional_meds"));
  eq(col("linked_symptoms"), "Tylenol → Headache; Air travel → Headache; Oatmeal (Lunch) → Nausea", "linked_symptoms column");
}, { ...base, others: [{ id: "o1", name: "Air travel" }], hotAdded: true, extras: [{ id: "x1", name: "Tylenol" }], foods: [{ id: "f1", name: "Oatmeal" }] });

await test("Flare-up checkbox in Symptoms logs a time with no symptoms; same mark as Suspected Flare; Recap and export show it", async page => {
  await page.check("[data-flare]");
  let s = await page.state();
  eq([s.trig[today], s.flare[today] > 1e11, s.slog[today]], [{ syms: true }, true, undefined], "flare marked with a time, no symptoms");
  await page.click("[data-flaret]"); await page.fill("#xtime", "07:45"); await page.click('#xform button[type="submit"]');
  eq(new Date((await page.state()).flare[today]).getHours(), 7, "time changed");
  const col = csvRowOf(await page.evaluate(k => buildCSV(k, k), today));
  eq([col("suspected_flare"), col("flare_time")], ["1", "7:45 AM"], "exported");
  await page.click('[data-tab="sum"][role="tab"]');
  assert((await page.textContent("#sumBody")).includes("Flare-ups"), "Recap counts flare-ups");
  assert(await page.$(`.cal button.fl[data-goto="${today}"]`), "outlined on the calendar");
  await page.click('[role="tab"][data-tab="today"]');
  await page.uncheck("[data-flare]");
  s = await page.state();
  eq([s.trig[today], s.flare[today]], [undefined, undefined], "unchecking clears both");
  await page.click('[data-copy="syms"]'); await page.check("#cmTrig"); await page.keyboard.press("Escape");
  assert(await page.isChecked("[data-flare]"), "Suspected Flare in the menu ticks the box");
  assert((await page.state()).flare[today] > 1e11, "and gives it a time");
}, base);

/* ---------- Overnight & dreams ---------- */
const EVE = "2026-10-26", MORN = "2026-10-27", NEXTN = "2026-10-28";   // Monday evening, Tuesday morning, Wednesday morning
const nightSeed = { ...base,
  meds: [{ id: "mo", name: "Montelukast", dose: "10 mg", slots: ["evening"] }, { id: "z", name: "Zyrtec", slots: ["evening"] }, { id: "c", name: "Cromolyn", slots: ["waking", "bedtime"] }],
  supps: [{ id: "lu", name: "Luteolin" }],
  log: { [EVE]: { "mo|evening": at(EVE, 17, 40), "z|evening": at(EVE, 20, 15), "c|bedtime": at(EVE, 22, 30) } },
  suplog: { [EVE]: [{ id: "lu", t: at(EVE, 22, 35) }] } };
const hm = t => { const d = new Date(t); return [keyOf(d), d.getHours(), d.getMinutes()]; };

await test("Overnight: Woke up now at 3:10 AM goes on last night with what woke you, body, feelings and how hard; the export puts it after Monday's evening doses", async page => {
  eq(await page.$$eval("[data-sec]", l => l.map(x => x.dataset.sec)).then(a => a[a.length - 1]), "night", "Overnight & dreams is the last section");
  eq(await page.textContent('.box.night .lid .mtime'), "Last night", "shows last night before 6 PM");
  const when = await page.textContent(".box.night .nwhen");
  assert(/Montelukast 5:40 PM/.test(when) && /Cromolyn 10:30 PM/.test(when) && /Luteolin 10:35 PM/.test(when), "evening doses listed: " + when);
  eq(await page.textContent("[data-wakeadd]"), "+ Woke up now", "button");
  await page.click("[data-wakeadd]");
  await page.waitForSelector("#ndlg[open]");
  let s = await page.state();
  eq(hm(s.nlog[MORN].w[0].t), [MORN, 3, 10], "logged at once, on Tuesday's night");
  eq(await page.textContent("#nsince"), "Since last dose: Luteolin 4h 35m · Cromolyn 4h 40m · Zyrtec 6h 55m · Montelukast 9h 30m", "time since each evening dose");
  await page.check('#nwhy input[value="dream"]');
  await page.click('#ndlg [data-nb="shake"]'); await page.click('#ndlg [data-nf="teary"]'); await page.click('#ndlg [data-nf="anx"]');
  await page.click('#ndlg [data-nl="4"]');
  eq(await page.textContent("#nlvlLab"), "How hard was it: 4 of 5", "level shown");
  await page.fill("#nc", "up 40 min");
  await page.click('#nform button[type="submit"]');
  const w = (await page.state()).nlog[MORN].w[0];
  eq([w.why, w.body, w.feel, w.i, w.c], ["dream", ["shake"], ["anx", "teary"], 4, "up 40 min"], "details saved, in list order");
  eq(await page.textContent(".box.night .chip .nm"), "Dream, Anxious +24up 40 min", "chip: what woke you, a feeling, +2 more, the level and the comment");
  eq(await page.textContent(".box.night .lid .st"), "1 time", "count");
  const col = csvCols(await page.evaluate(k => buildCSV(k, k), EVE));
  eq(col("night_after_wakeups (times the user woke in the night after this day; blank before night tracking started)"), "1", "Monday's row has the night after it");
  eq(col("night_after_wake_details (each wake-up: time, what woke them, body, feelings, how hard 1-5, time since each dose taken that evening, comment)"),
    "3:10 AM (woke from: dream; body: Shaking; felt: Anxious, Teary; how hard 4/5; since last dose: Luteolin 4h 35m · Cromolyn 4h 40m · Zyrtec 6h 55m · Montelukast 9h 30m; note: up 40 min)", "details");
  await page.click("[data-wakeadd]"); await page.click("#ncancel");
  eq((await page.state()).nlog[MORN].w.length, 2, "Cancel keeps a quick wake-up with just its time");
  await page.click('.box.night [data-rmwake="1"]');
  eq((await page.state()).nlog[MORN].w.length, 1, "× removes one");
  await page.click('.box.night [data-wake="0"].t'); await page.click("#nremove");
  eq((await page.state()).nlog[MORN], undefined, "Remove in the pop-up clears the night");
}, nightSeed, { clock: new Date(2026, 9, 27, 3, 10) });

await test("Overnight after 6 PM shows Tonight and logs into the coming night; last night stays as a line; a past day shows the night before it", async page => {
  eq(await page.textContent('.box.night .lid .mtime'), "Tonight", "evening switches to tonight");
  eq(await page.textContent(".lastn"), "Last night: woke once (3:10 AM) · dream 4/5 (nightmare)", "last night's line");
  await page.click("[data-wakeadd]");
  eq(hm((await page.state()).nlog[NEXTN].w[0].t), [MORN, 21, 0], "now, filed under Wednesday morning's night");
  await page.fill("#ntime", "02:30"); await page.click('#nform button[type="submit"]');
  eq(hm((await page.state()).nlog[NEXTN].w[0].t), [NEXTN, 2, 30], "2:30 AM is in the small hours of Wednesday");
  await page.click('.box.night [data-wake="0"].t'); await page.fill("#ntime", "22:15"); await page.click('#nform button[type="submit"]');
  eq(hm((await page.state()).nlog[NEXTN].w[0].t), [MORN, 22, 15], "10:15 PM is that evening");
  await page.click("#prevDay");
  eq(await page.textContent('.box.night .lid .mtime'), "Night before", "a past day shows the night before it");
  eq(await page.textContent("[data-wakeadd]"), "+ Add a wake-up", "button for a past night");
  await page.click("[data-wakeadd]"); await page.click("#ncancel");
  eq(hm((await page.state()).nlog[EVE].w[0].t), [EVE, 3, 0], "a past night starts at 3 AM, ready to change");
}, { ...nightSeed, nlog: { [MORN]: { w: [{ t: at(MORN, 3, 10), why: "dream", i: 3 }], d: { v: 4, nm: true } } } }, { clock: new Date(2026, 9, 27, 21, 0) });

await test("Dreams: vividness 1–5, Disturbing and Nightmare; None remembered clears them; notes save as you type; Recap and export count them", async page => {
  await page.click('.box.night [data-dv="4"]');
  eq((await page.state()).nlog[MORN].d.v, 4, "vividness");
  await page.click('.box.night [data-dv="4"]');
  eq((await page.state()).nlog[MORN], undefined, "tapping it again clears it");
  await page.click('.box.night [data-dv="5"]'); await page.check('[data-dflag="nm"]');
  await page.check('[data-dflag="none"]');
  eq((await page.state()).nlog[MORN].d, { none: true }, "None remembered clears vividness and flags");
  await page.click('.box.night [data-dv="4"]');
  eq((await page.state()).nlog[MORN].d, { v: 4 }, "a vividness takes None remembered off");
  await page.check('[data-dflag="dis"]');
  eq(await page.textContent(".box.night.l-dream .lid .st"), "4/5 · disturbing", "box status");
  await page.fill("textarea[data-dreamc]", "falling");
  await page.waitForTimeout(600);
  eq((await page.saved()).nlog[MORN].d, { v: 4, dis: true, c: "falling" }, "notes saved");
  await page.click('[data-tab="sum"][role="tab"]');
  const box = await page.locator("#sumBody .box", { hasText: "Overnight & dreams" }).textContent();
  assert(/Vivid dreams \(4–5\)1 night/.test(box) && /Disturbing dreams1 night/.test(box) && /Nightmares0 nights/.test(box), "Recap: " + box);
  const col = csvCols(await page.evaluate(k => buildCSV(k, k), EVE));
  eq([col("night_after_dream_vividness (1 faint to 5 very vivid)"), col("night_after_disturbing_dream (1 = yes)"), col("night_after_nightmare (1 = yes)"), col("night_after_dream_note")], ["4", "1", "", "falling"], "export");
}, nightSeed, { clock: new Date(2026, 9, 27, 8, 0) });

await test("Recap counts wake-ups per night, the usual time, what woke you and how you felt", async page => {
  await page.click('[data-tab="sum"][role="tab"]');
  const box = await page.locator("#sumBody .box", { hasText: "Overnight & dreams" }).textContent();
  assert(/3 nights/.test(box), "nights since the first one logged: " + box);
  assert(/2nights with a wake-up/.test(box), "nights with a wake-up");
  assert(/Wake-ups3 · 1 a night/.test(box), "total and per night");
  assert(/Most oftenaround 3 AM · 2 times/.test(box), "usual time");
  assert(/Woken by a dream2 times/.test(box) && /Woken by a symptom1 time/.test(box), "what woke you");
  assert(/Teary2 times/.test(box), "feelings");
}, { ...nightSeed, nlog: {
  "2026-10-25": { w: [{ t: at("2026-10-25", 3, 5), why: "dream", feel: ["teary"] }] },
  [MORN]: { w: [{ t: at(MORN, 3, 40), why: "dream", feel: ["teary"] }, { t: at(MORN, 5, 10), why: "sym", body: ["gut"] }] } } },
  { clock: new Date(2026, 9, 27, 9, 0) });

await test("overnight data from a backup keeps only known keys and sensible values", async page => {
  eq((await page.state()).nlog, { [MORN]: { w: [{ t: at(MORN, 3), body: ["shake"] }] } }, "cleaned");
}, { ...base, nlog: { bad: {}, [MORN]: { w: [{ t: "x" }, { t: at(MORN, 3), why: "zzz", body: ["shake", "nope", "shake"], i: 9 }], d: { v: 7, nm: "yes", c: "  " } } } });

/* ---------- Medication changes ---------- */
const chgSeed = { ...base, log: { "2026-10-01": { "m1|morning": at("2026-10-01", 8) } },
  slog: { "2026-10-08": { s1: [{ t: at("2026-10-08", 9) }] }, "2026-10-12": { s1: [{ t: at("2026-10-12", 9) }] }, "2026-10-16": { s2: [{ t: at("2026-10-16", 9) }] },
    "2026-10-22": { s1: [{ t: at("2026-10-22", 9) }] } },
  trig: { "2026-10-16": { syms: true } } };
await test("Medication changes: add in Settings; shown on its day and the Recap calendar; Recap compares before and after; exported; deleted", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  await page.click("#addChange");
  await page.fill("#chdate", "2026-10-20");
  await page.click('#chform button[type="submit"]');
  eq(await page.textContent("#chErr"), 'Say what changed, like "Started montelukast 10 mg".', "needs what changed");
  await page.fill("#chtxt", "Started montelukast 10 mg");
  await page.click('#chform button[type="submit"]');
  let s = await page.state();
  eq(s.changes.map(c => [c.d, c.txt]), [["2026-10-20", "Started montelukast 10 mg"]], "saved");
  assert((await page.textContent("#changeList")).includes("Oct 20, 2026"), "listed with its date");
  await page.evaluate(() => { viewDate = "2026-10-20"; render(); selectTab("today"); });
  eq(await page.textContent(".chgb"), "Medication changeStarted montelukast 10 mg", "shown above the doses that day");
  await page.click(".chgb");
  await page.fill("#chtxt", "Started montelukast 10 mg at dinner"); await page.click('#chform button[type="submit"]');
  eq((await page.state()).changes[0].txt, "Started montelukast 10 mg at dinner", "edited from Today");
  await page.evaluate(() => { viewDate = todayKey(); render(); });
  eq(await page.locator(".chgb").count(), 0, "not on other days");
  await page.click('[data-tab="sum"][role="tab"]');
  assert(await page.locator('.cal button[data-goto="2026-10-20"].chg').count() === 1, "marked on the calendar");
  const box = await page.locator("#sumBody .box").filter({ has: page.locator(".lid", { hasText: /^Medication changes$/ }) }).textContent();
  assert(/Before14 days/.test(box) && /After8 days/.test(box), "window lengths: " + box);
  assert(/Days with symptoms21%13%/.test(box), "3 of 14 days before, 1 of 8 after");
  assert(/Flare-ups10/.test(box), "flare-ups");
  assert(/Wake-ups a night––/.test(box), "no night tracking yet");
  const col = csvCols(await page.evaluate(k => buildCSV(k, k), "2026-10-20"));
  eq(col("medication_changes (changes the user marked on this day)"), "Started montelukast 10 mg at dinner", "export");
  await page.click('[data-tab="set"][role="tab"]');
  await page.click('#changeList [data-edit-change]'); await page.click("#chdel");
  assert((await askText(page)).includes('Delete "Started montelukast 10 mg at dinner"?'), "asks first");
  await page.click("#askYes");
  eq((await page.state()).changes, [], "deleted");
}, chgSeed, { clock: new Date(2026, 9, 27, 9, 0) });

/* ---------- Existing features still work ---------- */
/* ---------- Supplements as a checklist ---------- */
const suppSeed = { ...base, supps: [{ id: "vd", name: "Vitamin D", dose: "1000 IU" }, { id: "mg", name: "Magnesium", opts: [{ id: "gl", name: "glycinate" }, { id: "ci", name: "citrate" }] }, { id: "fo", name: "Fish oil" }] };
await test("supplements default to one checklist: check, uncheck, which type, Take all; an older logged entry shows as checked", async page => {
  eq(await page.$$eval("[data-suppbox]", l => l.map(x => x.dataset.suppbox)), ["once"], "one box, once a day");
  eq(await page.locator('select[data-ev="supp"]').count(), 0, "no Add supplement… picker");
  eq(await page.textContent('[data-suppbox="once"] .lid .st'), "1/3", "the entry logged earlier counts");
  assert(await page.isChecked('[data-sk="fo|once"]'), "Fish oil checked from its older entry");
  await page.click('[data-sk="vd|once"]');
  eq((await page.state()).suplog[today].find(e => e.id === "vd").s, "once", "checked in the Once box");
  await page.click('[data-sk="mg|once"]');
  await page.waitForSelector("#odlg[open]"); await page.click('#oList [data-oid="ci"]');
  eq((await page.state()).suplog[today].find(e => e.id === "mg").o, "ci", "asked which type");
  assert((await page.textContent('[data-suppbox="once"]')).includes("citrate"), "row shows the type taken");
  eq(await page.textContent('[data-suppbox="once"] .lid .st'), "Done", "all done");
  await page.click('[data-sk="vd|once"]');
  eq((await page.state()).suplog[today].some(e => e.id === "vd"), false, "unchecked");
  await page.click('[data-sk="mg|once"]'); await page.click('[data-sk="fo|once"]');
  eq((await page.state()).suplog[today], undefined, "all unchecked");
  await page.click('[data-sall="once"]');
  const L = (await page.state()).suplog[today];
  eq(L.map(e => e.id).sort(), ["fo", "mg", "vd"], "Take all");
  eq(L.find(e => e.id === "mg").o, "ci", "Take all uses the type taken last");
  assert((await page.textContent(".tsec[data-sec=meds]")).includes("Supplements"), "box title");
}, { ...suppSeed, suplog: { [today]: [{ id: "fo", t: at(today, 7) }] } });

await test("Settings: turn on times, hide Once a day, pick each supplement's times; hidden times are kept; log style brings back the picker", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  eq(await page.$eval("#suppMode", el => el.value), "list", "checklist by default");
  eq(await page.$$eval("#suppTimePick input:checked", l => l.map(x => x.value)), ["once"], "once a day by default");
  eq(await page.$$eval("#suppTimePick input", l => l.map(x => x.value)), ["once", "waking", "morning", "lunch", "afternoon", "evening", "bedtime"], "all six times plus once");
  await page.click('#suppTimePick input[value="once"]');
  eq((await page.state()).suppTimes, ["once"], "the last time can't be turned off");
  await page.click('#suppTimePick input[value="morning"]'); await page.click('#suppTimePick input[value="lunch"]'); await page.click('#suppTimePick input[value="bedtime"]');
  await page.click('#suppTimePick input[value="once"]');
  eq((await page.state()).suppTimes, ["morning", "lunch", "bedtime"], "times saved in order");
  // Fish oil: morning and bedtime
  await page.click('[data-edit-supp="fo"]');
  assert(await page.isVisible("#suppSlotPick"), "editor shows times");
  eq(await page.$$eval('#suppSlotPick input', l => l.map(x => x.value)), ["morning", "lunch", "bedtime"], "only the times shown");
  eq(await page.$$eval('#suppSlotPick input:checked', l => l.map(x => x.value)), ["morning"], "an older supplement starts in the first box");
  await page.click('#suppSlotPick input[value="bedtime"]'); await page.click('#saveItem');
  eq((await page.state()).supps.find(x => x.id === "fo").slots, ["morning", "bedtime"], "saved");
  eq(await page.$$eval('[data-stime="fo"]:checked', l => l.map(x => x.value)), ["morning", "bedtime"], "list shows its times as buttons");
  await page.click('[data-stime="vd"][value="lunch"]');
  eq((await page.state()).supps.find(x => x.id === "vd").slots, ["morning", "lunch"], "a time button on the row saves it");
  await page.click('[data-stime="vd"][value="morning"]'); await page.click('[data-stime="vd"][value="lunch"]');
  eq((await page.state()).supps.find(x => x.id === "vd").slots, ["lunch"], "the last one stays on");
  await page.click('[data-stime="vd"][value="morning"]'); await page.click('[data-stime="vd"][value="lunch"]');
  // A new one can't have no times
  await page.click("#addSupp"); await page.fill('input[name="name"]', "Zinc");
  await page.click('#suppSlotPick input[value="morning"]'); await page.click('#saveItem');
  eq(await page.textContent("#formErr"), "Pick at least one time.", "needs a time");
  await page.click('#suppSlotPick input[value="lunch"]'); await page.click('#saveItem');
  eq((await page.state()).supps.find(x => x.name === "Zinc").slots, ["lunch"], "Zinc at lunch");
  await page.click('[role="tab"][data-tab="today"]');
  eq(await page.locator("[data-suppbox]").count(), 0, "no separate Supplements box once they all have times");
  eq(await page.$$eval(".box.l-morning .row .nm", l => l.map(x => x.textContent)), ["Lisinopril", "Vitamin D", "Magnesium", "Fish oil"], "supplements below the morning meds, in one box");
  eq(await page.textContent(".box.l-morning .lid .st"), "0/4", "the box counts both");
  eq(await page.$$eval(".box.l-bedtime .smed .nm", l => l.map(x => x.textContent)), ["Fish oil"], "a bedtime box just for supplements");
  eq(await page.$$eval("[data-sec=meds] .box.l-morning, [data-sec=meds] .box.l-lunch, [data-sec=meds] .box.l-bedtime", l => l.map(x => x.className.split(" ").pop())), ["l-morning", "l-lunch", "l-bedtime"], "Morning, Lunch, Bedtime in order");
  eq(await page.textContent(".box.l-lunch .lid .st"), "0/1", "lunch box");
  await page.click('.box.l-morning [data-all]');
  const st = await page.state();
  eq([Object.keys(st.log[today]), st.suplog[today].filter(e => e.s === "morning").length], [["m1|morning"], 3], "Take all checks the meds and supplements in that box");
  await page.click('[data-sk="fo|bedtime"]');
  eq((await page.state()).suplog[today].filter(e => e.id === "fo").map(e => e.s), ["morning", "bedtime"], "checked at bedtime too");
  // Hiding bedtime keeps Fish oil's bedtime time for later
  await page.click('[data-tab="set"][role="tab"]');
  await page.click('#suppTimePick input[value="bedtime"]');
  await page.click('[data-edit-supp="fo"]'); await page.click('#saveItem');
  eq((await page.state()).supps.find(x => x.id === "fo").slots, ["morning", "bedtime"], "hidden time kept");
  // Log style: the old picker comes back, times are hidden
  await page.selectOption("#suppMode", "log");
  eq(await page.isVisible("#suppTimesF"), false, "times hidden in log style");
  await page.click('[role="tab"][data-tab="today"]');
  eq(await page.locator('[data-evbox="supp"] select[data-ev="supp"]').count(), 1, "Add supplement… picker");
  assert((await page.textContent('[data-evbox="supp"] .chips')).includes("Fish oil"), "what was checked shows as logged");
}, suppSeed);

await test("supplement checklist: extra entries show under Also taken; copying yesterday keeps each box", async page => {
  assert((await page.textContent('[data-suppbox="once"]')).includes("Also taken"), "the second Vitamin D is listed");
  await page.click('[data-suppbox="once"] [data-evrm="supp"]');
  eq((await page.state()).suplog[today].length, 1, "removed the extra one");
  await page.click('[data-tab="set"][role="tab"]');
  await page.click('#suppTimePick input[value="evening"]');
  await page.click('[role="tab"][data-tab="today"]');
  await page.click("#prevDay");
  await copyFrom(page, '[data-copy="supp"]');
  await page.waitForSelector("#xdlg[open]"); await page.click('#xform [type="submit"]');
  eq((await page.state()).suplog[shift(today, -1)].map(e => e.s), ["once", "once"], "copied with their boxes");
}, { ...suppSeed, supps: [{ id: "vd", name: "Vitamin D" }], suplog: { [today]: [{ id: "vd", t: at(today, 7), s: "once" }, { id: "vd", t: at(today, 9) }], [shift(today, -2)]: [{ id: "vd", t: at(shift(today, -2), 7), s: "once" }, { id: "vd", t: at(shift(today, -2), 8), s: "once" }] } });

await test("progress counts the supplement checklist too, not the log style", async page => {
  eq(await page.textContent(".progress .count"), "0/3", "1 med dose + 2 supplements");
  await page.click('[data-sk="vd|once"]');
  eq(await page.textContent(".progress .count"), "1/3", "a supplement counts");
  await page.click('[data-tab="set"][role="tab"]'); await page.selectOption("#suppMode", "log");
  await page.click('[role="tab"][data-tab="today"]');
  eq(await page.textContent(".progress .count"), "0/1", "log style: meds only");
}, { ...base, supps: [{ id: "vd", name: "Vitamin D" }, { id: "fo", name: "Fish oil" }] });

await test("medication checklist can be turned off: only Additional medication shows, off days aren't missed, End of day hides; on again by default", async page => {
  await page.click('[data-tab="set"][role="tab"]');
  eq(await page.$eval("#medMode", el => el.value), "on", "on by default");
  assert(await page.isVisible("#dayEndBox"), "End of day shows");
  await page.selectOption("#medMode", "off");
  eq((await page.state()).medsOffSince, today, "off from today");
  eq(await page.isVisible("#dayEndBox"), false, "End of day hidden");
  await page.click('[role="tab"][data-tab="today"]');
  eq(await page.locator(".box.l-morning .med").count(), 0, "no med boxes");
  assert(await page.isVisible(".box.l-extra"), "Additional medication still shows");
  eq(await page.textContent(".progress .count"), "0/1", "progress is the supplement");
  eq(await page.evaluate(() => dayEnder()), null, "the day ends at midnight");
  // yesterday is still a normal day, with its dose checklist
  await page.click("#prevDay");
  eq(await page.locator(".box.l-morning .med").count(), 1, "yesterday keeps its checklist");
  await page.click("#nextDay");
  // back on: the off day isn't counted as missed once it's in the past
  await page.evaluate(k => { state.medsOffSince = k; setMedsOn(true); commit(); }, shift(today, -3));
  const s = await page.state();
  eq([s.medsOffSince, s.medsOffSpells], [undefined, [[shift(today, -3), today]]], "spell kept");
  eq(await page.evaluate(k => dueOn(state.meds[0], "morning", k), shift(today, -2)), false, "off day not due");
  eq(await page.evaluate(k => dueOn(state.meds[0], "morning", k), today), true, "today due again");
  eq(await page.locator(".box.l-morning .med").count(), 1, "checklist back");
}, { ...base, supps: [{ id: "vd", name: "Vitamin D" }] });

await test("checking off a med and adding a food still work", async page => {
  await page.click('.row.med[data-k="m1|morning"]');
  assert((await page.state()).log[today]["m1|morning"] > 1e11, "med checked");
  await page.selectOption('select[data-pick="food"][data-meal="lunch"]', "f1");
  eq((await page.state()).meals[today].lunch.foods, ["f1"], "food logged");
  await page.click("#prevDay");
  eq(await page.evaluate(() => viewDate), shift(today, -1), "arrow still works");
}, { ...base, foods: [{ id: "f1", name: "Oatmeal" }] });

/* ---------- 10. Wide screen (unfolded) still renders ---------- */
await test("unfolded width renders Today and Recap side by side", async page => {
  assert(await page.isVisible("#sumBody .ygrid"), "year calendar visible");
  await swipe(page, 150);
  eq(await page.evaluate(() => viewDate), shift(today, -1), "swipe works on the Today column");
}, base, { width: 880, height: 900 });

console.log(results.join("\n"));
console.log(`\n${passed} passed, ${failed} failed`);
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
