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
async function open(seed, { width = 412, height = 900, geo = null } = {}) {
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
  await page.addInitScript(s => { if (!sessionStorage.getItem("seeded")) { localStorage.clear(); localStorage.setItem("daily-meds-welcomed", "1"); if (s) localStorage.setItem("daily-meds-v1", JSON.stringify(s)); sessionStorage.setItem("seeded", "1"); } }, seed || null);
  await page.goto(URL0);
  page.state = () => page.evaluate(() => JSON.parse(JSON.stringify(state)));
  page.saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("daily-meds-v1")));
  page.errors = errors;
  page.close2 = () => ctx.close();
  return page;
}
async function test(name, fn, seed, opts) {
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
  eq(order.slice(-2), ["appts", "notes"], "appointments near the bottom, above Notes");
  await page.selectOption('select[data-pick="ev"][data-ev="appt"]', "__new");
  await page.fill('#itemForm [name="name"]', "GI follow-up");
  await page.fill('#itemForm [name="dose"]', "Dr. Lee");
  eq(await page.textContent("#doseLabel"), "Who or where", "field label");
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
}, { ...base, supps: [{ id: "sp1", name: "Vitamin D", dose: "1000 IU" }], smells: [{ id: "sm1", name: "Smoke" }], trackSmells: true });

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
  await page.waitForFunction(() => /Weather saved for/.test(document.getElementById("wxCover").textContent));
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
  eq(await page.$$eval("[data-sec]", l => l.map(x => x.dataset.sec)), ["meds", "food", "smells", "mood", "syms", "appts", "notes"], "order");
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
  eq(await page.locator("#layoutList .lrow").count(), 7, "one row per section");
  assert(await page.isDisabled('[data-move="meds"][data-dir="-1"]'), "first can't move up");
  await page.click('[data-move="syms"][data-dir="-1"]');
  await page.click('[data-move="syms"][data-dir="-1"]');
  eq((await page.state()).layout.map(e => e.id), ["meds", "food", "syms", "smells", "mood", "appts", "notes"], "moved up twice");
  await page.uncheck('[data-show="food"]');
  eq(await page.$$eval("[data-sec]", l => l.map(x => x.dataset.sec)), ["meds", "syms", "smells", "mood", "appts", "notes"], "Today follows");
  await page.click("#layoutReset");
  const L = (await page.state()).layout;
  eq(L.map(e => e.id), ["meds", "food", "smells", "mood", "syms", "appts", "notes"], "reset order");
  eq(L.find(e => e.id === "food").show, false, "reset keeps what's hidden");
}, base);
await test("older saved data gets the new layout; hidden appointments stay hidden", async page => {
  const L = (await page.state()).layout;
  eq(L.length, 7, "all sections"); eq(L.find(e => e.id === "appts").show, false, "carried over");
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
     extras: [{ id: "x1", name: "Tylenol" }, { id: "x2", name: "Aspirin" }], supps: [{ id: "u1", name: "Iron" }, { id: "u2", name: "Vitamin D" }],
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
  eq([ap.text, ap.sub], ["Copy Yesterday's Appointments", "Dr. Lee"], "appointments menu");
  await page.fill("#xtime", "14:00"); await page.click('#xform [type="submit"]');
  const s = await page.state();
  eq(s.smlog[today], [{ id: "sm1", t: at(today, 10) }], "smell copied");
  eq(s.olog[today], [{ id: "o1", t: at(today, 20) }, { id: "o1", t: at(today, 20) }], "other copied ×2");
  eq(s.alog[today], [{ id: "a1", t: at(today, 14) }], "appointment copied");
  eq(await page.locator('.tsec[data-sec="meds"] [data-copy]').count(), 0, "no copy menu on medications or supplements");
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
  const boxes = () => page.$$eval('.tsec[data-sec="food"] .box .lid .cpn', els => els.map(e => e.textContent));
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

/* ---------- Existing features still work ---------- */
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
