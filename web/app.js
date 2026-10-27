"use strict";
/* Personal YouTube interface. Plain JS, no build step. Talks only to the local backend (same origin)
   for data and to Invidious/companion (address from /config.json) for thumbnails and streams. */

/* ------------------------------------------------------------------ helpers */
const view = document.getElementById("view");
let BASE = "http://localhost:3000";
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
  set(key, val) {
    mem[key] = val;
    try { localStorage.setItem("yt." + key, JSON.stringify(val)); } catch { /* ignore */ }
  },
};

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
    h("img", { src: thumbUrl(id), loading: "lazy", alt: "", width: 320, height: 180 }),
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
  if (!list.length) {
    view.append(h("div", { class: "empty" },
      h("p", { text: "Your feed is empty, for now." }),
      h("p", { class: "small", style: "font-family:system-ui,sans-serif", text: "Search for a channel you like, open it and press Subscribe. New videos from your channels show up here." }),
      h("p", {}, h("button", { class: "btn primary", text: "Start searching", onclick: () => document.getElementById("q").focus() }))));
    return;
  }
  const sig = list.map((s) => s.ucid).sort().join(",");
  let cache = store.get("feedCache", null);
  const fresh = cache && cache.sig === sig && Date.now() - cache.at < 20 * 60 * 1000;
  let items;
  if (fresh && !force) items = cache.items;
  else {
    const status = h("p", { class: "muted", text: `Loading 0/${list.length} channels…` });
    view.append(status);
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
      status.textContent = `Loading ${done}/${list.length} channels…`;
    }
    items = all.filter((v) => v.videoId).sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, 80);
    if (items.length) store.set("feedCache", { sig, at: Date.now(), items });
    status.remove();
  }
  const head = view.querySelector("h1");
  head.after(h("div", { class: "row" },
    h("span", { class: "muted small", text: `Latest from your ${list.length} channel${list.length === 1 ? "" : "s"} · ` + (cache && fresh && !force ? "saved copy, refreshes every 20 minutes" : "just updated") }),
    h("span", { class: "spacer" }),
    h("button", { class: "btn", text: "Refresh", onclick: () => { store.set("feedCache", null); route(true); } })));
  view.append(items.length ? h("div", { class: "grid" }, items.map((v) => videoCard(v))) : h("p", { class: "empty", text: "No videos found. Invidious may be unreachable." }));
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
  const useGrid = cards.every((_, i) => data[i] && data[i].type === "video");
  body.replaceWith(cards.length ? h("div", { class: useGrid ? "grid" : "list" }, cards) : h("p", { class: "empty", text: "Nothing found." }));
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
  let idx = -1, dp = null, el = null, resumed = false, lastSave = 0;
  const label = { file: "Playing your downloaded file (no network)", dash: `Adaptive stream, capped at ${quality}`, itag18: "360p stream", embed: "Embedded Invidious player" };

  const teardown = () => {
    if (dp) { try { dp.destroy(); } catch { /* already gone */ } dp = null; }
    if (el && el.pause) { try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* ignore */ } }
    box.replaceChildren();
  };
  const next = (why) => {
    if (why) console.warn("player tier failed:", tiers[idx], why);
    teardown();
    idx++;
    const tier = tiers[idx];
    if (!tier) { note.textContent = "No playback source worked. Check that the stack is running, then reload."; return; }
    note.textContent = label[tier] + (idx > 0 && why ? " (fallback)" : "");
    if (tier === "embed") {
      el = h("iframe", { src: `${BASE}/embed/${id}?autoplay=1`, allow: "autoplay; fullscreen; picture-in-picture", allowfullscreen: true });
      box.append(el);
      return;
    }
    el = h("video", { controls: true, autoplay: true, playsinline: true, preload: "metadata" });
    resumed = false;
    el.addEventListener("error", () => next("media error"));
    el.addEventListener("loadedmetadata", () => {
      if (!resumed && position > 10 && el.duration && position < el.duration - 15) el.currentTime = position;
      resumed = true;
    });
    el.addEventListener("timeupdate", () => {
      if (el.currentTime - lastSave > 5 || el.currentTime < lastSave) { lastSave = el.currentTime; onTime(el.currentTime); }
    });
    el.addEventListener("ended", onEnded);
    box.append(el);
    if (tier === "file") el.src = "/files/" + enc(file);
    else if (tier === "itag18") el.src = `${BASE}/latest_version?id=${id}&itag=18&local=true`;
    else if (tier === "dash") {
      loadDash().then(() => {
        if (el.parentNode !== box) return;
        dp = dashjs.MediaPlayer().create();
        dp.updateSettings({ streaming: { retryAttempts: { MPD: 1 } } });
        dp.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
          try {
            const reps = dp.getRepresentationsByType ? dp.getRepresentationsByType("video") : dp.getBitrateInfoListFor("video");
            const cap = QUALITY_CAP[quality] || 720;
            const ok = reps.filter((r) => r.height && r.height <= cap).map((r) => r.bandwidth || r.bitrate);
            if (ok.length) dp.updateSettings({ streaming: { abr: { maxBitrate: { video: Math.round(Math.max(...ok) / 1000) } } } });
          } catch (e) { console.warn("quality cap not applied", e); }
        });
        dp.on(dashjs.MediaPlayer.events.ERROR, (e) => next(e && e.error ? e.error.message : "dash error"));
        dp.initialize(el, `${BASE}/api/manifest/dash/id/${id}?local=true`, true);
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
      subBtn, h("span", { class: "spacer" }), laterBtn, dlBtn),
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
  view.append(h("div", { class: "grid" }, list.map((v) => videoCard({ videoId: v.id, title: v.title, author: v.author, authorId: v.authorId, lengthSeconds: v.lengthSeconds, published: v.watchedAt ? v.watchedAt / 1000 : 0 },
    key === "watchLater" ? h("button", { class: "btn small", text: "Remove", onclick: () => { toggleLater(v); savedGrid(title, key, emptyText, withClear); } }) : null))));
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
        h("p", { class: "muted small", text: "Subscriptions, history, watch later and settings live only in this browser. Export them regularly." }),
        h("div", { class: "row" },
          h("button", { class: "btn", text: "Export JSON", onclick: () => {
            const data = { version: 1, subscriptions: subs(), history: store.get("history", []), watchLater: watchLater(), settings: settings() };
            const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })), download: `mytube-backup-${new Date().toISOString().slice(0, 10)}.json` });
            document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          } }),
          h("button", { class: "btn", text: "Import JSON", onclick: () => importInput.click() }), importInput)),
      h("div", { class: "panel" },
        h("strong", { text: "Connection" }),
        h("p", { class: "muted small", text: `Invidious address used by the player: ${BASE}` }),
        h("div", { class: "row" }, h("button", { class: "btn", text: "Check Invidious", onclick: async () => {
          status.textContent = "checking…";
          try { await api("search/suggestions?q=test"); status.textContent = "Invidious is reachable"; } catch (e) { status.textContent = "Not reachable: " + e.message; }
        } }), status))));
}

/* ---------------------------------------------------------------------- router */
const NAV_KEY = { "": "feed", search: "", watch: "", channel: "", playlist: "", subs: "subs", later: "later", history: "history", downloads: "downloads", settings: "settings" };

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
    if (name === "") await pageFeed(id, forceFeed === true);
    else if (name === "search") await pageSearch(id, params);
    else if (name === "watch" && parts[1]) await pageWatch(id, parts[1], params);
    else if (name === "channel" && parts[1]) await pageChannel(id, parts[1]);
    else if (name === "playlist" && parts[1]) await pagePlaylist(id, parts[1], params);
    else if (name === "subs") pageSubs();
    else if (name === "later") savedGrid("Watch later", "watchLater", "Nothing here yet. Press “Watch later” on any video.", false);
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

(async function boot() {
  applyTheme();
  try { CFG = await (await fetch("/config.json")).json(); BASE = CFG.invidious.replace(/\/$/, ""); } catch { /* keep default */ }
  route();
})();
