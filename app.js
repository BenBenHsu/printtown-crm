// 普印通案件追蹤 v2 — 主程式（欄位可自訂）
import * as F from "./fb.js";
export const APP_VERSION="v3.7";
import { GROUPS, TYPES, DEFAULT_FIELDS, PRIMARY_LINE, GROUP_RENAME, LOST_REASONS, OLD_LOST, LOST_RENAME, NEXT_ACTIONS, FIELDS_REV, LINE_RENAME, SERVICE_RENAME, ODOR_RENAME } from "./fields.js";

// 防點擊劫持：被別的網站用框架嵌入時，不顯示內容並跳回自己的網址
if(F.FRAME_GUARD&&window.top!==window.self){document.documentElement.style.display="none";try{window.top.location.replace(window.self.location.href)}catch(e){}throw new Error("framed")}
const CFG = window.PT_CONFIG || {};
const ADMIN = String(CFG.adminEmail || "").trim().toLowerCase();

const STAGES = [
  {k:"新詢問",c:"s-new",open:true},{k:"已聯繫",c:"s-contact",open:true},{k:"場勘/檢測",c:"s-visit",open:true},
  {k:"已報價",c:"s-quote",open:true},{k:"議價中",c:"s-nego",open:true},{k:"成交",c:"s-won",open:false},{k:"未成交",c:"s-lost",open:false}];
const STAGE_MAP = Object.fromEntries(STAGES.map(s=>[s.k,s]));
const isOpen = s => !!(STAGE_MAP[s]||{}).open;
const DEFAULT_OPT = {
  services:[
    {line:"事務機",name:"事務機租賃（含零元機）"},{line:"事務機",name:"耗材／維修"},
    {line:"異味處理",name:"異味處理"},{line:"異味處理",name:"空品檢測"},{line:"異味處理",name:"設備租賃（臭氧機／清淨機）"},
    {line:"異味處理",name:"除味液"},{line:"異味處理",name:"全身除味機"},{line:"異味處理",name:"其他"}],
  methods:["電話","LINE／Email","現場拜訪","客戶關懷"]
};
// 不能在表單直接編輯的欄位（由系統處理）
const NOT_IN_FORM = new Set(["code"]);
const LIST_SKIP_TYPES = new Set(["long","date","num","money","phone","email","file","auto","tags"]);
// 標籤 12 色（只存顏色代碼，畫面用固定色票，避免寫入任意 CSS）
const TAG_COLORS=[["red","紅"],["orange","橘"],["amber","琥珀"],["yellow","黃"],["lime","萊姆"],["green","綠"],["teal","青綠"],["cyan","青"],["blue","藍"],["indigo","靛"],["purple","紫"],["pink","粉"]];
const TAG_KEYS=new Set(TAG_COLORS.map(c=>c[0]));
const TAG_MAX=60, TAG_NAME_MAX=12;

const S = {raw:{},admins:[],meta:{},inq:[],opt:DEFAULT_OPT,fields:DEFAULT_FIELDS.map(f=>({...f})),groups:GROUPS.slice(),members:[],ad:{},user:null,email:"",isAdmin:false,
  rules:null,rulesLoaded:false,tags:[],view:"list",f:{stage:"open",owner:"",line:"",tags:[],q:""},tagEditId:"",listN:12,range:"90",me:"",unsubs:[],byField:"industry",setTab:"fields"};
let fs=null, auth=null, st=null;
const INQ_LIMIT=20000;
// 列表一次顯示 200 筆（資料很多時畫面不會卡住），按「顯示更多」再載入
const LIST_PAGE=12;      // 列表一次只顯示 12 筆，其餘收起來
const LIST_MORE=200;     // 展開時一次多顯示的筆數（大量資料時保持順暢）

/* ---------- helpers ---------- */
// 標籤
const cleanTag=t=>{if(!t||typeof t!=="object")return null;const id=String(t.id||"");if(!/^t_[a-z0-9]{4,24}$/.test(id))return null;
  const name=String(t.name||"").replace(/\s+/g," ").trim().slice(0,TAG_NAME_MAX);if(!name)return null;
  return {id,name,color:TAG_KEYS.has(t.color)?t.color:"blue",o:+t.o||0}};
const tagById=id=>S.tags.find(t=>t.id===id);
const tagName=id=>{const t=tagById(id);return t?t.name:""};
const tagChip=t=>`<span class="tg" data-c="${esc(t.color)}">${esc(t.name)}</span>`;
const tagChips=ids=>(Array.isArray(ids)?ids:[]).map(tagById).filter(Boolean).map(tagChip).join("");
const nextTagColor=()=>{const used=new Set(S.tags.map(t=>t.color));const f=TAG_COLORS.find(c=>!used.has(c[0]));return f?f[0]:TAG_COLORS[S.tags.length%12][0]};
// 每個標籤一份資料（tags/{id}）：兩人同時改不同標籤不會互相覆蓋；刪除權限由資料庫規則把關（只有管理者）
function saveTag(t,msg){
  const c=cleanTag(t);if(!c)return false;
  const cur=tagById(c.id),o=cur&&cur.o!=null?cur.o:Date.now();
  const doc={name:c.name,color:c.color,o,updatedAt:new Date().toISOString(),by:S.email};
  const i=S.tags.findIndex(x=>x.id===c.id);if(i>=0)S.tags[i]={...c,o};else S.tags.push({...c,o});
  return write(F.setDoc(F.doc(fs,"tags",c.id),doc),msg);
}
function deleteTag(id,msg){S.tags=S.tags.filter(t=>t.id!==id);return write(F.deleteDoc(F.doc(fs,"tags",id)),msg)}
// 照片連結只接受自家檔案儲存的網址，避免被寫入釣魚連結
const PHOTO_HOSTS=Array.isArray(F.PHOTO_HOSTS)?F.PHOTO_HOSTS:null;
function safeUrl(u){
  u=String(u||"");
  if(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(u))return u;
  if(/^blob:/.test(u))return u;
  let x;try{x=new URL(u,location.href)}catch(e){return ""}
  if(x.protocol!=="https:"&&!(x.protocol==="http:"&&x.hostname==="localhost"))return "";
  if(x.host===location.host)return x.href;
  if(typeof F.photoUrlOk==="function")return F.photoUrlOk(x)?x.href:""; // 只接受本系統照片資料夾
  if(PHOTO_HOSTS===null)return x.href; // 試用版：照片存在 claude.ai 頁面檔案庫
  if(!PHOTO_HOSTS.includes(x.hostname))return "";
  const bucket=String((CFG.firebase||{}).storageBucket||"");
  if(bucket&&x.hostname==="firebasestorage.googleapis.com"&&!x.pathname.startsWith("/v0/b/"+bucket+"/o/inquiries%2F"))return "";
  return x.href;
}
// 讀進來的案件資料整理成固定型態，避免單筆資料格式錯誤讓整個畫面壞掉
// 舊資料格式不對的欄位，下次修改時順便寫回正確格式（否則資料庫規則會擋下修改）
const withFix=(r,upd)=>{(r&&r._fix||[]).forEach(k=>{if(k==="followups"){if(!Array.isArray(upd.followups))upd.followups=r.followups}else if(!(k in upd))upd[k]=r[k]});return upd};
const ARR_KEYS=["services","followups","tags","odorType","machineType","features","quotes"];
function normInq(r){
  const fix=[];
  ARR_KEYS.forEach(k=>{if(r[k]!=null&&!Array.isArray(r[k])){r[k]=typeof r[k]==="string"&&r[k]?[r[k]]:[];fix.push(k)}});
  r.followups=(r.followups||[]).map(f=>f&&typeof f==="object"?f:{at:"",by:"",method:"",note:String(f==null?"":f)});
  if(fix.length)Object.defineProperty(r,"_fix",{value:fix,enumerable:false});
  ["date","code","stage","owner","company","contact","phone","nextDate","nextAction","quoteDate","wonDate","closedAt","reopenedAt","effectDate","warrantyDate","lostReason","visit"].forEach(k=>{if(r[k]!=null&&typeof r[k]!=="string")r[k]=String(r[k])});
  // v3.1 選項改名：舊資料顯示成新名稱（下次儲存時寫入新名稱）
  if(Array.isArray(r.odorType))r.odorType=[...new Set(r.odorType.map(x=>ODOR_RENAME[x]||x))];
  if(Array.isArray(r.services))r.services=[...new Set(r.services.map(x=>SERVICE_RENAME[x]||x))];
  if(r.custType!=="個人"&&r.custType!=="公司")r.custType=r.company==="個人"?"個人":"公司";
  if(r.lostReason&&LOST_RENAME[r.lostReason])r.lostReason=LOST_RENAME[r.lostReason];
  return r;
}
const $ = s => document.querySelector(s);
document.querySelectorAll(".top .logo small").forEach(e=>{e.textContent="詢價・跟進・來源 · "+APP_VERSION;e.title="程式版本 "+APP_VERSION});
const esc = v => String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2,"0");
const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const today = () => ymd(new Date());
const nowStamp = () => {const d=new Date();return ymd(d)+" "+pad(d.getHours())+":"+pad(d.getMinutes())};
const money = n => (n==null||n===""||isNaN(n))?"—":"$"+Math.round(+n).toLocaleString("zh-TW");
const pct = (a,b) => b?Math.round(a/b*100)+"%":"—";
const lineOf = name => {const s=S.opt.services.find(x=>x.name===name);return s?s.line:"其他"};
const lines = () => [...new Set(S.opt.services.map(s=>s.line))];
const linesOfRec = r => new Set((r.services||[]).map(lineOf));
const shortDate = s => s?s.slice(5).replace("-","/"):"";
const staff = () => {const n=S.members.map(m=>m.name).filter(Boolean);if(S.me&&!n.includes(S.me))n.unshift(S.me);return n};
const newId = () => Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const fld = id => S.fields.find(f=>f.id===id);
// 客戶顯示名稱：個人客戶顯示「聯絡人（個人）」，公司沒填名稱就顯示聯絡人
const custName = r => r.company==="個人"?((r.contact||"")?r.contact+"（個人）":"個人"):(r.company||r.contact||"（未填客戶）");
const on = id => {const f=fld(id);return !!(f&&f.enabled)};
function optionsOf(f){
  if(f.id==="stage")return STAGES.map(s=>s.k);
  if(f.id==="owner")return staff();
  if(f.id==="services")return S.opt.services.map(s=>s.name);
  return f.options||[];
}
async function compressImage(file,max=1600,q=.75){
  let src;try{src=await createImageBitmap(file,{imageOrientation:"from-image"})}catch(e){
    src=await new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>rej(new Error("無法讀取這張圖片"));im.src=URL.createObjectURL(file)})}
  const w=src.width,h=src.height,k=Math.min(1,max/Math.max(w,h));
  const c=document.createElement("canvas");c.width=Math.round(w*k);c.height=Math.round(h*k);
  c.getContext("2d").drawImage(src,0,0,c.width,c.height);
  return await new Promise(res=>c.toBlob(b=>res(b),"image/jpeg",q));
}
function toast(msg){const t=$("#toast");t.textContent=msg;t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,2600)}
function dueState(r){
  if(!isOpen(r.stage))return "closed";
  if(!r.nextDate)return "none";
  const t=today();return r.nextDate<t?"overdue":r.nextDate===t?"today":"later";
}
function banner(msg){const b=$("#dbBanner");if(msg){b.textContent=msg;b.hidden=false}else b.hidden=true}
function errText(e){
  const c=e&&e.code||"";
  if(String(c).includes("permission-denied"))return "沒有權限，或資料格式不符合規則（例如文字太長）。若一直出現，請聯絡管理者";
  if(String(c).includes("unavailable"))return "目前沒有網路，請連上網路後再按一次儲存（內容還在表單裡）";
  if(String(c).includes("not-found"))return "找不到這筆資料，可能已被管理者刪除";
  if(String(c).includes("resource-exhausted"))return "今日用量已達上限，請明天再試或升級雲端方案";
  return (e&&e.message)||"請稍後再試";
}
function write(p,okMsg){if(okMsg)toast(okMsg);Promise.resolve(p).catch(e=>toast("儲存失敗："+errText(e)));return true}
function fmtVal(f,v){
  if(v==null||v===""||(Array.isArray(v)&&!v.length))return "";
  if(f.type==="tags")return (Array.isArray(v)?v:[]).map(tagName).filter(Boolean).join("、");
  if(f.type==="money")return money(v);
  if(Array.isArray(v))return v.join("、");
  return String(v);
}
// 合併資料庫中的欄位設定與程式預設（新版加入的預設欄位會自動補上）
// v2.7：舊設定裡的「異味／空品專屬」「報價與結果」自動搬到新區塊，需求內容套用新的精簡預設
const isOldLayout=saved=>Array.isArray(saved)&&saved.some(x=>GROUP_RENAME[typeof x==="string"?x:x&&x.group]);
const REMOVED_FIELDS=["odorPlace"]; // 已取消的欄位：舊設定裡有也不再出現
const FIELD_ID_OK=/^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FIELD_TYPES_OK=new Set(Object.keys(TYPES).concat(["tags"]));
// v3.1：舊的欄位設定自動套用新選項、加入「本案總結」新欄位（只做一次；管理者存過欄位設定後就以設定為準）
const SUM_NEW=["deodorPeriod","effectDate","warrantyDate","closeNote"];
function migrate31(saved){
  saved=saved.map(f=>{
    if(f.id==="odorType"){let o=f.options.map(x=>x==="其他"?"其他異味":x);
      if(!o.includes("廁所／沼氣")){const i=o.indexOf("其他異味");i<0?o.push("廁所／沼氣"):o.splice(i,0,"廁所／沼氣")}
      return {...f,options:o}}
    if(f.id==="lostReason"){const extra=f.options.filter(x=>!OLD_LOST.includes(x)&&!LOST_REASONS.includes(x));
      return {...f,options:[...LOST_REASONS.filter(x=>x!=="其他"),...extra,"其他"]}}
    if(f.id==="nextAction")return {...f,type:"one",options:f.options.length?f.options:NEXT_ACTIONS.slice()};
    if(f.id==="nextDate")return {...f,desc:DEFAULT_FIELDS.find(d=>d.id==="nextDate").desc};
    return f});
  const have=new Set(saved.map(f=>f.id));
  let at=saved.findIndex(f=>f.id==="wonDate");if(at<0)at=saved.findIndex(f=>f.id==="wonAmount");
  SUM_NEW.filter(id=>!have.has(id)).forEach(id=>{const d=DEFAULT_FIELDS.find(x=>x.id===id);
    const g=(saved[at]&&saved[at].group)||d.group;const nf={...d,group:g};
    if(at<0)saved.push(nf);else{saved.splice(++at,0,nf)}});
  return saved;
}
// v3.3：報價區塊改成「使用設備數量 → 專員到場 → 報價金額（自動算）」
function migrate32(saved){
  const D=id=>DEFAULT_FIELDS.find(d=>d.id===id);
  saved=saved.map(f=>f.id==="equipQty"?{...f,enabled:true,desc:D("equipQty").desc}:f.id==="quoteAmount"?{...f,desc:D("quoteAmount").desc}:f);
  if(!saved.some(f=>f.id==="visit")){const i=saved.findIndex(f=>f.id==="equipQty");const v={...D("visit"),group:(saved[i]||{}).group||"報價"};i<0?saved.push(v):saved.splice(i+1,0,v)}
  const qa=saved.findIndex(f=>f.id==="quoteAmount");
  if(qa>=0){const mv=saved.filter(f=>(f.id==="equipQty"||f.id==="visit")&&f.group===saved[qa].group);
    if(mv.length){saved=saved.filter(f=>!mv.includes(f));const at=saved.findIndex(f=>f.id==="quoteAmount");saved.splice(at,0,...mv.sort((a,b)=>a.id==="equipQty"?-1:1))}}
  return saved;
}
function mergeFields(saved,rev){
  if(Array.isArray(saved))saved=saved.filter(f=>f&&typeof f==="object"&&FIELD_ID_OK.test(String(f.id))&&FIELD_TYPES_OK.has(f.type)).map(f=>({...f,name:String(f.name||f.id),options:Array.isArray(f.options)?f.options.map(String):[],col:["left","right"].includes(f.col)?f.col:""}));
  if(!Array.isArray(saved)||!saved.length)return DEFAULT_FIELDS.map(f=>({...f}));
  if(isOldLayout(saved)){
    const order=DEFAULT_FIELDS.filter(d=>d.group==="需求內容").map(d=>d.id);
    saved=saved.map(f=>{const g=GROUP_RENAME[f.group]||f.group;const d=DEFAULT_FIELDS.find(x=>x.id===f.id);
      return g==="需求內容"&&d&&d.group==="需求內容"?{...f,group:g,name:d.name,options:d.options,line:d.line,enabled:d.enabled}:{...f,group:g}});
    DEFAULT_FIELDS.forEach(d=>{if(!saved.some(f=>f.id===d.id))saved.push({...d})});
    const need=saved.filter(f=>f.group==="需求內容").sort((a,b)=>{const x=order.indexOf(a.id),y=order.indexOf(b.id);return (x<0?99:x)-(y<0?99:y)});
    saved=[...saved.filter(f=>f.group!=="需求內容"),...need];
  }
  saved=saved.filter(f=>!REMOVED_FIELDS.includes(f.id)).map(f=>f.id==="owner"&&f.name==="負責業務"?{...f,name:"接單同仁"}:f);
  if(!(+rev>=31))saved=migrate31(saved);
  if(!(+rev>=32))saved=migrate32(saved);
  if(!(+rev>=33))saved=saved.map(f=>{if(f.id!=="layout"||f.options.includes("透天"))return f;const o=f.options.slice(),i=o.indexOf("商業／辦公空間");i<0?o.push("透天"):o.splice(i,0,"透天");return {...f,options:o}});
  if(!(+rev>=34))saved=saved.map(f=>{
    if(f.id==="odorType"){let o=[...new Set(f.options.map(x=>ODOR_RENAME[x]||x))];
      if(!o.includes("薰香香氛"))o.push("薰香香氛");if(!o.includes("其他味道"))o.push("其他味道");
      const tail=["不明異味","薰香香氛","其他味道"].filter(x=>o.includes(x));o=[...o.filter(x=>!tail.includes(x)),...tail];return {...f,options:o}}
    if(f.id==="city"&&!f.options.includes("尚未確認"))return {...f,options:["尚未確認",...f.options]};
    if(f.id==="company")return {...f,required:false,desc:DEFAULT_FIELDS.find(d=>d.id==="company").desc};
    return f});
  if(!(+rev>=35)){
    saved=saved.map(f=>{
      if(f.id==="odorType"){let o=[...new Set(f.options.map(x=>ODOR_RENAME[x]||x))].filter(x=>x!=="其他味道");
        const i=o.indexOf("薰香香氛"),j=o.indexOf("不明異味");if(i>=0&&j>=0&&j<i){o.splice(i,1);o.splice(j,0,"薰香香氛")}return {...f,options:o}}
      if(f.id==="triedBefore"){const d=DEFAULT_FIELDS.find(x=>x.id==="triedBefore");return {...f,name:d.name,type:"long",line:"",enabled:true,desc:d.desc}}
      return f});
    const ti=saved.findIndex(f=>f.id==="triedBefore"),ni=saved.findIndex(f=>f.id==="need");
    if(ti>=0&&ni>=0){const [t]=saved.splice(ti,1);const n2=saved.findIndex(f=>f.id==="need");saved.splice(n2+1,0,{...t,group:saved[n2].group})}
    else if(ti<0&&ni>=0){saved.splice(ni+1,0,{...DEFAULT_FIELDS.find(x=>x.id==="triedBefore"),group:saved[ni].group})}
  }
  saved=saved.map(f=>LINE_RENAME[f.line]?{...f,line:LINE_RENAME[f.line]}:f);
  const ids=new Set(saved.map(f=>f.id));
  const out=saved.map(f=>{const d=DEFAULT_FIELDS.find(x=>x.id===f.id);return d?{...d,...f,sys:d.sys,builtin:d.builtin,sum:d.sum||"",type:d.sys||d.builtin?d.type:f.type}:{...f,sum:""}});
  DEFAULT_FIELDS.forEach(d=>{if(!ids.has(d.id))out.push({...d,enabled:false})});
  return out;
}

function mergeGroups(saved,fields){
  if(isOldLayout(saved))saved=[...GROUPS,...saved.filter(g=>!GROUP_RENAME[g]&&!GROUPS.includes(g))];
  const out=(Array.isArray(saved)&&saved.length?saved:GROUPS).filter((g,i,a)=>g&&a.indexOf(g)===i);
  fields.forEach(f=>{if(f.group&&!out.includes(f.group))out.push(f.group)});
  return out;
}
// v3.6：服務項目改名、補上新項目（管理者存過服務項目設定後就以設定為準）
const OPT_REV=36;
function migrateServices(list,rev){
  let out=list.filter(x=>x&&typeof x==="object").map(x=>({...x,line:LINE_RENAME[x.line]||x.line,name:SERVICE_RENAME[x.name]||x.name}));
  out=out.filter((x,i)=>out.findIndex(y=>y.name===x.name)===i);
  if(!(+rev>=OPT_REV)){const P=PRIMARY_LINE;DEFAULT_OPT.services.filter(d=>d.line===P&&!out.some(x=>x.name===d.name)).forEach(d=>out.push({...d}));
    const order=DEFAULT_OPT.services.filter(d=>d.line===P).map(d=>d.name);
    const prim=out.filter(x=>x.line===P).sort((a,b)=>{const i=order.indexOf(a.name),j=order.indexOf(b.name);return (i<0?99:i)-(j<0?99:j)});
    out=[...out.filter(x=>x.line!==P),...prim]}
  return out;
}
const primaryLine=()=>{const p=S.opt.primaryLine;return (p&&(LINE_RENAME[p]||p))||PRIMARY_LINE};
function applyV1(){
  if(S._fieldsSaved||!S.v1opt)return;
  const c=fld("channel"),l=fld("lostReason");
  if(c&&Array.isArray(S.v1opt.channels)&&S.v1opt.channels.length)c.options=S.v1opt.channels.slice();
  if(l&&Array.isArray(S.v1opt.lossReasons)&&S.v1opt.lossReasons.length)l.options=S.v1opt.lossReasons.slice();
}

/* ---------- gate ---------- */
const G_ICON='<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
function gate(html){$("#gate").hidden=false;$("#app").hidden=true;$("#gateBox").innerHTML='<div class="logo"><i>普</i>案件追蹤</div>'+html}
function showLogin(msg){
  gate(`<h1>普印通同仁登入</h1><p>${msg?esc(msg):"請用公司登記的 Google 帳號登入。"}</p><button class="gbtn" id="loginBtn">${G_ICON}使用 Google 帳號登入</button>`);
  $("#loginBtn").onclick=login;
}
function showDenied(){
  gate(`<h1>這個帳號還沒有權限</h1><p>你登入的是 <code>${esc(S.email)}</code>。請把這個 Email 傳給管理者，加入名單後重新整理即可使用。</p><button class="gbtn" id="swBtn">換一個帳號登入</button>`);
  $("#swBtn").onclick=logoutAndWipe;
}
function showSetup(){gate(`<h1>尚未完成設定</h1><p>請依說明文件的步驟，把 Supabase 的網址與金鑰貼進 <code>config.js</code>，再重新部署。</p><p>金鑰要用 <b>Publishable key</b>（sb_publishable_ 開頭）或 <b>anon public</b>。如果貼的是 Secret key 或 service_role，系統會拒絕啟動，請立刻換掉。</p>`)}
async function login(){
  const p=new F.GoogleAuthProvider();p.setCustomParameters({prompt:"select_account"});
  try{await F.signInWithPopup(auth,p)}
  catch(e){
    if(e&&(e.code==="auth/popup-blocked"||e.code==="auth/operation-not-supported-in-this-environment")){try{await F.signInWithRedirect(auth,p)}catch(e2){showLogin("登入失敗："+(e2.message||e2.code))}}
    else if(e&&e.code!=="auth/popup-closed-by-user"&&e.code!=="auth/cancelled-popup-request")showLogin("登入失敗："+(e.message||e.code));
  }
}

/* ---------- boot ---------- */
function boot(){
  const fc=CFG.supabase||CFG.firebase||{};
  if(typeof F.configOk==="function"?!F.configOk(fc):(!fc.apiKey||/請貼上/.test(fc.apiKey))){showSetup();return}
  const app=F.initializeApp(fc);
  auth=F.getAuth(app);
  try{fs=F.initializeFirestore(app,{localCache:F.persistentLocalCache({tabManager:F.persistentMultipleTabManager()})})}
  catch(e){fs=F.initializeFirestore(app,{})}
  try{st=F.getStorage(app)}catch(e){st=null}
  F.getRedirectResult(auth).catch(()=>{});
  F.onAuthStateChanged(auth,u=>{
    S.unsubs.forEach(f=>f());S.unsubs=[];
    if(!u){S.user=null;showLogin();return}
    S.user=u;S.email=(u.email||"").toLowerCase();S.isAdmin=S.email===ADMIN;
    S.me=u.displayName||S.email;
    gate("<p>讀取資料中…</p>");
    startData();
  });
  const onl=()=>{$("#offline").hidden=navigator.onLine};
  window.addEventListener("online",onl);window.addEventListener("offline",onl);onl();
}
function startData(){
  let opened=false;
  const openApp=()=>{if(opened)return;opened=true;$("#gate").hidden=true;$("#app").hidden=false;renderAll()};
  const denied=e=>{if(String(e&&e.code).includes("permission-denied")){S.unsubs.forEach(f=>f());S.unsubs=[];showDenied()}else banner("資料讀取中斷（"+(e&&e.code)+"），請重新整理頁面。")};
  S.unsubs.push(F.onSnapshot(F.doc(fs,"config","access"),snap=>{
    const d=snap.exists()?snap.data():{};
    S.members=Array.isArray(d.members)?d.members:[];S.raw.access=d;
    S.admins=Array.isArray(d.admins)?d.admins.map(x=>String(x).toLowerCase()):[];S.isAdmin=S.email===ADMIN||S.admins.includes(S.email);const stb=$("#sysTab");if(stb)stb.hidden=!S.isAdmin;if(!S.isAdmin&&S.view==="sys")setView("list");
    const mine=S.members.find(m=>(m.email||"").toLowerCase()===S.email);
    S.me=(mine&&mine.name)||S.user.displayName||S.email;
    $("#meName").textContent=S.me;
    renderAll(true);
  },denied));
  S.unsubs.push(F.onSnapshot(F.doc(fs,"config","fields"),snap=>{
    const d=snap.exists()?snap.data():{};S.raw.fields=snap.exists()?d:null;S._fieldsSaved=snap.exists();S.fields=mergeFields(d.fields||null,d.rev);S.groups=mergeGroups(d.groups,S.fields);applyV1();renderAll(true);
  },()=>{}));
  S.unsubs.push(F.onSnapshot(F.doc(fs,"config","options"),snap=>{
    S.raw.options=snap.exists()?snap.data():null;
    if(snap.exists()){
      const d=snap.data();S.opt=Object.assign({},DEFAULT_OPT,{services:migrateServices(Array.isArray(d.services)?d.services:DEFAULT_OPT.services,d.rev),methods:d.methods||DEFAULT_OPT.methods});
      // 第一版的來源與未成交原因選項，搬到欄位設定（只在欄位尚未存過時）
      S.v1opt={channels:d.channels,lossReasons:d.lossReasons};applyV1();
    }
    renderAll(true);
  },()=>{}));
  S.unsubs.push(F.onSnapshot(F.query(F.collection(fs,"inquiries"),F.orderBy("date","desc"),F.limit(INQ_LIMIT)),snap=>{
    S._lastSnap=snap;
    // 大量寫入（例如還原備份）時資料會連續更新：合併成每 0.15 秒最多重畫一次，避免畫面卡死
    if(!S._inqT)S._inqT=setTimeout(()=>{S._inqT=null;const sn=S._lastSnap;
      S.inq=sn.docs.map(d=>normInq(Object.assign({},d.data(),{id:d.id})));openApp();runAutoLost();fixDupCodes();renderAll(true);schedulePopup();
      if(S.inq.length>=INQ_LIMIT)banner("案件已達 "+INQ_LIMIT+" 筆上限，較舊的案件沒有載入。請聯絡系統維護人員。");
    },S.inq.length?150:0);
  },denied));
  S.unsubs.push(F.onSnapshot(F.collection(fs,"tags"),snap=>{
    S.raw.tagDocs={};snap.docs.forEach(d=>S.raw.tagDocs[d.id]=d.data());
    S.tags=snap.docs.map(d=>cleanTag(Object.assign({},d.data(),{id:d.id}))).filter(Boolean).sort((a,b)=>a.o-b.o).slice(0,TAG_MAX);
    const editing=document.activeElement&&document.activeElement.closest(".tagmgr");
    if(S.view==="settings"&&S.setTab==="tags"){if(!editing)renderSettings()}else renderAll(true);
  },()=>{}));
  S.unsubs.push(F.onSnapshot(F.doc(fs,"config","rules"),snap=>{
    S.rules=snap.exists()?snap.data():null;S.raw.rules=S.rules;S.rulesLoaded=true;runAutoLost();renderAll(true);
  },()=>{}));
  if(!S._popTimer)S._popTimer=setInterval(()=>{renderAll(true);schedulePopup()},10*60*1000);
  S.unsubs.push(F.onSnapshot(F.doc(fs,"config","pricing"),snap=>{
    S.raw.pricing=snap.exists()?snap.data():null;S.pricing=normPricing(S.raw.pricing);
    if(!(S.view==="settings"&&S.setTab==="pricing"&&document.activeElement&&document.activeElement.closest(".prtbl,#setBody")))renderAll(true);
  },()=>{}));
  S.unsubs.push(F.onSnapshot(F.doc(fs,"config","meta"),snap=>{S.meta=snap.exists()?snap.data():{};renderAll(true)},()=>{}));
  S.unsubs.push(F.onSnapshot(F.collection(fs,"adspend"),snap=>{
    S.ad={};S.raw.adspend={};snap.docs.forEach(d=>{S.ad[d.id]=d.data().spend||{};S.raw.adspend[d.id]=d.data()});if(S.view==="stats")renderAll(true);
  },()=>{}));
}

