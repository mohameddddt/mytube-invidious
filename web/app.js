"use strict";
/* Personal YouTube interface. Plain JS, no build step. Talks only to the local backend (same origin)
   for data and to Invidious/companion (address from /config.json) for thumbnails and streams. */

/* ------------------------------------------------------------------ helpers */
const view = document.getElementById("view");
let BASE = "http://localhost:3000";
let engineReady = true; // false while WSL and Invidious are still booting
let CFG = {}; // from /config.json: Invidious address and the download folders
let renderId = 0;
let cleanups = [];

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const mem = {};
const store = {
  get(key, def) {
    try {
      const raw = localStorage.getItem("yt." + key);
      if (raw !== null) return JSON.parse(raw);
    } catch { /* storage blocked: fall through to memory */ }
    return key in mem ? mem[key] : def;
  },
  set(key, val, push = true) {
    mem[key] = val;
    try { localStorage.setItem("yt." + key, JSON.stringify(val)); } catch { /* ignore */ }
    if (push && SYNC_KEYS.includes(key)) schedulePush(key);
  },
};

/* ------------------------------------------------------------------ shared data
   Subscriptions, history, watch later, settings and the feed copy live in one file on the PC, behind
   the local server, so the desktop app and any browser tab always show the same thing. localStorage is
   only a fast local copy of it. */
const SYNC_KEYS = ["subscriptions", "history", "watchLater", "likes", "settings", "feedCache"];
const pending = new Set();
const pushTimers = {};

function postState(key, value, keepalive) {
  return fetch("/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }), keepalive: !!keepalive }).catch(() => {});
}
function schedulePush(key) {
  pending.add(key);
  clearTimeout(pushTimers[key]);
  pushTimers[key] = setTimeout(() => { pending.delete(key); postState(key, store.get(key, null)); }, 800);
}
async function flushPending(keepalive) {
  const keys = [...pending];
  keys.forEach((k) => { clearTimeout(pushTimers[k]); pending.delete(k); });
  await Promise.all(keys.map((k) => postState(k, store.get(k, null), keepalive)));
}

/* First time a window meets the server it merges what it already has, so nothing is lost. */
function mergeFirst(key, local, remote) {
  if (remote == null) return local;
  if (local == null) return remote;
  const union = (id) => { const seen = new Set(remote.map((x) => x && x[id])); return [...remote, ...local.filter((x) => x && !seen.has(x[id]))]; };
  if (key === "subscriptions") return union("ucid");
  if (key === "watchLater" || key === "likes") return union("id");
  if (key === "history") {
    const byId = new Map();
    for (const e of [...remote, ...local]) {
      if (!e || !e.id) continue;
      const old = byId.get(e.id);
      if (!old || (e.watchedAt || 0) > (old.watchedAt || 0)) byId.set(e.id, e);
    }
    return [...byId.values()].sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0)).slice(0, 500);
  }
  if (key === "settings") return { ...local, ...remote };
  return (local.at || 0) > (remote.at || 0) ? local : remote; // feedCache: the newer copy
}

/* Returns true when this window's data changed because of what the server had. */
async function syncFromServer() {
  await flushPending();
  let remote;
  try {
    const res = await fetch("/state");
    if (!res.ok) return false;
    remote = await res.json();
  } catch { return false; }
  const first = !store.get("synced", false);
  let changed = false;
  for (const key of SYNC_KEYS) {
    const local = store.get(key, null);
    const theirs = remote[key] === undefined ? null : remote[key];
    const merged = first ? mergeFirst(key, local, theirs) : (key in remote ? theirs : local);
    if (JSON.stringify(merged) !== JSON.stringify(local)) { store.set(key, merged, false); changed = true; }
    if (merged != null && JSON.stringify(merged) !== JSON.stringify(theirs)) await postState(key, merged);
  }
  if (first) store.set("synced", true);
  return changed;
}

const DEFAULTS = { defaultQuality: "720p", downloadProfile: "standard", autoplay: false, theme: "system" };
const settings = () => ({ ...DEFAULTS, ...store.get("settings", {}) });
const QUALITY_CAP = { "360p": 360, "480p": 480, "720p": 720, "1080p": 1080 };
const PROFILE_LABEL = { data_saver: "Data saver (480p)", standard: "Standard (720p)", high: "High (1080p)", audio: "Audio (mp3)" };

function applyTheme() {
  const t = settings().theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

// Avatars: route Google image hosts through Invidious (/ggpht) so the browser never contacts them directly.
const GOOGLE_IMG = /^https?:\/\/[\w.-]+\.(?:ggpht|googleusercontent)\.com(\/.*)$/;
const abs = (u) => {
  if (!u) return "";
  if (u.startsWith("//")) u = "https:" + u;
  const g = GOOGLE_IMG.exec(u);
  if (g) return BASE + "/ggpht" + g[1];
  return u.startsWith("/") ? BASE + u : u;
};
const thumbUrl = (id, q = "mqdefault") => `${BASE}/vi/${id}/${q}.jpg`;
const num = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fmtNum = (n) => (typeof n === "number" ? num.format(n) : "");
function fmtDur(s) {
  if (!s) return "";
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function fmtAgo(sec) {
  if (!sec) return "";
  const diff = sec - Date.now() / 1000;
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [u, s] of units) if (Math.abs(diff) >= s) return rtf.format(Math.round(diff / s), u);
  return "just now";
}
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
const fmtDate = (sec) => new Date(sec * 1000).toLocaleString();

async function api(path) {
  let res;
  try { res = await fetch("/api/" + path); } catch { throw new Error("Cannot reach the local server."); }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `Request failed (${res.status})`);
  return data;
}
const enc = encodeURIComponent;

function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')]+/g)) {
    out.push(text.slice(last, m.index));
    out.push(h("a", { href: m[0], target: "_blank", rel: "noopener noreferrer", text: m[0] }));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/* ------------------------------------------------------------- subscriptions etc. */
const subs = () => store.get("subscriptions", []);
const isSub = (ucid) => subs().some((s) => s.ucid === ucid);
function toggleSub(ch) {
  let list = subs();
  if (list.some((s) => s.ucid === ch.ucid)) list = list.filter((s) => s.ucid !== ch.ucid);
  else list = [...list, ch];
  store.set("subscriptions", list);
  store.set("feedCache", null);
  return list.some((s) => s.ucid === ch.ucid);
}
const watchLater = () => store.get("watchLater", []);
function toggleLater(entry) {
  let list = watchLater();
  if (list.some((v) => v.id === entry.id)) list = list.filter((v) => v.id !== entry.id);
  else list = [entry, ...list];
  store.set("watchLater", list);
  return list.some((v) => v.id === entry.id);
}
function addHistory(entry) {
  const list = store.get("history", []).filter((x) => x.id !== entry.id);
  const prev = store.get("history", []).find((x) => x.id === entry.id);
  list.unshift({ ...entry, watchedAt: Date.now(), position: prev ? prev.position || 0 : 0 });
  store.set("history", list.slice(0, 500));
}
function savePosition(id, pos) {
  const list = store.get("history", []);
  const e = list.find((x) => x.id === id);
  if (e) { e.position = Math.floor(pos); store.set("history", list); }
}
const savedPosition = (id) => (store.get("history", []).find((x) => x.id === id) || {}).position || 0;
const likes = () => store.get("likes", []);
function toggleLike(entry) {
  let list = likes();
  if (list.some((v) => v.id === entry.id)) list = list.filter((v) => v.id !== entry.id);
  else list = [{ ...entry, likedAt: Date.now() }, ...list];
  store.set("likes", list);
  return list.some((v) => v.id === entry.id);
}

/* ----------------------------------------------------------------- suggestions
   A deliberately simple recommender. Every video you watched, liked or kept for later gets an interest
   weight: liked beats finished, finished beats abandoned, and it fades by half every two weeks. The
   strongest few become seeds, and the videos YouTube lists as related to them are the candidates. A
   candidate scores more when several seeds point at it, when it sits high in their lists, and when it
   comes from a channel you watch a lot. Related lists are kept in this browser (the watch page saves
   them for free), so the feed only asks Invidious for seeds it has never seen. */
const SEEDS = 8, RELATED_KEEP = 60, PER_CHANNEL = 2, MAX_SUGGESTIONS = 30;
const relatedFailed = new Set(); // seeds Invidious could not give this session, not retried until reload

function rememberRelated(id, recs) {
  const map = store.get("related", {});
  delete map[id]; // re-insert so the newest lists are the last to be dropped
  map[id] = recs.filter((v) => v.videoId).slice(0, 15).map((v) => ({
    videoId: v.videoId, title: v.title, author: v.author, authorId: v.authorId, lengthSeconds: v.lengthSeconds, viewCount: v.viewCount, liveNow: v.liveNow }));
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - RELATED_KEEP))) delete map[k];
  store.set("related", map);
}

