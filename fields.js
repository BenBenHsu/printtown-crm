// 普印通案件追蹤：預設欄位（依 2026-10 阿賓勾選的清單）
// 上線後在「設定 → 欄位管理」修改，會存到資料庫，這個檔案只在第一次使用時當預設值。

export const GROUPS = ["詢價基本","客戶資料","需求內容","事務機專屬","報價","跟進","來源"];
// v2.7 起「異味／空品專屬」併入「需求內容」，「報價與結果」改名「報價」
export const GROUP_RENAME = {"異味／空品專屬":"需求內容","報價與結果":"報價"};

export const TYPES = {
  text:"文字", long:"長文字", num:"數字", money:"金額", date:"日期", one:"單選", multi:"複選",
  phone:"電話", email:"Email", yn:"是／否", auto:"自動產生", file:"照片／檔案", tags:"標籤"
};

export const AREAS = ["臺北市","新北市","桃園市","臺中市","臺南市","高雄市","基隆／宜蘭","新竹／苗栗","彰化／南投／雲林","嘉義／屏東","花東／離島"];
export const CITIES = ["臺北市","新北市","桃園市","臺中市","臺南市","高雄市","基隆市","新竹市","新竹縣","苗栗縣","彰化縣","南投縣","雲林縣","嘉義市","嘉義縣","屏東縣","宜蘭縣","花蓮縣","臺東縣","澎湖縣","金門縣","連江縣"];

// sys: 系統必需，不能停用、不能改類型（分析與提醒要用）
// line: 只在詢問該業務線的服務時出現（"" = 全部都出現）
const F = (id,name,type,group,o={}) => Object.assign({id,name,type,group,required:false,enabled:true,line:"",col:"",hl:false,options:[],builtin:true,sys:false,desc:""},o);

export const LOST_REASONS = ["價格／預算問題","需求消失","選擇其他方式解決","選擇其他廠商","失聯","其他"];
export const OLD_LOST = ["價格／預算","選擇其他廠商","需求取消／延後","聯絡不上"];
export const LOST_RENAME = {"價格／預算":"價格／預算問題","需求取消／延後":"需求消失","聯絡不上":"失聯"};
export const NEXT_ACTIONS = ["定時48小時追本案","電話追蹤","傳 LINE 追蹤","寄送／確認報價","安排現場勘查","安排施工","其他"];
export const FIELDS_REV = 31; // 欄位設定版本：舊設定讀進來時自動套用 v3.1 的選項調整

export const PRIMARY_LINE = "AQ得來速"; // 預設顯示的業務線，其他業務線的服務收在開關後面