/* ---------- shell ---------- */
function renderAll(fromData){
  if($("#app").hidden)return;
  if(S.view==="list")renderList();
  else if(S.view==="dash")renderDash();
  else if(S.view==="sys"){if(!fromData)renderSys()}
  else if(S.view==="stats"){if(!(fromData&&document.activeElement&&document.activeElement.closest("#adForm")))renderStats()}
  else if(!fromData)renderSettings();
}
document.querySelectorAll("nav.tabs button").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
function setView(v){
  S.view=v;S.tagEditId="";
  document.querySelectorAll("nav.tabs button").forEach(b=>b.setAttribute("aria-selected",String(b.dataset.view===v)));
  ["list","dash","stats","settings","sys"].forEach(k=>$("#v-"+k).hidden=k!==v);
  window.scrollTo(0,0);renderAll();
}
$("#newBtn").addEventListener("click",()=>openForm(null));
// 登出時清掉這台裝置上的離線資料（客戶資料不留在共用電腦或別人的手機）
async function logoutAndWipe(){try{await F.signOut(auth)}catch(e){}
  try{if(F.terminate&&fs){await F.terminate(fs);if(F.clearIndexedDbPersistence)await F.clearIndexedDbPersistence(fs)}}catch(e){}
  try{sessionStorage.clear()}catch(e){}
  if(F.terminate)location.reload()}
$("#logoutBtn")&&$("#logoutBtn").addEventListener("click",logoutAndWipe);

/* ---------- 自動提醒規則 ---------- */
const RULE_DEFAULT={effect:{on:true,days:15},care:{on:true,days:30},autoLost:{on:true,days:40},remind:{on:true,hours:80},quote:{on:true,hours:90},next:{on:true,hours:48}};
// 規則數值一律轉成 1～9999 的整數，避免設定檔被寫入非數字
const ruleOf=(r,k)=>{const d=RULE_DEFAULT[k],v=Object.assign({},d,(r&&typeof r[k]==="object"&&r[k])||{}),u=d.hours!=null?"hours":"days";
  const n=Math.round(+v[u]);return {on:v.on!==false,[u]:n>=1&&n<=9999?n:d[u]}};
const R=()=>{const r=S.rules||{};return{effect:ruleOf(r,"effect"),care:ruleOf(r,"care"),autoLost:ruleOf(r,"autoLost"),remind:ruleOf(r,"remind"),quote:ruleOf(r,"quote"),next:ruleOf(r,"next")}};
// 下次行動日期預設：從詢價日期（追蹤紀錄則從今天）起算 N 小時（預設 48 小時＝隔兩天）
const nextDefault=base=>{const c=R().next;return addDays(/^\d{4}-\d{2}-\d{2}$/.test(base||"")?base:today(),Math.max(1,Math.round((c.on?+c.hours:24)/24)))};
// 日期型提醒：日期已過，或就是今天而且已經上午 8:00
const REMIND_HOUR=8;
const dateReached=d=>!!d&&(d<today()||(d===today()&&new Date().getHours()>=REMIND_HOUR));
const nextDue=r=>R().next.on&&isOpen(r.stage)&&dateReached(r.nextDate);
// 成交後的兩個提醒日：14天關心除味效果（第 15 天，只有除味服務）、30日滿意保固（第 30 天）
const isOdorCase=r=>linesOfRec(r).has(primaryLine());
const effectDefault=(won,r)=>won&&(!r||isOdorCase(r))?addDays(won,R().effect.days):"";
const warrantyDefault=won=>won?addDays(won,R().care.days):"";
const stampAt=a=>{const m=String(a||"").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);return m?new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5]).getTime():NaN};
const quoteBase=r=>{const t=r.quotedAt?Date.parse(r.quotedAt):NaN;return !isNaN(t)?t:(r.quoteDate?parseDay(r.quoteDate).getTime():NaN)};
const hoursSinceQuote=r=>Math.floor((Date.now()-quoteBase(r))/36e5);
function quoteDue(r){const c=R().quote;if(!c.on||r.stage!=="已報價")return false;const b=quoteBase(r);if(isNaN(b))return false;
  if((Date.now()-b)/36e5<+c.hours)return false;
  return !(r.followups||[]).some(f=>f.method!=="建立"&&f.method!=="系統"&&stampAt(f.at)>b);}
const dayMs=864e5;
const parseDay=s=>{const [y,m,d]=String(s).split("-").map(Number);return new Date(y,(m||1)-1,d||1)};
const daysSince=s=>s?Math.floor((Date.now()-parseDay(s).getTime())/dayMs):0;
const addDays=(s,n)=>{const d=parseDay(s);d.setDate(d.getDate()+n);return ymd(d)};
const createdMs=r=>{const t=r.createdAt?Date.parse(r.createdAt):NaN;return isNaN(t)?parseDay(r.date||today()).getTime():t};
const hoursSinceCreated=r=>Math.floor((Date.now()-createdMs(r))/36e5);
const hasRealFollowup=r=>(r.followups||[]).some(f=>f.method!=="建立"&&f.method!=="系統");
function careDue(r){const c=R().care;if(!c.on||r.stage!=="成交"||r.careDoneAt)return false;
  if(r.warrantyDate)return dateReached(r.warrantyDate);
  return !!(r.wonDate||r.closedAt)&&daysSince(r.wonDate||r.closedAt)>=+c.days}
function effectDue(r){const c=R().effect;return c.on&&r.stage==="成交"&&!r.effectDoneAt&&dateReached(r.effectDate)}
const wonDays=r=>daysSince(r.wonDate||r.closedAt);
function remindDue(r){const c=R().remind;return c.on&&isOpen(r.stage)&&!hasRealFollowup(r)&&hoursSinceCreated(r)>=+c.hours}
// 自動結案起算日：詢價日期、建檔日、重新開啟日取最晚者（補登舊案件不會一存檔就被結案）
const lostBase=r=>{const c=r.createdAt?String(r.createdAt).slice(0,10):"";return [r.date||"",c,r.reopenedAt||""].filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)).sort().pop()||""};
function lostLeft(r){const c=R().autoLost;if(!c.on||!isOpen(r.stage)||!lostBase(r))return null;return +c.days-daysSince(lostBase(r))}
const soonLost=r=>{const n=lostLeft(r);return n!=null&&n>0&&n<=5};
const mineOrAll=r=>S.isAdmin||!r.owner||r.owner===S.me;
const AUTO_DONE=new Set();
// 追蹤紀錄用「加入」而不是整串覆寫，兩人同時加紀錄不會互相蓋掉
const fuAppend=(r,entry)=>F.arrayUnion&&!(r._fix||[]).includes("followups")?F.arrayUnion(entry):[...((S.inq.find(x=>x.id===r.id)||r).followups||[]),entry];
// 兩人同時建立案件可能拿到同一個詢價編號：較晚建立、而且是自己建立的那一筆，自動改成下一個號碼
const CODE_FIXED=new Set();
function fixDupCodes(){
  if(!fs||!on("code"))return;
  const by={};S.inq.forEach(r=>{if(r.code)(by[r.code]=by[r.code]||[]).push(r)});
  Object.values(by).filter(a=>a.length>1).forEach(a=>{
    a.sort((x,y)=>String(x.createdAt||"").localeCompare(String(y.createdAt||""))||x.id.localeCompare(y.id));
    a.slice(1).forEach(r=>{
      if(r.createdBy!==S.email||CODE_FIXED.has(r.id))return;CODE_FIXED.add(r.id);
      const pre=r.code.replace(/\d+$/,""),n=S.inq.filter(x=>String(x.code||"").startsWith(pre)).map(x=>+String(x.code).slice(pre.length)||0);
      const code=pre+String(Math.max(0,...n)+1).padStart(3,"0");r.code=code;
      write(F.updateDoc(F.doc(fs,"inquiries",r.id),withFix(r,{code,updatedAt:new Date().toISOString(),updatedBy:S.email})),"詢價編號重複，已自動改為 "+code);
    });
  });
}
function runAutoLost(){
  if(!fs||!S.inq.length||!S.rulesLoaded)return; // 規則還沒讀到前不動作，避免用預設 40 天誤結案
  const c=R().autoLost;if(!c.on)return;
  S.inq.forEach(r=>{
    const n=lostLeft(r);if(n==null||n>0||AUTO_DONE.has(r.id))return;
    AUTO_DONE.add(r.id);
    const reason="超過 "+c.days+" 天未成交（系統自動）";
    const entry={at:nowStamp(),by:"系統",method:"系統",note:"詢價超過 "+c.days+" 天仍未成交，自動改為未成交。若仍在洽談，請把階段改回進行中的階段。",stage:"未成交"};
    write(F.updateDoc(F.doc(fs,"inquiries",r.id),withFix(r,{stage:"未成交",lostReason:reason,autoLost:true,closedAt:today(),nextAction:"",nextDate:"",
      followups:fuAppend(r,entry),updatedAt:new Date().toISOString(),updatedBy:S.email,autoBy:"system"})));
  });
}
// 彈出提醒：詢價超過 N 小時未追蹤、成交滿 N 天待關懷
S.popSeen=new Set();
function schedulePopup(){clearTimeout(S._popT);S._popT=setTimeout(showPopup,800)}
function showPopup(){
  if($("#app").hidden||$("#overlayRoot").firstElementChild)return;
  // 同仁正在列表上編輯標籤或打字時，不要突然跳出提醒蓋住畫面，稍後再試
  const ae=document.activeElement;if((S.view==="list"&&S.tagEditId&&document.querySelector(".tag-edit"))||(ae&&/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))){clearTimeout(S._popT);S._popT=setTimeout(showPopup,15000);return}
  const rem=S.inq.filter(r=>remindDue(r)&&mineOrAll(r)&&!S.popSeen.has("r"+r.id));
  const care=S.inq.filter(r=>careDue(r)&&mineOrAll(r)&&!S.popSeen.has("c"+r.id));
  const eff=S.inq.filter(r=>effectDue(r)&&mineOrAll(r)&&!S.popSeen.has("e"+r.id));
  const quo=S.inq.filter(r=>quoteDue(r)&&mineOrAll(r)&&!S.popSeen.has("q"+r.id));
  const nxt=S.inq.filter(r=>nextDue(r)&&mineOrAll(r)&&!S.popSeen.has("n"+r.id+r.nextDate)&&!rem.includes(r)&&!quo.includes(r)&&!S.popSeen.has("r"+r.id)&&!S.popSeen.has("q"+r.id));
  if(!rem.length&&!care.length&&!quo.length&&!nxt.length&&!eff.length)return;
  const rr=R();
  const item=(r,txt)=>`<button class="pop-item" data-id="${esc(r.id)}"><b>${esc(custName(r))}</b><span>${esc(txt)}</span></button>`;
  const sh=openSheet(`<div class="sheet-head"><div><h2>追蹤提醒</h2><div class="sub">點一筆直接打開案件</div></div><button class="btn ghost" data-close>關閉</button></div>
    ${rem.length?`<div class="card pop remind"><h3>詢價超過 ${rr.remind.hours} 小時，還沒有追蹤紀錄 <small>${rem.length} 件</small></h3>${rem.map(r=>item(r,`已 ${hoursSinceCreated(r)} 小時 · ${(r.services||[]).join("、")} · ${r.owner||"未指派"}`)).join("")}</div>`:""}
    ${quo.length?`<div class="card pop quote"><h3>報價後超過 ${rr.quote.hours} 小時，還沒有追蹤 <small>${quo.length} 件</small></h3>${quo.map(r=>item(r,`報價後 ${hoursSinceQuote(r)} 小時 · ${r.quoteAmount?money(r.quoteAmount)+" · ":""}${r.owner||"未指派"}`)).join("")}</div>`:""}
    ${nxt.length?`<div class="card pop nextdue"><h3>下次行動日期到了 <small>${nxt.length} 件</small></h3>${nxt.map(r=>item(r,`${r.nextDate<today()?"逾期 "+daysSince(r.nextDate)+" 天":"今天"} · ${r.nextAction||"追蹤客戶"} · ${r.owner||"未指派"}`)).join("")}</div>`:""}
    ${eff.length?`<div class="card pop care"><h3>14天關心除味效果 <small>${eff.length} 件</small></h3>${eff.map(r=>item(r,`成交 ${wonDays(r)} 天 · ${(r.services||[]).join("、")} · ${r.owner||"未指派"}`)).join("")}</div>`:""}
    ${care.length?`<div class="card pop care"><h3>30日滿意保固提醒 <small>${care.length} 件</small></h3>${care.map(r=>item(r,`成交 ${wonDays(r)} 天 · ${(r.services||[]).join("、")} · ${r.owner||"未指派"}`)).join("")}</div>`:""}
    <div class="form-actions"><button class="btn primary" data-close>知道了</button></div>`);
  rem.forEach(r=>S.popSeen.add("r"+r.id));care.forEach(r=>S.popSeen.add("c"+r.id));eff.forEach(r=>S.popSeen.add("e"+r.id));quo.forEach(r=>S.popSeen.add("q"+r.id));nxt.forEach(r=>S.popSeen.add("n"+r.id+r.nextDate));
  sh.querySelectorAll("[data-close]").forEach(b=>b.onclick=tryClose);
  // 提醒視窗剛跳出的 0.6 秒內不接受點擊，避免同仁原本要點別的地方卻點到提醒
  const shownAt=Date.now();
  sh.querySelectorAll(".pop-item").forEach(b=>b.onclick=()=>{if(Date.now()-shownAt<600)return;closeSheet();openDetail(b.dataset.id)});
}