function interests() {
  const now = Date.now();
  const fade = (t, halfLifeDays) => (t ? 0.5 ** ((now - t) / 86400000 / halfLifeDays) : 0.3);
  const vids = new Map(), channels = new Map();
  const add = (v, w, liked) => {
    if (!v || !v.id || !(w > 0)) return;
    const cur = vids.get(v.id) || { id: v.id, title: v.title, w: 0, liked: false };
    cur.w += w;
    cur.liked = cur.liked || liked;
    vids.set(v.id, cur);
    if (v.authorId) channels.set(v.authorId, (channels.get(v.authorId) || 0) + w);
  };
  for (const v of store.get("history", []).slice(0, 150)) {
    const watched = v.lengthSeconds ? Math.min(1, (v.position || 0) / v.lengthSeconds) : 0.5;
    add(v, fade(v.watchedAt, 14) * (0.3 + watched), false);
  }
  for (const v of likes()) add(v, 2 * fade(v.likedAt, 30), true);
  for (const v of watchLater()) add(v, 0.4, false);
  const seeds = [...vids.values()].sort((a, b) => b.w - a.w).slice(0, SEEDS);
  return { seeds, channels, seen: new Set(vids.keys()) };
}

/* Fetches related lists for seeds that have none yet. Resolves to true when something new arrived. */
async function fetchRelated() {
  const related = store.get("related", {});
  const missing = interests().seeds.filter((s) => !related[s.id] && !relatedFailed.has(s.id));
  if (!missing.length) return false;
  const res = await Promise.allSettled(missing.map((s) => api("videos/" + enc(s.id))));
  res.forEach((r, i) => {
    if (r.status === "fulfilled") rememberRelated(missing[i].id, r.value.recommendedVideos || []);
    else relatedFailed.add(missing[i].id);
  });
  return true;
}

