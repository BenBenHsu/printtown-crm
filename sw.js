// 離線快取：讓 App 在沒網路時也能打開（資料由 Firestore 自己的離線快取負責）
// 每次改版請把版本號 +1，同仁下次開啟就會拿到新版
const VERSION = "pt-crm-v31";
const SHELL = ["./", "index.html", "styles.css", "app.js", "fb.js", "sbapi.js", "vendor/supabase.js", "fields.js", "config.js",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 只快取自己的網站與 Firebase 程式庫；不快取資料庫、登入或其他網站的回應
  const cacheable = url.origin === location.origin; // 只快取自己的網站檔案；資料庫與登入一律不快取
  if (!cacheable || url.search || url.pathname.startsWith("/__/")) return; // 帶參數的網址（例如登入回傳）不快取
  // 網路優先，失敗才用快取：有網路時永遠拿到最新版
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok && res.type !== "opaque") {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(r => r || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