/* ---------- list ---------- */
// 列表「客戶／詢問內容」：詢價日期、服務、異味類型、格局坪數、需求描述，不必點開就看得到客戶問什麼
// 一鍵分享到 LINE：把客戶詢問的重點整理成一段文字
const LINE_MAX=1200;
function lineText(r){
  const L=[],add=(k,v)=>{v=Array.isArray(v)?v.filter(Boolean).join("、"):String(v==null?"":v).trim();if(v)L.push(k+"："+v)};
  L.push("【普印通詢價】"+custName(r));
  add("聯絡人",[r.contact,r.title?"（"+r.title+"）":""].join(""));
  add("電話",r.phone);
  if(on("lineId"))add("LINE ID",r.lineId);
  add("地區",[r.city,on("address")?r.address:""].filter(Boolean).join(" "));
  add("詢價日期",r.date);
  add("詢問服務",r.services);
  if(on("odorType"))add("異味類型",r.odorType);
  if(on("layout"))add("格局",r.layout);
  if(on("area")&&r.area)add("總坪數",r.area+" 坪");
  add("需求",r.need);
  if(on("caseNote"))add("案件狀況",r.caseNote);
  if(quotedOf(r))add("報價",r.quoteAmount?money(r.quoteAmount):"已報價");
  add("下次追蹤",isOpen(r.stage)&&r.nextDate?r.nextDate+(r.nextAction?" "+r.nextAction:""):"");
  add("接單同仁",r.owner);
  if(r.code)add("編號",r.code);
  let t=L.join("\n");const ch=Array.from(t);if(ch.length>LINE_MAX)t=ch.slice(0,LINE_MAX-1).join("")+"…"; // 以字元切，避免切斷表情符號
  return t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,""); // 只去掉落單的半個字元
}
// LINE 官方分享網址：手機開 LINE App 選聊天室；電腦開 LINE 分享頁
const LINE_BASE="https://line.me/R/share";
const lineUrlText=t=>{try{return LINE_BASE+"?text="+encodeURIComponent(t)}catch(e){return LINE_BASE}};
// 手機（含 iPad）才有 LINE App 可以直接開；LINE 電腦版官方不支援分享網址
const IS_MOBILE=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&/Mac/.test(navigator.platform||""));
const CAN_SHARE=typeof navigator.share==="function";
const IS_MAC=/Mac/.test(navigator.platform||navigator.userAgent||"");
const PASTE_KEY=IS_MAC?"⌘+V":"Ctrl+V";
// 開啟電腦版 LINE：只喚醒 App，不在網址裡放任何客戶資料（內容走剪貼簿），即使有別的程式搶這個網址也拿不到資料
const LINE_PC_URL="line://nv/chat";
function launchLinePC(){return new Promise(res=>{
  let left=false;const mark=()=>{left=true};
  window.addEventListener("blur",mark);document.addEventListener("visibilitychange",mark);
  try{const a=document.createElement("a");a.href=LINE_PC_URL;a.rel="noopener";a.style.display="none";document.body.appendChild(a);a.click();a.remove()}catch(e){}
  setTimeout(()=>{window.removeEventListener("blur",mark);document.removeEventListener("visibilitychange",mark);res(left)},1800);
})}
// 複製：先用剪貼簿 API，不行再用舊方法（部分瀏覽器、非 https 時）
function copyText(t){
  const legacy=()=>{try{const ta=document.createElement("textarea");ta.value=t;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,t.length);const ok=document.execCommand("copy");ta.remove();return ok}catch(e){return false}};
  try{if(navigator.clipboard&&window.isSecureContext)return navigator.clipboard.writeText(t).then(()=>true,()=>legacy())}catch(e){}
  return Promise.resolve(legacy());
}
const lineBtn=(r,cls="")=>`<button type="button" class="line-btn ${cls}" data-line-share="${esc(r.id)}" title="把客戶詢問資訊傳到 LINE">LINE 分享</button>`;
// 分享視窗：可先修改內容；手機用系統分享選 LINE（最穩），或直接開 LINE；電腦版複製後到 LINE 貼上
function openLineShare(id){
  const r=S.inq.find(x=>x.id===id);if(!r)return;
  const back=$("#overlayRoot").querySelector(".sheet")?id:null; // 從案件詳細頁打開的，關閉後回到詳細頁
  const sh=openSheet(`<div class="sheet-head"><div><h2>分享到 LINE</h2><div class="sub">${esc(custName(r))}</div></div><button class="btn ghost" data-close>關閉</button></div>
    <div class="card"><label class="f full"><span class="lbl">要傳的內容（可以先修改、加一句問候）</span><textarea id="lsTxt" rows="8" maxlength="${LINE_MAX+200}">${esc(lineText(r))}</textarea></label></div>
    <div class="share-acts">${IS_MOBILE?`
      ${CAN_SHARE?`<button type="button" class="btn primary big" data-act="share">傳到 LINE（選擇對象）</button>`:""}
      <a class="btn ${CAN_SHARE?"":"primary big"}" data-act="app" href="${esc(lineUrlText(lineText(r)))}">直接開啟 LINE App</a>
      <button type="button" class="btn" data-act="copy">複製內容</button>`:`
      <button type="button" class="btn primary big" data-act="pc">複製並開啟 LINE 電腦版</button>
      <button type="button" class="btn" data-act="copy">只複製內容</button>
      ${CAN_SHARE?`<button type="button" class="btn" data-act="share">用電腦的分享選單</button>`:""}
      <button type="button" class="btn" data-act="web">用手機傳（開 LINE 分享網頁掃碼）</button>`}
    </div>
    <div class="note share-tip" id="lsTip">${IS_MOBILE?(CAN_SHARE?"按「傳到 LINE」→ 在跳出的選單點 LINE 圖示 → 選朋友或群組 → 傳送。選單裡沒有 LINE，按「其他」或「更多」把 LINE 打開。":"按「直接開啟 LINE App」會跳到 LINE，選朋友或群組後傳送。"):`按「複製並開啟 LINE 電腦版」→ ① 在 LINE 點選要傳的人或群組 ② 在輸入框按 ${PASTE_KEY} 貼上 ③ 按 Enter 送出。（LINE 官方不開放網頁自動選人或自動送出，這兩步要自己按。）`}</div>
    <div class="note" style="margin-top:6px">內容含客戶電話，只傳給需要的同仁或群組。</div>`);
  const ta=sh.querySelector("#lsTxt"),txt=()=>ta.value.trim()||lineText(r),tip=sh.querySelector("#lsTip");
  S.onSheetClose=()=>{if(back)setTimeout(()=>openDetail(back),0)}; // 關閉（含 Esc、點外面）後回到案件詳細頁
  sh.querySelectorAll("[data-close]").forEach(b=>b.onclick=closeSheet);
  const appA=sh.querySelector('[data-act="app"]');
  ta.addEventListener("input",()=>{if(appA)appA.href=lineUrlText(txt())});
  sh.querySelectorAll("[data-act]").forEach(b=>b.onclick=async()=>{
    const a=b.dataset.act,t=txt();
    if(a==="pc"){const ok=await copyText(t);
      tip.textContent=(ok?"已複製。":"")+"正在開啟 LINE 電腦版…";
      const opened=await launchLinePC();
      tip.innerHTML=opened
        ?`<b>LINE 已開啟</b>：① 點選要傳的人或群組 ② 在輸入框按 <kbd>${PASTE_KEY}</kbd> 貼上 ③ 按 <kbd>Enter</kbd> 送出。${ok?"":"<br>（自動複製失敗：請先在上面的內容全選複製）"}`
        :`沒有偵測到 LINE 電腦版自動開啟。${ok?"內容已複製，":""}請手動打開 LINE，點選聯絡人後按 <kbd>${PASTE_KEY}</kbd> 貼上。<br>若跳出「要開啟 LINE 嗎？」請按「開啟」，並可勾選「一律允許」；還沒安裝的話，請到 LINE 官網下載電腦版。`;
      if(!ok){ta.focus();ta.select()}return}
    if(a==="copy"){const ok=await copyText(t);tip.textContent=ok?"已複製。到 LINE 打開聊天室，貼上後傳送。":"這個瀏覽器不允許自動複製，請在上面的內容裡長按（或 Ctrl+A）全選後複製。";if(!ok){ta.focus();ta.select()}toast(ok?"已複製":"請手動複製");return}
    if(a==="share"){try{await navigator.share({text:t});tip.textContent="已送出到分享選單。"}catch(e){if(e&&e.name==="AbortError")return;const ok=await copyText(t);tip.textContent=ok?"這台裝置無法使用分享選單，內容已複製，請到 LINE 貼上。":"這台裝置無法使用分享選單，請在上面的內容全選後複製，再到 LINE 貼上。"}return}
    if(a==="app"){b.href=lineUrlText(t);copyText(t);return} // 用一般連結在同一個視窗前往，手機才會交給 LINE App 開啟
    if(a==="web"){copyText(t);window.open(lineUrlText(t),"_blank","noopener,noreferrer");return}
  });
}
// 聯絡人、電話（電話可直接點撥）
function contactLine(r){
  const who=[r.contact,r.title?`（${r.title}）`:""].join("");
  const ph=String(r.phone||"").trim();
  if(!who&&!ph)return `<span class="ask-contact">${lineBtn(r)}</span>`;
  return `<span class="ask-contact">${who?`<em>${esc(who)}</em>`:""}${ph?`<a href="tel:${esc(ph.replace(/[^\d+#]/g,""))}">${esc(ph)}</a>`:""}${lineBtn(r)}</span>`;
}
// 是否已報價：有報價日期、曾改成已報價，或階段已到報價之後
const quotedOf=r=>!!(r.quoteDate||r.quotedAt)||["已報價","議價中","成交"].includes(r.stage);
function quoteCell(r){
  if(!quotedOf(r))return `<span class="qcell no">未報價</span>`;
  const d=r.quoteDate||(r.quotedAt?String(r.quotedAt).slice(0,10):"");
  return `<span class="qcell yes"><b>已報價</b><span>${r.quoteAmount?esc(money(r.quoteAmount)):"未填金額"}${d?" · "+esc(shortDate(d)):""}</span></span>`;
}
function askInfo(r){
  const top=[r.date?"詢價 "+shortDate(r.date):"",(r.services||[]).join("、")||"未選服務",r.code||""].filter(Boolean).join(" · ");
  const facts=[];
  if(on("odorType")&&Array.isArray(r.odorType)&&r.odorType.length)facts.push(r.odorType.join("、"));
  if(on("layout")&&r.layout)facts.push(r.layout);
  if(on("area")&&r.area)facts.push(r.area+" 坪");
  if(on("city")&&r.city)facts.push(r.city);
  const need=[r.need,r.caseNote].map(x=>String(x||"").trim()).filter(Boolean).join("｜");
  return `<span>${esc(top)}</span>${facts.length?`<span class="ask-facts">${facts.map(x=>`<i>${esc(x)}</i>`).join("")}</span>`:""}${need?`<span class="ask-need" title="${esc(need)}">${esc(need)}</span>`:""}`;
}
// 客戶別的標籤：點標籤＝加入篩選（可多選，必須同時有全部選定的標籤）；「＋ 標籤」直接幫這筆案件加減標籤
function rowTags(r){
  const sel=new Set(S.f.tags),ids=(r.tags||[]).filter(id=>tagById(id));
  const chips=ids.map(id=>{const t=tagById(id);return `<button type="button" class="tg tgf" data-c="${esc(t.color)}" data-tf="${esc(t.id)}" aria-pressed="${sel.has(t.id)}" title="篩選有「${esc(t.name)}」的案件">${esc(t.name)}</button>`}).join("");
  const open=S.tagEditId===r.id;
  const ed=open?`<span class="tag-edit" data-tagbox="${esc(r.id)}">${S.tags.map(t=>`<button type="button" class="tog tg" data-c="${esc(t.color)}" data-tt="${esc(t.id)}" aria-pressed="${ids.includes(t.id)}">${esc(t.name)}</button>`).join("")||'<span class="note">還沒有標籤，可直接新增</span>'}
    <span class="tg-add"><input type="text" maxlength="${TAG_NAME_MAX}" placeholder="新標籤名稱" aria-label="新標籤名稱"><button type="button" class="btn sm" data-tnew>＋ 新增</button></span><button type="button" class="btn sm primary" data-tdone>完成</button></span>`:"";
  return `<span class="tg-row">${chips}<button type="button" class="tg-plus" data-tagedit aria-expanded="${open}">${open?"收起":"＋ 標籤"}</button></span>${ed}`;
}
// 加／減單一標籤用 arrayUnion／arrayRemove：兩人同時替同一案件加標籤不會互相蓋掉
function setCaseTags(id,list,change){
  const r=S.inq.find(x=>x.id===id);if(!r)return;
  const clean=[...new Set(list)].filter(x=>tagById(x)).slice(0,TAG_MAX);
  r.tags=clean; // 先更新畫面，資料庫同步在背景完成
  let val=clean;
  if(change&&!(r._fix||[]).includes("tags")){if(change.add&&F.arrayUnion)val=F.arrayUnion(change.add);else if(change.del&&F.arrayRemove)val=F.arrayRemove(change.del)}
  write(F.updateDoc(F.doc(fs,"inquiries",id),withFix(r,{tags:val,updatedAt:new Date().toISOString(),updatedBy:S.email})));
}
function renderTagFilter(){
  let bar=$("#tagFilter");
  if(!bar){bar=document.createElement("div");bar.id="tagFilter";bar.className="tag-filter";const fl=document.querySelector("#v-list .filters");if(!fl)return;fl.after(bar)}
  S.f.tags=S.f.tags.filter(id=>tagById(id));
  bar.hidden=!S.f.tags.length;
  bar.innerHTML=S.f.tags.length?`<span class="note">標籤篩選（同時符合）：</span>${S.f.tags.map(id=>{const t=tagById(id);return `<button type="button" class="tg" data-c="${esc(t.color)}" data-rm="${esc(id)}" title="移除這個條件">${esc(t.name)} ×</button>`}).join("")}<button type="button" class="btn ghost sm" data-clear>清除</button>`:"";
  bar.querySelectorAll("[data-rm]").forEach(b=>b.onclick=()=>{S.f.tags=S.f.tags.filter(x=>x!==b.dataset.rm);renderList()});
  const c=bar.querySelector("[data-clear]");if(c)c.onclick=()=>{S.f.tags=[];renderList()};
}
function addTagToCase(id,raw){
  const name=String(raw||"").replace(/\s+/g," ").trim().slice(0,TAG_NAME_MAX);if(!name){toast("請輸入標籤名稱");return}
  let t=S.tags.find(x=>x.name===name);
  if(!t){if(S.tags.length>=TAG_MAX){toast("標籤最多 "+TAG_MAX+" 個");return}t={id:"t_"+newId(),name,color:nextTagColor()};saveTag(t,"已新增標籤「"+name+"」")}
  const r=S.inq.find(x=>x.id===id);const cur=(r&&r.tags)||[];if(!cur.includes(t.id))setCaseTags(id,[...cur,t.id],{add:t.id});
  S._focusTagInput=id;renderList();
}
const toggleTagFilter=id=>{S.f.tags=S.f.tags.includes(id)?S.f.tags.filter(x=>x!==id):[...S.f.tags,id];renderList()};
function renderList(){
  const ae=document.activeElement,keep=ae&&ae.closest&&ae.closest(".tag-edit")?{id:(ae.closest("[data-tagbox]")||{}).dataset?.tagbox,val:ae.tagName==="INPUT"?ae.value:null,tt:ae.dataset&&ae.dataset.tt,input:ae.tagName==="INPUT",pos:ae.selectionStart}:null;
  renderListInner();
  if(keep&&keep.id){const box=document.querySelector(`[data-tagbox="${CSS.escape(keep.id)}"]`);if(box){
    const inp=box.querySelector("input");if(inp&&keep.val!=null)inp.value=keep.val;
    const el=keep.input?inp:(keep.tt?box.querySelector(`[data-tt="${CSS.escape(keep.tt)}"]`):null);if(el){el.focus();if(keep.input&&keep.pos!=null)try{el.setSelectionRange(keep.pos,keep.pos)}catch(e){}}}}
}
function renderListInner(){
  const all=S.inq,t=today(),mon=t.slice(0,7);
  const open=all.filter(r=>isOpen(r.stage));
  const overdue=open.filter(r=>dueState(r)==="overdue").length;
  const due=open.filter(r=>dueState(r)==="today").length;
  const none=open.filter(r=>dueState(r)==="none").length;
  const mInq=all.filter(r=>(r.date||"").startsWith(mon));
  const mWon=all.filter(r=>r.stage==="成交"&&(r.wonDate||r.closedAt||r.date||"").startsWith(mon));
  $("#kpis").innerHTML=`
    <button class="kpi alert" data-go="overdue"><div class="k">逾期未跟進</div><div class="v">${overdue}</div><div class="d">下次行動日已過</div></button>
    <button class="kpi today" data-go="today"><div class="k">今天要跟進</div><div class="v">${due}</div><div class="d">${none?none+" 件未排下一步":"都已排定下一步"}</div></button>
    <button class="kpi" data-go="open"><div class="k">進行中案件</div><div class="v">${open.length}</div><div class="d">報價 ${money(open.reduce((a,r)=>a+(+(r.quoteAmount||r.estAmount)||0),0))}</div></button>
    <button class="kpi" data-go="month"><div class="k">本月詢價 / 成交</div><div class="v">${mInq.length}<span class="dim" style="font-size:16px"> / ${mWon.length}</span></div><div class="d">成交 ${money(mWon.reduce((a,r)=>a+(+r.wonAmount||0),0))}</div></button>`;
  $("#kpis").querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{S.f.stage=b.dataset.go;renderList()});
  const nQuo=all.filter(quoteDue).length,nRem=all.filter(remindDue).length,nCare=all.filter(careDue).length,nEff=all.filter(effectDue).length,nSoon=all.filter(soonLost).length,rr=R();
  let al=$("#alerts");if(!al){al=document.createElement("div");al.id="alerts";$("#kpis").after(al)}
  al.innerHTML=[nRem?`<button class="alert-pill remind" data-go="remind"><b>${nRem}</b> 件詢價超過 ${rr.remind.hours} 小時未追蹤</button>`:"",
    nQuo?`<button class="alert-pill quote" data-go="quote"><b>${nQuo}</b> 件報價後超過 ${rr.quote.hours} 小時未追蹤</button>`:"",
    nEff?`<button class="alert-pill care" data-go="effect"><b>${nEff}</b> 件待關心除味效果（14天）</button>`:"",
    nCare?`<button class="alert-pill care" data-go="care"><b>${nCare}</b> 件待30日滿意保固確認</button>`:"",
    nSoon?`<button class="alert-pill soon" data-go="soon"><b>${nSoon}</b> 件 5 天內將自動改為未成交</button>`:"",
    S.isAdmin&&S.inq.length&&backupAge()>=30?`<button class="alert-pill backup" data-backup="1">${backupAge()===Infinity?"還沒有做過完整備份":"已 "+backupAge()+" 天沒有完整備份"}</button>`:""].join("");
  al.hidden=!al.innerHTML;
  al.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{S.f.stage=b.dataset.go;renderList()});
  al.querySelectorAll("[data-backup]").forEach(b=>b.onclick=()=>setView("sys"));

  const counts={open:open.length,overdue,today:due,all:all.length,remind:nRem,quote:nQuo,care:nCare,effect:nEff,soon:nSoon};
  STAGES.forEach(s=>counts[s.k]=all.filter(r=>r.stage===s.k).length);
  const chipDefs=[["open","進行中"],["overdue","逾期"],["today","今天"],["remind","待首次追蹤"],["quote","報價待追蹤"],["effect","14天關心"],["care","30日保固"],["soon","即將自動結案"],...STAGES.map(s=>[s.k,s.k]),["all","全部"]];
  $("#stageChips").innerHTML=chipDefs.map(([k,l])=>`<button class="chip" data-k="${esc(k)}" aria-pressed="${S.f.stage===k}">${esc(l)}<b>${counts[k]||0}</b></button>`).join("")
    +(S.f.stage==="month"?`<button class="chip" aria-pressed="true">本月詢價</button>`:"");
  $("#stageChips").querySelectorAll("[data-k]").forEach(b=>b.onclick=()=>{S.f.stage=b.dataset.k;S.listN=LIST_PAGE;renderList()});
  const owners=[...new Set([...staff(),...all.map(r=>r.owner).filter(Boolean)])];
  $("#fOwner").innerHTML='<option value="">全部接單同仁</option>'+owners.map(n=>`<option ${n===S.f.owner?"selected":""}>${esc(n)}</option>`).join("");
  $("#fLine").innerHTML='<option value="">全部業務線</option>'+lines().map(n=>`<option ${n===S.f.line?"selected":""}>${esc(n)}</option>`).join("");
  const fT=$("#fTag");if(fT){fT.hidden=!on("tags")||!S.tags.length;
    fT.innerHTML='<option value="">＋ 依標籤篩選</option>'+S.tags.filter(t=>!S.f.tags.includes(t.id)).map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}
  renderTagFilter();

  const searchIds=S.fields.filter(f=>f.enabled&&["text","long","phone","email","auto"].includes(f.type)).map(f=>f.id);
  let rows=all.filter(r=>{
    const f=S.f.stage;
    if(f==="open"&&!isOpen(r.stage))return false;
    if(f==="overdue"&&dueState(r)!=="overdue")return false;
    if(f==="today"&&dueState(r)!=="today")return false;
    if(f==="month"&&!(r.date||"").startsWith(mon))return false;
    if(f==="remind"&&!remindDue(r))return false;
    if(f==="quote"&&!quoteDue(r))return false;
    if(f==="care"&&!careDue(r))return false;
    if(f==="effect"&&!effectDue(r))return false;
    if(f==="soon"&&!soonLost(r))return false;
    if(STAGE_MAP[f]&&r.stage!==f)return false;
    if(S.f.owner&&r.owner!==S.f.owner)return false;
    if(S.f.line&&!linesOfRec(r).has(S.f.line))return false;
    if(S.f.tags.length&&!S.f.tags.every(id=>(r.tags||[]).includes(id)))return false;
    if(S.f.q){const q=S.f.q.toLowerCase();const hay=searchIds.map(k=>r[k]).join(" ").toLowerCase();if(!hay.includes(q))return false}
    return true;
  });
  const rank={overdue:0,today:1,none:2,later:3,closed:4};
  const urg=r=>on("urgency")&&r.urgency&&r.urgency!=="一般"?0:1;
  // v3.4 排列：① 新詢問（越新越前）② 有提醒的案件 ③ 已報價 ④ 其他
  const hasAlert=r=>remindDue(r)||quoteDue(r)||nextDue(r)||effectDue(r)||careDue(r);
  const tier=r=>r.stage==="新詢問"?0:hasAlert(r)?1:r.stage==="已報價"?2:3;
  const TI=new Map(rows.map(r=>[r,tier(r)]));
  rows.sort((a,b)=>{const ta=TI.get(a),tb=TI.get(b);if(ta!==tb)return ta-tb;
    if(ta===0)return createdMs(b)-createdMs(a)||(b.date||"").localeCompare(a.date||"");
    const da=dueState(a),dbb=dueState(b);if(rank[da]!==rank[dbb])return rank[da]-rank[dbb];
    if(da!=="closed"&&urg(a)!==urg(b))return urg(a)-urg(b);
    if(da==="closed"||da==="none")return (b.date||"").localeCompare(a.date||"");
    return (a.nextDate||"").localeCompare(b.nextDate||"")});

  const L=$("#caseList");
  if(S.tagEditId&&(!on("tags")||!all.some(r=>r.id===S.tagEditId)))S.tagEditId="";
  if(!all.length){L.innerHTML='<div class="empty"><b>還沒有任何詢價</b>接到客戶詢問時，按右上角「＋ 新增詢價」登錄第一筆。<br>來源和詢問的服務一定要填，分析頁才算得出每個管道的成效。</div>';return}
  if(!rows.length){L.innerHTML='<div class="empty">沒有符合條件的案件</div>';return}
  L.innerHTML=`<div class="row head"><span></span><span>客戶／詢問內容</span><span>報價</span><span>階段</span><span>下次追蹤日</span><span>接單同仁</span></div>`+
    rows.slice(0,S.listN).map(r=>{
      const ds=dueState(r),st=STAGE_MAP[r.stage]||STAGES[0];
      const whenTxt=ds==="closed"?(r.stage==="成交"?"成交 "+money(r.wonAmount):(r.lostReason||"未成交")):
        ds==="none"?"未排下一步":(ds==="overdue"?"逾期 ":ds==="today"?"今天 ":"")+shortDate(r.nextDate);
      let u=on("urgency")&&isOpen(r.stage)&&r.urgency&&r.urgency!=="一般"?`<span class="urg">${esc(r.urgency)}</span>`:"";
      if(remindDue(r))u+=`<span class="flag remind">${hoursSinceCreated(r)} 小時未追蹤</span>`;
      if(quoteDue(r))u+=`<span class="flag remind">報價後 ${hoursSinceQuote(r)} 小時未追蹤</span>`;
      if(effectDue(r))u+=`<span class="flag care">14天關心除味效果</span>`;
      if(careDue(r))u+=`<span class="flag care">30日滿意保固</span>`;
      if(soonLost(r))u+=`<span class="flag soon">${lostLeft(r)} 天後自動結案</span>`;
      if(r.autoLost&&r.stage==="未成交")u+=`<span class="flag auto">系統結案</span>`;
      return `<div class="row ${ds}" role="button" tabindex="0" data-id="${esc(r.id)}">
        <span class="bar"></span>
        <span class="cust"><b>${u}${esc(custName(r))}</b>${on("tags")?rowTags(r):""}${contactLine(r)}${askInfo(r)}</span>
        ${quoteCell(r)}
        <span class="stwrap"><span class="stage ${st.c}">${esc(r.stage||"新詢問")}</span></span>
        <span class="next ${ds}"><span class="when">${esc(whenTxt)}</span>${ds!=="closed"?`<span>${esc(r.nextAction||"")}</span>`:""}</span>
        <span class="owner">${esc(r.owner||"—")}</span>
      </div>`}).join("")+(rows.length>S.listN||S.listN>LIST_PAGE?`<div class="list-more">${rows.length>S.listN?`<button type="button" class="btn" id="listMore">${S.listN===LIST_PAGE?"展開其餘":"再顯示"} ${Math.min(rows.length-S.listN,LIST_MORE)} 筆（還有 ${rows.length-S.listN} 筆）</button>`:""}${S.listN>LIST_PAGE&&rows.length>LIST_PAGE?`<button type="button" class="btn ghost" id="listLess">收合，只看前 ${LIST_PAGE} 筆</button>`:""}</div>`:"");
  const lm=$("#listMore");if(lm)lm.onclick=()=>{S.listN+=LIST_MORE;renderList()};
  const ll=$("#listLess");if(ll)ll.onclick=()=>{S.listN=LIST_PAGE;renderList();$("#caseList").scrollIntoView({block:"start"})};
  L.querySelectorAll(".row[data-id]").forEach(b=>{b.onclick=e=>{
      const t=e.target,id=b.dataset.id;
      if(t.closest("[data-line-share]")){openLineShare(id);return}
      if(t.closest("a"))return;
      const tf=t.closest("[data-tf]");if(tf){toggleTagFilter(tf.dataset.tf);return}
      if(t.closest("[data-tagedit]")){S.tagEditId=S.tagEditId===id?"":id;renderList();return}
      if(t.closest("[data-tdone]")){S.tagEditId="";renderList();return}
      const tt=t.closest("[data-tt]");if(tt){const r=S.inq.find(x=>x.id===id);const cur=(r&&r.tags)||[];
        const has=cur.includes(tt.dataset.tt);setCaseTags(id,has?cur.filter(x=>x!==tt.dataset.tt):[...cur,tt.dataset.tt],has?{del:tt.dataset.tt}:{add:tt.dataset.tt});renderList();return}
      if(t.closest("[data-tnew]")){const inp=b.querySelector(".tag-edit input");addTagToCase(id,inp&&inp.value);return}
      if(t.closest(".tag-edit"))return;
      openDetail(id)};
    const ti=b.querySelector(".tag-edit input");if(ti){ti.onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();addTagToCase(b.dataset.id,ti.value)}};if(S._focusTagInput===b.dataset.id){ti.focus();S._focusTagInput=""}}
    b.onkeydown=e=>{if((e.key==="Enter"||e.key===" ")&&e.target===b){e.preventDefault();openDetail(b.dataset.id)}}});
  if(S.tagEditId&&!rows.some(r=>r.id===S.tagEditId))S.tagEditId="";
}
$("#fOwner").addEventListener("change",e=>{S.f.owner=e.target.value;S.listN=LIST_PAGE;renderList()});
$("#fLine").addEventListener("change",e=>{S.f.line=e.target.value;renderList()});
{const fT=$("#fTag");if(fT)fT.addEventListener("change",e=>{const v=e.target.value;if(v&&!S.f.tags.includes(v))S.f.tags=[...S.f.tags,v];renderList()})}
$("#fQ").addEventListener("input",e=>{S.f.q=e.target.value.trim();S.listN=LIST_PAGE;renderList()});

