// Supabase 連線（只有這個檔案直接呼叫 Supabase；畫面程式透過 fb.js 使用）
import { createClient } from "./vendor/supabase.js";

const BUCKET = "crm-photos";

const qv = v => '"' + String(v).replace(/["\\]/g, "") + '"';
// cur = { t: 時間, c: 類別, i: 編號 }；回傳排在 cur 之後的 1000 筆
function after(q, tcol, cur) {
  q = q.order(tcol, { ascending: true }).order("col").order("id").limit(1000);
  if (cur && cur.t) q = q.or(`${tcol}.gt.${qv(cur.t)},and(${tcol}.eq.${qv(cur.t)},col.gt.${qv(cur.c || "")}),and(${tcol}.eq.${qv(cur.t)},col.eq.${qv(cur.c || "")},id.gt.${qv(cur.i || "")})`);
  return q;
}

export function makeApi(url, anonKey) {
  const sb = createClient(url, anonKey, {
    // 獨立的登入資料名稱：和放在同一個網域的設備維護系統分開，登出互不影響
    auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true, storageKey: "pt-crm-auth" }
  });
  const chk = ({ data, error }) => { if (error) throw error; return data; };
  return {
    async session() { const { data } = await sb.auth.getSession(); return (data.session && data.session.user) || null; },
    onAuth(cb) { const { data } = sb.auth.onAuthStateChange((ev, s) => cb((s && s.user) || null)); return () => data.subscription.unsubscribe(); },
    async signIn() {
      chk(await sb.auth.signInWithOAuth({ provider: "google",
        options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } } }));
    },
    async signOut() { await sb.auth.signOut(); },
    async me() { return chk(await sb.rpc("crm_me")); },
    // 依「時間＋類別＋編號」接續往下讀（不用頁碼），讀的同時有人修改也不會漏掉資料
    async changes(cur) { return chk(await after(sb.from("crm_docs").select("col,id,data,updated_at"), "updated_at", cur)); },
    async deletions(cur) { return chk(await after(sb.from("crm_deleted").select("col,id,deleted_at"), "deleted_at", cur)); },
    async upsert(col, id, data) { chk(await sb.from("crm_docs").upsert({ col, id, data }, { onConflict: "col,id" })); },
    async patch(col, id, set, union, remove) {
      chk(await sb.rpc("crm_patch", { p_col: col, p_id: id, p_set: set, p_union: union, p_remove: remove }));
    },
    async del(col, id) {
      const rows = chk(await sb.from("crm_docs").delete().eq("col", col).eq("id", id).select("id"));
      if (!rows || !rows.length) throw { code: "42501", message: "沒有權限" };
    },
    subscribe(onRow, onDel, onStatus) {
      const ch = sb.channel("crm-sync-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6))
        .on("postgres_changes", { event: "*", schema: "public", table: "crm_docs" },
          p => { if (p.eventType === "DELETE") onDel(p.old);
                 else if ((p.errors && p.errors.length) || !p.new || !("data" in p.new)) onRow(null); // 資料太大沒帶過來：改為重新下載
                 else onRow(p.new); })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "crm_deleted" }, p => onDel(p.new))
        .subscribe(s => onStatus && onStatus(s));
      return () => { try { sb.removeChannel(ch); } catch (e) {} };
    },
    async upload(path, blob) {
      chk(await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false }));
      return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    },
    async removeFile(path) { chk(await sb.storage.from(BUCKET).remove([path])); },
    photoPrefix: url.replace(/\/+$/, "") + "/storage/v1/object/public/" + BUCKET + "/inquiries/"
  };
}