/* Ranked suggestions, skipping anything already watched, liked, saved for later or in `exclude`. */
function suggest(exclude) {
  const { seeds, channels, seen } = interests();
  const related = store.get("related", {});
  const top = Math.max(1, ...channels.values());
  const cands = new Map();
  for (const s of seeds) {
    (related[s.id] || []).forEach((v, rank) => {
      if (!v.videoId || seen.has(v.videoId) || exclude.has(v.videoId)) return;
      const c = cands.get(v.videoId) || { v, score: (channels.get(v.authorId) || 0) / top, from: s, best: 0 };
      const pts = s.w * (1 - rank / 20);
      c.score += pts;
      if (pts > c.best) { c.best = pts; c.from = s; }
      cands.set(v.videoId, c);
    });
  }
  const perChannel = new Map(), out = [];
  for (const c of [...cands.values()].sort((a, b) => b.score - a.score)) {
    const n = perChannel.get(c.v.authorId) || 0;
    if (n >= PER_CHANNEL) continue; // keep the mix varied
    perChannel.set(c.v.authorId, n + 1);
    out.push({ ...c.v, why: `Because you ${c.from.liked ? "liked" : "watched"} “${c.from.title}”` });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

/* One suggestion after every two videos from your channels; any left over go at the end. */
function mixFeed(items, recs) {
  const out = [], rest = [...recs];
  items.forEach((v, i) => { out.push(v); if (i % 2 === 1 && rest.length) out.push(rest.shift()); });
  return out.concat(rest);
}

/* ------------------------------------------------------------------- downloads */
let libraryCache = null;
async function getLibrary(force) {
  if (libraryCache && !force) return libraryCache;
  const map = new Map();
  try {
    const items = await (await fetch("/downloads")).json();
    for (const it of items) {
      if (!it.id) continue;
      const cur = map.get(it.id);
      if (!cur || (cur.kind === "audio" && it.kind === "video")) map.set(it.id, it); // prefer video files
    }
  } catch { /* backend list failed: treat library as empty */ }
  libraryCache = map;
  return map;
}

async function startDownload(body) {
  try {
    const res = await fetch("/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 202) { toast("Download started. Follow it under Saved."); return true; }
    toast(data.error || "Download refused.");
  } catch { toast("Cannot reach the local server."); }
  return false;
}


/* ------------------------------------------------------------ custom dropdown
   Replaces the native <select> popup, which the browser draws itself and CSS cannot style. */
let closeOpenMenu = null;
function dropdown({ options, value, onChange, label }) {
  let current = value, active = 0;
  const btn = h("button", { type: "button", class: "dd-btn", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": label || null });
  const menu = h("div", { class: "dd-menu", role: "listbox", hidden: true });
  const root = h("div", { class: "dd" }, btn, menu);
  const labelOf = (v) => (options.find(([o]) => o === v) || options[0])[1];
  const paint = () => {
    btn.textContent = labelOf(current);
    menu.replaceChildren(...options.map(([v, l], i) => h("div", { class: "dd-item", role: "option", "aria-selected": String(v === current), "data-i": i, text: l })));
  };
  const mark = () => {
    [...menu.children].forEach((el, i) => el.classList.toggle("act", i === active));
    if (menu.children[active]) menu.children[active].scrollIntoView({ block: "nearest" });
  };
  const outside = (e) => { if (!root.contains(e.target)) close(); };
  function close() {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (closeOpenMenu === close) closeOpenMenu = null;
  }
  const choose = (i) => {
    const v = options[i][0];
    close();
    btn.focus();
    if (v !== current) { current = v; paint(); onChange(v); }
  };
  function open() {
    if (closeOpenMenu) closeOpenMenu();
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    menu.classList.remove("right", "up");
    const r = menu.getBoundingClientRect();
    if (r.right > innerWidth - 8) menu.classList.add("right");
    if (r.bottom > innerHeight - 8 && btn.getBoundingClientRect().top > r.height + 16) menu.classList.add("up");
    active = Math.max(0, options.findIndex(([v]) => v === current));
    mark();
    closeOpenMenu = close;
    document.addEventListener("pointerdown", outside, true);
  }
  btn.addEventListener("click", () => (menu.hidden ? open() : close()));
  menu.addEventListener("click", (e) => { const it = e.target.closest(".dd-item"); if (it) choose(Number(it.dataset.i)); });
  root.addEventListener("keydown", (e) => {
    if (menu.hidden) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % options.length; mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + options.length) % options.length; mark(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(active); }
    else if (e.key === "Escape") { e.preventDefault(); close(); btn.focus(); }
    else if (e.key === "Tab") close();
  });
  paint();
  return root;
}

/* ------------------------------------------------------------- download dialog */
const DL_VIDEO = [
  ["data_saver", "480p", "Data saver", "about 0.2–0.4 GB per hour"],
  ["standard", "720p", "Standard", "about 0.5–1 GB per hour"],
  ["high", "1080p", "High", "about 1–2 GB per hour"],
];

async function openFolder(kind) {
  try {
    const res = await fetch("/open-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
    if (!res.ok) toast((await res.json().catch(() => ({}))).error || "Could not open the folder.");
  } catch { toast("Cannot reach the local server."); }
}

function openDownloadDialog({ id, playlist, title, count }) {
  const cfg = settings();
  let kind = cfg.downloadProfile === "audio" ? "audio" : "video";
  let quality = DL_VIDEO.some(([k]) => k === cfg.downloadProfile) ? cfg.downloadProfile : "standard";
  let limit = "";
  const dlg = h("dialog", { class: "modal", "aria-label": "Download" });
  const body = h("div", { class: "modal-body" });
  dlg.append(body);

  const paint = () => {
    const folder = (kind === "audio" ? CFG.audioDir : CFG.videoDir) || "";
    const seg = h("div", { class: "seg", role: "tablist" }, [["video", "Video"], ["audio", "Audio only"]].map(([k, l]) =>
      h("button", { type: "button", role: "tab", class: "seg-btn" + (kind === k ? " on" : ""), "aria-selected": String(kind === k), text: l, onclick: () => { kind = k; paint(); } })));
    const choices = kind === "audio"
      ? [h("button", { type: "button", class: "choice on", "aria-pressed": "true" }, h("strong", { text: "MP3" }), h("span", { class: "muted small", text: "about 60–100 MB per hour" }))]
      : DL_VIDEO.map(([key, res, name, size]) => h("button", { type: "button", class: "choice" + (quality === key ? " on" : ""), "aria-pressed": String(quality === key), onclick: () => { quality = key; paint(); } },
        h("strong", { text: res }), h("span", { text: name }), h("span", { class: "muted small", text: size })));
    body.replaceChildren(
      h("h2", { class: "modal-title", text: playlist ? "Download playlist" : "Download" }),
      title ? h("p", { class: "modal-sub", text: title }) : null,
      seg,
      h("div", { class: "choices" }, choices),
      playlist ? h("div", { class: "row limitrow" }, h("span", { class: "muted small", text: "Videos to download" }),
        dropdown({ label: "Videos to download", value: limit, onChange: (v) => { limit = v; },
          options: [["", count ? `All ${count} videos` : "All videos"], ...[10, 25, 50, 100].filter((n) => !count || n < count).map((n) => [String(n), `First ${n}`])] })) : null,
      h("div", { class: "pathbox" },
        h("span", { class: "muted small", text: "Saves to" }),
        h("code", { text: folder }),
        h("button", { type: "button", class: "btn small", text: "Open folder", onclick: () => openFolder(kind) })),
      h("p", { class: "muted small", text: (playlist ? "Videos you already downloaded in this kind (video or audio) are skipped, and unavailable ones are passed over. " : "") + "The file is stored on this PC and also appears under Saved in this app, where you can play it or save another copy." }),
      h("div", { class: "row modal-actions" },
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn", text: "Cancel", onclick: () => dlg.close() }),
        h("button", { type: "button", class: "btn primary", text: "Download", onclick: async (e) => {
          e.target.disabled = true;
          const profile = kind === "audio" ? "audio" : quality;
          if (await startDownload(playlist ? { playlist, profile, title, limit: limit ? Number(limit) : undefined } : { id, profile, title })) {
            store.set("settings", { ...settings(), downloadProfile: profile });
            libraryCache = null;
            dlg.close();
          } else e.target.disabled = false;
        } })));
  };
  paint();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
}

/* --------------------------------------------------------------------- cards */
function thumbBox(href, id, lengthSeconds, live, progress) {
  return h("a", { class: "thumb", href },
    h("img", { src: thumbUrl(id), loading: "lazy", alt: "", width: 320, height: 180, onerror: (e) => { e.target.style.visibility = "hidden"; } }),
    live ? h("span", { class: "badge live", text: "LIVE" }) : lengthSeconds ? h("span", { class: "badge", text: fmtDur(lengthSeconds) }) : null,
    progress ? h("span", { class: "bar", style: `width:${progress}%` }) : null);
}

function videoCard(v, extra) {
  const id = v.videoId || v.id;
  const pos = savedPosition(id);
  const progress = v.lengthSeconds && pos > 10 ? Math.min(100, Math.round((pos / v.lengthSeconds) * 100)) : 0;
  const meta = [v.viewCount > 0 && fmtNum(v.viewCount) + " views", v.published ? fmtAgo(v.published) : v.publishedText].filter(Boolean).join(" · ");
  return h("div", { class: "card" },
    thumbBox("#/watch/" + id, id, v.lengthSeconds, v.liveNow, progress),
    h("a", { class: "title", href: "#/watch/" + id, text: v.title }),
    h("div", { class: "meta" }, v.authorId ? h("a", { href: "#/channel/" + v.authorId, text: v.author }) : v.author || ""),
    meta ? h("div", { class: "meta", text: meta }) : null,
    extra || null);
}

function relatedItem(v) {
  const id = v.videoId;
  return h("div", { class: "item" },
    thumbBox("#/watch/" + id, id, v.lengthSeconds, v.liveNow),
    h("div", { class: "body" },
      h("a", { class: "title", href: "#/watch/" + id, text: v.title }),
      h("div", { class: "meta muted small", text: v.author || "" }),
      h("div", { class: "meta muted small", text: v.viewCountText || "" })));
}

function channelItem(c) {
  return h("div", { class: "item" },
    h("a", { href: "#/channel/" + c.authorId }, h("img", { class: "avatar lg", loading: "lazy", alt: "", src: abs((c.authorThumbnails || []).slice(-1)[0]?.url || "") })),
    h("div", { class: "body" },
      h("a", { class: "title", href: "#/channel/" + c.authorId, text: c.author }),
      h("div", { class: "muted small", text: [c.subCount ? fmtNum(c.subCount) + " subscribers" : "", c.videoCount ? c.videoCount + " videos" : ""].filter(Boolean).join(" · ") }),
      h("div", { class: "muted small", text: (c.description || "").slice(0, 160) })));
}

/* YouTube "Mix" playlists (IDs starting with RD) are endless and cannot be downloaded. */
const isMix = (plid) => /^RD/.test(plid);

function playlistItem(p) {
  const first = p.playlistThumbnail || null;
  return h("div", { class: "item" },
    h("a", { class: "thumb", href: "#/playlist/" + p.playlistId },
      first ? h("img", { src: abs(first), loading: "lazy", alt: "" }) : null,
      h("span", { class: "badge", text: (p.videoCount || "") + " videos" })),
    h("div", { class: "body" },
      h("a", { class: "title", href: "#/playlist/" + p.playlistId, text: p.title }),
      h("div", { class: "muted small", text: p.author || "" }),
      isMix(p.playlistId) ? null : h("button", { class: "btn small", style: "margin-top:8px", text: "Download playlist",
        onclick: () => openDownloadDialog({ playlist: p.playlistId, title: p.title, count: p.videoCount }) })));
}

function resultItem(r) {
  if (r.type === "video") return videoCard(r);
  if (r.type === "channel") return channelItem(r);
  if (r.type === "playlist") return playlistItem(r);
  return null;
}

/* ---------------------------------------------------------------------- pages */
function showLoading(text = "Loading…") { view.replaceChildren(h("div", { class: "empty" }, h("span", { class: "spin" }), text)); }
function showError(err, retry) {
  view.replaceChildren(h("div", { class: "error" },
    h("p", { text: err.message || String(err) }),
    h("p", { class: "muted small", text: "If this keeps happening, make sure the stack is running (start-yt.bat) and see the troubleshooting table in the guide." }),
    retry ? h("button", { class: "btn", onclick: retry, text: "Retry" }) : null));
}

async function pageFeed(id, force) {
  const list = subs();
  const hour = new Date().getHours();
  const hello = hour < 5 ? "Still up?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  view.replaceChildren(h("h1", { text: hello }));
  if (!list.length && !interests().seeds.length) {
    view.append(h("div", { class: "empty" },
      h("p", { text: "Your feed is empty, for now." }),
      h("p", { class: "small", style: "font-family:system-ui,sans-serif", text: "Subscribe to channels you like, or just watch and like a few videos. New uploads and suggestions based on what you watch show up here." }),
      h("p", {}, h("button", { class: "btn primary", text: "Start searching", onclick: () => document.getElementById("q").focus() }))));
    return;
  }
  const sig = list.map((s) => s.ucid).sort().join(",");
  const cache = store.get("feedCache", null);
  const cached = cache && cache.sig === sig && cache.items && cache.items.length ? cache : null;
  const fresh = cached && Date.now() - cached.at < 20 * 60 * 1000;
  const n = list.length, plural = n === 1 ? "" : "s";

  /* Stale-while-revalidate: show the saved copy at once, refresh behind it. */
  const note = h("span", { class: "muted small" });
  const grid = h("div", {});
  view.append(h("div", { class: "row" }, note, h("span", { class: "spacer" }),
    h("button", { class: "btn", text: "Refresh", onclick: () => route(true) })), grid);
  let shown = [], status = "";
  const draw = (items, text) => {
    if (items) shown = items;
    if (text != null) status = text;
    const recs = suggest(new Set(shown.map((v) => v.videoId)));
    const all = mixFeed(shown, recs);
    note.textContent = [n ? `Latest from your ${n} channel${plural}` : "", recs.length ? "suggestions from what you watch" : "", status].filter(Boolean).join(" · ");
    grid.replaceChildren(all.length ? h("div", { class: "grid" }, all.map((v) => videoCard(v, v.why ? h("div", { class: "meta why", text: v.why }) : null)))
      : h("p", { class: "empty", text: n ? "No videos found. Invidious may be unreachable." : "No suggestions yet. Watch or like a few more videos." }));
  };
  /* Suggestions need the related lists of your top videos; fetch any that are missing, then redraw. */
  const more = async () => { if (engineReady && (await fetchRelated()) && id === renderId) draw(); };
  if (!n) {
    note.textContent = "Finding videos for you…";
    if (engineReady) await fetchRelated();
    if (id === renderId) draw([], "");
    return;
  }
  if (cached) {
    draw(cached.items, !engineReady ? "saved copy, the engine is still starting" : fresh && !force ? "saved copy, refreshes every 20 minutes" : "showing your saved copy, updating…");
    if (!engineReady || (fresh && !force)) return more();
  } else {
    note.textContent = `Loading 0/${n} channels…`;
  }

  const all = [];
  let done = 0;
  for (let i = 0; i < list.length; i += 4) {
    const batch = list.slice(i, i + 4);
    const results = await Promise.allSettled(batch.map((c) => api(`channels/${enc(c.ucid)}/videos`)));
    if (id !== renderId) return;
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const vids = Array.isArray(r.value) ? r.value : r.value.videos || [];
      for (const v of vids.slice(0, 12)) {
        if (v.type && v.type !== "video") continue;
        all.push({ videoId: v.videoId, title: v.title, author: v.author, authorId: v.authorId, lengthSeconds: v.lengthSeconds, viewCount: v.viewCount, published: v.published, liveNow: v.liveNow });
      }
    }
    done += batch.length;
    if (!cached) note.textContent = `Loading ${done}/${n} channels…`;
  }
  const items = all.filter((v) => v.videoId).sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, 80);
  if (items.length) {
    store.set("feedCache", { sig, at: Date.now(), items });
    draw(items, "just updated");
  } else if (cached) {
    draw(cached.items, "could not refresh right now, showing your saved copy");
  } else {
    draw([], "");
  }
  await more();
}

async function pageSearch(id, params) {
  const q = params.get("q") || "";
  document.getElementById("q").value = q;
  const type = params.get("type") || "video", page = Number(params.get("page") || 1);
  const form = h("form", { class: "filters" });
  const mk = (name, opts) => {
    const cur = name === "type" ? type : params.get(name) || "";
    return dropdown({ options: opts, value: cur, label: name, onChange: (v) => {
      const p = new URLSearchParams(params);
      p.delete("page");
      v ? p.set(name, v) : p.delete(name);
      location.hash = "#/search?" + p;
    } });
  };
  form.append(
    mk("type", [["video", "Videos"], ["channel", "Channels"], ["playlist", "Playlists"], ["all", "All"]]),
    mk("sort", [["", "Relevance"], ["date", "Upload date"], ["views", "View count"], ["rating", "Rating"]]),
    mk("date", [["", "Any time"], ["hour", "Last hour"], ["today", "Today"], ["week", "This week"], ["month", "This month"], ["year", "This year"]]),
    mk("duration", [["", "Any length"], ["short", "Under 4 min"], ["medium", "4-20 min"], ["long", "Over 20 min"]]));
  view.replaceChildren(h("h1", { text: q ? `Results for "${q}"` : "Search" }), form);
  if (!q) return;
  const body = h("p", { class: "empty", text: "Searching…" });
  view.append(body);
  const qs = new URLSearchParams({ q, type, page });
  for (const k of ["sort", "date", "duration"]) if (params.get(k)) qs.set(k, params.get(k));
  const data = await api("search?" + qs);
  if (id !== renderId) return;
  const cards = data.map(resultItem).filter(Boolean);
  const nav = h("div", { class: "row", style: "margin-top:16px" },
    page > 1 ? h("a", { class: "btn", href: "#/search?" + new URLSearchParams({ ...Object.fromEntries(params), page: page - 1 }), text: "Previous" }) : null,
    cards.length ? h("a", { class: "btn", href: "#/search?" + new URLSearchParams({ ...Object.fromEntries(params), page: page + 1 }), text: "Next" }) : null);
  body.replaceWith(cards.length ? h("div", { class: "grid" }, cards) : h("p", { class: "empty", text: "Nothing found." }));
  view.append(nav);
}

async function pageChannel(id, ucid) {
  showLoading();
  const info = await api("channels/" + enc(ucid));
  if (id !== renderId) return;
  const entry = { ucid, name: info.author, thumbnail: (info.authorThumbnails || []).slice(-1)[0]?.url || "" };
  const subBtn = h("button", { class: "btn primary" });
  const paint = () => { const on = isSub(ucid); subBtn.textContent = on ? "Subscribed" : "Subscribe"; subBtn.classList.toggle("primary", !on); };
  subBtn.addEventListener("click", () => { toggleSub(entry); paint(); });
  paint();
  const grid = h("div", { class: "grid" });
  const more = h("button", { class: "btn", text: "Load more" });
  let cont = null;
  const load = async () => {
    more.disabled = true;
    try {
      const d = await api(`channels/${enc(ucid)}/videos` + (cont ? `?continuation=${enc(cont)}` : ""));
      const vids = Array.isArray(d) ? d : d.videos || [];
      cont = Array.isArray(d) ? null : d.continuation || null;
      grid.append(...vids.filter((v) => !v.type || v.type === "video").map((v) => videoCard({ ...v, author: info.author, authorId: ucid })));
    } catch (e) { toast(e.message); }
    more.disabled = false;
    more.hidden = !cont;
  };
  view.replaceChildren(
    h("div", { class: "chanhead" },
      h("img", { class: "avatar lg", alt: "", src: abs(entry.thumbnail) }),
      h("div", {}, h("h1", { text: info.author }), h("div", { class: "muted small", text: info.subCount ? fmtNum(info.subCount) + " subscribers" : "" })),
      h("span", { class: "spacer" }), subBtn),
    info.description ? h("p", { class: "muted small", style: "white-space:pre-wrap;max-height:5em;overflow:hidden", text: info.description }) : null,
    grid, h("div", { class: "row", style: "margin-top:16px" }, more));
  load();
  more.addEventListener("click", load);
}

async function pagePlaylist(id, plid, params) {
  showLoading();
  const page = Number(params.get("page") || 1);
  const data = await api(`playlists/${enc(plid)}?page=${page}`);
  if (id !== renderId) return;
  const dlBtn = isMix(plid) ? null : h("button", { class: "btn primary", text: "Download playlist", onclick: () => openDownloadDialog({ playlist: plid, title: data.title, count: data.videoCount }) });
  const vids = (data.videos || []).map((v) => h("div", { class: "card" },
    thumbBox(`#/watch/${v.videoId}?list=${enc(plid)}`, v.videoId, v.lengthSeconds),
    h("a", { class: "title", href: `#/watch/${v.videoId}?list=${enc(plid)}`, text: v.title }),
    h("div", { class: "meta", text: v.author || "" })));
  view.replaceChildren(
    h("div", { class: "row" }, h("h1", { text: data.title }), h("span", { class: "spacer" }), dlBtn),
    h("p", { class: "muted small", text: [data.author, data.videoCount ? data.videoCount + " videos" : ""].filter(Boolean).join(" · ") }),
    vids.length ? h("div", { class: "grid" }, vids) : h("p", { class: "empty", text: page > 1 ? "No more videos." : "Invidious can't list the videos of this playlist (common with Shorts-only playlists). You can still download it." }),
    h("div", { class: "row", style: "margin-top:16px" },
      page > 1 ? h("a", { class: "btn", href: `#/playlist/${plid}?page=${page - 1}`, text: "Previous" }) : null,
      vids.length >= 100 ? h("a", { class: "btn", href: `#/playlist/${plid}?page=${page + 1}`, text: "Next" }) : null));
}

/* ---------------------------------------------------------------- watch + player */
let dashLoading = null;
function loadDash() {
  if (window.dashjs) return Promise.resolve();
  if (!dashLoading) {
    dashLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/dashjs/5.2.1/modern/umd/dash.all.min.js";
      s.onload = resolve;
      s.onerror = () => { dashLoading = null; reject(new Error("dash.js failed to load")); };
      document.head.append(s);
    });
  }
  return dashLoading;
}

/* Player chrome: our own controls over a bare <video>, so the look matches the app and the settings
   menu can offer quality and speed. Icons are inline SVG, so nothing extra is downloaded. */
const PL_ICON = {
  play: '<path d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10.1-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>',
  vol: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path class="s" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path class="s" d="M16 9.5l5 5M21 9.5l-5 5"/>',
  gear: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.47.47 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/>',
  pip: '<rect class="s" x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11.5" width="7" height="5.5" rx="1"/>',
  full: '<path class="s" d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  unfull: '<path class="s" d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>',
};
const plIcon = (name) => { const s = h("span", { class: "pl-ico" }); s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${PL_ICON[name]}</svg>`; return s; };
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const speedLabel = (r) => (r === 1 ? "Normal" : r + "×");
function fmtClock(s) {
  s = Math.max(0, Math.floor(isFinite(s) ? s : 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/* Playback fallback chain (guide 10.4): file -> dash -> itag18 -> embed. */
function mountPlayer(box, note, opts) {
  const { id, live, file, quality, position, onTime, onEnded } = opts;
  const tiers = [];
  if (file) tiers.push("file");
  if (live) tiers.push("embed");
  else {
    if (quality !== "360p") tiers.push("dash");
    tiers.push("itag18", "embed");
  }
  let idx = -1, dp = null, el = null, resumed = false, lastSave = 0, fellBack = false;
  const dashUrl = `${BASE}/api/manifest/dash/id/${id}?local=true`;
  let resumeAt = position, exactResume = false;
  let cap = QUALITY_CAP[quality] || 720, pinned = 0; // pinned: a height chosen in the menu, 0 = auto
  /* The manifest is filtered before dash.js picks a stream: heights up to the cap, or only the height picked above it. */
  let above = 0, allHeights = []; // above: the height picked above the cap when the manifest was last loaded
  const allowed = (hgt) => (above ? hgt === above : hgt <= cap);
  let speed = store.get("speed", 1);
  const vol = store.get("volume", { level: 1, muted: false });
  const SOURCE = { file: "Your downloaded file, no network used", dash: "Adaptive stream", itag18: "Single 360p stream", embed: "Embedded Invidious player" };

  /* ---- chrome */
  const media = h("div", { class: "pl-media" });
  const hit = h("div", { class: "pl-hit" });
  const big = h("button", { type: "button", class: "pl-big", "aria-label": "Play" }, plIcon("play"));
  const spin = h("div", { class: "pl-spin", hidden: true });
  const buf = h("div", { class: "pl-buf" }), fill = h("div", { class: "pl-fill" });
  const knob = h("div", { class: "pl-knob" }), tip = h("div", { class: "pl-tip", hidden: true });
  const bar = h("div", { class: "pl-bar", role: "slider", "aria-label": "Seek", "aria-valuemin": "0" }, h("div", { class: "pl-track" }, buf, fill), knob, tip);
  const btn = (icon, label, onclick) => h("button", { type: "button", class: "pl-btn", "aria-label": label, title: label, onclick }, plIcon(icon));
  const setIcon = (b, name, label) => { b.replaceChildren(plIcon(name)); b.setAttribute("aria-label", label); b.title = label; };
  const playBtn = btn("play", "Play (k)", () => toggle());
  const muteBtn = btn("vol", "Mute (m)", () => { vol.muted = !vol.muted; applyVolume(); });
  const volIn = h("input", { type: "range", class: "pl-vol", min: "0", max: "1", step: "0.05", "aria-label": "Volume" });
  volIn.addEventListener("input", () => { vol.level = Number(volIn.value); vol.muted = vol.level === 0; applyVolume(); });
  const time = h("span", { class: "pl-time", text: "0:00 / 0:00" });
  const gearBtn = btn("gear", "Settings", () => (menu.hidden ? openMenu("main") : closeMenu()));
  const pipBtn = document.pictureInPictureEnabled ? btn("pip", "Picture in picture", () => {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else if (isVideo()) el.requestPictureInPicture().catch(() => {});
  }) : null;
  const fullBtn = btn("full", "Full screen (f)", () => toggleFull());
  const menu = h("div", { class: "pl-menu", role: "menu", hidden: true });
  const ctrl = h("div", { class: "pl-ctrl" }, bar,
    h("div", { class: "pl-row" }, playBtn, h("div", { class: "pl-volbox" }, muteBtn, volIn), time, h("span", { class: "spacer" }), gearBtn, pipBtn, fullBtn));
  box.classList.add("pl");
  box.replaceChildren(media, hit, big, spin, ctrl, menu);

  const isVideo = () => !!el && el.tagName === "VIDEO";
  const toggle = () => { if (!isVideo()) return; if (el.paused || el.ended) el.play().catch(() => {}); else el.pause(); };
  const toggleFull = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else box.requestFullscreen().catch(() => {}); };
  const seek = (t) => { if (isVideo() && isFinite(el.duration)) { el.currentTime = Math.min(Math.max(0, t), el.duration - 0.1); paintTime(); } };
  function applyVolume() {
    vol.level = Math.round(Math.min(1, Math.max(0, vol.level)) * 100) / 100;
    if (isVideo()) { el.volume = vol.level; el.muted = vol.muted; }
    volIn.value = vol.muted ? 0 : vol.level;
    setIcon(muteBtn, vol.muted || vol.level === 0 ? "mute" : "vol", vol.muted ? "Unmute (m)" : "Mute (m)");
    store.set("volume", vol);
  }
  function setSpeed(r) { speed = r; store.set("speed", r); if (isVideo()) { el.defaultPlaybackRate = r; el.playbackRate = r; } }

  let dragging = false;
  function paintTime() {
    if (!isVideo()) return;
    const d = el.duration, t = el.currentTime;
    const frac = isFinite(d) && d > 0 ? t / d : 0;
    if (!dragging) { fill.style.transform = `scaleX(${frac})`; knob.style.left = frac * 100 + "%"; }
    time.textContent = `${fmtClock(t)} / ${fmtClock(d)}`;
    bar.setAttribute("aria-valuenow", Math.floor(t));
    bar.setAttribute("aria-valuemax", Math.floor(d) || 0);
    bar.setAttribute("aria-valuetext", time.textContent);
    const b = el.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) { buf.style.transform = `scaleX(${isFinite(d) && d ? b.end(i) / d : 0})`; break; }
  }
  function paintPlaying() {
    const playing = isVideo() && !el.paused && !el.ended;
    box.classList.toggle("playing", playing);
    setIcon(playBtn, playing ? "pause" : "play", playing ? "Pause (k)" : "Play (k)");
    if (!playing) wake();
  }

  /* seek bar: drag to scrub, hover for the time under the pointer */
  const fracAt = (x) => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)); };
  const showTip = (f) => {
    if (!isVideo() || !isFinite(el.duration)) return;
    tip.hidden = false;
    tip.textContent = fmtClock(f * el.duration);
    tip.style.left = Math.min(Math.max(f * 100, 4), 96) + "%";
  };
  const moveTo = (f) => { fill.style.transform = `scaleX(${f})`; knob.style.left = f * 100 + "%"; };
  bar.addEventListener("pointermove", (e) => { const f = fracAt(e.clientX); showTip(f); if (dragging) moveTo(f); });
  bar.addEventListener("pointerleave", () => { if (!dragging) tip.hidden = true; });
  bar.addEventListener("pointerdown", (e) => {
    if (!isVideo() || e.button !== 0) return;
    dragging = true;
    bar.classList.add("drag");
    bar.setPointerCapture(e.pointerId);
    const f = fracAt(e.clientX);
    moveTo(f);
    showTip(f);
  });
  bar.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove("drag");
    tip.hidden = true;
    seek(fracAt(e.clientX) * el.duration);
  });
  bar.addEventListener("pointercancel", () => { dragging = false; bar.classList.remove("drag"); tip.hidden = true; paintTime(); });

  /* controls fade out while playing and the pointer rests */
  let idleTimer = null;
  function wake() {
    box.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (box.classList.contains("playing") && menu.hidden && !dragging) box.classList.add("idle"); }, 2600);
  }
  box.addEventListener("pointermove", wake);
  box.addEventListener("pointerdown", wake);
  box.addEventListener("focusin", wake);
  let clickTimer = null;
  hit.addEventListener("click", () => {
    if (!menu.hidden) return closeMenu();
    clearTimeout(clickTimer);
    clickTimer = setTimeout(toggle, 200); // a second click within 200 ms means full screen, not pause
  });
  hit.addEventListener("dblclick", () => { clearTimeout(clickTimer); toggleFull(); });
  big.addEventListener("click", () => toggle());
  const onFull = () => { const on = document.fullscreenElement === box; setIcon(fullBtn, on ? "unfull" : "full", on ? "Exit full screen (f)" : "Full screen (f)"); };
  document.addEventListener("fullscreenchange", onFull);

  /* ---- settings menu: quality, speed, and where the picture comes from */
  const heights = () => allHeights;
  const nowPlaying = () => (isVideo() && el.videoHeight ? el.videoHeight + "p" : "");
  function qualityLabel() {
    if (tiers[idx] === "dash") return pinned ? pinned + "p" : `Auto${nowPlaying() ? " · " + nowPlaying() : ""}`;
    return nowPlaying() || (tiers[idx] === "itag18" ? "360p" : "Original");
  }
  const item = (label, value, onclick, sel) => h("button", { type: "button", class: "pl-mi" + (sel ? " sel" : ""), role: "menuitem", onclick, disabled: !onclick },
    h("span", { text: label }), value != null ? h("span", { class: "v", text: value }) : null);
  function openMenu(page) {
    const tier = tiers[idx];
    let kids;
    if (page === "main") {
      const pick = tier === "dash" ? () => openMenu("quality") : tier === "itag18" && !tiers.includes("dash") ? upgrade : null;
      kids = [
        item("Quality", tier === "itag18" && pick ? "360p · go higher ›" : qualityLabel() + (pick ? "  ›" : ""), pick),
        item("Playback speed", speedLabel(speed) + "  ›", () => openMenu("speed")),
        h("div", { class: "pl-msrc", text: SOURCE[tier] + (fellBack ? " (the better source failed)" : "") + (tier === "dash" ? `, Auto goes up to ${cap}p` : "") }),
      ];
    } else {
      const back = item("‹  " + (page === "quality" ? "Quality" : "Playback speed"), null, () => openMenu("main"));
      back.classList.add("pl-mhead");
      kids = page === "quality"
        ? [back, item(`Auto (up to ${cap}p)`, null, () => pickQuality(0), !pinned), ...heights().map((hgt) => item(hgt + "p", null, () => pickQuality(hgt), pinned === hgt))]
        : [back, ...SPEEDS.map((r) => item(speedLabel(r), null, () => { setSpeed(r); openMenu("main"); }, r === speed))];
    }
    menu.replaceChildren(...kids);
    menu.dataset.page = page;
    menu.hidden = false;
    gearBtn.classList.add("on");
    wake();
    if (page !== "main") (menu.querySelector(".pl-mi.sel") || menu.querySelector(".pl-mi")).focus();
  }
  function closeMenu() { menu.hidden = true; gearBtn.classList.remove("on"); }
  const outside = (e) => { if (!menu.hidden && !menu.contains(e.target) && !gearBtn.contains(e.target)) closeMenu(); };
  document.addEventListener("pointerdown", outside, true);

  function pickQuality(hgt) {
    pinned = hgt;
    closeMenu();
    if (!dp) return;
    const want = pinned > cap ? pinned : 0;
    if (want !== above) { // the filter must see the change: reload the manifest where we are
      above = want;
      spin.hidden = false;
      dp.attachSource(dashUrl, isVideo() ? el.currentTime : NaN);
    } else applyPin();
  }
  function applyPin() {
    try {
      if (!pinned) return dp.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
      const rep = dp.getRepresentationsByType("video").filter((r) => r.height === pinned).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
      dp.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      if (rep) dp.setRepresentationForTypeById("video", rep.id, true);
    } catch (e) { console.warn("quality change failed", e); }
  }
  /* The 360p setting skips DASH; this lets one video go higher without touching the setting. */
  function upgrade() {
    closeMenu();
    if (isVideo()) resumeAt = el.currentTime;
    exactResume = true;
    cap = 1080;
    tiers.splice(idx, 0, "dash");
    idx--;
    next();
  }

  /* ---- keyboard: YouTube's keys, ignored while typing or when a page button has focus */
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !isVideo()) return;
    const t = e.target, k = e.key.toLowerCase();
    if (t.closest && t.closest("input:not(.pl-vol), textarea, select, [contenteditable], dialog")) return;
    if ((k === " " || k === "enter") && t.closest && t.closest("button, a")) return;
    let done = true;
    if (k === " " || k === "k") toggle();
    else if (k === "j") seek(el.currentTime - 10);
    else if (k === "l") seek(el.currentTime + 10);
    else if (k === "arrowleft") seek(el.currentTime - 5);
    else if (k === "arrowright") seek(el.currentTime + 5);
    else if (k === "arrowup") { vol.level += 0.05; vol.muted = false; applyVolume(); }
    else if (k === "arrowdown") { vol.level -= 0.05; applyVolume(); }
    else if (k === "m") { vol.muted = !vol.muted; applyVolume(); }
    else if (k === "f") toggleFull();
    else if (e.key === ">" || e.key === "<") setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, SPEEDS.indexOf(speed) + (e.key === ">" ? 1 : -1)))] || 1);
    else if (/^[0-9]$/.test(k) && isFinite(el.duration)) seek((Number(k) / 10) * el.duration);
    else if (k === "escape" && !menu.hidden) closeMenu();
    else done = false;
    if (done) { e.preventDefault(); wake(); }
  };
  document.addEventListener("keydown", onKey);

  /* ---- sources */
  const dropSource = () => {
    if (dp) { try { dp.destroy(); } catch { /* already gone */ } dp = null; }
    if (el && el.pause) { try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* ignore */ } }
    media.replaceChildren();
  };
  const teardown = () => {
    dropSource();
    el = null;
    clearTimeout(idleTimer);
    clearTimeout(clickTimer);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("fullscreenchange", onFull);
    if (document.fullscreenElement === box) document.exitFullscreen().catch(() => {});
    box.replaceChildren();
  };
  const next = (why) => {
    if (why) { console.warn("player tier failed:", tiers[idx], why); fellBack = true; }
    dropSource();
    closeMenu();
    idx++;
    const tier = tiers[idx];
    note.textContent = "";
    if (!tier) { el = null; box.classList.add("embed"); note.textContent = "No playback source worked. Check that the stack is running, then reload."; return; }
    box.classList.toggle("embed", tier === "embed");
    if (tier === "embed") {
      el = h("iframe", { src: `${BASE}/embed/${id}?autoplay=1`, allow: "autoplay; fullscreen; picture-in-picture", allowfullscreen: true });
      media.append(el);
      return;
    }
    el = h("video", { autoplay: true, playsinline: true, preload: "metadata" });
    resumed = false;
    el.addEventListener("error", () => next("media error"));
    el.addEventListener("loadedmetadata", () => {
      if (!resumed && (exactResume ? resumeAt > 1 : resumeAt > 10 && el.duration && resumeAt < el.duration - 15)) el.currentTime = resumeAt;
      resumed = true;
      paintTime();
    });
    el.addEventListener("timeupdate", () => {
      paintTime();
      if (el.currentTime - lastSave > 5 || el.currentTime < lastSave) { lastSave = el.currentTime; onTime(el.currentTime); }
    });
    el.addEventListener("progress", paintTime);
    el.addEventListener("durationchange", paintTime);
    el.addEventListener("play", paintPlaying);
    el.addEventListener("pause", paintPlaying);
    el.addEventListener("ended", () => { paintPlaying(); onEnded(); });
    el.addEventListener("waiting", () => { spin.hidden = false; });
    for (const ev of ["playing", "canplay", "seeked", "pause"]) el.addEventListener(ev, () => { spin.hidden = true; });
    el.addEventListener("resize", () => { if (!menu.hidden && menu.dataset.page === "main") openMenu("main"); }); // Auto shows the live height
    media.append(el);
    applyVolume();
    setSpeed(speed);
    paintPlaying();
    if (tier === "file") el.src = "/files/" + enc(file);
    else if (tier === "itag18") el.src = `${BASE}/latest_version?id=${id}&itag=18&local=true`;
    else if (tier === "dash") {
      const video = el;
      loadDash().then(() => {
        if (el !== video) return;
        const ev = dashjs.MediaPlayer.events;
        above = pinned > cap ? pinned : 0;
        dp = dashjs.MediaPlayer().create();
        dp.updateSettings({ streaming: { retryAttempts: { MPD: 1 } } });
        /* Filtering the manifest (rather than a bitrate cap set later) stops dash.js from ever starting above the cap. */
        dp.registerCustomCapabilitiesFilter((rep) => !rep.height || allowed(Number(rep.height))); // audio has no height
        dp.on(ev.MANIFEST_LOADED, (e) => { // runs before the filter, so the menu can offer every height
          try {
            const hs = e.data.Period[0].AdaptationSet.flatMap((a) => a.Representation || []).map((r) => Number(r.height)).filter(Boolean);
            allHeights = [...new Set([...allHeights, ...hs])].sort((a, b) => b - a);
          } catch { /* menu falls back to Auto only */ }
        });
        dp.on(ev.STREAM_INITIALIZED, () => { setSpeed(speed); if (pinned) applyPin(); });
        dp.on(ev.ERROR, (e) => next(e && e.error ? e.error.message : "dash error"));
        dp.initialize(video, dashUrl, true);
      }).catch((e) => next(e.message));
    }
  };
  next();
  return teardown;
}

function parseDescription(text) { return h("div", { class: "desc" }, linkify(text || "")); }

async function pageWatch(id, vid, params) {
  showLoading();
  const lib = await getLibrary();
  const fileEntry = lib.get(vid);
  let info = null, failure = null;
  try { info = await api("videos/" + enc(vid)); } catch (e) { failure = e; }
  if (id !== renderId) return;
  if (!info && !fileEntry) throw failure;

  const cfg = settings();
  const title = info ? info.title : fileEntry.name.replace(/ \[[\w-]{11}\]\.\w+$/, "");
  document.title = title + " · My Tube";
  cleanups.push(() => { document.title = "My Tube"; });

  const box = h("div", { class: "player" });
  const note = h("p", { class: "player-note" });
  let nextHref = null;
  const goNext = () => { if (cfg.autoplay && nextHref) location.hash = nextHref; };

  addHistory({ id: vid, title, author: info ? info.author : "", authorId: info ? info.authorId : "", lengthSeconds: info ? info.lengthSeconds : 0 });

  const offline = !info;
  const file = fileEntry && (fileEntry.kind === "video" || offline) ? fileEntry.name : null;
  cleanups.push(mountPlayer(box, note, {
    id: vid, live: info && info.liveNow, file, quality: cfg.defaultQuality, position: savedPosition(vid),
    onTime: (t) => savePosition(vid, t), onEnded: goNext,
  }));

  /* actions */
  const entry = { id: vid, title, author: info ? info.author : "", authorId: info ? info.authorId : "", lengthSeconds: info ? info.lengthSeconds : 0 };
  const laterBtn = h("button", { class: "btn" });
  const paintLater = () => { const on = watchLater().some((v) => v.id === vid); laterBtn.textContent = on ? "In watch later" : "Watch later"; laterBtn.classList.toggle("on", on); };
  laterBtn.addEventListener("click", () => { toggleLater(entry); paintLater(); });
  paintLater();
  const likeBtn = h("button", { class: "btn" });
  const paintLike = () => { const on = likes().some((v) => v.id === vid); likeBtn.textContent = on ? "Liked" : "Like"; likeBtn.classList.toggle("on", on); };
  likeBtn.addEventListener("click", () => { toggleLike(entry); paintLike(); });
  paintLike();

  const dlBtn = h("button", { class: "btn primary", text: "Download", onclick: () => openDownloadDialog({ id: vid, title }) });

  const subBtn = info ? h("button", { class: "btn" }) : null;
  if (subBtn) {
    const ch = { ucid: info.authorId, name: info.author, thumbnail: (info.authorThumbnails || []).slice(-1)[0]?.url || "" };
    const paint = () => { const on = isSub(ch.ucid); subBtn.textContent = on ? "Subscribed" : "Subscribe"; subBtn.classList.toggle("on", on); };
    subBtn.addEventListener("click", () => { toggleSub(ch); paint(); });
    paint();
  }

  const left = h("div", {},
    box, note,
    h("h1", { style: "margin-top:12px", text: title }),
    h("div", { class: "row" },
      info ? h("a", { class: "row", href: "#/channel/" + info.authorId }, h("img", { class: "avatar", alt: "", src: abs((info.authorThumbnails || []).slice(-1)[0]?.url || "") }), h("strong", { text: info.author })) : null,
      subBtn, h("span", { class: "spacer" }), likeBtn, laterBtn, dlBtn),
    fileEntry ? h("p", { class: "muted small", text: `In your library: ${fileEntry.name} (${fmtSize(fileEntry.size)})` }) : null,
    failure ? h("p", { class: "error", text: "Invidious is not reachable, showing your offline copy only. " + failure.message }) : null);

  const right = h("div", { class: "list" });
  if (info) {
    const meta = [fmtNum(info.viewCount) && fmtNum(info.viewCount) + " views", fmtNum(info.likeCount) && fmtNum(info.likeCount) + " likes", info.published ? fmtAgo(info.published) : ""].filter(Boolean).join(" · ");
    const desc = parseDescription(info.description);
    const toggle = h("button", { class: "btn", text: "Show more", onclick: () => { desc.classList.toggle("open"); toggle.textContent = desc.classList.contains("open") ? "Show less" : "Show more"; } });
    left.append(h("p", { class: "muted", text: meta }), desc, h("div", { style: "margin-top:8px" }, toggle));

    const recs = (info.recommendedVideos || []).filter((v) => v.videoId);
    if (recs.length) nextHref = "#/watch/" + recs[0].videoId;
    rememberRelated(vid, recs); // feeds the suggestions on the home page
    right.append(h("h2", { style: "margin:0", text: "Up next" }), ...recs.map(relatedItem));

    /* playlist context: autoplay moves to the next playlist item */
    const list = params.get("list");
    if (list) {
      api(`playlists/${enc(list)}`).then((pl) => {
        const vids = pl.videos || [];
        const i = vids.findIndex((v) => v.videoId === vid);
        const box = h("div", { class: "panel", style: "margin-bottom:6px" }, h("strong", { text: pl.title || "Playlist" }));
        if (i >= 0 && vids[i + 1]) {
          nextHref = `#/watch/${vids[i + 1].videoId}?list=${enc(list)}`;
          box.append(h("p", { class: "small", style: "margin:6px 0" }, "Next: ", h("a", { href: nextHref, text: vids[i + 1].title })));
        }
        box.append(h("div", { class: "row", style: "margin-top:8px" },
          h("a", { class: "btn small", href: "#/playlist/" + list, text: "Open playlist" }),
          isMix(list) ? null : h("button", { class: "btn small", text: "Download playlist", onclick: () => openDownloadDialog({ playlist: list, title: pl.title, count: pl.videoCount }) })));
        right.prepend(box);
      }).catch(() => {});
    }

    /* comments: fetched only when scrolled into view */
    const clist = h("div", {});
    const cmore = h("button", { class: "btn", hidden: true, text: "More comments" });
    const chead = h("h2", { text: "Comments" });
    let cont = null;
    const loadComments = async () => {
      cmore.disabled = true;
      try {
        const d = await api(`comments/${enc(vid)}` + (cont ? `?continuation=${enc(cont)}` : ""));
        if (id !== renderId) return;
        if (d.commentCount) chead.textContent = `Comments (${fmtNum(d.commentCount)})`;
        cont = d.continuation || null;
        clist.append(...(d.comments || []).map((c) => h("div", { class: "comment" },
          h("img", { class: "avatar", style: "width:36px;height:36px", loading: "lazy", alt: "", src: abs((c.authorThumbnails || []).slice(-1)[0]?.url || "") }),
          h("div", {}, h("div", { class: "who", text: `${c.author} · ${c.publishedText || ""}` }), h("div", { class: "txt", text: c.content || "" }),
            c.likeCount ? h("div", { class: "muted small", text: fmtNum(c.likeCount) + " likes" }) : null))));
        if (!clist.childNodes.length) clist.append(h("p", { class: "muted", text: "No comments (or comments are off)." }));
      } catch (e) { clist.append(h("p", { class: "muted", text: "Comments unavailable: " + e.message })); cont = null; }
      cmore.disabled = false;
      cmore.hidden = !cont;
    };
    cmore.addEventListener("click", loadComments);
    const sentinel = h("div", {});
    left.append(chead, clist, cmore, sentinel);
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); loadComments(); } });
      io.observe(sentinel);
      cleanups.push(() => io.disconnect());
    } else loadComments();
  }
  view.replaceChildren(h("div", { class: "watch" }, left, right));
}