/* ---------- overlay ---------- */
function openSheet(html){
  const root=$("#overlayRoot");
  root.innerHTML=`<div class="overlay"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const ov=root.firstElementChild;
  S.sheetDirty=false;S._closeArmed=false;
  ov.addEventListener("pointerdown",e=>{ov._down=e.target===ov});
  ov.addEventListener("click",e=>{if(e.target===ov&&ov._down)tryClose();ov._down=false});
  ov.addEventListener("input",e=>{if(e.target.closest("#inqForm,#fuForm"))S.sheetDirty=true});
  document.addEventListener("keydown",escClose);
  document.body.style.overflow="hidden";
  return ov.querySelector(".sheet");
}
function escClose(e){if(e.key==="Escape"&&!e.isComposing&&e.keyCode!==229)tryClose()}
// 表單有改過還沒存：第一次按關閉只提醒，4 秒內再按一次才真的關閉
function tryClose(){
  if(S.sheetDirty&&!S._closeArmed){S._closeArmed=true;toast("還有沒儲存的內容，再按一次關閉就會放棄");setTimeout(()=>{S._closeArmed=false},4000);return}
  closeSheet();
}
// 等資料庫確認存好才關閉表單；失敗時表單留著並顯示原因（離線時先關閉，連線後自動同步）
function saveThenClose(p,sh,errSel,okMsg,onOk){
  const btns=[...sh.querySelectorAll('button[type="submit"],button[data-quote]')],btn=btns.find(b=>!b.dataset.quote)||btns[0],err=sh.querySelector(errSel);
  const ok=()=>{if(onOk)onOk();toast(okMsg);S.sheetDirty=false;closeSheet()};
  if(!navigator.onLine&&F.OFFLINE_WRITES!==false){Promise.resolve(p).catch(e=>toast("同步失敗："+errText(e)));ok();toast(okMsg+"（目前離線，連線後自動同步）");return}
  btns.forEach(b=>b.disabled=true);if(btn){btn.dataset.t=btn.textContent;btn.textContent="儲存中…"}
  let done=false;
  const t=setTimeout(()=>{if(done)return;done=true;ok()},10000); // 網路很慢：資料庫會在背景繼續同步
  Promise.resolve(p).then(()=>{if(done)return;done=true;clearTimeout(t);ok()},e=>{clearTimeout(t);
    if(done){toast("儲存失敗："+errText(e));return}done=true;
    btns.forEach(b=>b.disabled=false);if(btn)btn.textContent=btn.dataset.t||"儲存";if(err)err.textContent="儲存失敗："+errText(e)});
}
function closeSheet(){const h=S.onSheetClose;S.onSheetClose=null;if(h)try{h()}catch(e){}$("#overlayRoot").innerHTML="";document.removeEventListener("keydown",escClose);document.body.style.overflow=""}

/* ---------- dynamic form ---------- */
function opts(list,cur,blank){return (blank!=null?`<option value="">${esc(blank)}</option>`:"")+list.map(v=>`<option ${v===cur?"selected":""}>${esc(v)}</option>`).join("")+(cur&&!list.includes(cur)?`<option selected>${esc(cur)}</option>`:"")}
function inputHtml(f,v){
  const id="x_"+f.id,ph=f.desc?` placeholder="${esc(f.desc)}"`:"";
  const req=f.required?' <span class="req">*</span>':"";
  const full=(["long","multi","file"].includes(f.type)||f.id==="services"?" full":"")+(f.hl||f.required?" hl":"");
  const lab=`<span class="lbl">${esc(f.name)}${req}</span>`;
  let ctl="";
  switch(f.type){
    case "long":ctl=`<textarea id="${id}"${ph} maxlength="5000">${esc(v)}</textarea>`;break;
    case "num":case "money":ctl=`<input type="number" inputmode="decimal" id="${id}" value="${esc(v)}">`;break;
    case "date":ctl=`<input type="date" id="${id}" value="${esc(v)}">`;break;
    case "phone":ctl=`<input type="tel" inputmode="tel" id="${id}" value="${esc(v)}">`;break;
    case "email":ctl=`<input type="email" inputmode="email" id="${id}" value="${esc(v)}">`;break;
    case "yn":ctl=`<select id="${id}">${opts(["是","否"],v,"未確認")}</select>`;break;
    case "one":ctl=`<select id="${id}">${opts(optionsOf(f),v,f.id==="stage"?null:"請選擇")}</select>`;break;
    case "multi":{
      const set=new Set(Array.isArray(v)?v:[]);
      if(f.id==="services"){
        const P=primaryLine(),others=lines().filter(l=>l!==P);
        const grp=l=>`<div class="svc-group"><em>${esc(l)}</em>${S.opt.services.filter(s=>s.line===l).map(s=>`<button type="button" class="tog" aria-pressed="${set.has(s.name)}" data-v="${esc(s.name)}">${esc(s.name)}</button>`).join("")}</div>`;
        const openMore=[...set].some(n=>lineOf(n)!==P);
        ctl=`<div class="svc-pick" data-multi="${esc(f.id)}">${lines().includes(P)?grp(P):""}`+
          (others.length?`<label class="switch"><input type="checkbox" class="showMore" ${openMore?"checked":""}><span class="knob"></span>顯示${esc(others.join("、"))}服務</label><div class="more-lines" ${openMore?"":"hidden"}>${others.map(grp).join("")}</div>`:"")+`</div>`;
      }else{
        const all=[...optionsOf(f),...[...set].filter(x=>!optionsOf(f).includes(x))];
        ctl=`<div class="svc-group" data-multi="${esc(f.id)}">${all.map(o=>`<button type="button" class="tog" aria-pressed="${set.has(o)}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
      }
      return `<div class="f${full}" data-fid="${esc(f.id)}" data-line="${esc(f.line||"")}">${lab}${ctl}</div>`;
    }
    case "tags":{
      const set=new Set(Array.isArray(v)?v:[]);
      return `<div class="f full${f.required?" hl":""}" data-fid="${esc(f.id)}" data-line="${esc(f.line||"")}">${lab}<div class="tag-pick" data-multi="${esc(f.id)}">${S.tags.map(t=>`<button type="button" class="tog tg" data-c="${esc(t.color)}" aria-pressed="${set.has(t.id)}" data-v="${esc(t.id)}">${esc(t.name)}</button>`).join("")}
        <span class="tg-add"><input type="text" maxlength="${TAG_NAME_MAX}" placeholder="新標籤名稱" aria-label="新標籤名稱"><button type="button" class="btn sm">＋ 新增標籤</button></span></div>
        <div class="note" style="margin-top:4px">可複選。名稱和顏色在「設定 → 標籤」修改。</div></div>`;
    }
    case "file":return `<div class="f full" data-fid="${esc(f.id)}" data-line="${esc(f.line||"")}">${lab}<div class="photos" data-photos="${esc(f.id)}"></div>
      <label class="btn sm photo-add"><input type="file" accept="image/*" multiple data-pick="${esc(f.id)}" hidden>＋ 加入照片</label>
      <div class="note" style="margin-top:4px">手機可以直接拍照。上傳前會自動壓縮成長邊 1600 像素，一張約 200–400 KB。</div></div>`;
    case "auto":return `<div class="f" data-fid="${esc(f.id)}">${lab}<input disabled value="${esc(v||"建立後自動產生")}"></div>`;
    default:
      if(f.id==="company"){const isP=v==="個人";
        ctl=`<span class="cust-type"><select id="x_custType" aria-label="公司或個人"><option value="公司" ${isP?"":"selected"}>公司</option><option value="個人" ${isP?"selected":""}>個人</option></select><input id="${id}" value="${esc(isP?"":v)}"${ph} maxlength="200" ${isP?"hidden":""}></span>`;break}
      ctl=`<input id="${id}" value="${esc(v)}"${ph} maxlength="500">`;
  }
  return `<label class="f${full}" data-fid="${esc(f.id)}" data-line="${esc(f.line||"")}">${lab}${ctl}</label>`;
}
function readField(sh,f){
  if(f.id==="company"){const t=sh.querySelector("#x_custType");if(t&&t.value==="個人")return "個人"}
  if(f.type==="multi"||f.type==="tags"){const box=sh.querySelector(`[data-multi="${f.id}"]`);return box?[...box.querySelectorAll('.tog[aria-pressed="true"]')].map(b=>b.dataset.v):[]}
  const el=sh.querySelector("#x_"+f.id);if(!el||el.disabled)return undefined;
  const v=el.value.trim();
  if(f.type==="num"||f.type==="money")return v===""?null:+v;
  return v;
}
// 接單同仁：新增詢價時預設為這台裝置上一次選的人（不在同仁名單就用自己）
const ownerKey=()=>"pt-crm-last-owner:"+(S.email||"");
function lastOwner(){let o="";try{o=localStorage.getItem(ownerKey())||""}catch(e){}return o&&staff().includes(o)?o:S.me}
function rememberOwner(o){try{if(o)localStorage.setItem(ownerKey(),o)}catch(e){}}
const defaultNextAction=()=>{const f=fld("nextAction");const o=f?optionsOf(f):[];return f&&f.type==="one"&&o.length?o[0]:""};
function openForm(id){
  const r=id?S.inq.find(x=>x.id===id):null;
  const t0=today();
  const v=r||{date:t0,stage:"新詢問",owner:lastOwner(),services:[],nextDate:nextDefault(t0),nextAction:defaultNextAction()};
  const active=S.fields.filter(f=>f.enabled&&!(f.id==="code"&&!r));
  const recId=r?r.id:newId();
  const PH={},added=[],removed=[];let busy=0,saved=false;
  active.filter(f=>f.type==="file").forEach(f=>PH[f.id]=(Array.isArray(v[f.id])?v[f.id]:[]).map(x=>({...x})));
  const body=mergeGroups(S.groups,active).map(g=>{
    const fsIn=active.filter(f=>f.group===g);if(!fsIn.length)return "";
    const lineOnly=fsIn.every(f=>f.line)?fsIn[0].line:"";
    const L=fsIn.filter(f=>f.col==="left"),Rt=fsIn.filter(f=>f.col==="right"),rest=fsIn.filter(f=>f.col!=="left"&&f.col!=="right");
    const inner=(L.length||Rt.length)?`<div class="cols2"><div class="colL"><div class="colh">必要資料</div>${L.map(f=>inputHtml(f,v[f.id])).join("")}</div><div class="colR"><div class="colh">次要資料</div>${Rt.map(f=>inputHtml(f,v[f.id])).join("")}</div></div>${rest.length?`<div class="grid" style="margin-top:10px">${rest.map(f=>inputHtml(f,v[f.id])).join("")}</div>`:""}`
      :`<div class="grid">${fsIn.map(f=>inputHtml(f,v[f.id])).join("")}</div>`;
    return `<div class="card" data-group="${esc(g)}" ${lineOnly?`data-gline="${esc(lineOnly)}"`:""}><h3>${esc(g)}${lineOnly?` <small>詢問${esc(lineOnly)}服務時才出現</small>`:g==="需求內容"?` <small>預設為詢問${esc(primaryLine())}服務</small>`:""}</h3>${inner}</div>`;
  }).join("");
  const sh=openSheet(`
    <div class="sheet-head"><div><h2>${r?"編輯詢價":"新增詢價"}</h2><div class="sub">標 <span style="color:var(--danger)">*</span> 為必填</div></div><button class="btn ghost" data-close>關閉</button></div>
    <form id="inqForm" novalidate>${body}
      <div class="form-actions"><span class="err" id="fErr"></span><button type="button" class="btn" data-close>取消</button>${!r&&S.pricing.items.length?`<button type="button" class="btn" data-quote="1" id="fQuoteBtn">建立並報價</button>`:""}<button type="submit" class="btn primary">${r?"儲存變更":"建立案件"}</button></div>
    </form>`);
  sh.querySelectorAll("[data-close]").forEach(b=>b.onclick=tryClose);
  // 照片：選取 → 手機端壓縮 → 上傳 → 顯示縮圖
  const drawPhotos=fid=>{const box=sh.querySelector(`[data-photos="${fid}"]`);if(!box)return;
    box.innerHTML=PH[fid].map((p,i)=>`<div class="ph ${p.up!=null?"up":""}">${p.url&&safeUrl(p.url)?`<img src="${esc(safeUrl(p.url))}" alt="">`:`<div class="ph-wait">${p.err?"失敗":Math.round((p.up||0)*100)+"%"}</div>`}${S.isAdmin||!p.path||added.includes(p.path)?`<button type="button" class="ph-x" data-i="${i}" aria-label="移除照片">×</button>`:""}</div>`).join("");
    box.querySelectorAll(".ph-x").forEach(b=>b.onclick=()=>{const p=PH[fid][+b.dataset.i];if(!p||p.up!=null&&!p.err&&!p.url)return;
      PH[fid].splice(+b.dataset.i,1);if(p.path)(added.includes(p.path)?F.deletePhoto(st,p.path).catch(()=>{}):removed.push(p.path));drawPhotos(fid)})};
  Object.keys(PH).forEach(drawPhotos);
  sh.querySelectorAll("[data-pick]").forEach(inp=>inp.onchange=async()=>{
    const fid=inp.dataset.pick,files=[...inp.files];inp.value="";
    if(!st){toast("照片功能尚未開通，請聯絡管理者");return}
    for(const file of files){
      const item={up:0,name:file.name};PH[fid].push(item);busy++;drawPhotos(fid);
      try{const blob=await compressImage(file);const path=`inquiries/${recId}/${Date.now()}-${Math.random().toString(36).slice(2,6)}.jpg`;
        const res=await F.uploadPhoto(st,path,blob,x=>{item.up=x;drawPhotos(fid)},{uploader:S.email});
        Object.assign(item,{path:res.path,url:res.url,at:nowStamp(),by:S.me});delete item.up;added.push(res.path);}
      catch(e){item.err=true;toast("照片上傳失敗："+((e&&e.message)||"請檢查網路"));PH[fid].splice(PH[fid].indexOf(item),1)}
      busy--;drawPhotos(fid);
    }
  });
  S.onSheetClose=()=>{if(!saved)added.forEach(path=>F.deletePhoto(st,path).catch(()=>{}))};
  let syncSum=()=>{};
  const syncLines=()=>{
    const picked=[...sh.querySelectorAll('[data-multi="services"] .tog[aria-pressed="true"]')].map(b=>b.dataset.v);
    const ls=new Set(picked.map(lineOf));if(!ls.size)ls.add(primaryLine());
    sh.querySelectorAll("[data-line]").forEach(el=>{const l=el.dataset.line;el.hidden=!!l&&!ls.has(l)});
    sh.querySelectorAll("[data-gline]").forEach(el=>{el.hidden=!ls.has(el.dataset.gline)});
    S._formLs=ls;syncSum();
  };
  sh.querySelectorAll(".tog").forEach(b=>b.onclick=()=>{b.setAttribute("aria-pressed",String(b.getAttribute("aria-pressed")!=="true"));syncLines()});
  sh.querySelectorAll(".tg-add").forEach(box=>{const inp=box.querySelector("input"),btn=box.querySelector("button");
    const add=()=>{const name=inp.value.replace(/\s+/g," ").trim().slice(0,TAG_NAME_MAX);if(!name)return;
      let t=S.tags.find(x=>x.name===name);
      if(!t){if(S.tags.length>=TAG_MAX){toast("標籤最多 "+TAG_MAX+" 個");return}
        t={id:"t_"+newId(),name,color:nextTagColor()};saveTag(t,"已新增標籤「"+name+"」")}
      const pick=box.closest(".tag-pick");let b=pick.querySelector(`.tog[data-v="${t.id}"]`);
      if(!b){b=document.createElement("button");b.type="button";b.className="tog tg";b.dataset.c=t.color;b.dataset.v=t.id;b.textContent=t.name;
        b.onclick=()=>b.setAttribute("aria-pressed",String(b.getAttribute("aria-pressed")!=="true"));pick.insertBefore(b,box)}
      b.setAttribute("aria-pressed","true");inp.value=""};
    btn.onclick=add;inp.onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();add()}}});
  sh.querySelectorAll(".showMore").forEach(c=>c.onchange=()=>{c.closest(".svc-pick").querySelector(".more-lines").hidden=!c.checked});
  // 本案總結：「成交」顯示成交金額、日期、除味期間、兩個提醒日；「未成交」顯示原因；和「案件階段」連動
  const stSel=sh.querySelector("#x_stage");
  const sumEls=active.filter(f=>f.sum).map(f=>({f,el:sh.querySelector(`[data-fid="${f.id}"]`)})).filter(x=>x.el);
  if(sumEls.length&&stSel){
    const openStage=isOpen(v.stage)?v.stage:"議價中";
    const box=document.createElement("div");box.className="f full sumbox";box.dataset.fid="__sum";
    box.innerHTML=`<span class="lbl">本案總結</span><div class="sumseg" role="group" aria-label="本案總結"><button type="button" data-s="open">進行中</button><button type="button" data-s="成交">成交</button><button type="button" data-s="未成交">未成交</button></div><div class="sum-hint">選「成交」或「未成交」，上方的案件階段會一起改。</div><div class="grid sum-won"></div><div class="grid sum-lost"></div><div class="grid sum-both"></div>`;
    sumEls[0].el.parentNode.insertBefore(box,sumEls[0].el);
    sumEls.forEach(({f,el})=>box.querySelector(".sum-"+f.sum).appendChild(el));
    const inp=id=>sh.querySelector("#x_"+id);
    const autoSet=(id,val)=>{const el=inp(id);if(!el||el.closest("[data-fid]").hidden)return;if(!el.value||el.dataset.auto){el.value=val;el.dataset.auto=val?"1":""}};
    ["effectDate","warrantyDate"].forEach(id=>{const el=inp(id);if(el)el.addEventListener("input",()=>{delete el.dataset.auto})});
    const fillWon=()=>{const wd=inp("wonDate");let won=wd&&wd.value;
      if(wd&&!won&&!wd.closest("[data-fid]").hidden){wd.value=won=today()}
      won=won||(r&&r.wonDate)||today();
      autoSet("effectDate",addDays(won,R().effect.days));autoSet("warrantyDate",addDays(won,R().care.days));
      const wa=inp("wonAmount"),qa=inp("quoteAmount");if(wa&&!wa.value&&qa&&qa.value)wa.value=qa.value};
    syncSum=()=>{
      const st=stSel.value,mode=isOpen(st)?"open":st,ls=S._formLs||new Set();
      box.querySelectorAll(".sumseg button").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.s===mode)));
      sumEls.forEach(({f,el})=>{const want=f.sum==="both"?mode!=="open":f.sum==="won"?mode==="成交":mode==="未成交";el.hidden=!want||(!!f.line&&!ls.has(f.line))});
      box.querySelector(".sum-hint").hidden=mode!=="open";
      if(mode==="成交"&&v.stage!=="成交")fillWon(); // 舊的成交案件不補排提醒，避免一次跳出一堆過期提醒
    };
    box.querySelectorAll(".sumseg button").forEach(b=>b.onclick=()=>{stSel.value=b.dataset.s==="open"?(isOpen(stSel.value)?stSel.value:openStage):b.dataset.s;S.sheetDirty=true;syncSum()});
    stSel.addEventListener("change",syncSum);
    const wd=inp("wonDate");if(wd)wd.addEventListener("input",()=>{if(wd.value){autoSet("effectDate",addDays(wd.value,R().effect.days));autoSet("warrantyDate",addDays(wd.value,R().care.days))}});
    // 既有案件的提醒日如果是系統排的，成交日期改了就跟著改
    [["effectDate",R().effect.days],["warrantyDate",R().care.days]].forEach(([id,n])=>{const el=inp(id);if(el&&r&&r.wonDate&&el.value===addDays(r.wonDate,n))el.dataset.auto="1"});
  }
  // 新增詢價：改了詢價日期，下次行動日期跟著改（同仁自己改過就不動）
  if(!r){const d=sh.querySelector("#x_date"),nd=sh.querySelector("#x_nextDate");
    if(d&&nd){nd.dataset.auto="1";nd.addEventListener("input",()=>{delete nd.dataset.auto});
      d.addEventListener("input",()=>{if(nd.dataset.auto&&/^\d{4}-\d{2}-\d{2}$/.test(d.value))nd.value=nextDefault(d.value)})}}
  // 公司／個人：選個人就不用打名稱；選公司才出現名稱欄（可以不填）
  {const ct=sh.querySelector("#x_custType"),ci=sh.querySelector("#x_company");
   if(ct&&ci)ct.addEventListener("change",()=>{ci.hidden=ct.value==="個人";if(!ci.hidden)ci.focus()})}
  syncLines();
  // 「建立並報價」：一般按鈕觸發送出（按 Enter 仍然是「建立案件」）
  let wantQuote=false;
  sh.querySelectorAll("#fQuoteBtn,#fQuoteBtn2").forEach(fq=>fq.onclick=()=>{if(fq.disabled)return;wantQuote=true;sh.querySelector("#inqForm").requestSubmit()});
  // 報價區塊：填台數、選到場 → 報價金額（未稅）自動計算，並顯示稅金與含稅總計
  {const qn=sh.querySelector("#x_equipQty"),vs=sh.querySelector("#x_visit"),qa=sh.querySelector("#x_quoteAmount"),P=S.pricing;
   const it1=P.items.find(x=>x.kind==="qty"),it2=P.items.find(x=>x.kind==="yn");
   if(qa&&(qn||vs)&&(it1||it2)){
     const host=qa.closest("[data-fid]"),box=document.createElement("div");box.className="f full qcalc";box.dataset.fid="__qcalc";
     host.after(box);
     const gross=()=>{const n=qn?Math.max(0,Math.floor(+qn.value||0)):0,y=vs&&vs.value==="有"?1:0;return (it1?n*it1.price:0)+(it2?y*it2.price:0)};
     const show=()=>{const sub=qa.value===""?null:Math.round(+qa.value);
       if(sub==null||!(sub>=0)){box.innerHTML=`<span class="dim">填使用設備數量、選專員到場，報價金額會自動計算。</span>`;}
       else{const tax=Math.round(sub*P.taxRate);
         box.innerHTML=`<span>未稅 <b>${money(sub)}</b> ＋ 營業稅 ${Math.round(P.taxRate*1000)/10}% ${money(tax)} ＝ 含稅 <b>${money(sub+tax)}</b></span>`+
           (it1?`<small class="dim">${esc(it1.name)} ${money(it1.price)}／${esc(it1.unit)}${it2?`；${esc(it2.name)} ${money(it2.price)}`:""}</small>`:"")}
       box.insertAdjacentHTML("beforeend",`<button type="button" class="btn sm primary" id="fQuoteBtn2" data-quote="1">產生報價單 →</button>`);
       const b=box.querySelector("#fQuoteBtn2");b.onclick=()=>{if(b.disabled)return;wantQuote=true;sh.querySelector("#inqForm").requestSubmit()}};
     const recalc=()=>{qa.value=gross()||(qn&&qn.value!==""||vs&&vs.value?"0":"");qa.dataset.auto="1";show()};
     [qn,vs].forEach(el=>el&&el.addEventListener(el.tagName==="SELECT"?"change":"input",recalc));
     qa.addEventListener("input",()=>{delete qa.dataset.auto;show()});
     if(qa.value===""&&(qn&&qn.value!==""||vs&&vs.value))recalc();else show();
   }}
  sh.querySelector("#inqForm").addEventListener("submit",e=>{
    e.preventDefault();
    const wq=wantQuote;wantQuote=false;
    const data={},miss=[];
    active.forEach(f=>{
      if(f.type==="auto")return;
      const el=sh.querySelector(`[data-fid="${f.id}"]`);const hidden=el&&el.hidden;
      if(f.type==="file"){if(hidden)return;const list=(PH[f.id]||[]).filter(p=>p.url).map(p=>({path:p.path,url:p.url,at:p.at||"",by:p.by||""}));data[f.id]=list;if(f.required&&!list.length)miss.push(f.name);return}
      const val=readField(sh,f);if(val===undefined)return;
      if(hidden){return}
      data[f.id]=val;
      if(f.required&&(val===""||val==null||(Array.isArray(val)&&!val.length)))miss.push(f.name);
    });
    {const ct=sh.querySelector("#x_custType");if(ct&&"company" in data)data.custType=ct.value==="個人"?"個人":"公司"}
    if(busy){sh.querySelector("#fErr").textContent="照片還在上傳，請稍候再按";return}
    if(miss.length){sh.querySelector("#fErr").textContent="請填寫："+miss.join("、");return}
    data.updatedAt=new Date().toISOString();data.updatedBy=S.email;
    // 標籤沒動就不寫，避免蓋掉別人剛在列表加的標籤
    if(r&&"tags" in data){const a=[...(data.tags||[])].sort().join(),b=[...(v.tags||[])].sort().join();if(a===b)delete data.tags}
    const stage=data.stage||(r&&r.stage)||"新詢問";
    if(isOpen(stage))data.closedAt=null;else if(!(r&&r.closedAt))data.closedAt=today();
    if(r&&!isOpen(r.stage)&&isOpen(stage)){data.reopenedAt=today();data.autoLost=false;AUTO_DONE.delete(r.id)}
    if(stage==="成交"&&!data.wonDate&&!(r&&r.wonDate))data.wonDate=today();
    if(stage==="成交"&&!(r&&r.stage==="成交")){const won=data.wonDate||(r&&r.wonDate)||today(),svc={services:data.services||(r&&r.services)||[]};
      if(!data.warrantyDate&&!(r&&r.warrantyDate))data.warrantyDate=warrantyDefault(won);
      if(!data.effectDate&&!(r&&r.effectDate)&&isOdorCase(svc))data.effectDate=effectDefault(won)}
    if(stage==="已報價"&&!(r&&r.stage==="已報價"))data.quotedAt=new Date().toISOString();
    const andQuote=wq;
    const onOk=()=>{saved=true;removed.forEach(path=>F.deletePhoto(st,path).catch(()=>{}));if(andQuote)setTimeout(()=>openQuote(recId,0,null,{equipQty:data.equipQty,visit:data.visit}),80)};
    if(r){saveThenClose(F.updateDoc(F.doc(fs,"inquiries",r.id),withFix(r,data)),sh,"#fErr","已儲存",onOk)}
    else{
      data.stage=stage;data.createdAt=data.updatedAt;data.createdBy=S.email;
      data.followups=[{at:nowStamp(),by:S.me,method:"建立",note:"建立詢價案件"}];
      if(on("code")){const pre="Q"+(data.date||today()).slice(2,4)+(data.date||today()).slice(5,7)+"-";
        const n=S.inq.filter(x=>(x.code||"").startsWith(pre)).map(x=>+x.code.slice(pre.length)||0);data.code=pre+String((n.length?Math.max(...n):0)+1).padStart(3,"0")}
      rememberOwner(data.owner);
      saveThenClose(F.setDoc(F.doc(fs,"inquiries",recId),data),sh,"#fErr","已建立案件"+(data.code?" "+data.code:""),onOk);
    }
  });
}

/* ---------- detail ---------- */
const CARE_METHODS=["關心除味效果","滿意保固確認"];
// 下次行動：選單（舊資料是自由文字，照樣保留顯示）
function naCtl(cur){const f=fld("nextAction");if(f&&f.type==="one"){const o=optionsOf(f);return `<select id="u_na">${opts(o,cur||o[0]||"",o.length?null:"請選擇")}</select>`}
  return `<input id="u_na" maxlength="500" value="${esc(cur||"")}">`}
function openDetail(id){
  const r=S.inq.find(x=>x.id===id);if(!r)return;
  const st=STAGE_MAP[r.stage]||STAGES[0];
  const fu=(r.followups||[]).slice().reverse();
  const rl=linesOfRec(r);
  const shown=S.fields.filter(f=>f.enabled&&!["company","stage","owner","date"].includes(f.id)&&(!f.line||rl.has(f.line)));
  const groupsHtml=mergeGroups(S.groups,shown).map(g=>{
    const items=shown.filter(f=>f.group===g).map(f=>{
      if(f.type==="file"){const ps=Array.isArray(r[f.id])?r[f.id]:[];if(!ps.length)return "";
        const ok=ps.map(p=>safeUrl(p&&p.url)).filter(Boolean);if(!ok.length)return "";
        return `<dt>${esc(f.name)}</dt><dd><div class="photos view">${ok.map(u=>`<a class="ph" href="${esc(u)}" target="_blank" rel="noopener noreferrer"><img src="${esc(u)}" alt="${esc(f.name)}" loading="lazy" referrerpolicy="no-referrer"></a>`).join("")}</div></dd>`}
      if(f.type==="tags"){const h=tagChips(r[f.id]);return h?`<dt>${esc(f.name)}</dt><dd><span class="tg-row">${h}</span></dd>`:""}
      let val=fmtVal(f,r[f.id]);if(!val)return "";
      if(f.type==="phone")val=`<a href="tel:${esc(String(r[f.id]).replace(/[^\d+#]/g,""))}">${esc(val)}</a>`;
      else if(f.type==="long")val=`<span style="white-space:pre-wrap">${esc(val)}</span>`;
      else val=esc(val);
      return `<dt>${esc(f.name)}</dt><dd>${val}</dd>`}).join("");
    return items?`<div class="dgroup"><h4>${esc(g)}</h4><dl class="dl">${items}</dl></div>`:"";
  }).join("")+(r.closedAt?`<div class="dgroup"><dl class="dl"><dt>結案日期</dt><dd class="num">${esc(r.closedAt)}</dd></dl></div>`:"");
  const sh=openSheet(`
    <div class="sheet-head"><div><h2>${esc(custName(r))}</h2><div class="sub"><span class="stage ${st.c}">${esc(r.stage)}</span> · ${esc(r.owner||"未指派")} · 詢價 ${esc(r.date||"")}${r.code?" · "+esc(r.code):""}</div></div>${lineBtn(r,"btn sm")}<button class="btn sm" id="dEdit">編輯</button><button class="btn ghost" data-close>關閉</button></div>
    ${effectDue(r)?`<div class="banner-in care">14天關心除味效果：成交已 ${wonDays(r)} 天，請聯絡客戶確認除味效果（味道是否改善、有沒有復發）。<button type="button" class="btn sm" id="doEff">填寫關心紀錄</button></div>`:""}
    ${r.effectDoneAt?`<div class="banner-in done">已於 ${esc(r.effectDoneAt)} 關心除味效果</div>`:""}
    ${careDue(r)?`<div class="banner-in care">30日滿意保固提醒：成交已 ${wonDays(r)} 天，請聯絡客戶確認滿意度與保固事項。<button type="button" class="btn sm" id="doCare">填寫保固確認</button></div>`:""}
    ${r.careDoneAt?`<div class="banner-in done">已於 ${esc(r.careDoneAt)} 完成30日滿意保固確認</div>`:""}
    ${quoteDue(r)?`<div class="banner-in remind">報價後已 ${hoursSinceQuote(r)} 小時，請聯絡客戶確認報價。</div>`:""}
    ${remindDue(r)?`<div class="banner-in remind">詢價已 ${hoursSinceCreated(r)} 小時，還沒有任何追蹤紀錄。</div>`:""}
    ${lostLeft(r)!=null&&lostLeft(r)<=5?`<div class="banner-in soon">再 ${Math.max(0,lostLeft(r))} 天（${addDays(lostBase(r),R().autoLost.days)}）沒有成交，系統會自動改為未成交。</div>`:""}
    ${r.autoLost&&r.stage==="未成交"?`<div class="banner-in auto">這筆是系統自動改為未成交。若仍在洽談，在下方把階段改回進行中的階段即可，系統會重新計算 ${R().autoLost.days} 天。</div>`:""}
    ${quoteCard(r)}
    <div class="card"><h3>新增追蹤紀錄</h3>
      <form id="fuForm" class="grid" novalidate>
        <label class="f">方式<select id="u_method">${opts([...S.opt.methods,...CARE_METHODS.filter(m=>!S.opt.methods.includes(m))],"電話")}</select></label>
        <label class="f">更新階段<select id="u_stage">${opts(STAGES.map(s=>s.k),r.stage)}</select></label>
        <label class="f full"><span class="lbl">內容 <span class="req">*</span></span><textarea id="u_note" maxlength="5000" placeholder="客戶說了什麼、我們答應了什麼"></textarea></label>
        <label class="f" id="u_wonW" hidden>成交金額（元）<input type="number" id="u_won" inputmode="numeric" value="${esc(r.wonAmount??r.quoteAmount??r.estAmount??"")}"></label>
        <label class="f" id="u_wdW" hidden>成交日期<input type="date" id="u_wd" value="${esc(r.wonDate||today())}"></label>
        <label class="f" id="u_dpW" hidden>除味期間<input id="u_dp" maxlength="500" placeholder="例如 10/20～10/27，共 7 天" value="${esc(r.deodorPeriod||"")}"></label>
        <label class="f" id="u_efW" hidden>14天關心除味效果<input type="date" id="u_ef" value="${esc(r.effectDate||"")}"></label>
        <label class="f" id="u_wrW" hidden>30日滿意保固提醒<input type="date" id="u_wr" value="${esc(r.warrantyDate||"")}"></label>
        <label class="f" id="u_lostW" hidden>未成交原因<select id="u_lost">${opts(optionsOf(fld("lostReason")||{options:[]}),r.lostReason,"請選擇")}</select></label>
        <label class="f full" id="u_cnW" hidden>本案備註<textarea id="u_cn" maxlength="5000" rows="2" placeholder="成交條件、未成交的補充說明">${esc(r.closeNote||"")}</textarea></label>
        <label class="f" id="u_naW">下次行動${naCtl(r.nextAction)}</label>
        <label class="f" id="u_ndW">日期<input type="date" id="u_nd" value="${esc(r.nextDate&&r.nextDate>today()?r.nextDate:nextDefault())}"></label>
        <div class="form-actions full" style="margin-top:4px"><span class="err" id="uErr"></span><button class="btn primary" type="submit">加入紀錄</button></div>
      </form>
    </div>
    <div class="card"><h3>追蹤紀錄 <small>${(r.followups||[]).length} 筆</small></h3>
      <ul class="timeline">${fu.map(f=>`<li><span class="t">${esc((f.at||"").slice(0,10))}<br>${esc((f.at||"").slice(11))}</span><div><div class="m">${esc(f.method||"")}${f.by?" · "+esc(f.by):""}${f.stage?" · 階段 → "+esc(f.stage):""}</div><div class="n">${esc(f.note||"")}</div></div></li>`).join("")||'<li><span></span><span class="dim">尚無紀錄</span></li>'}</ul>
    </div>
    <div class="card"><h3>案件資料</h3>${groupsHtml||'<span class="dim">尚未填寫其他資料</span>'}</div>
    ${S.isAdmin?`<div style="margin-top:18px"><button class="btn danger sm" id="dDel">刪除此案件</button><div id="delBox"></div></div>`:""}`);
  sh.querySelectorAll("[data-close]").forEach(b=>b.onclick=tryClose);
  sh.querySelector("#dEdit").onclick=()=>openForm(id);
  const dq=sh.querySelector("#dQuote");if(dq)dq.onclick=()=>{closeSheet();openQuote(id)};
  sh.querySelectorAll("[data-q]").forEach(b=>b.onclick=()=>{closeSheet();openQuotePrint(id,b.dataset.q)});
  sh.querySelectorAll("[data-line-share]").forEach(a=>a.addEventListener("click",()=>openLineShare(id)));
  const stSel=sh.querySelector("#u_stage");
  const odor=isOdorCase(r),q=x=>sh.querySelector(x);
  // 從其他階段改成「成交」時，自動排兩個提醒日（成交日期改了就跟著改，自己改過的不動）
  const autoD=(sel,n,ok)=>{const el=q(sel);if(!ok||r.stage==="成交")return;if(!el.value||el.dataset.auto){el.value=addDays(q("#u_wd").value||today(),n);el.dataset.auto="1"}};
  ["#u_ef","#u_wr"].forEach(x=>q(x).addEventListener("input",()=>delete q(x).dataset.auto));
  const autoAll=()=>{autoD("#u_ef",R().effect.days,odor);autoD("#u_wr",R().care.days,true)};
  q("#u_wd").addEventListener("input",autoAll);
  const sync=()=>{const s=stSel.value,w=s!=="成交";q("#u_wonW").hidden=w;q("#u_wdW").hidden=w||!on("wonDate");
    q("#u_dpW").hidden=w||!odor||!on("deodorPeriod");q("#u_efW").hidden=w||!odor;q("#u_wrW").hidden=w;
    q("#u_lostW").hidden=s!=="未成交";q("#u_cnW").hidden=isOpen(s)||!on("closeNote");
    if(!w)autoAll();
    const o=isOpen(s);q("#u_naW").hidden=!o;q("#u_ndW").hidden=!o};
  stSel.onchange=sync;sync();
  const dc=sh.querySelector("#doCare");
  if(dc)dc.onclick=()=>{sh.querySelector("#u_method").value="滿意保固確認";const n=sh.querySelector("#u_note");n.placeholder="例如：客戶滿意，味道沒有復發，已說明保固內容";n.focus()};
  const de=sh.querySelector("#doEff");
  if(de)de.onclick=()=>{sh.querySelector("#u_method").value="關心除味效果";const n=sh.querySelector("#u_note");n.placeholder="例如：味道明顯改善，雨天還有一點霉味，約下週複查";n.focus()};
  sh.querySelector("#fuForm").addEventListener("submit",e=>{
    e.preventDefault();
    const note=sh.querySelector("#u_note").value.trim(),stage=stSel.value;
    if(!note){sh.querySelector("#uErr").textContent="請填寫追蹤內容";return}
    if(stage==="未成交"&&!sh.querySelector("#u_lost").value){sh.querySelector("#uErr").textContent="請選擇未成交原因";return}
    const entry={at:nowStamp(),by:S.me,method:sh.querySelector("#u_method").value,note};
    if(stage!==r.stage)entry.stage=stage;
    const upd={followups:fuAppend(r,entry),stage,updatedAt:new Date().toISOString(),updatedBy:S.email};
    if(isOpen(stage)){upd.nextAction=q("#u_na").value.trim();upd.nextDate=sh.querySelector("#u_nd").value;upd.closedAt=null}
    else{upd.nextAction="";upd.nextDate="";if(isOpen(r.stage)||!r.closedAt)upd.closedAt=today()}
    if(stage==="成交"){const w=q("#u_won").value;upd.wonAmount=w===""?null:+w;upd.wonDate=q("#u_wd").value||today();
      if(!q("#u_dpW").hidden)upd.deodorPeriod=q("#u_dp").value.trim();
      if(!q("#u_efW").hidden)upd.effectDate=q("#u_ef").value;
      upd.warrantyDate=q("#u_wr").value}
    if(stage==="未成交")upd.lostReason=q("#u_lost").value;
    if(!isOpen(stage)&&!q("#u_cnW").hidden)upd.closeNote=q("#u_cn").value.trim();
    if(entry.method==="關心除味效果")upd.effectDoneAt=today();
    if(entry.method==="客戶關懷"||entry.method==="滿意保固確認")upd.careDoneAt=today();
    if(stage==="已報價"&&r.stage!=="已報價")upd.quotedAt=new Date().toISOString();
    if(!isOpen(r.stage)&&isOpen(stage)){upd.reopenedAt=today();upd.autoLost=false;AUTO_DONE.delete(id)}
    saveThenClose(F.updateDoc(F.doc(fs,"inquiries",id),withFix(r,upd)),sh,"#uErr","已加入紀錄");
  });
  const dDel=sh.querySelector("#dDel");if(dDel)dDel.onclick=()=>{
    sh.querySelector("#delBox").innerHTML=`<div class="confirm">刪除後無法復原，也會從分析中移除。<button class="btn danger sm" id="delYes">確定刪除</button><button class="btn sm" id="delNo">取消</button></div>`;
    sh.querySelector("#delNo").onclick=()=>sh.querySelector("#delBox").innerHTML="";
    sh.querySelector("#delYes").onclick=()=>{
      S.fields.filter(f=>f.type==="file").forEach(f=>(Array.isArray(r[f.id])?r[f.id]:[]).forEach(p=>p.path&&F.deletePhoto(st,p.path).catch(()=>{})));
      write(F.deleteDoc(F.doc(fs,"inquiries",id)),"已刪除");closeSheet()};
  };
}

/* ---------- 報價（v3.2） ---------- */
// 單價、稅率放在 config/pricing，只有管理者可以改；每份報價單把當下的品項與金額存進案件的 quotes（之後調價不影響舊報價單）
const PRICING_DEFAULT={
  items:[{id:"ozone",name:"AQ得來速商用臭氧服務（商用臭氧機、商用除味扇）",unit:"台",price:5200,kind:"qty",note:"每台每次施工"},
         {id:"visit",name:"專員到場",unit:"次",price:3500,kind:"yn",note:"整案一次"}],
  taxRate:0.05,company:"普印通科技股份有限公司",companyInfo:"統一編號 28210837｜電話 (02)2732-0137｜0800-581-881",
  quoteNote:"",
  // v3.5 公司報價單範本（商用臭氧機除味報價單）
  tel:"(02) 2732-0137",fax:"(02) 2707-8550",validDays:14,payTerms:"確認預約後全額匯款",stamp:true,
  terms:"除味時間：3天\n除味運轉時間：人跟寵物都不能入內，門窗緊閉\n除味完成：門窗打開保持通風\n\n付款方式：確認預約除味設備租用，需先全額匯款，不另收押金\n\n服務提供30天滿意保固：\n除味後30天內，如主觀認為味道還有殘留，可以再次申請除味，不用租金，只需負擔每台設備500元來回運費即可"};
const QP_ID_OK=/^[a-z0-9_]{1,24}$/;
const cut=(s,n)=>String(s==null?"":s).replace(/[\u0000-\u001f]/g," ").trim().slice(0,n);
function normPricing(d){
  d=d&&typeof d==="object"?d:{};
  const items=(Array.isArray(d.items)?d.items:PRICING_DEFAULT.items).slice(0,20).map(x=>{
    x=x&&typeof x==="object"?x:{};const p=Math.round(+x.price);
    if(x.name==="AQ得來速商用臭氧機")x={...x,name:PRICING_DEFAULT.items[0].name}; // v3.7 品項改名
    return {id:QP_ID_OK.test(String(x.id))?String(x.id):"i"+Math.random().toString(36).slice(2,8),name:cut(x.name,40),unit:cut(x.unit,6),
      price:p>=0&&p<=9999999?p:0,kind:x.kind==="yn"?"yn":"qty",note:cut(x.note,60)}}).filter(x=>x.name);
  const t=+d.taxRate;
  return {items,taxRate:t>=0&&t<=0.3?t:PRICING_DEFAULT.taxRate,
    company:cut(d.company!=null?d.company:PRICING_DEFAULT.company,60),companyInfo:cut(d.companyInfo!=null?d.companyInfo:PRICING_DEFAULT.companyInfo,160),
    quoteNote:String(d.quoteNote!=null?d.quoteNote:PRICING_DEFAULT.quoteNote).slice(0,1000),
    tel:cut(d.tel!=null?d.tel:PRICING_DEFAULT.tel,30),fax:cut(d.fax!=null?d.fax:PRICING_DEFAULT.fax,30),
    validDays:(v=>v>=1&&v<=365?v:PRICING_DEFAULT.validDays)(Math.round(+d.validDays)),
    payTerms:cut(d.payTerms!=null?d.payTerms:PRICING_DEFAULT.payTerms,80),stamp:d.stamp!==false,
    terms:String(d.terms!=null?d.terms:PRICING_DEFAULT.terms).replace(/\r/g,"").slice(0,1500)};
}
S.pricing=normPricing(null);
const appendArr=(r,key,entry)=>F.arrayUnion&&!(r._fix||[]).includes(key)?F.arrayUnion(entry):[...((S.inq.find(x=>x.id===r.id)||r)[key]||[]),entry];
const quotesOf=r=>(Array.isArray(r&&r.quotes)?r.quotes:[]).filter(q=>q&&typeof q==="object"&&Array.isArray(q.lines)).slice().sort((a,b)=>(+a.ver||0)-(+b.ver||0));
// 計算：品項金額相加 → 減折扣 → 小計（未稅）→ 稅金四捨五入 → 總計（含稅）
function calcQuote(lines,discount,rate){
  const gross=lines.reduce((a,l)=>a+l.amount,0),disc=Math.max(0,Math.round(+discount||0));
  const subtotal=gross-disc,tax=Math.round(subtotal*rate);
  return {gross,discount:disc,subtotal,tax,total:subtotal+tax};
}
const QUOTE_EARLY=["新詢問","已聯繫","場勘/檢測"];
// 報價單號：日期＋當天流水號（範本格式，例如 20261019003）
function nextQuoteNo(d){const pre=String(d).replace(/-/g,"");let n=0;
  S.inq.forEach(r=>quotesOf(r).forEach(q=>{const m=String(q.no||"").match(/^(\d{8})(\d{3})$/);if(m&&m[1]===pre)n=Math.max(n,+m[2])}));
  return pre+String(n+1).padStart(3,"0")}
const salesKey=()=>"pt-crm-sales-phone:"+(S.email||"");
const salesPhone=()=>{try{return localStorage.getItem(salesKey())||""}catch(e){return ""}};
function openQuote(id,tries=0,from=null,seed=null){
  let r=S.inq.find(x=>x.id===id);
  if(!r){if(tries<20)setTimeout(()=>openQuote(id,tries+1,from,seed),150);else toast("找不到案件，請稍後再試");return}
  if(seed)r={...r,...seed}; // 表單剛存的台數／到場（資料庫同步前先用）
  const P=S.pricing,qs=quotesOf(r),prev=from||qs[qs.length-1],ver=(qs.reduce((a,q)=>Math.max(a,+q.ver||0),0))+1;
  if(!P.items.length){toast("尚未設定報價品項，請管理者到「設定 → 報價設定」新增");return}
  // 預設數量：案件「報價」區塊填的台數／到場優先，其次是上一版報價
  const it1=P.items.find(x=>x.kind==="qty"),it2=P.items.find(x=>x.kind==="yn");
  const prevQty=id=>{
    if(from){const l=from.lines.find(x=>x.id===id);return l?l.qty:0}
    if(it1&&id===it1.id&&r.equipQty!=null&&r.equipQty!==""&&+r.equipQty>=0)return Math.floor(+r.equipQty);
    if(it2&&id===it2.id&&(r.visit==="有"||r.visit==="沒有"))return r.visit==="有"?1:0;
    const l=prev&&prev.lines.find(x=>x.id===id);return l?l.qty:0};
  const row=(it,i)=>`<tr data-i="${i}"><td>${esc(it.name)}${it.note?`<small class="dim"> ${esc(it.note)}</small>`:""}</td>
    <td>${it.kind==="yn"?`<select class="q-in" aria-label="${esc(it.name)}"><option value="0">沒有</option><option value="1" ${prevQty(it.id)?"selected":""}>有</option></select>`
      :`<input class="q-in" type="number" inputmode="numeric" min="0" max="999" step="1" value="${prevQty(it.id)}" aria-label="${esc(it.name)}數量"> ${esc(it.unit)}`}</td>
    <td class="num">${money(it.price)}</td><td class="num q-amt">—</td></tr>`;
  const sh=openSheet(`<div class="sheet-head"><div><h2>${ver>1?"修改報價（第 "+ver+" 版）":"產生報價單"}</h2><div class="sub">${esc(custName(r))} · 價格為未稅，系統自動加 ${Math.round(P.taxRate*1000)/10}% 營業稅</div></div><button class="btn ghost" data-close>關閉</button></div>
    <form id="qForm" novalidate>
    <div class="card"><h3>報價項目</h3>
      <div class="tbl-wrap"><table class="t qtbl"><thead><tr><th>項目</th><th>數量</th><th>單價（未稅）</th><th>金額（未稅）</th></tr></thead>
      <tbody>${P.items.map(row).join("")}</tbody>
      <tfoot>
        <tr><td colspan="3">折扣（未稅）<input id="qDisc" type="number" inputmode="numeric" min="0" step="1" value="${prev?prev.discount||0:0}" style="width:110px;margin-left:8px"></td><td class="num" id="qDiscV">—</td></tr>
        <tr><td colspan="3"><b>小計（未稅）</b></td><td class="num" id="qSub"><b>—</b></td></tr>
        <tr><td colspan="3">營業稅 ${Math.round(P.taxRate*1000)/10}%</td><td class="num" id="qTax">—</td></tr>
        <tr class="qtot"><td colspan="3"><b>總計（含稅）</b></td><td class="num" id="qTot"><b>—</b></td></tr>
      </tfoot></table></div>
      <div class="grid" style="margin-top:10px">
        <label class="f" id="qReasonW"><span class="lbl">折扣原因 <span class="req">*</span></span><input id="qReason" maxlength="200" value="${esc(prev&&prev.discountReason||"")}" placeholder="例如：老客戶回購、多台優惠"></label>
        <label class="f"><span class="lbl">業務專員電話</span><input id="qSales" maxlength="30" value="${esc(prev&&prev.salesPhone||salesPhone())}" placeholder="例如 0970-000123"></label>
        <label class="f full"><span class="lbl">報價單備註（印在「六、備註」）</span><textarea id="qNote" rows="2" maxlength="1000">${esc(prev?prev.note||"":P.quoteNote)}</textarea></label>
      </div>
    </div>
    <div class="form-actions"><span class="err" id="qErr"></span><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">產生報價單${ver>1?"（第 "+ver+" 版）":""}</button></div>
    </form>`);
  sh.querySelectorAll("[data-close]").forEach(b=>b.onclick=tryClose);
  const read=()=>{
    const lines=[];
    sh.querySelectorAll("tbody tr[data-i]").forEach(tr=>{const it=P.items[+tr.dataset.i],el=tr.querySelector(".q-in");
      let q=it.kind==="yn"?(el.value==="1"?1:0):(el.value.trim()===""?0:+el.value);if(!(q>=0&&Number.isInteger(q)))q=NaN;
      const amt=q>0?q*it.price:0;tr.querySelector(".q-amt").textContent=q>0?money(amt):"—";
      lines.push({id:it.id,name:it.name,unit:it.unit,price:it.price,qty:q,amount:amt,kind:it.kind})});
    return lines};
  const upd=()=>{const lines=read(),c=calcQuote(lines.filter(l=>l.qty>0),sh.querySelector("#qDisc").value,P.taxRate);
    sh.querySelector("#qDiscV").textContent=c.discount?"−"+money(c.discount):"—";
    sh.querySelector("#qSub").innerHTML="<b>"+money(c.subtotal)+"</b>";sh.querySelector("#qTax").textContent=money(c.tax);sh.querySelector("#qTot").innerHTML="<b>"+money(c.total)+"</b>";
    sh.querySelector("#qReasonW").hidden=!c.discount;return {lines,c}};
  sh.querySelector("#qForm").addEventListener("input",upd);sh.querySelector("#qForm").addEventListener("change",upd);upd();
  sh.querySelector("#qForm").addEventListener("submit",e=>{
    e.preventDefault();const err=sh.querySelector("#qErr");
    const {lines,c}=upd(),bad=lines.find(l=>!(l.qty>=0&&l.qty<=999));
    if(bad){err.textContent="「"+bad.name+"」數量要是 0～999 的整數";return}
    const used=lines.filter(l=>l.qty>0);
    if(!used.length){err.textContent="請至少選一個報價項目";return}
    if(c.discount>c.gross){err.textContent="折扣不能大於項目金額";return}
    const reason=sh.querySelector("#qReason").value.trim();
    if(c.discount&&!reason){err.textContent="有折扣時請填寫折扣原因";return}
    const cur=S.inq.find(x=>x.id===id)||r,v2=quotesOf(cur).reduce((a,q)=>Math.max(a,+q.ver||0),0)+1;
    const now=new Date().toISOString(),d=today(),no=nextQuoteNo(d),sp=cut(sh.querySelector("#qSales").value,30);
    try{if(sp)localStorage.setItem(salesKey(),sp)}catch(e){}
    const q={id:newId(),no,ver:v2,date:d,at:nowStamp(),by:S.me,byEmail:S.email,lines:used.map(({kind,...l})=>l),taxRate:P.taxRate,...c,
      discountReason:c.discount?reason.slice(0,200):"",note:sh.querySelector("#qNote").value.trim().slice(0,1000),
      company:cur.company==="個人"?"":(cur.company||""),contact:cur.contact||"",phone:cur.phone||"",address:cur.address||"",taxId:cur.taxId||"",caseCode:cur.code||"",salesPhone:sp,
      seller:{company:P.company,info:P.companyInfo,tel:P.tel,fax:P.fax,validDays:P.validDays,payTerms:P.payTerms,terms:P.terms}};
    const entry={at:nowStamp(),by:S.me,method:"報價",note:`產生報價單 ${no}：未稅 ${money(c.subtotal)}，含稅 ${money(c.total)}${c.discount?`（折扣 ${money(c.discount)}：${q.discountReason}）`:""}`};
    const u={quotes:appendArr(cur,"quotes",q),quoteAmount:c.subtotal,quoteDate:d,quoteNo:no,updatedAt:now,updatedBy:S.email};
    // 報價單改了數量／到場，案件的「報價」區塊跟著更新
    {const l1=it1&&lines.find(l=>l.id===it1.id),l2=it2&&lines.find(l=>l.id===it2.id);if(l1)u.equipQty=l1.qty;if(l2)u.visit=l2.qty?"有":"沒有"}
    if(QUOTE_EARLY.includes(cur.stage)){u.stage="已報價";entry.stage="已報價";u.quotedAt=now}
    else if(cur.stage==="已報價"||cur.stage==="議價中")u.quotedAt=now;
    u.followups=appendArr(cur,"followups",entry);
    saveThenClose(F.updateDoc(F.doc(fs,"inquiries",id),withFix(cur,u)),sh,"#qErr","已產生報價單 "+no,()=>{S.sheetDirty=false;setTimeout(()=>openQuotePrint(id,q.id,q),60)});
  });
}
// 報價單：照公司範本（商用臭氧機除味報價單）排版，A4 橫式
const QROWS=10;
function quoteHtml(q,stamp){
  const s=q.seller||{},P=S.pricing,v=(k)=>s[k]!=null?s[k]:P[k];
  const [Y,M,Dd]=String(q.date||"").split("-");
  const rows=q.lines.map(l=>`<tr><td>${esc(l.name)}</td><td class="c">${esc(l.qty)}</td><td class="num">${money(l.price).replace("$","")}</td><td class="num">${money(l.amount).replace("$","")}</td></tr>`);
  if(q.discount)rows.push(`<tr><td>折扣${q.discountReason?"（"+esc(q.discountReason)+"）":""}</td><td></td><td></td><td class="num">−${money(q.discount).replace("$","")}</td></tr>`);
  while(rows.length<QROWS)rows.push(`<tr class="blank"><td>&nbsp;</td><td></td><td></td><td></td></tr>`);
  const rate=Math.round((+q.taxRate||0)*1000)/10;
  const terms=`${q.address?`案件地址：${esc(q.address)}\n\n`:"案件地址：\n\n"}${esc(v("terms")||"")}`;
  return `<div class="qdoc qtpl">
    <div class="qt-head"><img src="img/qt-logo.jpg" alt="普印通 Print Town Technology" class="qt-logo"><img src="img/qt-name.jpg" alt="${esc(s.company||P.company)}" class="qt-name"><span></span></div>
    <table class="qt-main">
      <colgroup><col class="w-name"><col class="w-qty"><col class="w-pr"><col class="w-amt"><col class="w-note"></colgroup>
      <tr><th colspan="5" class="qt-title">報　價　單</th></tr>
      <tr><td colspan="4" class="qt-cust">客戶：${esc(q.company||(q.contact?q.contact+"（個人）":""))}${q.company&&q.contact?`　聯絡人：${esc(q.contact)}`:""}</td><td class="qt-date">日期：<span>${esc(Y||"")}</span> 年 <span>${esc(M||"")}</span> 月 <span>${esc(Dd||"")}</span> 日</td></tr>
      <tr class="qt-hd"><th>品名規格</th><th>數量</th><th>單價</th><th>合計</th><th>備註</th></tr>
      ${rows.map((r,i)=>i===0?r.replace(/<\/tr>$/,`<td class="qt-terms" rowspan="${rows.length+3}">${terms}</td></tr>`):r).join("")}
      <tr class="qt-sum"><td colspan="3" class="r">小計（未稅）：</td><td class="num">${money(q.subtotal).replace("$","")}</td></tr>
      <tr class="qt-sum"><td colspan="3" class="r">營業稅 ${rate}%：</td><td class="num">${money(q.tax).replace("$","")}</td></tr>
      <tr class="qt-tot"><td colspan="3" class="r">總價（含稅）：</td><td class="num">${money(q.total).replace("$","")}</td></tr>
    </table>
    <div class="qt-info">
      <div>一、報價單號：${esc(q.no)}<br>二、詢價編號：${esc(q.caseCode||"")}${q.ver?`（第 ${esc(q.ver)} 版）`:""}<br>三、有效期限為報價 ${esc(v("validDays"))} 日內有效</div>
      <div>四、產品單價為：未稅（另加營業稅 ${rate}%）<br>五、收款條件：${esc(v("payTerms")||"")}<br>六、備註：${esc(q.note||"")}</div>
      <div>電話：${esc(v("tel")||"")}<br>傳真：${esc(v("fax")||"")}</div>
      <div>業務專員：${esc(q.by||"")} ${esc(q.salesPhone||"")}</div>
    </div>
    <div class="qt-foot">
      <div class="qt-confirm"><b>訂購確認欄</b>
        <table><tr><td>客戶確認簽署：</td><td>簽訂日期：</td><td>統一編號：${esc(q.taxId||"")}</td></tr>
          <tr><td>送貨聯絡人：${esc(q.contact||"")}</td><td>連絡電話：${esc(q.phone||"")}</td><td>傳真號碼：</td></tr>
          <tr><td colspan="2">送貨地址：${esc(q.address||"")}</td><td>送貨備註：</td></tr></table></div>
      ${stamp!==false?`<img src="img/qt-stamp.jpg" alt="報價專用章" class="qt-stamp">`:`<span class="qt-stamp"></span>`}
    </div>
  </div>`;
}
function openQuotePrint(id,qid,fallback){
  const r=S.inq.find(x=>x.id===id),q=(r&&quotesOf(r).find(x=>x.id===qid))||fallback;if(!q)return;
  const sh=openSheet(`<div class="sheet-head"><div><h2>報價單 ${esc(q.no)}</h2><div class="sub">第 ${esc(q.ver)} 版 · ${esc(q.date)} · 含稅 ${money(q.total)}</div></div>
    ${r?`<button class="btn sm" id="qEdit">修改數量／備註</button>`:""}<button class="btn primary sm" id="qPrint">列印／存成 PDF</button><button class="btn ghost" data-close>關閉</button></div>
    <label class="qt-stampsw"><input type="checkbox" id="qStamp" ${S.pricing.stamp?"checked":""}> 加蓋報價專用章</label>
    <div class="qt-wrap"><div id="qDocBox">${quoteHtml(q,S.pricing.stamp)}</div></div>
    <p class="note">列印時請選「橫向」。存成 PDF：列印視窗的「目的地」選「另存為 PDF」。按「修改數量／備註」會產生新的一版，這一版保留不變。</p>`);
  // 預覽縮放到視窗寬度（列印時是原尺寸 A4 橫式）
  const fit=()=>{const w=sh.querySelector(".qt-wrap"),d=sh.querySelector(".qtpl");if(!w||!d)return;const z=Math.min(1,(w.clientWidth-2)/1040);d.style.zoom=z>0?String(z):"1"};
  const stampEl=sh.querySelector("#qStamp");stampEl.onchange=()=>{sh.querySelector("#qDocBox").innerHTML=quoteHtml(q,stampEl.checked);fit()};
  fit();const onRs=()=>fit();window.addEventListener("resize",onRs);S.onSheetClose=()=>window.removeEventListener("resize",onRs);
  sh.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>{closeSheet();if(r)openDetail(id)});
  const qe=sh.querySelector("#qEdit");if(qe)qe.onclick=()=>{closeSheet();openQuote(id,0,q)};
  sh.querySelector("#qPrint").onclick=()=>{
    let root=document.getElementById("printRoot");if(!root){root=document.createElement("div");root.id="printRoot";document.body.appendChild(root)}
    root.innerHTML=quoteHtml(q,stampEl.checked);document.body.classList.add("printing");
    const oldTitle=document.title;document.title="報價單_"+q.no+"_"+(q.company||q.contact||"");
    const done=()=>{document.body.classList.remove("printing");root.innerHTML="";document.title=oldTitle;window.removeEventListener("afterprint",done)};
    window.addEventListener("afterprint",done);window.print();setTimeout(()=>{if(!window.matchMedia("print").matches)done()},1500)};
}
function quoteCard(r){
  if(!S.pricing.items.length)return "";
  const qs=quotesOf(r).slice().reverse();
  return `<div class="card qcard"><h3>報價單 <small>${qs.length?qs.length+" 份":"尚未報價"}</small><button type="button" class="btn sm primary" id="dQuote" style="margin-left:auto">${qs.length?"修改報價（第 "+(qs.reduce((a,q)=>Math.max(a,+q.ver||0),0)+1)+" 版）":"＋ 產生報價單"}</button></h3>
    ${qs.length?`<div class="qlist">${qs.map(q=>`<button type="button" class="qitem" data-q="${esc(q.id)}"><span><b>${esc(q.no)}</b> <small>第 ${esc(q.ver)} 版 · ${esc(q.date)} · ${esc(q.by||"")}</small></span><span class="num">未稅 ${money(q.subtotal)} ／ 含稅 <b>${money(q.total)}</b></span></button>`).join("")}</div>`:`<p class="note" style="margin:0">填台數、選到場，系統自動算稅金和總計。</p>`}
  </div>`;
}
// 設定 → 報價設定：品項、單價、稅率、公司抬頭（只有管理者可以改）
function renderPricing(B){
  const P=S.pricing,ed=S.isAdmin,dis=ed?"":"disabled";
  let items=P.items.map(x=>({...x}));
  const draw=()=>{
    B.innerHTML=`<p class="note" style="font-size:13px">${ed?"調整後按「儲存報價設定」，之後產生的報價單套用新價格；已經產生的報價單不會改變。":"只有管理者可以修改報價設定。"}所有單價為未稅。</p>
    <div class="card"><h3>報價品項</h3><div class="tbl-wrap"><table class="t prtbl"><thead><tr><th>品項名稱</th><th>單位</th><th>單價（未稅）</th><th>填寫方式</th><th>說明</th>${ed?"<th></th>":""}</tr></thead><tbody>
      ${items.map((x,i)=>`<tr data-i="${i}"><td><input data-k="name" maxlength="40" value="${esc(x.name)}" ${dis}></td><td><input data-k="unit" maxlength="6" value="${esc(x.unit)}" style="width:60px" ${dis}></td>
        <td><input data-k="price" type="number" min="0" step="1" value="${esc(x.price)}" style="width:110px" ${dis}></td>
        <td><select data-k="kind" ${dis}><option value="qty" ${x.kind==="qty"?"selected":""}>填數量</option><option value="yn" ${x.kind==="yn"?"selected":""}>選有／沒有</option></select></td>
        <td><input data-k="note" maxlength="60" value="${esc(x.note)}" ${dis}></td>${ed?`<td><button type="button" class="btn sm ghost" data-del="${i}">刪除</button></td>`:""}</tr>`).join("")}
    </tbody></table></div>${ed?`<button type="button" class="btn sm" id="prAdd" style="margin-top:8px">＋ 新增品項</button>`:""}</div>
    <div class="card"><h3>稅率與報價單抬頭</h3><div class="grid">
      <label class="f"><span class="lbl">營業稅率（%）</span><input id="prTax" type="number" min="0" max="30" step="0.1" value="${Math.round(P.taxRate*1000)/10}" ${dis}></label>
      <label class="f"><span class="lbl">公司名稱</span><input id="prCo" maxlength="60" value="${esc(P.company)}" ${dis}></label>
      <label class="f full"><span class="lbl">公司資訊（統編、電話等）</span><input id="prInfo" maxlength="160" value="${esc(P.companyInfo)}" ${dis}></label>
      <label class="f full"><span class="lbl">報價單預設備註（印在「六、備註」，每份報價可修改）</span><textarea id="prNote" rows="2" maxlength="1000" ${dis}>${esc(P.quoteNote)}</textarea></label></div></div>
    <div class="card"><h3>報價單範本內容</h3><div class="grid">
      <label class="f"><span class="lbl">公司電話</span><input id="prTel" maxlength="30" value="${esc(P.tel)}" ${dis}></label>
      <label class="f"><span class="lbl">公司傳真</span><input id="prFax" maxlength="30" value="${esc(P.fax)}" ${dis}></label>
      <label class="f"><span class="lbl">報價有效期限（天）</span><input id="prValid" type="number" min="1" max="365" value="${esc(P.validDays)}" ${dis}></label>
      <label class="f"><span class="lbl">收款條件</span><input id="prPay" maxlength="80" value="${esc(P.payTerms)}" ${dis}></label>
      <label class="f full"><span class="lbl">右側「備註」欄內容（案件地址會自動放在最上面）</span><textarea id="prTerms" rows="8" maxlength="1500" ${dis}>${esc(P.terms)}</textarea></label>
      <label class="f full"><span><input type="checkbox" id="prStamp" ${P.stamp?"checked":""} ${dis}> 報價單預設加蓋報價專用章（列印前仍可取消）</span></label></div></div>
    ${ed?`<div class="form-actions"><span class="err" id="prErr"></span><button class="btn primary" id="prSave">儲存報價設定</button></div>`:""}`;
    if(!ed)return;
    B.querySelectorAll(".prtbl [data-k]").forEach(el=>el.addEventListener("input",()=>{const x=items[+el.closest("tr").dataset.i];x[el.dataset.k]=el.dataset.k==="price"?el.value:el.value}));
    B.querySelectorAll(".prtbl [data-k=kind]").forEach(el=>el.addEventListener("change",()=>{items[+el.closest("tr").dataset.i].kind=el.value}));
    B.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{items.splice(+b.dataset.del,1);draw()});
    B.querySelector("#prAdd").onclick=()=>{if(items.length>=20){toast("品項最多 20 個");return}items.push({id:"i"+Math.random().toString(36).slice(2,8),name:"",unit:"式",price:0,kind:"qty",note:""});draw()};
    B.querySelector("#prSave").onclick=()=>{
      const err=B.querySelector("#prErr"),tax=+B.querySelector("#prTax").value;
      const clean=items.map(x=>({...x,name:cut(x.name,40),unit:cut(x.unit,6),note:cut(x.note,60),price:Math.round(+x.price)}));
      if(clean.some(x=>!x.name)){err.textContent="品項名稱不能空白";return}
      if(clean.some(x=>!(x.price>=0&&x.price<=9999999))){err.textContent="單價要是 0～9,999,999 的整數";return}
      if(!(tax>=0&&tax<=30)){err.textContent="稅率要在 0～30% 之間";return}
      const doc={items:clean,taxRate:Math.round(tax*10)/1000,company:cut(B.querySelector("#prCo").value,60),companyInfo:cut(B.querySelector("#prInfo").value,160),
        quoteNote:B.querySelector("#prNote").value.slice(0,1000),
        tel:cut(B.querySelector("#prTel").value,30),fax:cut(B.querySelector("#prFax").value,30),validDays:Math.round(+B.querySelector("#prValid").value),
        payTerms:cut(B.querySelector("#prPay").value,80),terms:B.querySelector("#prTerms").value.replace(/\r/g,"").slice(0,1500),stamp:B.querySelector("#prStamp").checked,
        updatedAt:new Date().toISOString(),by:S.email};
      if(!(doc.validDays>=1&&doc.validDays<=365)){err.textContent="有效期限要在 1～365 天";return}
      S.pricing=normPricing(doc);write(F.setDoc(F.doc(fs,"config","pricing"),doc),"報價設定已儲存");
    };
  };
  draw();
}

/* ---------- 儀表板 ---------- */
S.dRange=S.dRange||"30";S.dMine=false;
function dRangeStart(k){const t=today();if(k==="all")return "0000-00-00";if(k==="month")return t.slice(0,8)+"01";if(k==="year")return t.slice(0,4)+"-01-01";const x=new Date();x.setDate(x.getDate()-(+k)+1);return ymd(x)}
function dPrevRange(k){ // 對照的前一段期間
  if(k==="all")return ["9999-99-99","0000-00-00"];
  const s=parseDay(dRangeStart(k)),e=new Date();const len=Math.round((e-s)/dayMs)+1;
  const ps=new Date(s);ps.setDate(ps.getDate()-len);const pe=new Date(s);pe.setDate(pe.getDate()-1);return [ymd(ps),ymd(pe)];
}
const stampMs=a=>{const m=String(a||"").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);return m?new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5]).getTime():NaN};
function firstReplyHours(r){const f=(r.followups||[]).find(x=>x.method!=="建立"&&x.method!=="系統");if(!f)return null;const h=(stampMs(f.at)-createdMs(r))/36e5;return isNaN(h)||h<0?null:h}
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
function delta(cur,prev,fmt,goodUp=true){
  if(prev==null||cur==null||prev===0&&cur===0)return '<span class="dl-flat">與前期持平</span>';
  if(!prev)return '<span class="dl-flat">前期無資料</span>';
  const d=(cur-prev)/prev,up=d>0,good=up===goodUp;
  if(Math.abs(d)<.005)return '<span class="dl-flat">與前期持平</span>';
  return `<span class="${good?"dl-good":"dl-bad"}">${up?"▲":"▼"} ${Math.round(Math.abs(d)*100)}%</span><span class="dl-flat"> vs 前期 ${fmt(prev)}</span>`;
}
const fmtH=h=>h==null?"—":h<24?Math.round(h)+" 小時":(h/24).toFixed(1)+" 天";
function lineColor(l,i){return i===0?"var(--c1)":i===1?"var(--c2)":"var(--c-other)"}

function barChart({id,cats,series,height=180,yLabel="",width=560}){
  // series: [{name,color,values[]}] — 堆疊直條，片段間留 2px 間隙
  const W=width,H=height,pl=34,pr=8,pt=16,pb=26;
  const tot=cats.map((_,i)=>series.reduce((a,s)=>a+(s.values[i]||0),0));
  const max=Math.max(4,...tot),step=Math.ceil(max/4),top=step*4;
  const bw=(W-pl-pr)/cats.length,w=Math.min(34,bw*.62);
  const y=v=>H-pb-(H-pt-pb)*v/top;
  let g="";
  for(let i=0;i<=4;i++){const v=step*i,yy=y(v);g+=`<line x1="${pl}" x2="${W-pr}" y1="${yy}" y2="${yy}" stroke="var(--grid)" stroke-width="1"/><text x="${pl-6}" y="${yy+4}" text-anchor="end" class="ax">${v}</text>`}
  let bars="";
  cats.forEach((c,i)=>{
    const x=pl+i*bw+(bw-w)/2;let base=0;
    const tip=`${c.full||c.label}：共 ${tot[i]}`+(series.length>1?"｜"+series.map(s=>`${s.name} ${s.values[i]||0}`).join("、"):"");
    series.forEach((s,si)=>{const v=s.values[i]||0;if(!v)return;
      const y0=y(base),y1=y(base+v);const h=Math.max(0,y0-y1-(base>0?2:0));
      const isTop=series.slice(si+1).every(t=>!(t.values[i]));
      bars+=isTop?`<path d="${roundTop(x,y1,w,h)}" fill="${s.color}"/>`:`<rect x="${x}" y="${y1}" width="${w}" height="${h}" fill="${s.color}"/>`;
      base+=v});
    bars+=`<rect class="hit" x="${pl+i*bw}" y="${pt}" width="${bw}" height="${H-pt-pb}" data-tip="${esc(tip)}"/>`;
    if(c.label)bars+=`<text x="${x+w/2}" y="${H-8}" text-anchor="middle" class="ax">${esc(c.label)}</text>`;
    if(tot[i]&&c.showTotal!==false)bars+=`<text x="${x+w/2}" y="${y(tot[i])-4}" text-anchor="middle" class="val">${tot[i]}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" id="${id}" role="img" aria-label="${esc(yLabel)}">${g}${bars}</svg>`;
}
function roundTop(x,y,w,h){const r=Math.min(4,h,w/2);return `M${x},${y+h} L${x},${y+r} Q${x},${y} ${x+r},${y} L${x+w-r},${y} Q${x+w},${y} ${x+w},${y+r} L${x+w},${y+h} Z`}
function legendHtml(series){return series.length>1?`<div class="legend">${series.map(s=>`<span style="--c:${s.color}">${esc(s.name)}</span>`).join("")}</div>`:""}
function bindTips(root){
  let tip=document.getElementById("chartTip");if(!tip){tip=document.createElement("div");tip.id="chartTip";tip.className="ctip";tip.hidden=true;document.body.appendChild(tip)}
  root.querySelectorAll("[data-tip]").forEach(el=>{
    el.addEventListener("pointerenter",()=>{tip.textContent=el.dataset.tip;tip.hidden=false;el.classList.add("on")});
    el.addEventListener("pointermove",e=>{const x=Math.min(e.clientX+14,window.innerWidth-tip.offsetWidth-8);tip.style.left=x+"px";tip.style.top=(e.clientY-tip.offsetHeight-12)+"px"});
    el.addEventListener("pointerleave",()=>{tip.hidden=true;el.classList.remove("on")});
  });
}

function renderDash(){
  const V=$("#v-dash"),t=today(),k=S.dRange;
  const start=dRangeStart(k),[ps,pe]=dPrevRange(k);
  const base=S.inq.filter(r=>!S.dMine||r.owner===S.me);
  const inR=(r,a,b)=>(r.date||"")>=a&&(r.date||"")<=b;
  const cur=base.filter(r=>inR(r,start,t)),prev=base.filter(r=>inR(r,ps,pe));
  const wonIn=(a,b)=>base.filter(r=>r.stage==="成交"&&(r.wonDate||r.closedAt||"")>=a&&(r.wonDate||r.closedAt||"")<=b);
  const wonC=wonIn(start,t),wonP=wonIn(ps,pe);
  const sumW=a=>a.reduce((x,r)=>x+(+r.wonAmount||0),0);
  const closedIn=(a,b)=>base.filter(r=>!isOpen(r.stage)&&(r.closedAt||"")>=a&&(r.closedAt||"")<=b);
  const cc=closedIn(start,t),cp=closedIn(ps,pe);
  const rate=a=>a.length?a.filter(r=>r.stage==="成交").length/a.length:null;
  const frC=avg(cur.map(firstReplyHours).filter(h=>h!=null)),frP=avg(prev.map(firstReplyHours).filter(h=>h!=null));
  const cycle=a=>avg(a.filter(r=>r.date&&(r.wonDate||r.closedAt)).map(r=>Math.max(0,(parseDay(r.wonDate||r.closedAt)-parseDay(r.date))/dayMs)));
  const open=base.filter(r=>isOpen(r.stage));
  const pipe=open.reduce((a,r)=>a+(+(r.quoteAmount||r.estAmount)||0),0);
  const rr=R();

  // 待辦清單
  const lists=[
    ["remind",`超過 ${rr.remind.hours} 小時未追蹤`,base.filter(remindDue),r=>`${hoursSinceCreated(r)} 小時`],
    ["quote",`報價後 ${rr.quote.hours} 小時未追蹤`,base.filter(quoteDue),r=>`報價後 ${hoursSinceQuote(r)} 小時`],
    ["overdue","下次行動已逾期",open.filter(r=>dueState(r)==="overdue"),r=>`逾期 ${daysSince(r.nextDate)} 天`],
    ["today","今天要跟進",open.filter(r=>dueState(r)==="today"),r=>r.nextAction||"今天"],
    ["effect","14天關心除味效果",base.filter(effectDue),r=>`成交 ${wonDays(r)} 天`],
    ["care","30日滿意保固提醒",base.filter(careDue),r=>`成交 ${wonDays(r)} 天`],
    ["soon","5 天內將自動結案",base.filter(soonLost),r=>`剩 ${lostLeft(r)} 天`]
  ];
  const todo=lists.map(([key,title,arr,meta])=>`<div class="todo-col ${key}"><h4>${title}<b>${arr.length}</b></h4>${arr.slice(0,6).map(r=>`<button class="todo-item" data-id="${esc(r.id)}"><span>${esc(custName(r))}</span><small>${esc(meta(r))} · ${esc(r.owner||"未指派")}</small></button>`).join("")||'<div class="todo-empty">沒有</div>'}${arr.length>6?`<button class="todo-more" data-go="${key}">看全部 ${arr.length} 件 →</button>`:""}</div>`).join("");

  // 詢價頻率：近 12 週，依業務線堆疊
  const L=lines(),wk=[];const now=new Date();const mon=new Date(now);mon.setDate(now.getDate()-((now.getDay()+6)%7));mon.setHours(0,0,0,0);
  for(let i=11;i>=0;i--){const s=new Date(mon);s.setDate(s.getDate()-7*i);const e=new Date(s);e.setDate(e.getDate()+6);wk.push([ymd(s),ymd(e)])}
  const seriesW=L.slice(0,2).map((l,i)=>({name:l,color:lineColor(l,i),values:wk.map(([a,b])=>base.filter(r=>inR(r,a,b)&&[...linesOfRec(r)][0]===l).length)}));
  if(L.length>2||base.some(r=>!(r.services||[]).length))seriesW.push({name:"其他",color:"var(--c-other)",values:wk.map(([a,b])=>base.filter(r=>inR(r,a,b)&&!L.slice(0,2).includes([...linesOfRec(r)][0])).length)});
  const wkCats=wk.map(([a,b],i)=>({label:i%2===1||i===11?a.slice(5).replace("-","/"):"",full:`${a.slice(5).replace("-","/")}–${b.slice(5).replace("-","/")} 那週`}));
  const wkAvg=avg(seriesW.length?wk.map((_,i)=>seriesW.reduce((a,s)=>a+s.values[i],0)):[]);
  // 星期分布、時段分布（近 90 天）
  const s90=dRangeStart("90"),r90=base.filter(r=>inR(r,s90,t));
  const wd=["一","二","三","四","五","六","日"],wdv=[0,0,0,0,0,0,0];r90.forEach(r=>{wdv[(parseDay(r.date).getDay()+6)%7]++});
  const hrs=[["9 點前",0,9],["9–12",9,12],["12–14",12,14],["14–18",14,18],["18 點後",18,24]],hv=hrs.map(()=>0);
  r90.forEach(r=>{if(!r.createdAt)return;const h=new Date(r.createdAt).getHours();const i=hrs.findIndex(x=>h>=x[1]&&h<x[2]);if(i>=0)hv[i]++});

  // 漏斗
  const funnel=STAGES.filter(s=>s.open).map(s=>{const a=open.filter(r=>r.stage===s.k);return{k:s.k,c:s.c,n:a.length,amt:a.reduce((x,r)=>x+(+(r.quoteAmount||r.estAmount)||0),0)}});
  const fMax=Math.max(1,...funnel.map(f=>f.n));

  // 業務表現
  const owners=[...new Set([...staff(),...base.map(r=>r.owner).filter(Boolean)])];
  const ownerRows=owners.map(o=>{const mine=base.filter(r=>r.owner===o);const c=mine.filter(r=>inR(r,start,t));const w=wonC.filter(r=>r.owner===o);
    return{o,open:mine.filter(r=>isOpen(r.stage)).length,neu:c.length,won:w.length,amt:sumW(w),over:mine.filter(r=>isOpen(r.stage)&&dueState(r)==="overdue").length+mine.filter(remindDue).length,fr:avg(c.map(firstReplyHours).filter(h=>h!=null))}}).filter(x=>x.open||x.neu||x.won);

  // 來源前 5（本期）
  const src=agg(cur,r=>r.channel).slice(0,5),sMax=Math.max(1,...src.map(o=>o.n));
  // 最近成交
  const recentWon=base.filter(r=>r.stage==="成交").sort((a,b)=>(b.wonDate||b.closedAt||"").localeCompare(a.wonDate||a.closedAt||"")).slice(0,5);
  const returning=cur.filter(r=>r.returning==="是"||String(r.channel||"").includes("回購")).length;

  V.innerHTML=`
  <div class="an-head"><h2>儀表板</h2>
    <label class="mine"><input type="checkbox" id="dMine" ${S.dMine?"checked":""}> 只看我的案件</label>
    <select id="dRange" aria-label="期間">${[["7","近 7 天"],["30","近 30 天"],["month","本月"],["90","近 90 天"],["year","今年"],["all","全部"]].map(([v,l])=>`<option value="${v}" ${k===v?"selected":""}>${l}</option>`).join("")}</select>
  </div>
  <div class="tiles">
    <div class="tile"><div class="k">新詢價</div><div class="v">${cur.length}</div><div class="d">${delta(cur.length,prev.length,x=>x+" 件")}</div></div>
    <div class="tile"><div class="k">成交金額</div><div class="v">${money(sumW(wonC))}</div><div class="d">${wonC.length} 件 · ${delta(sumW(wonC),sumW(wonP),money)}</div></div>
    <div class="tile"><div class="k">成交率 <small>本期結案的案件</small></div><div class="v">${rate(cc)==null?"—":Math.round(rate(cc)*100)+"%"}</div><div class="d">${cc.length} 件結案 · ${delta(rate(cc),rate(cp),x=>Math.round(x*100)+"%")}</div></div>
    <div class="tile"><div class="k">平均首次回應</div><div class="v">${fmtH(frC)}</div><div class="d">從建立到第一筆追蹤 · ${delta(frC,frP,fmtH,false)}</div></div>
    <div class="tile"><div class="k">進行中金額</div><div class="v">${money(pipe)}</div><div class="d">${open.length} 件進行中 · 以報價或預估金額計</div></div>
    <div class="tile"><div class="k">平均成交天數</div><div class="v">${cycle(wonC)==null?"—":Math.round(cycle(wonC))+" 天"}</div><div class="d">從詢價到成交${returning?` · 本期 ${returning} 件舊客回購`:""}</div></div>
  </div>

  <div class="card"><h3>追蹤客戶 <small>點客戶直接打開案件</small></h3><div class="todo-grid">${todo}</div></div>

  <div class="an-grid">
    <div class="card full"><h3>詢價頻率 <small>近 12 週，每週新詢價數；平均每週 ${wkAvg==null?"—":wkAvg.toFixed(1)} 件</small></h3>
      ${legendHtml(seriesW)}<div class="scroll-x">${barChart({id:"wkChart",cats:wkCats,series:seriesW,yLabel:"近 12 週每週詢價數",width:1100,height:230})}</div></div>
    <div class="card"><h3>哪幾天詢價最多 <small>近 90 天，依星期</small></h3>
      ${barChart({id:"wdChart",cats:wd.map(d=>({label:"週"+d,full:"星期"+d})),series:[{name:"詢價",color:"var(--c1)",values:wdv}],height:160,yLabel:"依星期的詢價數"})}</div>
    <div class="card"><h3>什麼時段詢價 <small>近 90 天，依建立時間</small></h3>
      ${barChart({id:"hrChart",cats:hrs.map(h=>({label:h[0],full:h[0]})),series:[{name:"詢價",color:"var(--c1)",values:hv}],height:160,yLabel:"依時段的詢價數"})}</div>
    <div class="card"><h3>進行中案件卡在哪 <small>依階段</small></h3>
      <div class="funnel">${funnel.map(f=>`<div class="fr" data-tip="${esc(f.k)}：${f.n} 件，${money(f.amt)}"><span class="stage ${f.c}">${esc(f.k)}</span><span class="fbar"><i style="width:${f.n?Math.max(3,f.n/fMax*100):0}%"></i></span><b>${f.n}</b><small>${money(f.amt)}</small></div>`).join("")}</div></div>
    <div class="card"><h3>本期詢價來源 <small>前 5 名</small></h3>
      <div class="funnel">${src.map(o=>`<div class="fr" data-tip="${esc(o.k)}：詢價 ${o.n}，成交 ${o.won}"><span class="sname">${esc(o.k)}</span><span class="fbar"><i style="width:${Math.max(3,o.n/sMax*100)}%"></i></span><b>${o.n}</b><small>成交 ${o.won}</small></div>`).join("")||'<div class="dim">本期沒有詢價</div>'}</div></div>
    <div class="card full"><h3>業務表現 <small>本期</small></h3>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>接單同仁</th><th>進行中</th><th>本期新詢價</th><th>本期成交</th><th>成交金額</th><th>待處理</th><th>平均首次回應</th></tr></thead>
      <tbody>${ownerRows.map(o=>`<tr><td>${esc(o.o)}</td><td>${o.open}</td><td>${o.neu}</td><td>${o.won}</td><td>${money(o.amt)}</td><td class="${o.over?"warnc":""}">${o.over}</td><td>${fmtH(o.fr)}</td></tr>`).join("")||'<tr><td colspan="7" class="dim">本期沒有資料</td></tr>'}</tbody></table></div>
      <div class="note">待處理 = 逾期未跟進＋超過 ${rr.remind.hours} 小時未追蹤</div></div>
    <div class="card full"><h3>最近成交</h3>
      <div class="tbl-wrap"><table class="t won"><thead><tr><th>客戶</th><th>服務</th><th>來源</th><th>成交日期</th><th>金額</th><th>接單同仁</th></tr></thead>
      <tbody>${recentWon.map(r=>`<tr class="clk" data-id="${esc(r.id)}"><td>${esc(custName(r))}</td><td style="font-family:var(--sans)">${esc((r.services||[]).join("、"))}</td><td style="font-family:var(--sans)">${esc(r.channel||"")}</td><td>${esc(r.wonDate||r.closedAt||"")}</td><td>${money(r.wonAmount)}</td><td style="font-family:var(--sans)">${esc(r.owner||"")}</td></tr>`).join("")||'<tr><td colspan="6" class="dim">還沒有成交案件</td></tr>'}</tbody></table></div></div>
  </div>`;
  V.querySelector("#dRange").onchange=e=>{S.dRange=e.target.value;S.recN=30;renderDash()};
  V.querySelector("#dMine").onchange=e=>{S.dMine=e.target.checked;renderDash()};
  V.querySelectorAll("[data-id]").forEach(b=>b.onclick=()=>openDetail(b.dataset.id));
  V.querySelectorAll(".todo-more").forEach(b=>b.onclick=()=>{S.f.stage=b.dataset.go;setView("list")});
  bindTips(V);
  S.dRangeLabel={"7":"近 7 天","30":"近 30 天","month":"本月","90":"近 90 天","year":"今年","all":"全部期間"}[k]||"";
  renderDashMore(V,cur);
}

/* ---------- 系統（管理者專用）：一鍵備份、匯出 CSV ---------- */
function renderSys(){
  const V=$("#v-sys");
  if(!S.isAdmin){V.innerHTML='<div class="empty">只有管理者可以使用「系統」功能。</div>';return}
  S.csvRange=S.csvRange||"all";
  const pick=[["all","全部"],["year","今年"],["90","近 90 天"],["month","本月"]];
  V.innerHTML=`<div class="an-head"><h2>系統</h2><span class="note">只有系統擁有者與管理者看得到這一頁</span></div>
    <div class="card"><h3>匯出 CSV <small>用 Excel 打開，做報表或交給會計</small></h3>
      <div class="sys-row"><label class="f" style="max-width:220px">期間（依詢價日期）<select id="csvRange">${pick.map(([k,l])=>`<option value="${k}" ${S.csvRange===k?"selected":""}>${l}</option>`).join("")}</select></label>
      <button class="btn primary" id="csvGo">匯出 CSV</button><span class="note" id="csvMsg"></span></div>
    </div>
    <div id="sysBackup"></div>`;
  const rows=()=>{const k=S.csvRange;const st=k==="all"?"0000-00-00":k==="year"?today().slice(0,4)+"-01-01":k==="month"?today().slice(0,8)+"01":(()=>{const x=new Date();x.setDate(x.getDate()-90);return ymd(x)})();
    return S.inq.filter(r=>(r.date||"")>=st)};
  V.querySelector("#csvRange").onchange=e=>{S.csvRange=e.target.value};
  V.querySelector("#csvGo").onclick=()=>{const rs=rows();exportCsv(rs);V.querySelector("#csvMsg").textContent=`已匯出 ${rs.length} 筆`};
  renderBackup(V.querySelector("#sysBackup"));
}

/* ---------- 儀表板：客戶分析、全部詢價紀錄 ---------- */
function distCard(title,rows,keyFn){
  const list=agg(rows,keyFn).slice(0,8),max=Math.max(1,...list.map(o=>o.n));
  return `<div class="card"><h3>${esc(title)}</h3><div class="funnel">${list.map(o=>`<div class="fr" data-tip="${esc(o.k)}：詢價 ${o.n}，成交 ${o.won}，成交率 ${pct(o.won,o.won+o.lost)}"><span class="sname">${esc(o.k)}</span><span class="fbar"><i style="width:${Math.max(3,o.n/max*100)}%"></i></span><b>${o.n}</b><small>成交 ${o.won}</small></div>`).join("")||'<div class="dim" style="font-size:13px">尚無資料</div>'}</div></div>`;
}
function renderDashMore(V,rows){
  const box=document.createElement("div");box.id="dashMore";
  const cards=[["客戶類型／產業","industry"],["地區","city"],["詢問的服務","services"],["異味類型","odorType"],["格局","layout"],["新舊客戶","returning"]]
    .filter(([,id])=>on(id)).map(([t,id])=>distCard(t,rows,r=>{const v=r[id];if(id==="returning")return v==="是"?"舊客戶":v==="否"?"新客戶":"未確認";return v==null?[]:v})).join("");
  // 客戶排行：同一個公司／單位名稱合併
  const m=new Map();
  rows.forEach(r=>{const k=String(custName(r)).trim();const o=m.get(k)||{k,n:0,won:0,amt:0,last:"",owner:"",ids:[]};
    o.n++;o.ids.push(r.id);if(r.stage==="成交"){o.won++;o.amt+=(+r.wonAmount||0)}if((r.date||"")>o.last){o.last=r.date||"";o.owner=r.owner||""}m.set(k,o)});
  const custs=[...m.values()].sort((a,b)=>b.amt-a.amt||b.n-a.n);
  const repeat=custs.filter(c=>c.n>=2).length;
  box.innerHTML=`
    <h2 class="dsec">客戶分析 <small>${esc(S.dRangeLabel||"")}・共 ${custs.length} 位客戶，${repeat} 位詢價 2 次以上</small></h2>
    <div class="an-grid three">${cards}</div>
    <div class="card"><h3>客戶排行 <small>依成交金額，其次依詢價次數</small></h3>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>客戶</th><th>詢價次數</th><th>成交次數</th><th>成交金額</th><th>最近詢價</th><th>接單同仁</th></tr></thead>
      <tbody>${custs.slice(0,10).map(c=>`<tr class="clk" data-id="${esc(c.ids[0])}"><td>${esc(c.k)}</td><td>${c.n}</td><td>${c.won}</td><td>${money(c.amt)}</td><td>${esc(c.last)}</td><td style="font-family:var(--sans)">${esc(c.owner)}</td></tr>`).join("")||'<tr><td colspan="6" class="dim">尚無資料</td></tr>'}</tbody></table></div></div>
    <h2 class="dsec">全部詢價紀錄 <small>${rows.length} 筆・點標題排序、點一列打開案件</small></h2>
    <div class="card"><input type="search" id="recQ" class="recq" placeholder="搜尋客戶、電話、地區、服務、接單同仁…" value="${esc(S.recQ||"")}">
      <div class="tbl-wrap"><table class="t rec"><thead><tr>${[["date","詢價日期"],["code","編號"],["company","客戶"],["services","詢問服務"],["city","地區"],["channel","來源"],["stage","階段"],["quoteAmount","報價金額"],["owner","接單同仁"]].map(([k,l])=>`<th data-sort="${k}" class="${S.recSort===k?"on":""}">${l}${S.recSort===k?(S.recDir>0?" ▲":" ▼"):""}</th>`).join("")}</tr></thead><tbody id="recBody"></tbody></table></div>
      <div class="form-actions" style="justify-content:center"><button class="btn sm" id="recMore" hidden>顯示更多</button></div></div>`;
  V.appendChild(box);
  S.recSort=S.recSort||"date";S.recDir=S.recDir||-1;S.recN=S.recN||30;
  const draw=()=>{
    const q=(S.recQ||"").toLowerCase();
    let list=rows.filter(r=>!q||[r.company,r.contact,r.phone,r.city,(r.services||[]).join(" "),r.owner,r.code,r.channel,r.stage].join(" ").toLowerCase().includes(q));
    const k=S.recSort,d=S.recDir;
    list.sort((a,b)=>{let x=a[k],y=b[k];if(Array.isArray(x))x=x.join("");if(Array.isArray(y))y=y.join("");
      if(k==="quoteAmount"){x=+x||0;y=+y||0;return (x-y)*d}return String(x||"").localeCompare(String(y||""))*d});
    const st=r=>STAGE_MAP[r.stage]||STAGES[0];
    box.querySelector("#recBody").innerHTML=list.slice(0,S.recN).map(r=>`<tr class="clk" data-id="${esc(r.id)}"><td>${esc(r.date||"")}</td><td>${esc(r.code||"")}</td><td>${esc(custName(r))}</td><td>${esc((r.services||[]).join("、"))}</td><td>${esc(r.city||"")}</td><td>${esc(r.channel||"")}</td><td><span class="stage ${st(r).c}">${esc(r.stage||"")}</span></td><td>${r.quoteAmount?money(r.quoteAmount):""}</td><td>${esc(r.owner||"")}</td></tr>`).join("")||'<tr><td colspan="9" class="dim">沒有符合的紀錄</td></tr>';
    box.querySelectorAll("#recBody [data-id]").forEach(tr=>tr.onclick=()=>openDetail(tr.dataset.id));
    const more=box.querySelector("#recMore");more.hidden=list.length<=S.recN;more.textContent=`顯示更多（還有 ${Math.max(0,list.length-S.recN)} 筆）`;
  };
  box.querySelector("#recQ").oninput=e=>{S.recQ=e.target.value;S.recN=30;draw()};
  box.querySelectorAll("th[data-sort]").forEach(th=>th.onclick=()=>{const k=th.dataset.sort;if(S.recSort===k)S.recDir=-S.recDir;else{S.recSort=k;S.recDir=k==="date"||k==="quoteAmount"?-1:1}
    box.querySelectorAll("th[data-sort]").forEach(h=>{const kk=h.dataset.sort;h.classList.toggle("on",kk===S.recSort);h.textContent=h.textContent.replace(/ [▲▼]$/,"")+(kk===S.recSort?(S.recDir>0?" ▲":" ▼"):"")});draw()});
  box.querySelector("#recMore").onclick=()=>{S.recN+=50;draw()};
  box.querySelectorAll("tbody .clk[data-id]").forEach(tr=>{if(!tr.closest("#recBody"))tr.onclick=()=>openDetail(tr.dataset.id)});
  draw();bindTips(box);
}

/* ---------- stats ---------- */
function rangeStart(){
  const t=today();
  if(S.range==="month")return t.slice(0,8)+"01";
  if(S.range==="year")return t.slice(0,4)+"-01-01";
  if(S.range==="all")return "0000-00-00";
  const x=new Date();x.setDate(x.getDate()-(+S.range));return ymd(x);
}
function monthsBetween(a,b){const out=[];let [y,m]=a.split("-").map(Number);const [by,bm]=b.split("-").map(Number);while(y<by||(y===by&&m<=bm)){out.push(y+"-"+pad(m));m++;if(m>12){m=1;y++}if(out.length>240)break}return out}
function agg(rows,keyFn){
  const m=new Map();
  rows.forEach(r=>{[].concat(keyFn(r)).forEach(k=>{if(k==null||k==="")return;const o=m.get(k)||{k,n:0,won:0,lost:0,open:0,amt:0};o.n++;
    if(r.stage==="成交"){o.won++;o.amt+=(+r.wonAmount||0)}else if(r.stage==="未成交")o.lost++;else o.open++;m.set(k,o)})});
  return [...m.values()].sort((a,b)=>b.n-a.n);
}
function aggTable(list,label){
  const max=Math.max(1,...list.map(o=>o.n));
  return `<div class="tbl-wrap"><table class="t"><thead><tr><th>${esc(label)}</th><th>詢價</th><th>進行中</th><th>成交</th><th>成交率</th><th>成交金額</th></tr></thead><tbody>${
    list.map(o=>`<tr><td>${esc(o.k)}</td><td><div class="barcell">${o.n}<i style="width:${Math.round(o.n/max*70)}px"></i></div></td><td>${o.open}</td><td>${o.won}</td><td>${pct(o.won,o.won+o.lost)}</td><td>${money(o.amt)}</td></tr>`).join("")||'<tr><td colspan="6" class="dim">此期間沒有資料</td></tr>'}</tbody></table></div>`;
}
function renderStats(){
  const V=$("#v-stats"),start=rangeStart(),t=today();
  const rows=S.inq.filter(r=>(r.date||"")>=start&&(r.date||"")<=t);
  const firstMonth=S.range==="all"?(S.inq.map(r=>r.date).filter(Boolean).sort()[0]||t).slice(0,7):start.slice(0,7);
  const months=monthsBetween(firstMonth,t.slice(0,7));
  const spend={};months.forEach(mo=>{const s=S.ad[mo]||{};Object.keys(s).forEach(ch=>spend[ch]=(spend[ch]||0)+(+s[ch]||0))});
  const totalSpend=Object.values(spend).reduce((a,b)=>a+b,0);
  const byCh=agg(rows,r=>r.channel);
  const maxCh=Math.max(1,...byCh.map(o=>o.n));
  const won=rows.filter(r=>r.stage==="成交"),lost=rows.filter(r=>r.stage==="未成交");
  const wonAmt=won.reduce((a,r)=>a+(+r.wonAmount||0),0);

  const chRows=byCh.map(o=>{const sp=spend[o.k]||0;return `<tr><td>${esc(o.k)}</td>
    <td><div class="barcell">${o.n}<i style="width:${Math.round(o.n/maxCh*70)}px"></i></div></td><td>${o.won}</td><td>${pct(o.won,o.won+o.lost)}</td><td>${money(o.amt)}</td>
    <td class="${sp?"":"dim"}">${sp?money(sp):"—"}</td><td class="${sp?"":"dim"}">${sp?money(sp/o.n):"—"}</td><td class="${sp&&o.won?"":"dim"}">${sp&&o.won?money(sp/o.won):"—"}</td><td class="${sp?"":"dim"}">${sp?(o.amt/sp).toFixed(1)+"x":"—"}</td></tr>`}).join("");

  const L=lines();
  const hm={};rows.forEach(r=>{linesOfRec(r).forEach(l=>{const k=r.channel+"|"+l;hm[k]=(hm[k]||0)+1})});
  const hmMax=Math.max(1,...Object.values(hm));
  const hmRows=byCh.map(o=>`<tr><td>${esc(o.k)}</td>${L.map(l=>{const n=hm[o.k+"|"+l]||0;const a=n?(.12+.75*n/hmMax):0;return `<td class="c" style="background:${n?`color-mix(in srgb, var(--brand) ${Math.round(a*100)}%, transparent)`:"transparent"}">${n||'<span class="dim">·</span>'}</td>`}).join("")}</tr>`).join("");

  // 依欄位分析：任何單選／複選／是否／文字欄位
  const anaFields=S.fields.filter(f=>f.enabled&&!LIST_SKIP_TYPES.has(f.type)&&!["channel","company","channelDetail","stage"].includes(f.id));
  if(!anaFields.some(f=>f.id===S.byField))S.byField=(anaFields.find(f=>f.id==="services")||anaFields[0]||{}).id;
  const bf=fld(S.byField);
  const byF=bf?agg(rows,r=>{const v=r[bf.id];return v==null?[]:v}):[];

  const tMonths=monthsBetween((()=>{const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-11);return ymd(d).slice(0,7)})(),t.slice(0,7));
  const colors=["var(--s-new)","var(--brand)","var(--s-visit)","var(--s-contact)"];
  const tm=tMonths.map(mo=>{const o={mo,tot:0};L.forEach(l=>o[l]=0);S.inq.forEach(r=>{if((r.date||"").startsWith(mo)){o.tot++;const p=[...linesOfRec(r)][0];if(p!=null)o[p]=(o[p]||0)+1}});return o});
  const niceMax=Math.ceil(Math.max(4,...tm.map(o=>o.tot))/4)*4;
  const W=640,H=200,pl=30,pr=8,pt=10,pb=24,bw=(W-pl-pr)/tm.length;
  let svg=`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="近 12 個月詢價數" style="max-width:100%;display:block">`;
  for(let i=0;i<=4;i++){const v=niceMax/4*i,y=H-pb-(H-pt-pb)*v/niceMax;svg+=`<line x1="${pl}" x2="${W-pr}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/><text x="${pl-6}" y="${y+4}" text-anchor="end" font-size="10" fill="var(--muted)" font-family="IBM Plex Mono,monospace">${v}</text>`}
  tm.forEach((o,i)=>{let y=H-pb;const x=pl+i*bw+bw*.18,w=bw*.64;
    L.forEach((l,li)=>{const h=(H-pt-pb)*(o[l]||0)/niceMax;if(h>0){y-=h;svg+=`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colors[li%colors.length]}"><title>${o.mo} ${esc(l)}：${o[l]}</title></rect>`}});
    if(o.tot)svg+=`<text x="${x+w/2}" y="${y-3}" text-anchor="middle" font-size="10" fill="var(--ink2)" font-family="IBM Plex Mono,monospace">${o.tot}</text>`;
    svg+=`<text x="${x+w/2}" y="${H-8}" text-anchor="middle" font-size="10" fill="var(--muted)" font-family="IBM Plex Mono,monospace">${+o.mo.slice(5)}月</text>`});
  svg+="</svg>";

  const lr={};lost.forEach(r=>{const k=r.lostReason||"未填";lr[k]=(lr[k]||0)+1});
  const lrArr=Object.entries(lr).sort((a,b)=>b[1]-a[1]);const lrMax=Math.max(1,...lrArr.map(x=>x[1]));
  const chOpts=(fld("channel")||{options:[]}).options;
  const adMonth=S.adMonth||t.slice(0,7),adCur=S.ad[adMonth]||{};
  V.innerHTML=`
    <div class="an-head"><h2>來源與服務分析</h2>
      <select id="rangeSel" aria-label="期間">${[["month","本月"],["30","近 30 天"],["90","近 3 個月"],["180","近 6 個月"],["year","今年"],["all","全部"]].map(([k,l])=>`<option value="${k}" ${S.range===k?"selected":""}>${l}</option>`).join("")}</select>

    </div>
    <div class="kpis" style="margin-top:14px">
      <div class="kpi" style="cursor:default"><div class="k">詢價數</div><div class="v">${rows.length}</div><div class="d">${esc(start==="0000-00-00"?"全部期間":start+" 起")}</div></div>
      <div class="kpi" style="cursor:default"><div class="k">成交率</div><div class="v">${pct(won.length,won.length+lost.length)}</div><div class="d">成交 ${won.length}・未成交 ${lost.length}・進行中 ${rows.length-won.length-lost.length}</div></div>
      <div class="kpi" style="cursor:default"><div class="k">成交金額</div><div class="v" style="font-size:22px">${money(wonAmt)}</div><div class="d">平均每案 ${won.length?money(wonAmt/won.length):"—"}</div></div>
      <div class="kpi" style="cursor:default"><div class="k">廣告費</div><div class="v" style="font-size:22px">${totalSpend?money(totalSpend):"—"}</div><div class="d">${totalSpend?"投報 "+(wonAmt/totalSpend).toFixed(1)+"x":"在下方登錄每月廣告費"}</div></div>
    </div>
    <div class="an-grid" style="margin-top:14px">
      <div class="card full"><h3>各來源管道成效 <small>成交率 = 成交 ÷（成交＋未成交），進行中不計</small></h3>
        <div class="tbl-wrap"><table class="t"><thead><tr><th>管道</th><th>詢價</th><th>成交</th><th>成交率</th><th>成交金額</th><th>廣告費</th><th>每筆詢價成本</th><th>每筆成交成本</th><th>投報</th></tr></thead>
        <tbody>${chRows||'<tr><td colspan="9" class="dim">此期間沒有詢價</td></tr>'}</tbody></table></div></div>
      <div class="card full"><h3 style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">依欄位分析
        <select id="byFieldSel" aria-label="分析欄位" style="font-weight:400">${anaFields.map(f=>`<option value="${esc(f.id)}" ${f.id===S.byField?"selected":""}>${esc(f.name)}</option>`).join("")}</select>
        <small>例如：客戶類型、縣市、介紹人、異味類型、緊急程度</small></h3>
        ${bf?aggTable(byF,bf.name):""}</div>
      <div class="card"><h3>哪個管道帶來哪條業務線</h3>
        <div class="tbl-wrap"><table class="t hm"><thead><tr><th>管道</th>${L.map(l=>`<th style="text-align:center">${esc(l)}</th>`).join("")}</tr></thead><tbody>${hmRows||`<tr><td colspan="${L.length+1}" class="dim">此期間沒有詢價</td></tr>`}</tbody></table></div>
        <div class="note">顏色越深，該管道帶來的這條業務線詢價越多。</div></div>
      <div class="card"><h3>近 12 個月詢價數 <small>依主要業務線</small></h3>
        <div class="legend">${L.map((l,i)=>`<span style="--c:${colors[i%colors.length]}">${esc(l)}</span>`).join("")}</div>${svg}</div>
      <div class="card full"><h3>未成交原因</h3>
        ${lrArr.length?`<table class="t"><tbody>${lrArr.map(([k,n])=>`<tr><td>${esc(k)}</td><td><div class="barcell">${n}<i style="width:${Math.round(n/lrMax*120)}px;background:var(--s-lost)"></i></div></td></tr>`).join("")}</tbody></table>`:'<div class="dim" style="font-size:13px">此期間沒有未成交案件</div>'}</div>
      ${S.isAdmin?`<div class="card full"><h3>登錄廣告費 <small>每月一次，填各管道的實際花費；沒花錢的管道留空</small></h3>
        <form id="adForm" novalidate>
          <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:12px"><label class="f">月份<input type="month" id="adMonth" value="${esc(adMonth)}"></label></div>
          <div class="adform">${chOpts.map((ch,i)=>`<label class="f">${esc(ch)}<input type="number" inputmode="numeric" id="ad_${i}" data-ch="${esc(ch)}" value="${adCur[ch]!=null?esc(adCur[ch]):""}" placeholder="0"></label>`).join("")}</div>
          <div class="form-actions"><button type="submit" class="btn primary">儲存 ${esc(adMonth)} 廣告費</button></div>
        </form></div>`:""}
    </div>`;
  V.querySelector("#rangeSel").onchange=e=>{S.range=e.target.value;renderStats()};
  V.querySelector("#byFieldSel").onchange=e=>{S.byField=e.target.value;renderStats()};
  if(S.isAdmin)V.querySelector("#adMonth").onchange=e=>{if(e.target.value){S.adMonth=e.target.value;renderStats()}};
  if(S.isAdmin)V.querySelector("#adForm").addEventListener("submit",e=>{
    e.preventDefault();const spend={};
    V.querySelectorAll("[data-ch]").forEach(i=>{if(i.value!=="")spend[i.dataset.ch]=+i.value});
    write(F.setDoc(F.doc(fs,"adspend",adMonth),{month:adMonth,spend,updatedAt:new Date().toISOString(),by:S.email}),"已儲存 "+adMonth+" 廣告費");
    document.activeElement&&document.activeElement.blur();
  });

}
function exportCsv(rows){
  const cols=S.fields.filter(f=>f.enabled).map(f=>[f.id,f.name,f]);
  cols.push(["closedAt","結案日期"],["followups","追蹤紀錄"]);
  // 防止 CSV 公式注入：以 = + - @ 或 tab/換行 開頭的內容，前面加 ' 讓 Excel 當文字
  const cell=v=>{let s=String(v==null?"":v);if(/^[=+\-@\t\r]/.test(s)&&!/^[+-]?[\d\s().#-]+$/.test(s))s="'"+s;return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
  const out=[cols.map(c=>c[1]).join(",")].concat(rows.map(r=>cols.map(([k])=>{
    const v=r[k];
    if(Array.isArray(v)&&v.length&&v[0]&&typeof v[0]==="object"&&v[0].url)return cell(v.length+" 張照片");
    if(k==="tags")return cell((v||[]).map(tagName).filter(Boolean).join("、"));
    if(k==="followups")return cell((Array.isArray(v)?v:[]).map(f=>`${f.at} ${f.method||""} ${f.by||""}：${f.note||""}`).join("\n"));
    return cell(Array.isArray(v)?v.join("、"):v)}).join(",")));
  const name="普印通詢價_"+today()+".csv",data="﻿"+out.join("\n");
  if(window.PT_SAVE){window.PT_SAVE(name,data);return}
  const blob=new Blob([data],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;
  document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);
}

/* ---------- settings ---------- */
function memberRow(m){const own=(m.email||"").toLowerCase()===ADMIN,adm=own||S.admins.includes((m.email||"").toLowerCase());
  return `<tr><td><input data-m="name" value="${esc(m.name)}" placeholder="姓名"></td><td><input data-m="email" type="email" value="${esc(m.email)}" placeholder="name@gmail.com" ${own?"readonly":""}></td>
  <td class="adm"><label title="管理者：全部功能。一般同仁：只能新增、修改案件"><input type="checkbox" data-m="admin" ${adm?"checked":""} ${own?"disabled":""}> 管理者</label></td>
  <td>${own?'<span class="tag">系統擁有者</span>':'<button type="button" class="x" aria-label="移除">×</button>'}</td></tr>`}
function renderSettings(){
  const V=$("#v-settings");
  const tabs=[["fields","欄位管理"],["tags","標籤"],["rules","自動提醒規則"],["options","服務項目與追蹤方式"],["pricing","報價設定"],["members","同仁名單"]];
  V.innerHTML=`<div class="an-head"><h2>設定</h2></div>
    <div class="subtabs">${tabs.map(([k,l])=>`<button class="chip" data-st="${k}" aria-pressed="${S.setTab===k}">${l}</button>`).join("")}</div>
    <div id="setBody"></div>
    <p class="note">登入帳號：${esc(S.email)}${S.isAdmin?'<span class="pill">管理者</span>':""}</p>`;
  V.querySelectorAll("[data-st]").forEach(b=>b.onclick=()=>{S.setTab=b.dataset.st;renderSettings()});
  const B=V.querySelector("#setBody");
  if(S.setTab==="fields")renderFieldManager(B);
  else if(S.setTab==="rules")renderRules(B);
  else if(S.setTab==="tags")renderTags(B);
  else if(S.setTab==="backup")renderBackup(B);
  else if(S.setTab==="options")renderOptions(B);
  else if(S.setTab==="pricing")renderPricing(B);
  else renderMembers(B);
}
// 標籤管理：所有同仁都可以新增、改名、改顏色；刪除只有管理者
function renderTags(B){
  const use={};S.inq.forEach(r=>(r.tags||[]).forEach(id=>use[id]=(use[id]||0)+1));
  const sw=(t)=>`<div class="sw-row" role="radiogroup" aria-label="顏色">${TAG_COLORS.map(([k,n])=>`<button type="button" class="sw" data-c="${k}" role="radio" aria-checked="${t.color===k}" aria-label="${n}" title="${n}"></button>`).join("")}</div>`;
  B.innerHTML=`<div class="tagmgr"><p class="note" style="font-size:13px">標籤用來替案件分類（例如 VIP、急件、待回電）。所有同仁都可以新增標籤、改名稱和顏色；${S.isAdmin?"管理者可以刪除標籤。":"刪除標籤只有管理者可以。"}名稱最多 ${TAG_NAME_MAX} 個字。</p>
    <div class="card"><h3>新增標籤</h3><div class="tag-new"><input type="text" id="tgName" maxlength="${TAG_NAME_MAX}" placeholder="例如：VIP 客戶"><button class="btn primary sm" id="tgAdd" type="button">新增</button><span class="err" id="tgErr"></span></div>${sw({color:S._newTagColor||nextTagColor()}).replace('class="sw-row"','class="sw-row" id="tgNewSw"')}</div>
    <div class="card"><h3>全部標籤 <small>${S.tags.length} 個・改完名稱離開輸入框就會儲存</small></h3>
      ${S.tags.length?S.tags.map(t=>`<div class="tag-item" data-id="${esc(t.id)}"><span class="tg" data-c="${esc(t.color)}">${esc(t.name)}</span>
        <input type="text" class="tg-name" maxlength="${TAG_NAME_MAX}" value="${esc(t.name)}" aria-label="標籤名稱">
        <span class="note">${use[t.id]||0} 件案件</span>${S.isAdmin?`<button type="button" class="btn ghost sm tg-del">刪除</button>`:""}
        ${sw(t)}</div>`).join(""):'<div class="dim">還沒有標籤</div>'}
    </div></div>`;
  S._newTagColor=S._newTagColor||nextTagColor();
  B.querySelectorAll("#tgNewSw .sw").forEach(b=>b.onclick=()=>{S._newTagColor=b.dataset.c;B.querySelectorAll("#tgNewSw .sw").forEach(x=>x.setAttribute("aria-checked",String(x===b)))});
  const add=()=>{const name=B.querySelector("#tgName").value.replace(/\s+/g," ").trim().slice(0,TAG_NAME_MAX),err=B.querySelector("#tgErr");
    if(!name){err.textContent="請輸入名稱";return}
    if(S.tags.some(t=>t.name===name)){err.textContent="已經有這個標籤";return}
    if(S.tags.length>=TAG_MAX){err.textContent="標籤最多 "+TAG_MAX+" 個";return}
    saveTag({id:"t_"+newId(),name,color:S._newTagColor},"已新增標籤");S._newTagColor=null;renderTags(B)};
  B.querySelector("#tgAdd").onclick=add;B.querySelector("#tgName").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();add()}};
  B.querySelectorAll(".tag-item").forEach(row=>{const id=row.dataset.id;
    const upd=patch=>{const cur=tagById(id);if(cur)saveTag({...cur,...patch},"已儲存標籤")};
    row.querySelectorAll(".sw").forEach(b=>b.onclick=()=>{upd({color:b.dataset.c});renderTags(B)});
    const inp=row.querySelector(".tg-name");
    const commit=()=>{const name=inp.value.replace(/\s+/g," ").trim().slice(0,TAG_NAME_MAX);const cur=tagById(id);if(!cur)return;
      if(!name){inp.value=cur.name;return}if(name===cur.name)return;
      if(S.tags.some(t=>t.id!==id&&t.name===name)){toast("已經有同名的標籤");inp.value=cur.name;return}
      upd({name});row.querySelector(".tg").textContent=name};
    inp.onblur=commit;inp.onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();inp.blur()}};
    const del=row.querySelector(".tg-del");
    if(del)del.onclick=()=>{if(!del.dataset.armed){del.dataset.armed="1";del.textContent="再按一次刪除";setTimeout(()=>{if(del.isConnected){delete del.dataset.armed;del.textContent="刪除"}},6000);return}
      deleteTag(id,"已刪除標籤");renderTags(B)};
  });
}
function renderRules(B){
  const r=R(),ed=S.isAdmin,dis=ed?"":"disabled";
  const row=(k,title,desc,unit)=>`<div class="card rule"><label class="rule-on"><input type="checkbox" id="r_${k}_on" ${r[k].on?"checked":""} ${dis}> 啟用</label>
    <div class="rule-body"><h3>${title}</h3><p class="note">${desc}</p>
    <label class="rule-n">${k==="remind"?"詢價後超過":k==="quote"?"報價後超過":k==="next"?"預設排在詢價日期":k==="effect"||k==="care"?"排在成交後第":"超過"} <input type="number" min="1" id="r_${k}_n" value="${esc(r[k].hours!=null?r[k].hours:r[k].days)}" ${dis}> ${unit}</label></div></div>`;
  B.innerHTML=`<p class="note" style="font-size:13px">${ed?"調整後按「儲存規則」，所有同仁立即套用。":"只有管理者可以修改規則。"}</p>
    ${row("remind","追蹤提醒","新詢價建立後，超過設定時數還沒有任何追蹤紀錄，會在列表標示並跳出提醒視窗。時數從建立案件起算，包含假日。","小時")}
    ${row("next","下次行動提醒（定時追本案）","新增詢價時，「下次行動」預設「定時48小時追本案」，日期自動排在詢價日期加上設定時數（48 小時＝隔兩天，可以手動改）；加追蹤紀錄時從當天起算。到了那天上午 8:00 後登入，自動跳出追蹤提醒；逾期的每次登入都會提醒。","小時後（預設 48 小時＝隔兩天）")}
    ${row("quote","報價後追蹤提醒","案件改成「已報價」後，超過設定時數還沒有新的追蹤紀錄，會在列表標示並跳出提醒視窗。","小時（從改成已報價起算）")}
    ${row("effect","14天關心除味效果","除味服務成交時，自動在「本案總結」排一個關心日（預設成交後第 15 天）。當天上午 8:00 後登入跳出提醒；在案件裡用「關心除味效果」方式記一筆追蹤，就算完成。","天（預設 15 天）")}
    ${row("care","30日滿意保固提醒","成交時自動在「本案總結」排一個保固確認日（預設成交後第 30 天）。當天上午 8:00 後登入跳出提醒；在案件裡用「滿意保固確認」方式記一筆追蹤，就算完成。","天（預設 30 天）")}
    ${row("autoLost","自動改為未成交","詢價超過設定天數仍未成交，系統自動改為「未成交」，原因記為「超過 N 天未成交（系統自動）」。到期前 5 天會先在列表提醒；被自動結案的案子改回進行中階段後，會重新計算天數。","天（從詢價日期起算）")}
    ${ed?`<div class="form-actions"><span class="err" id="rErr"></span><button class="btn primary" id="rSave">儲存規則</button></div>`:""}`;
  if(!ed)return;
  B.querySelector("#rSave").onclick=()=>{
    const g=k=>({on:B.querySelector(`#r_${k}_on`).checked,n:+B.querySelector(`#r_${k}_n`).value});
    const a=g("remind"),c=g("care"),l=g("autoLost"),q=g("quote"),n=g("next"),ef=g("effect");
    if([a,c,l,q,n,ef].some(x=>!(x.n>=1))){B.querySelector("#rErr").textContent="數字至少要 1";return}
    write(F.setDoc(F.doc(fs,"config","rules"),{remind:{on:a.on,hours:a.n},quote:{on:q.on,hours:q.n},next:{on:n.on,hours:n.n},care:{on:c.on,days:c.n},effect:{on:ef.on,days:ef.n},autoLost:{on:l.on,days:l.n},updatedAt:new Date().toISOString(),by:S.email}),"規則已儲存");
  };
}
function renderOptions(B){
  const c=S.opt,ro=S.isAdmin?"":" readonly";
  B.innerHTML=`<p class="note" style="font-size:13px">一行一項，${S.isAdmin?"只有管理者可以修改":"只有管理者可以修改，你目前只能查看"}。改名稱不會改到已登錄的案件。其他單選、複選欄位的選項（例如來源管道、客戶類型、未成交原因）在「欄位管理」裡改。</p>
    <form id="cfgForm" novalidate><div class="an-grid" style="margin-top:6px">
      <div class="card"><h3>服務項目 <small>格式：業務線｜服務名稱</small></h3><label class="f"><textarea id="c_svc" rows="12"${ro}>${esc(c.services.map(s=>s.line+"｜"+s.name).join("\n"))}</textarea></label></div>
      <div class="card"><h3>追蹤方式</h3><label class="f"><textarea id="c_m" rows="8"${ro}>${esc(c.methods.join("\n"))}</textarea></label></div>
    </div>${S.isAdmin?`<div class="form-actions"><span class="err" id="cErr"></span><button type="submit" class="btn primary">儲存</button></div>`:""}</form>`;
  if(!S.isAdmin)return;
  B.querySelector("#cfgForm").addEventListener("submit",e=>{
    e.preventDefault();
    const L=id=>B.querySelector(id).value.split("\n").map(s=>s.trim()).filter(Boolean);
    const services=L("#c_svc").map(s=>{const p=s.split(/[｜|]/);return p.length>1?{line:p[0].trim(),name:p.slice(1).join("｜").trim()}:{line:"其他",name:s}}).filter(s=>s.name);
    if(!services.length){B.querySelector("#cErr").textContent="服務項目至少要一項";return}
    write(F.setDoc(F.doc(fs,"config","options"),{services,methods:L("#c_m"),rev:OPT_REV,updatedAt:new Date().toISOString()}),"已儲存");
  });
}
function renderMembers(B){
  const members=S.members.length?S.members:[{name:S.me,email:S.email}];
  B.innerHTML=`<div class="card"><h3>同仁名單 <small>${S.isAdmin?"名單上的 Google 帳號才能登入；姓名會出現在「接單同仁」選單":"只有管理者可以修改"}</small></h3>
    <p class="note" style="margin-top:0"><b>權限：</b>管理者可以使用全部功能。一般同仁可以新增、修改案件和加追蹤紀錄；不能刪除案件或照片，不能備份、匯出，也不能改設定與廣告費。</p>
    ${S.isAdmin?`<p class="note" style="margin-top:0">建議至少再勾一位「管理者」當備援，避免系統擁有者的帳號無法登入時，沒有人能管理系統。</p>`:""}
    ${S.isAdmin?`<form id="memForm" novalidate>
      <div class="tbl-wrap"><table class="members"><tbody id="memBody">${members.map(memberRow).join("")}</tbody></table></div>
      <div class="form-actions"><span class="err" id="mErr"></span><button type="button" class="btn sm" id="memAdd">＋ 新增同仁</button><button type="submit" class="btn primary">儲存名單</button></div>
    </form>`:`<div class="tags">${S.members.map(m=>`<span class="tag">${esc(m.name)}</span>`).join("")||"—"}</div>`}</div>`;
  if(!S.isAdmin)return;
  const body=B.querySelector("#memBody");
  const bindX=()=>body.querySelectorAll(".x").forEach(b=>b.onclick=()=>b.closest("tr").remove());bindX();
  B.querySelector("#memAdd").onclick=()=>{body.insertAdjacentHTML("beforeend",memberRow({name:"",email:""}));bindX();body.lastElementChild.querySelector("input").focus()};
  B.querySelector("#memForm").addEventListener("submit",e=>{
    e.preventDefault();
    const rows=[...body.querySelectorAll("tr")].map(tr=>({name:tr.querySelector('[data-m="name"]').value.trim(),email:tr.querySelector('[data-m="email"]').value.trim().toLowerCase(),admin:tr.querySelector('[data-m="admin"]').checked})).filter(m=>m.name||m.email);
    const admins=[...new Set(rows.filter(m=>m.admin&&m.email!==ADMIN).map(m=>m.email))];
    const list=rows.map(({name,email})=>({name,email}));
    if(list.some(m=>!m.name||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.email))){B.querySelector("#mErr").textContent="每一列都要填姓名和正確的 Email";return}
    if(!list.some(m=>m.email===S.email))list.unshift({name:S.me,email:S.email});
    if(!list.some(m=>m.email===ADMIN))list.unshift({name:"系統擁有者",email:ADMIN});
    write(F.setDoc(F.doc(fs,"config","access"),{members:list,emails:[...new Set(list.map(m=>m.email))],admins,updatedAt:new Date().toISOString()}),"名單已儲存");
  });
}

