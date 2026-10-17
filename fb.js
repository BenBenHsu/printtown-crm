// 資料層（Supabase 版）：畫面程式只透過這個檔案存取資料。
// 對外提供和原本 Firebase 版相同的用法，所以畫面與功能不用改。
// 做法：第一次登入下載全部資料並存在這台裝置；之後只下載「有變動的資料」，並用即時通道同步其他同仁的修改。
import { makeApi } from "./sbapi.js";

export const OFFLINE_WRITES = false; // 沒網路時不能存檔（畫面會提醒，資料留在表單裡）
export const FRAME_GUARD = true;     // 不允許被別的網站嵌入（防點擊劫持）
export const PHOTO_HOSTS = [];

const COLS = new Set(["inquiries", "tags", "config", "adspend"]);
let api = null;
const store = new Map();  // "類別/編號" → 資料
const stamp = new Map();  // "類別/編號" → 資料庫更新時間
const subs = new Set();   // 畫面的監聽
let user = null, gen = 0, started = false, denied = null, since = "";
let stopRT = null, pollT = null, pulling = null, persistT = null, emitT = null;
const dirty = new Set();
const clone = d => JSON.parse(JSON.stringify(d === undefined ? null : d));

/* ---------- 設定與登入 ---------- */
// 擋掉「貼錯金鑰」：Secret / service_role 金鑰絕不能放在網頁上，貼了就不啟動
function isSecretKey(k) {
  if (/^sb_secret_/i.test(k)) return true;
  try { const p = JSON.parse(atob(k.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); return p && p.role === "service_role"; } catch (e) { return false; }
}
export function configOk(c) {
  const k = String((c && c.anonKey) || "");
  return !!(c && /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(String(c.url || "")) && k.length > 20 && !/請貼上/.test(k) && !isSecretKey(k));
}
export function initializeApp(c) { api = makeApi(String(c.url).replace(/\/+$/, ""), c.anonKey); return {}; }
export const getAuth = () => ({});
export class GoogleAuthProvider { setCustomParameters() {} }
// 會轉到 Google 登入頁，登入完回到系統
export async function signInWithPopup() { try { await api.signIn(); } catch (e) { throw mapErr(e); } return new Promise(() => {}); }
export const signInWithRedirect = signInWithPopup;
export const getRedirectResult = async () => null;
const mapUser = u => u ? { uid: u.id, email: String(u.email || "").toLowerCase(),
  displayName: (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || u.email } : null;
export function onAuthStateChanged(a, cb) {
  let last;
  const emitU = u => { const k = u ? u.id : ""; if (k === last) return; last = k; stopSync(); user = mapUser(u); cb(user); };
  api.session().then(emitU, () => emitU(null));
  return api.onAuth(emitU);
}
export async function signOut() { stopSync(); try { await api.signOut(); } catch (e) {} }

/* ---------- 和 Firestore 相同的查詢寫法 ---------- */
export const initializeFirestore = () => ({});
export const persistentLocalCache = () => ({});
export const persistentMultipleTabManager = () => ({});
export const collection = (fs, p) => ({ kind: "col", path: p, mods: [] });
export const doc = (fs, c, id) => ({ kind: "doc", path: c + "/" + id, col: c, id: String(id) });
export const query = (c, ...m) => ({ ...c, mods: m });
export const orderBy = (f, d) => ({ t: "o", f, d });
export const limit = n => ({ t: "l", n });
export const arrayUnion = (...v) => ({ __op: "union", v: clone(v) });
export const arrayRemove = (...v) => ({ __op: "remove", v: clone(v) });

const snapDoc = k => { const d = store.get(k); return { id: k.slice(k.indexOf("/") + 1), exists: () => d !== undefined, data: () => d }; };
function run(L) {
  if (L.ref.kind === "doc") { L.next(snapDoc(L.ref.path)); return; }
  const pre = L.ref.path + "/"; let docs = [];
  store.forEach((v, k) => { if (k.startsWith(pre)) docs.push(snapDoc(k)); });
  L.ref.mods.forEach(m => {
    if (m.t === "o") docs.sort((a, b) => { const x = (a.data() || {})[m.f] ?? "", y = (b.data() || {})[m.f] ?? ""; return (x < y ? -1 : x > y ? 1 : 0) * (m.d === "desc" ? -1 : 1); });
    if (m.t === "l") docs = docs.slice(0, m.n);
  });
  L.next({ docs });
}
const colOf = L => L.ref.kind === "doc" ? L.ref.path.split("/")[0] : L.ref.path;
function changed(key) {
  dirty.add(key.split("/")[0]);
  if (!emitT) emitT = setTimeout(() => {
    emitT = null; const cs = new Set(dirty); dirty.clear();
    subs.forEach(L => { if (L.ready && cs.has(colOf(L))) { try { run(L); } catch (e) {} } });
  }, 0);
  schedulePersist();
}
export function onSnapshot(ref, next, err) {
  const L = { ref, next, err, ready: false };
  subs.add(L);
  if (denied) { setTimeout(() => err && err(denied), 0); }
  else if (started && L.ref) { if (synced) { L.ready = true; setTimeout(() => run(L), 0); } }
  else ensureSync();
  return () => subs.delete(L);
}

/* ---------- 同步 ---------- */
let synced = false;
function mapErr(e) {
  const c = String((e && e.code) || ""), m = String((e && e.message) || "");
  if (c === "42501" || c === "P0001" || c === "PGRST301" || /row-level security|permission|JWT/i.test(m)) return { code: "permission-denied", message: m };
  if (c === "P0002") return { code: "not-found", message: "找不到這筆資料" };
  if ((e && e.name === "TypeError") || /Failed to fetch|NetworkError|Load failed/i.test(m)) return { code: "unavailable", message: "網路連線中斷，請稍後再試" };
  return { code: c || "unknown", message: m || "請稍後再試" };
}
function failAll(e) { subs.forEach(L => { if (L.err) try { L.err(e); } catch (x) {} }); }
let verified = false, retryT = null;
const showAll = () => { synced = true; subs.forEach(L => { L.ready = true; run(L); }); };
async function ensureSync() {
  if (started || !user) return;
  started = true; const g = ++gen;
  let me = null;
  try { me = await api.me(); }
  catch (e) {
    if (g !== gen) return;
    const m = mapErr(e);
    // 沒網路：先顯示這台裝置上次存的資料（只能看），連上網路後自動確認身分並同步
    if (m.code === "unavailable") {
      await loadCache(g); if (g !== gen) return;
      if (store.size) { showAll(); }
      else failAll(m);
      started = false; clearTimeout(retryT); retryT = setTimeout(() => { if (!started) ensureSync(); }, 30000);
      return;
    }
    started = false; failAll(m); return;
  }
  if (g !== gen) return;
  if (!me || !me.staff) { denied = { code: "permission-denied" }; store.clear(); stamp.clear(); await clearIndexedDbPersistence(); failAll(denied); return; }
  verified = true;
  if (!store.size) { await loadCache(g); if (g !== gen) return; }
  if (store.size) showAll();
  try { await pull(g); } catch (e) { if (!store.size) { failAll(mapErr(e)); return; } }
  if (g !== gen) return;
  showAll();
  stopRT = api.subscribe(r => { if (r) applyRow(r); else pull(g).catch(() => {}); }, d => applyDel(d),
    s => { if (s === "SUBSCRIBED") pull(g).catch(() => {}); });
  pollT = setInterval(() => { if (navigator.onLine) pull(g).catch(() => {}); }, 60000);
}
window.addEventListener("online", () => { if (!started && user) ensureSync(); else if (started && synced) pull(gen).catch(() => {}); });
function stopSync() {
  gen++; started = false; synced = false; denied = null; since = ""; verified = false; clearTimeout(retryT); pend.clear();
  if (stopRT) { stopRT(); stopRT = null; }
  if (pollT) { clearInterval(pollT); pollT = null; }
  store.clear(); stamp.clear();
}
const later = (a, b) => !b || (a && Date.parse(a) > Date.parse(b));
function applyRow(r) {
  if (!r || !COLS.has(r.col) || typeof r.id !== "string") return;
  const k = r.col + "/" + r.id;
  if (stamp.has(k) && r.updated_at && later(stamp.get(k), r.updated_at)) return; // 舊的通知晚到，略過
  store.set(k, r.data && typeof r.data === "object" ? r.data : {});
  if (r.updated_at) { stamp.set(k, r.updated_at); if (later(r.updated_at, since)) since = r.updated_at; }
  changed(k);
}
function applyDel(d) {
  if (!d || !COLS.has(d.col)) return;
  const k = d.col + "/" + d.id;
  if (d.deleted_at && stamp.has(k) && later(stamp.get(k), d.deleted_at)) return; // 刪除後又重新建立
  if (store.delete(k)) { stamp.delete(k); changed(k); }
}
async function pull(g) {
  if (pulling) return pulling;
  if (!verified) return;
  pulling = (async () => {
    try {
      // 往前多抓 1 分鐘，避免時間差漏掉資料（重複抓到不影響）
      const s0 = since ? new Date(Date.parse(since) - 60000).toISOString() : "";
      let cur = s0 ? { t: s0, c: "", i: "" } : null;
      for (;;) {
        const rows = await api.changes(cur);
        if (g !== gen) return;
        rows.forEach(applyRow);
        if (rows.length < 1000) break;
        const L = rows[rows.length - 1]; cur = { t: L.updated_at, c: L.col, i: L.id };
      }
      if (s0) {
        let dc = { t: s0, c: "", i: "" };
        for (;;) {
          const dels = await api.deletions(dc);
          if (g !== gen) return;
          dels.forEach(applyDel);
          if (dels.length < 1000) break;
          const L = dels[dels.length - 1]; dc = { t: L.deleted_at, c: L.col, i: L.id };
        }
      }
    } finally { pulling = null; }
  })();
  return pulling;
}

/* ---------- 這台裝置上的資料副本（下次打開不用全部重新下載）---------- */
const IDB = "pt-crm-cache", OS = "kv";
function idb() { return new Promise((res, rej) => { try { const r = indexedDB.open(IDB, 1); r.onupgradeneeded = () => r.result.createObjectStore(OS); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); }
const cacheKey = () => "v1:" + (user ? user.email : "");
async function loadCache(g) {
  try {
    const db = await idb();
    const v = await new Promise((res, rej) => { const q = db.transaction(OS).objectStore(OS).get(cacheKey()); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    if (g !== gen || !v || !Array.isArray(v.docs)) return;
    v.docs.forEach(([k, d, t]) => { if (COLS.has(String(k).split("/")[0])) { store.set(k, d); if (t) stamp.set(k, t); } });
    since = v.since || "";
  } catch (e) {}
}
function schedulePersist() {
  clearTimeout(persistT);
  persistT = setTimeout(async () => {
    if (!user || !synced) return;
    try {
      const db = await idb(); const docs = [];
      store.forEach((d, k) => { if (!pend.has(k)) docs.push([k, d, stamp.get(k) || ""]); });
      pend.forEach((p, k) => { if (p.had) docs.push([k, p.prev, p.stamp || ""]); }); // 還沒確認的修改不存，存上次確認過的版本
      db.transaction(OS, "readwrite").objectStore(OS).put({ since, docs, at: Date.now() }, cacheKey());
    } catch (e) {}
  }, 800);
}
export async function terminate() { stopSync(); }
export async function clearIndexedDbPersistence() {
  clearTimeout(persistT);
  await new Promise(res => { try { const r = indexedDB.deleteDatabase(IDB); r.onsuccess = r.onerror = r.onblocked = () => res(); } catch (e) { res(); } });
}

/* ---------- 寫入（先更新畫面，資料庫拒絕時還原）---------- */
const pend = new Map(); // 還在等資料庫確認的資料：保留上次確認過的版本
function localSet(k, d) {
  const had = store.has(k), prev = store.get(k), st = stamp.get(k);
  if (!pend.has(k)) pend.set(k, { had, prev, stamp: st, n: 0 });
  pend.get(k).n++;
  store.set(k, d); changed(k);
  return {
    ok() { const p = pend.get(k); if (p && --p.n <= 0) pend.delete(k); schedulePersist(); },
    undo() {
      const p = pend.get(k); if (p && --p.n <= 0) pend.delete(k);
      // 送出期間別人已經更新了這筆（收到較新的版本），就不要還原成舊資料
      if (stamp.get(k) !== st) { changed(k); return; }
      if (had) store.set(k, prev); else store.delete(k); changed(k);
    }
  };
}
export async function setDoc(ref, d) {
  const data = clone(d);
  const w = localSet(ref.path, data);
  try { await api.upsert(ref.col, ref.id, data); w.ok(); } catch (e) { w.undo(); throw mapErr(e); }
}
export async function updateDoc(ref, patch) {
  const set = {}, uni = {}, rem = {};
  Object.keys(patch || {}).forEach(k => {
    const v = patch[k];
    if (v && v.__op === "union") uni[k] = v.v;
    else if (v && v.__op === "remove") rem[k] = v.v;
    else set[k] = v === undefined ? null : clone(v);
  });
  const cur = store.get(ref.path);
  let undo = null;
  if (cur !== undefined) {
    const next = Object.assign({}, cur, set);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    Object.keys(uni).forEach(k => { const a = Array.isArray(next[k]) ? next[k].slice() : []; uni[k].forEach(x => { if (!a.some(y => same(x, y))) a.push(x); }); next[k] = a; });
    Object.keys(rem).forEach(k => { const a = Array.isArray(next[k]) ? next[k] : []; next[k] = a.filter(y => !rem[k].some(x => same(x, y))); });
    undo = localSet(ref.path, next);
  }
  try { await api.patch(ref.col, ref.id, set, uni, rem); if (undo) undo.ok(); } catch (e) { if (undo) undo.undo(); throw mapErr(e); }
}
export async function deleteDoc(ref) {
  const had = store.has(ref.path), prev = store.get(ref.path);
  if (had) { store.delete(ref.path); changed(ref.path); }
  try { await api.del(ref.col, ref.id); }
  catch (e) { if (had) { store.set(ref.path, prev); changed(ref.path); } throw mapErr(e); }
}

/* ---------- 照片 ---------- */
export const getStorage = () => ({});
export async function uploadPhoto(st, path, blob, onProgress) {
  onProgress && onProgress(0.3);
  let url; try { url = await api.upload(path, blob); } catch (e) { throw mapErr(e); }
  onProgress && onProgress(1);
  return { path, url };
}
export async function deletePhoto(st, path) { try { await api.removeFile(path); } catch (e) { throw mapErr(e); } }
// 照片網址只接受本系統照片資料夾
export function photoUrlOk(x) { return !!(api && x && String(x.href).startsWith(api.photoPrefix)); }