/* ------------------------------------------------------------------ list pages */
function pageSubs() {
  const list = subs();
  view.replaceChildren(h("h1", { text: "Your channels" }));
  if (!list.length) return view.append(h("p", { class: "empty", text: "No channels yet. Open one and press Subscribe." }));
  view.append(h("div", { class: "list" }, list.map((c) => h("div", { class: "item", style: "align-items:center" },
    h("a", { href: "#/channel/" + c.ucid }, h("img", { class: "avatar", alt: "", loading: "lazy", src: abs(c.thumbnail) })),
    h("a", { class: "title", href: "#/channel/" + c.ucid, text: c.name }),
    h("span", { class: "spacer" }),
    h("button", { class: "btn", text: "Unsubscribe", onclick: () => { toggleSub(c); pageSubs(); } })))));
}

function savedGrid(title, key, emptyText, withClear) {
  const list = store.get(key, []);
  view.replaceChildren(h("div", { class: "row" }, h("h1", { text: title }), h("span", { class: "spacer" }),
    withClear && list.length ? h("button", { class: "btn", text: "Clear", onclick: () => { if (confirm(`Clear ${title.toLowerCase()}?`)) { store.set(key, []); savedGrid(title, key, emptyText, withClear); } } }) : null));
  if (!list.length) return view.append(h("p", { class: "empty", text: emptyText }));
  const remove = { watchLater: toggleLater, likes: toggleLike }[key];
  view.append(h("div", { class: "grid" }, list.map((v) => videoCard({ videoId: v.id, title: v.title, author: v.author, authorId: v.authorId, lengthSeconds: v.lengthSeconds, published: (v.watchedAt || v.likedAt || 0) / 1000 },
    remove ? h("button", { class: "btn small", text: "Remove", onclick: () => { remove(v); savedGrid(title, key, emptyText, withClear); } }) : null))));
}