/* --- 備份與還原 --- */
const RESTORE_CFG=["access","fields","options","rules","pricing"];
const DOC_ID_OK=/^(?!__.*__$)[A-Za-z0-9_-]{1,64}$/, MONTH_OK=/^\d{4}-\d{2}$/, DAY_OK=/^\d{4}-\d{2}-\d{2}$/;
const isObj=o=>!!o&&typeof o==="object"&&!Array.isArray(o);
const backupAge=()=>{const t=S.meta&&S.meta.lastBackupAt;return t?Math.floor((Date.now()-Date.parse(t))/dayMs):Infinity};
function buildBackup(){
  const strip=o=>{const c={...o};delete c.id;return c};
  return {app:"printtown-crm",format:1,exportedAt:new Date().toISOString(),by:S.email,
    counts:{inquiries:S.inq.length},
    collections:{
      inquiries:Object.fromEntries(S.inq.map(r=>[r.id,strip(r)])),
      config:Object.fromEntries(RESTORE_CFG.filter(k=>S.raw[k]).map(k=>[k,S.raw[k]])),
      tags:S.raw.tagDocs||{},
      adspend:S.raw.adspend||{}
    }};
}
function saveFile(name,text,type){
  if(window.PT_SAVE){window.PT_SAVE(name,text);return}
  const blob=new Blob([text],{type});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;
  document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);
}
function renderBackup(B){
  const age=backupAge(),last=S.meta&&S.meta.lastBackupAt;
  B.innerHTML=`
  <div class="card"><h3>完整備份</h3>
    <p class="note" style="margin-top:0">把所有資料存成一個檔案：詢價案件（含追蹤紀錄）、欄位設定、自動提醒規則、服務項目、同仁名單、廣告費。建議每月一次，存到公司雲端硬碟。</p>
    <div class="bk-status ${age>=30?"warn":""}">${last?`上次備份：${esc(last.slice(0,10))}（${age} 天前，${esc(S.meta.lastBackupBy||"")}）`:"還沒有做過完整備份"}</div>
    <div class="form-actions" style="justify-content:flex-start"><button class="btn primary" id="bkDo">下載完整備份</button><span class="note" id="bkMsg"></span></div>
    <p class="note">照片本身存在雲端檔案儲存，備份檔裡記錄的是照片連結；只要不刪除雲端專案，照片就會一直在。</p>
  </div>
  <div class="card"><h3>從備份還原 <small>${S.isAdmin?"":"只有管理者可以還原"}</small></h3>
    ${S.isAdmin?`<p class="note" style="margin-top:0">選擇之前下載的備份檔。還原會把檔案裡的資料寫回系統：同一筆案件以備份檔的內容為準，系統裡多出來的案件會保留不刪。</p>
    <label class="btn sm" style="display:inline-block">選擇備份檔<input type="file" accept="application/json,.json" id="rsFile" hidden></label>
    <div id="rsBox"></div>`:""}
  </div>`;
  B.querySelector("#bkDo").onclick=()=>{
    const data=buildBackup(),name="普印通案件追蹤_完整備份_"+today()+".json";
    saveFile(name,JSON.stringify(data,null,1),"application/json");
    S.meta={...(S.meta||{}),lastBackupAt:new Date().toISOString(),lastBackupBy:S.me};
    write(F.setDoc(F.doc(fs,"config","meta"),S.meta));
    renderBackup(B);B.querySelector("#bkMsg").textContent=`已產生 ${name}（${data.counts.inquiries} 筆案件）`;
  };
  if(!S.isAdmin)return;
  B.querySelector("#rsFile").onchange=async e=>{
    const file=e.target.files[0];e.target.value="";if(!file)return;
    const box=B.querySelector("#rsBox");
    let d;try{d=JSON.parse(await file.text())}catch(err){box.innerHTML='<div class="confirm">這不是有效的備份檔</div>';return}
    if(!d||d.app!=="printtown-crm"||!d.collections){box.innerHTML='<div class="confirm">這個檔案不是案件追蹤的備份檔</div>';return}
    // 只接受格式正確的資料：案件編號、日期、設定項目都要符合規則，其餘略過
    const C=isObj(d.collections)?d.collections:{};
    const inq=isObj(C.inquiries)?C.inquiries:{},allIds=Object.keys(inq);
    const ids=allIds.filter(i=>DOC_ID_OK.test(i)&&isObj(inq[i])&&DAY_OK.test(String(inq[i].date||"")));
    const cfgAll=isObj(C.config)?C.config:{},cfg=Object.keys(cfgAll).filter(k=>RESTORE_CFG.includes(k)&&isObj(cfgAll[k]));
    const adAll=isObj(C.adspend)?C.adspend:{},ad=Object.keys(adAll).filter(m=>MONTH_OK.test(m)&&isObj(adAll[m]));
    const tgAll=isObj(C.tags)?C.tags:{},tg=Object.keys(tgAll).map(k=>cleanTag(Object.assign({},tgAll[k],{id:k}))).filter(Boolean);
    const skipped=allIds.length-ids.length+Object.keys(cfgAll).length-cfg.length+Object.keys(adAll).length-ad.length+Object.keys(tgAll).length-tg.length;
    const have=new Set(S.inq.map(r=>r.id)),over=ids.filter(i=>have.has(i)).length;
    const accChange=cfg.includes("access")&&JSON.stringify((cfgAll.access.emails||[]).slice().sort())!==JSON.stringify(((S.raw.access||{}).emails||[]).slice().sort());
    box.innerHTML=`<div class="rs-sum"><b>${esc(file.name)}</b><br>備份時間：${esc((d.exportedAt||"").slice(0,16).replace("T"," "))}<br>
      案件 ${ids.length} 筆（新增 ${ids.length-over}、覆蓋 ${over}）· 廣告費 ${ad.length} 個月 · 標籤 ${tg.length} 個 · 設定 ${cfg.length} 項${skipped?`<br><span style="color:var(--danger)">有 ${skipped} 筆格式不正確，會略過不還原</span>`:""}</div>
      <label class="rs-opt"><input type="checkbox" id="rsCfg"> 一併還原設定（欄位、規則、服務項目、同仁名單）</label>
      ${accChange?`<div class="note" style="color:var(--danger)">注意：備份檔裡的同仁名單和現在不同。勾選還原設定，會把名單改回備份當時（已離職同仁可能恢復登入權限）。</div>`:""}
      <div class="confirm" style="background:var(--warn-soft)">確定要還原嗎？覆蓋的案件會變回備份當時的內容。
        <button class="btn danger sm" id="rsGo">確定還原</button><button class="btn sm" id="rsNo">取消</button></div><div class="note" id="rsMsg"></div>`;
    box.querySelector("#rsNo").onclick=()=>box.innerHTML="";
    box.querySelector("#rsGo").onclick=async()=>{
      const jobs=[];
      ids.forEach(i=>{const x={...inq[i]};delete x.id;jobs.push(["inquiries",i,x])});
      ad.forEach(m=>jobs.push(["adspend",m,adAll[m]]));
      tg.forEach(t=>jobs.push(["tags",t.id,{name:t.name,color:t.color,o:t.o||Date.now(),updatedAt:new Date().toISOString(),by:S.email}]));
      const lc=a=>Array.isArray(a)?a.map(x=>String(x).trim().toLowerCase()):[];
      if(box.querySelector("#rsCfg").checked)cfg.forEach(k=>{let v=cfgAll[k];
        if(k==="access"){const mem=Array.isArray(v.members)?v.members.map(m=>({...m,email:String((m&&m.email)||"").trim().toLowerCase()})).filter(m=>m.email):[];
          // 登入權限以名單為準：名單上的人一律可以登入（舊備份可能少了這一欄）
          v={...v,members:mem,emails:[...new Set([...lc(v.emails),...mem.map(m=>m.email)])].filter(Boolean),admins:lc(v.admins)}}
        jobs.push(["config",k,v])});
      const msg=box.querySelector("#rsMsg");let done=0,fail=0;
      box.querySelector("#rsGo").disabled=true;
      for(let i=0;i<jobs.length;i+=20){
        await Promise.all(jobs.slice(i,i+20).map(([c,id,data])=>{try{return F.setDoc(F.doc(fs,c,id),data).then(()=>done++).catch(()=>fail++)}catch(e){fail++;return null}}));
        msg.textContent=`還原中… ${done+fail} / ${jobs.length}`;
      }
      box.querySelector("#rsGo").disabled=false;
      msg.textContent=fail?`完成 ${done} 筆，${fail} 筆失敗（可能是權限、網路或資料格式），請再試一次`:`還原完成，共 ${done} 筆`;
      toast(fail?"部分還原失敗":"還原完成");
    };
  };
}

