# LionBooking

JPTIP 一對一日文家教預約系統。以 Cloudflare Workers + D1 為後端、`public/` 下的靜態 HTML/Tailwind 頁面為前端，提供學生、老師、管理者三種角色的預約流程。

## 技術架構

- **後端**：Cloudflare Workers（`src/index.ts`），負責 Email OTP 登入驗證（`/api/otp/request`、`/api/otp/verify`）與 `/api/config`，其餘路徑一律回傳 `public/` 靜態資源（`ASSETS` binding）。
- **資料庫**：Cloudflare D1（`migrations/` 下的 SQL migration，`wrangler d1 migrations apply` 套用）。
- **前端**：純靜態 HTML，每個頁面各自撰寫 JS（無共用前端框架、無 build 工具處理 JS），共用邏輯集中在 `public/script.js`（登入 OTP 流程、共用日期選擇器、toast、卡片傾斜效果、下拉選單綁定等）。
- **樣式**：Tailwind v4，原始碼在 `src/tailwind/input.css`，需 build 成 `public/style.css` 才會生效；頁面各自的 `<style>` 區塊處理該頁專屬樣式。
- **通知**：系統信件（登入驗證碼、預約成功／取消通知）透過 Microsoft Graph 從共用信箱 `one-on-one@jptip.co.jp` 寄出，副本留在該信箱的寄件備份當作寄信紀錄。信件內容可在管理端「系統信件」修改（預設範本在 `src/email-templates.ts`）。

## 目錄結構

```
public/
  admin/     管理者頁面（老師/學生/課程管理）
  teacher/   老師頁面（我的課程、教課時段、休假申請）
  student/   學生頁面（預約精靈、我的課程）
  script.js  共用前端邏輯
  style.css  Tailwind 編譯輸出（勿手動編輯，改 src/tailwind/input.css 後重新 build）
src/
  index.ts          Cloudflare Worker 進入點
  tailwind/input.css Tailwind 原始樣式
migrations/          D1 資料庫 schema 與種子資料
wrangler.jsonc        Cloudflare Workers 設定
```

## 開發

安裝套件：

```bash
npm install
```

啟動開發伺服器（同時 watch Tailwind CSS 並啟動 `wrangler dev`）：

```bash
npm run dev
```

預設會在 `http://localhost:12345` 啟動。

單獨編譯一次 CSS：

```bash
npm run build:css
```

## 測試

後端（`src/index.ts`）以 [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/) 撰寫測試，在真正的 workerd runtime 裡跑，會套用 `migrations/` 到一個隔離的測試用 D1（不會動到本機或正式的資料庫）：

```bash
npm test
```

開發時用 watch 模式：

```bash
npm run test:watch
```

前端以 [Playwright](https://playwright.dev/) 寫端對端測試，會自動啟動 `npm run dev`（`http://localhost:12345`）並用真正的瀏覽器跑過登入、預約精靈、管理者代管老師等關鍵流程：

```bash
npm run test:e2e
```

用瀏覽器介面除錯：

```bash
npm run test:e2e:ui
```

## 資料庫（D1）

套用 migrations：

```bash
npx wrangler d1 migrations apply lionbooking
```

`migrations/` 內含 schema 初始化與測試用的老師/學生/管理者種子資料。

## 部署

專案在 Cloudflare 上的名稱為 `lionbooking`（`wrangler.jsonc` 中的 `name` 與 D1 `database_name`）：

```bash
npx wrangler deploy
```

## 環境變數 / Secrets

| 名稱 | 說明 |
|---|---|
| `MS_TENANT_ID`、`MS_CLIENT_ID`、`MS_SENDER_EMAIL` | 寄信用的 Azure 應用程式註冊與寄件信箱（寫在 `wrangler.jsonc` 的 vars） |
| `MS_CLIENT_SECRET` | 寄信用的 Azure 用戶端密碼「值」（Worker secret；本機放 `.dev.vars`，本機寄出的信標題會加上「[測試]」）。沒設定就不寄信 |
| `ALLOW_ANY_OTP` | 僅限測試站台使用，設為 `true` 時 `/api/otp/verify` 會接受任何 6 碼數字，**正式環境務必不可設定** |

## 慣例

- 日期/時間一律以 UTC+8（台灣時間）儲存，顯示時再依當前登入者（學生/老師）設定的個人時區換算。
- 每個頁面各自維護自己的 JS 邏輯，不共用元件模組；只有真正通用的行為才放進 `public/script.js`。