async function pageDownloads(id) {
  view.replaceChildren(h("h1", { text: "Saved on this PC" }));
  const jobsBox = h("div", {}), libBox = h("div", {});
  const folders = h("div", { class: "panel folders" }, [["Videos", "video", CFG.videoDir], ["Audio", "audio", CFG.audioDir]].map(([n, k, p]) =>
    h("div", { class: "row" }, h("strong", { text: n }), h("code", { text: p || "" }), h("span", { class: "spacer" }), h("button", { class: "btn small", text: "Open folder", onclick: () => openFolder(k) }))));
  view.append(h("p", { class: "lead", text: "Everything you download is stored on this PC, and listed here so you can play it in the app." }), folders,
    h("h2", { text: "Downloading" }), jobsBox, h("h2", { text: "Library" }), libBox);
  let timer = null, lastActive = -1, lastSig = null;
  const stop = () => clearTimeout(timer);
  cleanups.push(stop);
  const tick = async () => {
    try {
      const jobs = await (await fetch("/jobs")).json();
      if (id !== renderId) return;
      const active = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
      jobsBox.replaceChildren(jobs.length ? h("table", {},
        h("thead", {}, h("tr", {}, ["Item", "Format", "Status", "Progress", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, jobs.map((j) => {
          const live = j.status === "queued" || j.status === "running";
          const name = j.title || (j.kind === "playlist" ? "Playlist " + j.target : j.target);
          const status = j.status === "error" ? "failed: " + (j.error || "")
            : j.status === "running" && j.kind === "playlist" ? (j.total ? `video ${j.index} of ${j.total}` : "reading playlist…")
            : j.status === "done" && j.message ? "done · " + j.message : j.status;
          return h("tr", {},
            h("td", {}, h("a", { href: (j.kind === "playlist" ? "#/playlist/" : "#/watch/") + j.target, text: name }),
              j.kind === "playlist" ? h("div", { class: "muted small", text: "Playlist" + (j.limit ? ", first " + j.limit : "") }) : null),
            h("td", { text: PROFILE_LABEL[j.profile] || j.profile }),
            h("td", { class: j.status === "error" ? "stat-err" : "", text: status }),
            h("td", {}, j.status === "running" || j.status === "done" ? h("progress", { max: 100, value: (j.kind === "playlist" ? j.overall : j.percent) || 0 }) : null),
            h("td", {}, live ? h("button", { class: "btn small", text: "Cancel", onclick: async () => {
              await fetch("/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job: j.id }) }).catch(() => {});
              clearTimeout(timer);
              tick();
            } }) : null));
        }))) : h("p", { class: "muted", text: "No jobs in this session." }));
      const sig = jobs.map((j) => j.index + ":" + j.status).join();
      if (sig !== lastSig) { lastSig = sig; await paintLibrary(); } // a new file landed
      lastActive = active;
      timer = setTimeout(tick, active ? 2000 : 6000);
    } catch (e) { jobsBox.replaceChildren(h("p", { class: "error", text: "Cannot reach the local server." })); }
  };
  const paintLibrary = async () => {
    libraryCache = null;
    const items = await (await fetch("/downloads")).json();
    if (id !== renderId) return;
    libBox.replaceChildren(items.length ? h("table", {},
      h("thead", {}, h("tr", {}, ["File", "Type", "Size", "Added", ""].map((t) => h("th", { text: t })))),
      h("tbody", {}, items.map((f) => h("tr", {},
        h("td", { text: f.name }), h("td", { text: f.kind }), h("td", { text: fmtSize(f.size) }), h("td", { class: "small", text: fmtDate(f.mtime) }),
        h("td", {}, h("div", { class: "row" }, f.id ? h("a", { class: "btn", href: "#/watch/" + f.id, text: "Play" }) : null, h("a", { class: "btn", href: "/files/" + enc(f.name), download: f.name, text: "Save copy" }))))))) : h("p", { class: "muted", text: "Nothing downloaded yet." }));
  };
  tick();
}

function pageSettings() {
  const cfg = settings();
  const save = (patch) => { store.set("settings", { ...settings(), ...patch }); applyTheme(); toast("Saved"); };
  const sel = (key, opts) => dropdown({ options: opts, value: cfg[key], label: key, onChange: (v) => save({ [key]: v }) });
  const status = h("span", { class: "muted small", text: "not checked" });
  const importInput = h("input", { type: "file", accept: "application/json", hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const ok = (a) => Array.isArray(a);
      if (ok(data.subscriptions)) store.set("subscriptions", data.subscriptions.filter((s) => s && typeof s.ucid === "string" && typeof s.name === "string").map((s) => ({ ucid: s.ucid, name: s.name, thumbnail: typeof s.thumbnail === "string" ? s.thumbnail : "" })));
      if (ok(data.history)) store.set("history", data.history.filter((x) => x && typeof x.id === "string").slice(0, 500));
      if (ok(data.watchLater)) store.set("watchLater", data.watchLater.filter((x) => x && typeof x.id === "string"));
      if (ok(data.likes)) store.set("likes", data.likes.filter((x) => x && typeof x.id === "string"));
      if (data.settings && typeof data.settings === "object") store.set("settings", { ...DEFAULTS, ...data.settings });
      store.set("feedCache", null);
      applyTheme();
      toast("Imported");
      pageSettings();
    } catch { toast("That file is not a valid export."); }
  } });
  view.replaceChildren(
    h("h1", { text: "Settings" }),
    h("div", { class: "settings" },
      h("label", {}, "Playback quality", sel("defaultQuality", [["360p", "360p (saves most data)"], ["480p", "480p"], ["720p", "720p"], ["1080p", "1080p"]])),
      h("label", {}, "Download profile", sel("downloadProfile", Object.entries(PROFILE_LABEL))),
      h("label", {}, "Autoplay next video", h("input", { type: "checkbox", checked: cfg.autoplay, onchange: (e) => save({ autoplay: e.target.checked }) })),
      h("label", {}, "Theme", sel("theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]])),
      h("div", { class: "panel" },
        h("strong", { text: "Backup" }),
        h("p", { class: "muted small", text: "Subscriptions, history, watch later, likes and settings live only on this PC. Export them regularly." }),
        h("div", { class: "row" },
          h("button", { class: "btn", text: "Export JSON", onclick: () => {
            const data = { version: 1, subscriptions: subs(), history: store.get("history", []), watchLater: watchLater(), likes: likes(), settings: settings() };
            const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })), download: `mytube-backup-${new Date().toISOString().slice(0, 10)}.json` });
            document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          } }),
          h("button", { class: "btn", text: "Import JSON", onclick: () => importInput.click() }), importInput)),
      h("div", { class: "panel" },
        h("strong", { text: "Connection" }),
        h("p", { class: "muted small", text: `Invidious address used by the player: ${BASE}` }),
        h("p", { class: "muted small", text: `My Tube ${CFG.version || ""}` }),
        h("div", { class: "row" }, h("button", { class: "btn", text: "Check Invidious", onclick: async () => {
          status.textContent = "checking…";
          try { await api("search/suggestions?q=test"); status.textContent = "Invidious is reachable"; } catch (e) { status.textContent = "Not reachable: " + e.message; }
        } }), status))));
}

