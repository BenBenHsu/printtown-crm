// ============================================================
// 普印通案件追蹤：設定檔（Supabase 版）
// 只要改這個檔案。網址和金鑰在 Supabase → Project Settings → API Keys / Data API。
// 金鑰請貼「Publishable key」（sb_publishable_ 開頭）或舊版「anon public」（eyJ 開頭），
// 這把可以公開在網頁上。絕對不要貼「Secret key」（sb_secret_ 開頭）或「service_role」。
// 最簡單：和「設備維護系統」用的是同一組網址和金鑰，直接照抄即可。
// ============================================================
window.PT_CONFIG = {
  // 系統擁有者的 Google 帳號（全部小寫，要和 crm_setup.sql 裡的一致）
  adminEmail: "oface007@gmail.com",

  supabase: {
    url: "請貼上 Project URL，例如 https://abcdefgh.supabase.co",
    anonKey: "請貼上 Publishable key 或 anon public key"
  }
};