/* --- 欄位管理 --- */
// FM：編輯中的草稿（按「儲存」才寫入）。fields 的順序＝表單上的順序；groups 的順序＝大區塊順序。
let FM=null;
function fmInit(){
  const fields=S.fields.map(f=>({...f,options:[...(f.options||[])]}));
  FM={fields,groups:mergeGroups(S.groups,fields),dirty:false,collapsed:new Set()};
}
function fmDirty(B){FM.dirty=true;const m=B.querySelector("#fmState");if(m)m.textContent="有變更尚未儲存"}

function renderFieldManager(B){
  if(!FM)fmInit();
  const editable=S.isAdmin;
  const lineOpts=["",...lines()];
  const fixedOptIds=["stage","owner","services"];
  const card=(f)=>{
    const i=FM.fields.indexOf(f);
    const hasOpts=(f.type==="one"||f.type==="multi")&&!fixedOptIds.includes(f.id);
    const dis=editable?"":"disabled";
    const reqLock=!editable||f.type==="auto";
    return `<div class="fm ${f.enabled?"":"off"}" data-i="${i}">
      <div class="fm-top">
        ${editable?`<span class="handle" data-drag="field" title="拖曳調整位置" aria-hidden="true">⠿</span>`:""}
        <input class="fm-name" data-k="name" value="${esc(f.name)}" aria-label="欄位名稱" ${dis}>
        <span class="fm-tags">${f.sys?'<span class="tag">系統必需</span>':""}${!f.builtin?'<span class="tag cus">自訂</span>':""}</span>
        <div class="seg" role="group" aria-label="是否必填">
          <button type="button" data-req="1" aria-pressed="${!!f.required}" ${reqLock?"disabled":""}>必填</button>
          <button type="button" data-req="0" aria-pressed="${!f.required}" ${reqLock?"disabled":""}>非必填</button>
        </div>
        ${editable?`<span class="fm-move"><button type="button" class="btn sm" data-mv="-1" aria-label="上移">↑</button><button type="button" class="btn sm" data-mv="1" aria-label="下移">↓</button></span>`:""}
      </div>
      <div class="fm-row">
        <label class="fm-on"><input type="checkbox" data-k="enabled" ${f.enabled?"checked":""} ${f.sys||!editable?"disabled":""}> 使用中</label>
        <label>類型<select data-k="type" ${f.builtin||f.sys||!editable?"disabled":""}>${Object.entries(TYPES).filter(([k])=>(k!=="auto"||f.type==="auto")&&(k!=="tags"||f.type==="tags")).map(([k,v])=>`<option value="${k}" ${f.type===k?"selected":""}>${v}</option>`).join("")}</select></label>
        <label>所在區塊<select data-k="group" ${dis}>${FM.groups.map(g=>`<option ${g===f.group?"selected":""}>${esc(g)}</option>`).join("")}</select></label>
        <label>欄位位置<select data-k="col" ${dis}><option value="" ${!f.col?"selected":""}>自動排列</option><option value="left" ${f.col==="left"?"selected":""}>左欄（必要）</option><option value="right" ${f.col==="right"?"selected":""}>右欄（次要）</option></select></label>
        <label>出現條件<select data-k="line" ${f.sys||!editable?"disabled":""}>${lineOpts.map(l=>`<option value="${esc(l)}" ${l===(f.line||"")?"selected":""}>${l?"只在詢問"+esc(l)+"時":"一律出現"}</option>`).join("")}</select></label>
        ${!f.builtin&&editable?`<button type="button" class="del" data-del>刪除欄位</button>`:""}
      </div>
      ${f.type==="auto"?'<div class="note">自動產生，不需要填寫</div>':""}
      ${hasOpts?`<label class="fm-opts">選項（一行一項）<textarea data-k="options" rows="${Math.min(8,Math.max(3,(f.options||[]).length+1))}" ${dis}>${esc((f.options||[]).join("\n"))}</textarea></label>`:""}
      ${fixedOptIds.includes(f.id)?`<div class="note">${f.id==="services"?"選項在「服務項目與追蹤方式」設定":f.id==="owner"?"選項來自同仁名單":"階段由系統固定"}</div>`:""}
    </div>`;
  };
  const groupHtml=(g,gi)=>{
    const items=FM.fields.filter(f=>f.group===g);
    const col=FM.collapsed.has(g);
    return `<section class="fm-group ${col?"collapsed":""}" data-g="${esc(g)}">
      <div class="fm-gh">
        ${editable?`<span class="handle" data-drag="group" title="拖曳調整區塊順序" aria-hidden="true">⠿</span>`:""}
        <input class="fm-gname" data-gi="${gi}" value="${esc(g)}" aria-label="區塊名稱" ${editable?"":"disabled"}>
        <span class="fm-gcount">${items.filter(f=>f.enabled).length} / ${items.length}</span>
        ${editable?`<span class="fm-move"><button type="button" class="btn sm" data-gmv="-1" aria-label="區塊上移">↑</button><button type="button" class="btn sm" data-gmv="1" aria-label="區塊下移">↓</button></span>`:""}
        ${editable&&!items.length?`<button type="button" class="del" data-gdel>刪除區塊</button>`:""}
        <button type="button" class="btn sm ghost" data-col>${col?"展開":"收合"}</button>
      </div>
      <div class="fm-list" data-g="${esc(g)}">${items.map(card).join("")||'<div class="fm-empty">把欄位拖到這裡</div>'}</div>
    </section>`;
  };
  B.innerHTML=`<p class="note" style="font-size:13px">${editable?"按住 ⠿ 拖曳，可以調整欄位順序、把欄位移到別的區塊，也可以調整整個區塊的順序。手機上同樣按住 ⠿ 拖曳，或用 ↑↓ 按鈕。取消「使用中」的欄位會從表單隱藏，已填的資料仍保留。改完按最下方「儲存欄位設定」，所有同仁立即套用。":"只有管理者可以修改欄位設定。"}</p>
    <div class="fm-tools">${editable?`<button type="button" class="btn sm" id="colAll">全部收合</button><button type="button" class="btn sm" id="expAll">全部展開</button>`:""}</div>
    <div id="fmGroups">${FM.groups.map(groupHtml).join("")}</div>
    ${editable?`<div class="card"><h3>新增欄位</h3><form id="addF" class="grid" novalidate>
      <label class="f">欄位名稱<input id="nf_name" placeholder="例如：停車資訊"></label>
      <label class="f">類型<select id="nf_type">${Object.entries(TYPES).filter(([k])=>k!=="auto"&&k!=="file"&&k!=="tags").map(([k,v])=>`<option value="${k}">${v}</option>`).join("")}</select></label>
      <label class="f">所在區塊<select id="nf_group">${FM.groups.map(g=>`<option>${esc(g)}</option>`).join("")}</select></label>
      <label class="f">是否必填<select id="nf_req"><option value="0">非必填</option><option value="1">必填</option></select></label>
      <label class="f">出現條件<select id="nf_line">${lineOpts.map(l=>`<option value="${esc(l)}">${l?"只在詢問"+esc(l)+"時":"一律出現"}</option>`).join("")}</select></label>
      <div class="form-actions full" style="margin-top:0"><span class="err" id="nfErr"></span><button class="btn" type="submit">＋ 加入欄位</button></div>
    </form></div>
    <div class="card"><h3>新增區塊</h3><form id="addG" class="grid" novalidate>
      <label class="f full">區塊名稱<input id="ng_name" placeholder="例如：場勘資訊"></label>
      <div class="form-actions full" style="margin-top:0"><span class="err" id="ngErr"></span><button class="btn" type="submit">＋ 加入區塊</button></div>
    </form></div>
    <div class="form-actions sticky-save"><span class="err" id="fmErr"></span><span class="note" id="fmState" style="margin:0 auto 0 0">${FM.dirty?"有變更尚未儲存":""}</span><button type="button" class="btn" id="fmReset">放棄變更</button><button type="button" class="btn primary" id="fmSave">儲存欄位設定</button></div>`:""}`;
  if(!editable)return;
  const rerender=()=>{const y=window.scrollY;renderFieldManager(B);window.scrollTo(0,y)};

  // 欄位內容
  B.querySelectorAll(".fm").forEach(el=>{
    const f=FM.fields[+el.dataset.i];
    el.querySelectorAll("[data-k]").forEach(inp=>{
      const k=inp.dataset.k;
      const evt=inp.type==="checkbox"||inp.tagName==="SELECT"?"change":"input";
      inp.addEventListener(evt,()=>{
        if(k==="enabled")f.enabled=inp.checked;
        else if(k==="options")f.options=inp.value.split("\n").map(s=>s.trim()).filter(Boolean);
        else f[k]=inp.value;
        if(k==="enabled")el.classList.toggle("off",!inp.checked);
        fmDirty(B);
        if(k==="type"||k==="group"||k==="enabled")rerender();
      });
    });
    el.querySelectorAll("[data-req]").forEach(b=>b.onclick=()=>{f.required=b.dataset.req==="1";fmDirty(B);
      el.querySelectorAll("[data-req]").forEach(x=>x.setAttribute("aria-pressed",String((x.dataset.req==="1")===f.required)))});
    el.querySelectorAll("[data-mv]").forEach(b=>b.onclick=()=>{
      const d=+b.dataset.mv,same=FM.fields.filter(x=>x.group===f.group);
      const p=same.indexOf(f),q=same[p+d];if(!q)return;
      const a=FM.fields.indexOf(f),c=FM.fields.indexOf(q);[FM.fields[a],FM.fields[c]]=[FM.fields[c],FM.fields[a]];
      fmDirty(B);rerender();
    });
    const del=el.querySelector("[data-del]");
    if(del)del.onclick=()=>{
      if(del.dataset.armed){FM.fields.splice(FM.fields.indexOf(f),1);fmDirty(B);rerender();return}
      del.dataset.armed="1";del.textContent="再按一次確認刪除（已填資料不會被清除）";
    };
  });
  // 區塊
  B.querySelectorAll(".fm-group").forEach(sec=>{
    const g=sec.dataset.g;
    const nm=sec.querySelector(".fm-gname");
    nm.addEventListener("change",()=>{
      const v=nm.value.trim();
      if(!v||(v!==g&&FM.groups.includes(v))){nm.value=g;toast(v?"已經有同名區塊":"區塊名稱不能空白");return}
      FM.groups[FM.groups.indexOf(g)]=v;FM.fields.forEach(f=>{if(f.group===g)f.group=v});
      if(FM.collapsed.delete(g))FM.collapsed.add(v);fmDirty(B);rerender();
    });
    sec.querySelectorAll("[data-gmv]").forEach(b=>b.onclick=()=>{
      const i=FM.groups.indexOf(g),j=i+(+b.dataset.gmv);if(j<0||j>=FM.groups.length)return;
      [FM.groups[i],FM.groups[j]]=[FM.groups[j],FM.groups[i]];fmDirty(B);rerender();
    });
    const gd=sec.querySelector("[data-gdel]");
    if(gd)gd.onclick=()=>{FM.groups=FM.groups.filter(x=>x!==g);fmDirty(B);rerender()};
    sec.querySelector("[data-col]").onclick=()=>{FM.collapsed.has(g)?FM.collapsed.delete(g):FM.collapsed.add(g);rerender()};
  });
  B.querySelector("#colAll").onclick=()=>{FM.groups.forEach(g=>FM.collapsed.add(g));rerender()};
  B.querySelector("#expAll").onclick=()=>{FM.collapsed.clear();rerender()};

  // 拖曳（滑鼠與手指都可以）
  enableDrag(B.querySelector("#fmGroups"),()=>{
    // 依畫面上的新位置重建順序
    const groups=[],fields=[];
    B.querySelectorAll("#fmGroups .fm-group").forEach(sec=>{
      const g=sec.dataset.g;groups.push(g);
      sec.querySelectorAll(".fm").forEach(el=>{const f=FM.fields[+el.dataset.i];f.group=g;fields.push(f)});
    });
    FM.fields.forEach(f=>{if(!fields.includes(f))fields.push(f)});
    FM.groups=groups;FM.fields=fields;fmDirty(B);rerender();
  });

  B.querySelector("#addF").addEventListener("submit",e=>{
    e.preventDefault();
    const name=B.querySelector("#nf_name").value.trim();
    if(!name){B.querySelector("#nfErr").textContent="請輸入欄位名稱";return}
    if(FM.fields.some(f=>f.name===name)){B.querySelector("#nfErr").textContent="已經有同名欄位";return}
    const type=B.querySelector("#nf_type").value,group=B.querySelector("#nf_group").value;
    const nf={id:"c_"+newId(),name,type,group,line:B.querySelector("#nf_line").value,required:B.querySelector("#nf_req").value==="1",enabled:true,options:(type==="one"||type==="multi")?["選項一","選項二"]:[],builtin:false,sys:false,desc:""};
    const lastIdx=FM.fields.map(f=>f.group).lastIndexOf(group);
    FM.fields.splice(lastIdx<0?FM.fields.length:lastIdx+1,0,nf);
    FM.collapsed.delete(group);fmDirty(B);rerender();toast("已加入「"+name+"」，記得按儲存");
  });
  B.querySelector("#addG").addEventListener("submit",e=>{
    e.preventDefault();
    const name=B.querySelector("#ng_name").value.trim();
    if(!name){B.querySelector("#ngErr").textContent="請輸入區塊名稱";return}
    if(FM.groups.includes(name)){B.querySelector("#ngErr").textContent="已經有同名區塊";return}
    FM.groups.push(name);fmDirty(B);rerender();toast("已加入區塊「"+name+"」，把欄位拖進去或在欄位的「所在區塊」選它");
  });
  B.querySelector("#fmReset").onclick=()=>{FM=null;rerender()};
  B.querySelector("#fmSave").onclick=()=>{
    const bad=FM.fields.find(f=>!String(f.name).trim());if(bad){B.querySelector("#fmErr").textContent="有欄位沒有名稱";return}
    const emptyOpt=FM.fields.find(f=>f.enabled&&(f.type==="one"||f.type==="multi")&&!fixedOptIds.includes(f.id)&&!(f.options||[]).length);
    if(emptyOpt){B.querySelector("#fmErr").textContent="「"+emptyOpt.name+"」需要至少一個選項";return}
    const clean=FM.fields.map(f=>({id:f.id,name:String(f.name).trim(),type:f.type,group:f.group,required:!!f.required,enabled:!!f.enabled,line:f.line||"",col:f.col||"",options:f.options||[],builtin:!!f.builtin,sys:!!f.sys,desc:f.desc||""}));
    const groups=mergeGroups(FM.groups,clean);
    S._fieldsSaved=true;S.fields=mergeFields(clean,FIELDS_REV);S.groups=groups;FM=null;
    write(F.setDoc(F.doc(fs,"config","fields"),{fields:clean,groups,rev:FIELDS_REV,updatedAt:new Date().toISOString(),by:S.email}),"欄位設定已儲存");
    rerender();
  };
}