/* ---------------------------------------------------------------------- router */
const NAV_KEY = { "": "feed", search: "", watch: "", channel: "", playlist: "", subs: "subs", later: "later", liked: "liked", history: "history", downloads: "downloads", settings: "settings" };

/* Pages that talk to Invidious wait for it; local pages (channels, later, liked, history, saved, settings) never do. */
const ENGINE_ROUTES = new Set(["", "search", "watch", "channel", "playlist"]);
async function ensureEngine(id, name) {
  if (engineReady || !ENGINE_ROUTES.has(name)) return true;
  if (name === "" && store.get("feedCache", null)) return true; // the feed shows its saved copy meanwhile
  await waitForEngine(true);
  engineReady = true;
  return id === renderId;
}

async function route(forceFeed) {
  const id = ++renderId;
  cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  cleanups = [];
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, query = ""] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  const name = parts[0] || "";
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === NAV_KEY[name]));
  window.scrollTo(0, 0);
  try {
    if (!(await ensureEngine(id, name))) return;
    if (name === "") await pageFeed(id, forceFeed === true);
    else if (name === "search") await pageSearch(id, params);
    else if (name === "watch" && parts[1]) await pageWatch(id, parts[1], params);
    else if (name === "channel" && parts[1]) await pageChannel(id, parts[1]);
    else if (name === "playlist" && parts[1]) await pagePlaylist(id, parts[1], params);
    else if (name === "subs") pageSubs();
    else if (name === "later") savedGrid("Watch later", "watchLater", "Nothing here yet. Press “Watch later” on any video.", false);
    else if (name === "liked") savedGrid("Liked videos", "likes", "Nothing liked yet. Press “Like” on a video you enjoy and the feed suggests more like it.", false);
    else if (name === "history") savedGrid("History", "history", "Nothing watched yet.", true);
    else if (name === "downloads") await pageDownloads(id);
    else if (name === "settings") pageSettings();
    else view.replaceChildren(h("p", { class: "empty", text: "Page not found." }));
  } catch (err) {
    if (id === renderId) showError(err, () => route());
  }
}