export const DEFAULT_FIELDS = [
  F("date","詢價日期","date","詢價基本",{required:true,sys:true}),
  F("code","詢價編號","auto","詢價基本",{desc:"建立時自動產生，例如 Q2610-012"}),
  F("owner","接單同仁","one","詢價基本",{required:true,sys:true,desc:"接到這筆詢價的同仁，選項來自同仁名單"}),
  F("contactWay","客戶怎麼聯絡我們","one","詢價基本",{hl:true,options:["電話","LINE","網路表單／Email"]}),
  F("urgency","緊急程度","one","詢價基本",{options:["一般","急件"]}),
  F("tags","標籤","tags","詢價基本",{desc:"自訂分類，可複選"}),
  F("stage","案件階段","one","詢價基本",{required:true,sys:true}),

  F("channel","從哪裡知道普印通","one","來源",{sys:true,
    options:["Google 搜尋／官網","Google 廣告","FB／IG／LINE","BNI 引薦","舊客戶轉介／回購","協會／展覽／媒體","其他"]}),
  F("channelDetail","來源細節","text","來源",{desc:"哪篇文章、哪個關鍵字、哪個廣告"}),
  F("referrer","介紹人","text","來源",{desc:"BNI 夥伴或轉介客戶的姓名"}),
  F("returning","是否為舊客戶","yn","來源"),
  F("utm","廣告活動代碼","text","來源",{enabled:false}),

  // col: "left" 左欄（必要）／"right" 右欄（次要）／"" 自動排列
  F("company","公司／單位名稱","text","客戶資料",{required:true,sys:true,col:"left",desc:"個人客戶可填姓名"}),
  F("contact","聯絡人","text","客戶資料",{required:true,col:"left"}),
  F("title","聯絡人職稱／身份","text","客戶資料",{required:true,col:"left",desc:"例如：店長、總務、採購、老闆、屋主、房客"}),
  F("phone","電話","phone","客戶資料",{required:true,col:"left",hl:true}),
  F("city","地區","one","客戶資料",{required:true,col:"left",options:AREAS}),
  F("industry","客戶類型／產業","one","客戶資料",{col:"right",options:["餐飲","醫療／托嬰","辦公室／機關學校","住宅","其他"]}),
  F("taxId","統一編號","text","客戶資料",{col:"right"}),
  F("email","Email","email","客戶資料",{col:"right"}),
  F("lineId","LINE ID","text","客戶資料",{col:"right"}),
  F("address","詳細地址","text","客戶資料",{col:"right"}),
  F("isDecider","聯絡人是否為決策者","yn","客戶資料",{enabled:false,col:"right"}),
  F("phone2","第二支電話","phone","客戶資料",{enabled:false,col:"right"}),
  F("invoiceTitle","發票抬頭","text","客戶資料",{enabled:false,col:"right"}),

  // 需求內容：預設是詢問 AQ得來速 服務，只留最常用的欄位；其他欄位在「設定 → 欄位管理」可以再打開
  F("services","詢問的服務","multi","需求內容",{required:true,sys:true,desc:"選項在「服務項目」設定"}),
  F("odorType","異味類型","multi","需求內容",{line:"AQ得來速",options:["菸味","寵物味","油煙味","火災","裝潢味","甲醛","廁所／沼氣","其他異味"]}),
  F("layout","格局","one","需求內容",{line:"AQ得來速",options:["套房","1房1廳","2房1廳","2房2廳","3房1廳","3房2廳","4房2廳","5房以上","商業／辦公空間"]}),
  F("area","總坪數","num","需求內容",{line:"AQ得來速"}),
  F("need","需求描述","long","需求內容",{desc:"客戶原話最好"}),
  F("photos","現場照片／附件","file","需求內容",{desc:"需開啟 Firebase 檔案儲存後才能使用"}),
  F("caseNote","案件情況敘述","long","需求內容",{enabled:false,builtin:false,desc:"現場狀況、問題經過"}),
  F("assessment","專員評估敘述","long","需求內容",{enabled:false,builtin:false,desc:"專員的判斷：可能成因、建議方案、難易度"}),
  F("odorSince","發生多久／頻率","text","需求內容",{enabled:false,line:"AQ得來速"}),
  F("triedBefore","已試過的方法","text","需求內容",{enabled:false,line:"AQ得來速"}),
  F("complaint","是否有客訴或稽查壓力","yn","需求內容",{enabled:false,line:"AQ得來速"}),
  F("needReport","是否需要檢測報告","yn","需求內容",{enabled:false,line:"AQ得來速"}),
  F("wantDate","希望完成／到位日期","date","需求內容",{enabled:false}),
  F("budget","客戶預算範圍","one","需求內容",{enabled:false,options:["未提","5 萬以下","5–20 萬","20 萬以上"]}),

  F("machineType","機型需求","multi","事務機專屬",{enabled:false,line:"事務機",options:["彩色","黑白","A3","A4","多功能事務機"]}),
  F("qty","需要台數","num","事務機專屬",{enabled:false,line:"事務機"}),
  F("volume","每月預估印量","text","事務機專屬",{enabled:false,line:"事務機",desc:"黑白／彩色張數"}),
  F("currentVendor","目前使用的品牌／廠商","text","事務機專屬",{enabled:false,line:"事務機"}),
  F("contractEnd","現有合約到期日","date","事務機專屬",{enabled:false,line:"事務機"}),
  F("features","功能需求","multi","事務機專屬",{enabled:false,line:"事務機",options:["掃描","傳真","裝訂","卡片列印","帳號管控"]}),
  F("purchaseWay","採購方式","one","事務機專屬",{enabled:false,line:"事務機",options:["一般租賃","零元機","台銀共契","標案"]}),


  F("quoteAmount","報價金額","money","報價",{desc:"選填"}),
  F("equipQty","使用設備數量","num","報價",{desc:"選填，例如 2 台"}),
  F("estAmount","預估金額","money","報價",{enabled:false}),
  F("quoteDate","報價日期","date","報價"),
  F("quoteNo","報價單號","text","報價",{enabled:false}),
  // v3.1「本案總結」：選「成交」顯示成交金額～30日保固；選「未成交」顯示未成交原因；本案備註兩者都有
  F("wonAmount","成交金額","money","報價",{sys:true,sum:"won"}),
  F("wonDate","成交日期","date","報價",{sum:"won",desc:"選「成交」時自動帶入今天，可修改"}),
  F("deodorPeriod","除味期間","text","報價",{sum:"won",line:"AQ得來速",desc:"例如 10/20～10/27，共 7 天"}),
  F("effectDate","14天關心除味效果","date","報價",{sys:true,sum:"won",line:"AQ得來速",desc:"成交後自動排在第 15 天，當天上午 8:00 後提醒"}),
  F("warrantyDate","30日滿意保固提醒","date","報價",{sys:true,sum:"won",desc:"成交後自動排在第 30 天，當天上午 8:00 後提醒"}),
  F("lostReason","未成交原因","one","報價",{sys:true,sum:"lost",options:LOST_REASONS}),
  F("closeNote","本案備註","long","報價",{sum:"both",desc:"成交條件、未成交的補充說明"}),
  F("competitor","競爭對手","text","報價"),
  F("contractTerm","合約期間／月租金","text","報價"),

  F("nextAction","下次行動","one","跟進",{sys:true,options:NEXT_ACTIONS,desc:"選項可在「設定 → 欄位管理」修改"}),
  F("nextDate","下次行動日期","date","跟進",{sys:true,desc:"預設詢價日期的隔兩天，當天上午 8:00 後登入自動提醒"}),
  F("memo","內部備註","long","跟進")
];