// 通用拖曳排序：按住 [data-drag] 把手移動。field 可跨區塊；group 調整區塊順序。
function enableDrag(root,onDone){
  root.querySelectorAll("[data-drag]").forEach(h=>{
    h.addEventListener("pointerdown",e=>{
      if(e.button!==undefined&&e.button!==0)return;
      e.preventDefault();
      const kind=h.dataset.drag;
      const item=h.closest(kind==="group"?".fm-group":".fm");
      if(kind==="group")root.classList.add("dragging-groups");
      item.classList.add("dragging");
      const startY=e.clientY;let moved=false,raf=0,lastY=e.clientY,lastX=e.clientX;
      const autoScroll=()=>{
        const edge=70,vh=window.innerHeight;
        if(lastY<edge)window.scrollBy(0,-12);else if(lastY>vh-edge)window.scrollBy(0,12);
        raf=requestAnimationFrame(autoScroll);
      };
      raf=requestAnimationFrame(autoScroll);
      const move=ev=>{
        lastY=ev.clientY;lastX=ev.clientX;
        if(!moved&&Math.abs(ev.clientY-startY)<4)return;moved=true;
        item.style.pointerEvents="none";
        const under=document.elementFromPoint(lastX,lastY);if(!under)return;
        if(kind==="group"){
          const tgt=under.closest(".fm-group");
          if(!tgt||tgt===item||!root.contains(tgt))return;
          const r=tgt.getBoundingClientRect();
          root.insertBefore(item,lastY<r.top+r.height/2?tgt:tgt.nextSibling);
        }else{
          const tgt=under.closest(".fm");
          if(tgt&&tgt!==item&&root.contains(tgt)){
            const r=tgt.getBoundingClientRect();
            tgt.parentNode.insertBefore(item,lastY<r.top+r.height/2?tgt:tgt.nextSibling);
          }else{
            const list=under.closest(".fm-list")||(under.closest(".fm-group")||{}).querySelector?.(".fm-list");
            if(list&&root.contains(list)&&!list.contains(item)){
              const empty=list.querySelector(".fm-empty");if(empty)empty.remove();
              list.appendChild(item);
              const sec=list.closest(".fm-group");if(sec)sec.classList.remove("collapsed");
            }
          }
        }
      };
      const up=()=>{
        cancelAnimationFrame(raf);
        document.removeEventListener("pointermove",move);
        document.removeEventListener("pointerup",up);
        document.removeEventListener("pointercancel",up);
        item.style.pointerEvents="";item.classList.remove("dragging");root.classList.remove("dragging-groups");
        if(moved)onDone();
      };
      document.addEventListener("pointermove",move);
      document.addEventListener("pointerup",up);
      document.addEventListener("pointercancel",up);
    });
  });
}


boot();

/* ---------- 離線快取 ---------- */
if("serviceWorker" in navigator&&location.protocol==="https:")navigator.serviceWorker.register("sw.js").catch(()=>{});