/* ------------------------------------------------------------------ boot + search box */
document.getElementById("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  sgHide();
  const q = document.getElementById("q").value.trim();
  if (q) location.hash = "#/search?" + new URLSearchParams({ q });
});
const sg = document.getElementById("suggest");
const qInput = document.getElementById("q");
let suggestTimer, sgItems = [], sgActive = -1;
const sgHide = () => { sg.hidden = true; sgActive = -1; };
const sgMark = () => [...sg.children].forEach((el, i) => el.classList.toggle("act", i === sgActive));
function runSearch(q) {
  sgHide();
  qInput.value = q;
  location.hash = "#/search?" + new URLSearchParams({ q });
}
qInput.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = qInput.value.trim();
  if (q.length < 2) return sgHide();
  suggestTimer = setTimeout(async () => {
    try {
      const d = await api("search/suggestions?q=" + enc(q));
      if (qInput.value.trim() !== q || document.activeElement !== qInput) return; // stale answer
      sgItems = (d.suggestions || []).slice(0, 8);
      sgActive = -1;
      sg.replaceChildren(...sgItems.map((t) => h("div", { class: "sg-item", role: "option", text: t })));
      sg.hidden = !sgItems.length;
    } catch { /* suggestions are optional */ }
  }, 220);
});
qInput.addEventListener("keydown", (e) => {
  if (sg.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = sgItems.length;
    sgActive = e.key === "ArrowDown" ? (sgActive + 1 >= n ? -1 : sgActive + 1) : (sgActive <= -1 ? n - 1 : sgActive - 1);
    sgMark();
  } else if (e.key === "Enter" && sgActive >= 0) { e.preventDefault(); runSearch(sgItems[sgActive]); }
  else if (e.key === "Escape") sgHide();
});
qInput.addEventListener("blur", sgHide);
sg.addEventListener("pointerdown", (e) => {
  const it = e.target.closest(".sg-item");
  if (it) { e.preventDefault(); runSearch(it.textContent); }
});
window.addEventListener("hashchange", () => route());
window.addEventListener("focus", async () => {
  if ((await syncFromServer()) && !location.hash.startsWith("#/watch")) route();
});
// push any change made in the last moments before the window goes away
window.addEventListener("pagehide", () => { flushPending(true); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPending(true); });

/* Start-up: WSL and the containers take about 15 s to boot on a cold start. */
async function engineStatus() {
  try { return (await (await fetch("/status")).json()).invidious; } catch { return true; } // old backend: assume ready
}

async function waitForEngine(withSplash) {
  const started = Date.now();
  let slow = null, skip = false;
  for (;;) {
    if (await engineStatus()) return;
    if (withSplash && !slow) {
      slow = h("div", { class: "muted small", hidden: true, style: "margin-top:14px" },
        h("p", { text: "Still waiting. Make sure WSL and Docker started (see the launch guide)." }),
        h("button", { class: "btn", text: "Continue anyway", onclick: () => { skip = true; } }));
      view.replaceChildren(h("div", { class: "empty splash" },
        h("p", {}, h("span", { class: "spin" }), "Starting the engine…"),
        h("p", { class: "small", style: "font-family:system-ui,sans-serif", text: "Booting WSL and the Invidious containers. This takes about 15 seconds on a cold start." }),
        slow));
    }
    if (slow && Date.now() - started > 90000) slow.hidden = false;
    if (skip) return;
    await new Promise((r) => setTimeout(r, 700));
  }
}

(async function boot() {
  applyTheme();
  try { CFG = await (await fetch("/config.json")).json(); BASE = CFG.invidious.replace(/\/$/, ""); } catch { /* keep default */ }
  await syncFromServer();
  applyTheme();
  engineReady = await engineStatus();
  const onHome = !location.hash || location.hash === "#/" || location.hash === "#";
  if (!engineReady && onHome && store.get("feedCache", null)) {
    // There is a saved feed: show it now and let the engine finish booting behind it.
    const banner = h("div", { class: "panel boot-banner" }, h("span", { class: "spin" }), "Starting the engine… thumbnails and playback appear in a few seconds.");
    route();
    view.before(banner);
    await waitForEngine(false);
    engineReady = true;
    banner.remove();
    return route();
  }
  route();
})();
