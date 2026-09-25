// ==========================================================================
// 共用頭像/課程圖工具
// ==========================================================================
const AVATAR_LIST = [
  '001-bear.png', '002-rabbit.png', '003-cow.png', '004-puffer-fish.png', '005-owl.png',
  '006-panda.png', '007-hen.png', '008-llama.png', '009-elephant.png', '010-cat.png',
  '011-penguin.png', '012-chicken.png', '013-frog.png', '014-hedgehog.png', '015-mouse.png',
  '016-duck.png', '017-dog.png', '018-sloth.png', '019-ferret.png', '020-beaver.png',
  '021-wild-boar.png', '022-chameleons.png', '023-koala.png', '024-squirrel.png', '025-turkey.png',
  '026-deer.png', '027-fox.png', '028-bat.png', '029-lion.png', '030-parrot.png',
  '031-ostrich.png', '032-snake.png', '033-camel.png', '034-horse.png', '035-skunk.png',
  '036-hippopotamus.png', '037-crab.png', '038-rhino.png', '039-giraffe.png', '040-gorilla.png',
  '041-zebra.png', '042-wolf.png', '043-goat.png', '044-turtle.png', '045-pig.png',
  '046-walrus.png', '047-bee.png', '048-sheep.png', '049-monkey.png', '050-octopus.png',
  '051-bear-1.png', '052-sea-lion.png', '053-polar-bear.png',
];
// 把資料放進 innerHTML 的樣板字串之前一律先跳脫：老師的專長／座右銘可以自己改，姓名、課程名稱
// 等也都是使用者輸入的文字，直接塞進 HTML 會讓裡面的 <script>、onerror= 之類的內容被執行（XSS）。
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function randomAvatar() { return AVATAR_LIST[Math.floor(Math.random() * AVATAR_LIST.length)]; }
function avatarSrc(avatar) {
  if (!avatar) return `../assets/avatars/${randomAvatar()}`;
  if (avatar.startsWith('data:')) return avatar; // 舊資料相容：裁切後直接存 base64（尚未上傳到 R2）
  if (avatar.startsWith('avatars/')) return `/${avatar}`; // R2 上傳的真實頭像，經 Worker /avatars/:key 讀取
  return `../assets/avatars/${avatar}`; // 隨機動物頭像（打包在 assets 裡的固定圖示）
}

// 課程詳情標題旁的複製按鈕（學生預約紀錄／老師我的課程／管理端預約紀錄／管理端學生預約紀錄共用）：
// 直接把畫面上課程詳情每一格的「標題：內容」加上狀態組成文字——畫面顯示什麼就複製什麼，時區也
// 自動跟該頁一致。方便使用者有問題時直接貼給客服／老師／學生，不用自己謄打。
function bindCopyDetailButton(btn, getStatusLabel, onFail) {
  const icon = btn.querySelector('i');
  // .copy-icon-pop 沒被拿掉過就直接換圖示 class 的話，動畫不會重播（CSS animation 只在 class
  // 真的「從無到有」時才會重新觸發）。先換 class、強制 reflow、再加回去，確保每次點擊都重播。
  function swapIcon(newIconClass) {
    icon.className = newIconClass;
    void icon.offsetWidth;
    icon.classList.add('copy-icon-pop');
  }
  btn.addEventListener('click', async () => {
    const summary = btn.closest('.section').querySelector('.confirm-summary');
    const lines = [...summary.querySelectorAll('.confirm-highlight')]
      .filter((el) => !el.hidden)
      .map((el) => `${el.querySelector('p').textContent}：${el.querySelector('h3').textContent}`);
    const status = getStatusLabel();
    if (status) lines.push(`${t('history.detail.status')}：${status}`);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      swapIcon('fa-solid fa-check');
      setTimeout(() => swapIcon('fa-regular fa-copy'), 1500);
    } catch {
      onFail();
    }
  });
}

// 課程詳情「課程」那一格的圖示（管理端預約紀錄／學生預約紀錄／老師我的課程共用）：
// 課程有上傳封面圖就用真的課程圖片（圓形裁切，跟課程管理列表一致），沒有就維持書本圖示。
function setCourseHighlightIcon(imgEl, course) {
  const src = course ? courseImageSrc(course.image) : '';
  imgEl.src = src || '../assets/icons/books.png';
  imgEl.classList.toggle('is-course-photo', !!src);
}

// 課程封面圖：沒上傳過就回傳空字串（呼叫端自行 fallback 成色塊+文字）
function courseImageSrc(image) {
  if (!image) return '';
  if (image.startsWith('data:')) return image; // 舊資料相容：裁切後直接存 base64（尚未上傳到 R2）
  if (image.startsWith('courses/')) return `/${image}`; // R2 上傳的真實課程圖，經 Worker /courses/:key 讀取
  return `../assets/avatars/${image}`; // 隨機圖示（沿用跟老師/學生一樣的動物圖示集）
}

// 老師端三頁（教課可能時間／我的課程／休假申請）要讀「這頁在看的那位老師」的完整資料（時區在領收書資料裡）：
//   老師本人 → /api/teachers/me（只回自己那筆）
//   管理者代管 → /api/teachers 完整清單裡找 ?id= 那位（完整欄位只有管理者拿得到，
//                學生／老師呼叫 /api/teachers 只會拿到選老師卡片需要的公開欄位）
async function loadCurrentTeacher(viewingAsAdmin, teacherIdParam) {
  if (!viewingAsAdmin) {
    return fetch('/api/teachers/me').then((res) => (res.ok ? res.json() : null)).catch(() => null);
  }
  const teachers = await fetch('/api/teachers').then((res) => (res.ok ? res.json() : [])).catch(() => []);
  return teachers.find((t) => t.id === Number(teacherIdParam)) || null;
}

// 設定頁（學生／老師）的「上傳圖片」：選檔 → 裁切成 400x400 正方形 → 交給 onCropped(dataUrl, blob)。
// 跟管理端不同，這裡裁切完不會馬上上傳：呼叫端先用 dataUrl 本地預覽，按「確認編輯」才真的上傳，
// 沒按就離開的話伺服器上的頭像不會被換掉。頁面上要有 #avatarCropModal 那組裁切 modal 跟 Cropper.js。
function bindAvatarCropUpload(uploadBtn, fileInput, onCropped) {
  const CROP_OUTPUT_SIZE = 400;
  const modal = document.getElementById('avatarCropModal');
  const img = document.getElementById('avatar-crop-image');
  let cropper = null;

  function closeCropModal() {
    if (cropper) { cropper.destroy(); cropper = null; }
    modal.classList.remove('open');
    fileInput.value = '';
  }

  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      img.src = reader.result;
      modal.classList.add('open');
      img.onload = () => {
        if (cropper) cropper.destroy();
        cropper = new Cropper(img, { aspectRatio: 1, viewMode: 1, dragMode: 'move', guides: true, autoCropArea: 1, background: false });
      };
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('avatar-crop-confirm-btn').addEventListener('click', () => {
    if (!cropper) return;
    const canvas = cropper.getCroppedCanvas({ width: CROP_OUTPUT_SIZE, height: CROP_OUTPUT_SIZE });
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    canvas.toBlob((blob) => { if (blob) onCropped(dataUrl, blob); }, 'image/jpeg', 0.8);
    closeCropModal();
  });
  document.getElementById('avatar-crop-cancel-btn').addEventListener('click', closeCropModal);
  document.getElementById('avatar-crop-close-btn').addEventListener('click', closeCropModal);
}

// ==========================================================================
// 分頁（列表 + 分頁按鈕）
// ==========================================================================
function paginate(items, pageSize, renderRowFn, containerEl, paginationEl, pageState, emptyHtml, onRender) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  pageState.page = Math.min(pageState.page, totalPages);
  const start = (pageState.page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  containerEl.innerHTML = pageItems.map(renderRowFn).join('') || emptyHtml;
  if (onRender) onRender(containerEl);

  paginationEl.innerHTML = '';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.setAttribute('aria-label', '上一頁');
  prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
  prevBtn.disabled = pageState.page === 1;
  prevBtn.addEventListener('click', () => {
    pageState.page--;
    paginate(items, pageSize, renderRowFn, containerEl, paginationEl, pageState, emptyHtml, onRender);
  });
  paginationEl.appendChild(prevBtn);

  for (let p = 1; p <= totalPages; p++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = p;
    if (p === pageState.page) btn.classList.add('active');
    btn.addEventListener('click', () => {
      pageState.page = p;
      paginate(items, pageSize, renderRowFn, containerEl, paginationEl, pageState, emptyHtml, onRender);
    });
    paginationEl.appendChild(btn);
  }

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.setAttribute('aria-label', '下一頁');
  nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
  nextBtn.disabled = pageState.page === totalPages;
  nextBtn.addEventListener('click', () => {
    pageState.page++;
    paginate(items, pageSize, renderRowFn, containerEl, paginationEl, pageState, emptyHtml, onRender);
  });
  paginationEl.appendChild(nextBtn);
}

// ==========================================================================
// 下拉選單（下拉框選單）讀寫目前選取值
// ==========================================================================
function getDropdownValue(dropdownId) {
  const selected = document.querySelector(`#${dropdownId} .dropdown-menu li.selected`);
  return selected ? selected.dataset.value : null;
}
function setDropdownValue(dropdownId, value) {
  if (!value) return;
  const dropdown = document.getElementById(dropdownId);
  const items = [...dropdown.querySelectorAll('.dropdown-menu li')];
  // 時區標籤比對忽略寫法差異：舊資料可能是 '(UTC+6:30) 仰光'、'(UTC+9) 東京' 這種有括號、沒補零
  // 或城市名稱不同的寫法，選項則是 'UTC+06:30 仰光'——完全一樣的找不到時，改用解析出來的 UTC
  // 偏移量比對，不然選單會什麼都沒選到，按儲存時時區就被存成空白。
  const isTimezone = (v) => /UTC[+-]\d/.test(v || '');
  const li = items.find((l) => l.dataset.value === value)
    || (isTimezone(value) ? items.find((l) => isTimezone(l.dataset.value) && parseUtcOffset(l.dataset.value) === parseUtcOffset(value)) : null);
  if (!li) return;
  dropdown.querySelectorAll('.dropdown-menu li').forEach((l) => l.classList.remove('selected'));
  li.classList.add('selected');
  dropdown.querySelector('.dropdown-trigger .label').textContent = li.textContent.trim();
  dropdown.dispatchEvent(new CustomEvent('dropdown:change', { bubbles: true }));
}

// ==========================================================================
// Dropdown (custom select)
// ==========================================================================
document.querySelectorAll('.dropdown').forEach((dropdown) => {
  const trigger = dropdown.querySelector('.dropdown-trigger');
  const menu = dropdown.querySelector('.dropdown-menu');
  const label = dropdown.querySelector('.dropdown-trigger .label');
  const multi = dropdown.dataset.multi === 'true';

  trigger.addEventListener('click', () => {
    document.querySelectorAll('.dropdown.open').forEach((other) => {
      if (other !== dropdown) other.classList.remove('open');
    });
    dropdown.classList.toggle('open');
  });

  menu.querySelectorAll('li').forEach((item) => {
    item.addEventListener('click', () => {
      if (multi) {
        item.classList.toggle('selected');
        // data-label 是給需要「顯示文字跟實際存值不同」的下拉選單用的（例如星期
        // 幾要翻譯成使用者語言、但存進資料庫的 value 得維持固定的中文 key）；沒
        // 設定就照舊用 data-value，其他既有的下拉選單完全不受影響。
        const chosen = [...menu.querySelectorAll('li.selected')].map((li) => li.dataset.label || li.dataset.value);
        label.textContent = chosen.length ? chosen.join('、') : dropdown.dataset.placeholder;
      } else {
        menu.querySelectorAll('li').forEach((li) => li.classList.remove('selected'));
        item.classList.add('selected');
        label.textContent = item.dataset.label || item.dataset.value;
        dropdown.classList.remove('open');
      }
      // 讓頁面知道選取變了（例如「選齊了才讓新增按鈕可以按」）
      dropdown.dispatchEvent(new CustomEvent('dropdown:change', { bubbles: true }));
    });
  });
});

document.addEventListener('click', (e) => {
  document.querySelectorAll('.dropdown.open').forEach((dropdown) => {
    if (!dropdown.contains(e.target)) dropdown.classList.remove('open');
  });
});

// ==========================================================================
// 多語系（i18n）——語言字典由 /i18n/{lang}.json 抓取，套用到帶
// data-i18n / data-i18n-placeholder / data-i18n-aria-label 屬性的元素；
// 帳號登入後的「真相」存在資料庫的 language 欄位（見 src/index.ts 的
// /api/me/language），這裡的 localStorage 只是登入前、或 API 回應前的
// 暫存/預設值，避免畫面閃一下才套用正確語言。
// ==========================================================================
const SUPPORTED_LANGUAGES = ['zh-Hant', 'ja', 'en', 'vi', 'my'];
const LANG_LABELS = {
  'zh-Hant': '繁體中文',
  ja: '日本語',
  en: 'English',
  vi: 'Tiếng Việt',
  my: 'မြန်မာဘာသာ',
};
const LANG_STORAGE_KEY = 'lang';

function getCurrentLang() {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    return SUPPORTED_LANGUAGES.includes(stored) ? stored : 'zh-Hant';
  } catch {
    return 'zh-Hant';
  }
}
function setCurrentLang(lang) {
  try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch {}
}

let i18nDict = {};
let i18nLang = null;

async function loadI18nDict(lang) {
  if (i18nLang === lang) return;
  const res = await fetch(`/i18n/${lang}.json`).catch(() => null);
  i18nDict = res && res.ok ? await res.json() : {};
  i18nLang = lang;
}

// {{name}} 佔位符做簡單字串替換（例如「還可在 {{seconds}} 秒後...」）。
function t(key, params) {
  let text = i18nDict[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{{${k}}}`, v);
    }
  }
  return text;
}

function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
}

async function initI18n(lang) {
  await loadI18nDict(lang);
  document.documentElement.lang = lang;
  applyTranslations();
}

// 語言切換元件：把 🌐 圖示鈕 + 下拉選單畫進 container，選了新語言就更新
// localStorage、重新套用翻譯，並透過 onChange 讓呼叫端決定要不要連帶存回帳號。
function renderLangSwitch(container, currentLang, onChange) {
  container.classList.add('lang-switch');
  container.innerHTML = `
    <button type="button" class="lang-switch-trigger" aria-label="Language"><i class="fa-solid fa-fw fa-globe"></i></button>
    <ul class="lang-switch-menu">
      ${SUPPORTED_LANGUAGES.map((code) => `<li data-value="${code}" class="${code === currentLang ? 'selected' : ''}">${LANG_LABELS[code]}<span class="select-badge"><i class="fa-solid fa-fw fa-check"></i></span></li>`).join('')}
    </ul>`;

  container.querySelector('.lang-switch-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    container.classList.toggle('open');
  });
  container.querySelectorAll('.lang-switch-menu li').forEach((li) => {
    li.addEventListener('click', async () => {
      const lang = li.dataset.value;
      container.classList.remove('open');
      if (lang === i18nLang) return;
      container.querySelectorAll('.lang-switch-menu li').forEach((l) => l.classList.remove('selected'));
      li.classList.add('selected');
      setCurrentLang(lang);
      // 淡出→換字→淡入，蓋掉不同語言文字長度不一造成的版面跳動；只在使用者主動
      // 切換語言時做，第一次載入頁面呼叫 initI18n() 不會經過這裡，不受影響。
      document.body.classList.add('i18n-fade-out');
      await new Promise((resolve) => setTimeout(resolve, 150));
      await initI18n(lang);
      document.body.classList.remove('i18n-fade-out');
      if (onChange) onChange(lang);
    });
  });
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) container.classList.remove('open');
  });
}

// ==========================================================================
// 多語系日期格式——用 Intl.DateTimeFormat 依語言自動套用當地慣用的日期
// 順序/標點，而不是每個語言各自手刻規則。時間一律用 24 小時制 HH:mm，
// 這點在所有語言下順序都一樣，不需要另外處理。
// ==========================================================================
const DATE_LOCALE_MAP = {
  'zh-Hant': 'zh-TW',
  ja: 'ja-JP',
  en: 'en-GB',
  vi: 'vi-VN',
  my: 'my-MM-u-nu-latn', // 緬甸文用阿拉伯數字（0-9），比原生緬甸數字更符合當地數位產品慣例
};
// 短格式的星期縮寫要各語言分開挑：中/日/越用 narrow（單字不重複、看得出差異）；
// 英文 narrow 會有 T=Tuesday/Thursday 撞字問題，改用 short。緬甸文不透過這裡
// 的 Intl 路徑（見下方 MY_WEEKDAY_NAMES 的說明），這裡的設定對它沒有作用。
const WEEKDAY_SHORT_STYLE_MAP = { 'zh-Hant': 'narrow', ja: 'narrow', en: 'short', vi: 'narrow' };

// 緬甸文（my）星期／月份名稱直接寫死，不透過 Intl.DateTimeFormat 查——實測發現
// 不少瀏覽器（例如某些 Android WebView、這次測試用的 Chromium）沒有內建緬甸文
// 的語系資料，Intl 遇到不支援的語言會「悄悄 fallback 回系統預設語言」而不是報
// 錯，畫面就會變成使用者選了緬甸文、卻看到中文或英文日期的狀況。寫死表格可以
// 保證不管瀏覽器支不支援，緬甸文使用者看到的永遠是正確的緬甸文。
// 索引對齊 Date.getDay()（0 = 星期日）；緬甸文的星期名稱沒有更短的縮寫形式
// （長格式、短格式是同一組字），這點已經用 Intl 在有支援的環境下驗證過。
const MY_WEEKDAY_NAMES = ['တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ'];
// 日期選擇器的星期標題欄位很窄，緬甸文全名（尤其星期四 ကြာသပတေး）會擠爆，這裡另外用單字縮寫，
// 索引與 MY_WEEKDAY_NAMES 對齊（0 = 星期日）。
const MY_WEEKDAY_SHORT_NAMES = ['နွေ', 'လာ', 'ဂါ', 'ဟူး', 'ကြာ', 'သော', 'နေ'];
const MY_MONTH_NAMES = [
  'ဇန်နဝါရီ', 'ဖေဖော်ဝါရီ', 'မတ်', 'ဧပြီ', 'မေ', 'ဇွန်',
  'ဇူလိုင်', 'သြဂုတ်', 'စက်တင်ဘာ', 'အောက်တိုဘာ', 'နိုဝင်ဘာ', 'ဒီဇင်ဘာ',
];
// 數字仍用阿拉伯數字（0-9），跟緬甸當地數位產品的慣例一致（見 DATE_LOCALE_MAP 的說明）。
function myFormatLong(d) {
  return `${d.getFullYear()} ${MY_MONTH_NAMES[d.getMonth()]} ${d.getDate()} ${MY_WEEKDAY_NAMES[d.getDay()]}`;
}
function myFormatShort(d) {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getFullYear()} ${MY_WEEKDAY_NAMES[d.getDay()]}`;
}
function myMonthYearLabel(year, month) {
  return `${MY_MONTH_NAMES[month]} ${year}`;
}

// ==========================================================================
// 老師／學生「時區」欄位（例：'UTC+06:30 仰光'；舊資料可能是 '(UTC+6:30) 仰光'）— 從標籤字串解析出實際小時
// 差，統一在這裡處理，courses/hours/lessons/booking-history 等頁面都共用，
// 才不用每個頁面各自寫一份、又漏掉緬甸這種非整數小時的時區。
// ==========================================================================
// 上課日期時間一律以 UTC+8（台北時間）儲存，預約／取消的時限也都以 UTC+8 判斷，不受瀏覽器
// 所在時區影響（跟後端 src/index.ts 的同名函式算法一致）。
function hoursUntilUtc8(dateISO, timeStr) {
  return (Date.parse(`${dateISO}T${timeStr}:00+08:00`) - Date.now()) / 3600000;
}
function utc8DateISO(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

function parseUtcOffset(label) {
  const m = /UTC([+-]\d+)(?::(\d+))?/.exec(label || '');
  if (!m) return 8; // 沒有設定時區時，跟資料庫時間基準（UTC+8）一致
  const hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) / 60 : 0;
  return hours < 0 ? hours - minutes : hours + minutes;
}

// ISO 8601 風格的固定寬度格式（"+08:00"、"+06:30"），所有時區長度一致，
// 不會有的補 0、有的沒補（"+8" 跟 "+6:30" 混用）這種不一致的寫法。
function formatUtcOffset(offsetHours) {
  const sign = offsetHours < 0 ? '-' : '+';
  const abs = Math.abs(offsetHours);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 句子裡要帶出時區時用（例：「所有時段皆為 UTC+06:30 仰光時間」）——統一成不帶括號、
// 偏移量補零的 'UTC+06:30 仰光'；舊資料 '(UTC+6:30) 仰光' 這種寫法也會轉成一樣的格式。
function formatTimezoneForSentence(label) {
  const city = (label || '').replace(/^\s*\(?UTC[+-][\d:]*\)?\s*/, '').trim();
  return `UTC${formatUtcOffset(parseUtcOffset(label))}${city ? ` ${city}` : ''}`;
}

// 老師時段（teacher_hours）用固定的中文「星期幾」字串當資料庫的 day 值（跟
// src/index.ts 的 WEEKDAY_NAMES 一致），畫面顯示才需要翻譯——這裡只是顯示用
// 的查表，不影響實際存值。
const WEEKDAY_KEY_TO_I18N = {
  '星期一': 'weekday.mon', '星期二': 'weekday.tue', '星期三': 'weekday.wed',
  '星期四': 'weekday.thu', '星期五': 'weekday.fri', '星期六': 'weekday.sat', '星期日': 'weekday.sun',
};
function weekdayLabel(key) {
  return t(WEEKDAY_KEY_TO_I18N[key] || key);
}

function parseYmd(dateInput) {
  return dateInput instanceof Date ? dateInput : new Date(String(dateInput).replaceAll('/', '-'));
}

function formatDateLong(dateInput, lang = getCurrentLang()) {
  const d = parseYmd(dateInput);
  if (lang === 'my') return myFormatLong(d);
  const locale = DATE_LOCALE_MAP[lang] || DATE_LOCALE_MAP['zh-Hant'];
  if (lang === 'zh-Hant') {
    // 年月日之間留空白、月/日補成兩位數（09 而非 9），星期前面也留空白：
    // 「2026 年 09 月 10 日 星期四」。
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(d);
    return `${d.getFullYear()} 年 ${month} 月 ${day} 日 ${weekday}`;
  }
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(d);
}

function formatDateShort(dateInput, lang = getCurrentLang()) {
  const d = parseYmd(dateInput);
  if (lang === 'my') return myFormatShort(d);
  const locale = DATE_LOCALE_MAP[lang] || DATE_LOCALE_MAP['zh-Hant'];
  // 繁體中文用 ASCII 括號 + 單字星期（例：2026/09/22(二)），跟其他語言的
  // locale 預設組合輸出（例：Tue, 22/09/2026）故意做成不同排法。
  if (lang === 'zh-Hant') {
    const datePart = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(d);
    return `${datePart}(${weekday})`;
  }
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', weekday: WEEKDAY_SHORT_STYLE_MAP[lang] || 'short' }).format(d);
}
// ==========================================================================
// Date picker (single-day select, demo month navigation)
// ==========================================================================
(() => {
  const picker = document.querySelector('[data-datepicker]');
  if (!picker) return;

  const monthLabel = picker.querySelector('[data-month-label]');
  const grid = picker.querySelector('[data-grid]');
  const prevBtn = picker.querySelector('[data-prev]');
  const nextBtn = picker.querySelector('[data-next]');
  const weekdayHeaderEls = [...picker.querySelectorAll('.datepicker-weekdays span')];

  const now = new Date();
  let viewYear = now.getFullYear();
  let viewMonth = now.getMonth();
  const today = { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
  let selected = null;

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function firstWeekdayMon0(y, m) { const d = new Date(y, m, 1).getDay(); return (d + 6) % 7; }

  // 星期標題（週一開頭，跟格子的排法一致）依語言產生；緬甸文查表（見
  // MY_WEEKDAY_NAMES 的說明），其他語言交給 Intl，不要寫死中文。
  if (weekdayHeaderEls.length === 7) {
    const lang = getCurrentLang();
    picker.querySelector('.datepicker-weekdays').classList.toggle('is-compact', lang === 'my');
    if (lang === 'my') {
      // MY_WEEKDAY_NAMES 索引 0 = 星期日，這裡從星期一開始排，所以位移一格。
      for (let i = 0; i < 7; i++) {
        weekdayHeaderEls[i].textContent = MY_WEEKDAY_SHORT_NAMES[(i + 1) % 7];
      }
    } else {
      const locale = DATE_LOCALE_MAP[lang] || DATE_LOCALE_MAP['zh-Hant'];
      const style = WEEKDAY_SHORT_STYLE_MAP[lang] || 'narrow';
      // 2026-01-05 是週一，從這天開始連续取 7 天即為週一到週日。
      for (let i = 0; i < 7; i++) {
        const d = new Date(2026, 0, 5 + i);
        weekdayHeaderEls[i].textContent = new Intl.DateTimeFormat(locale, { weekday: style }).format(d);
      }
    }
  }

  function render() {
    // 月份標題：緬甸文查表，其他語言交給 Intl 依語言自動調整年月順序/標點
    // （例如英文會變成 "August 2026"），不是每個語言都跟中文一樣「年 月」這種順序。
    const lang = getCurrentLang();
    if (lang === 'my') {
      monthLabel.textContent = myMonthYearLabel(viewYear, viewMonth);
    } else {
      const locale = DATE_LOCALE_MAP[lang] || DATE_LOCALE_MAP['zh-Hant'];
      monthLabel.textContent = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(new Date(viewYear, viewMonth, 1));
    }
    picker.dataset.year = viewYear;
    picker.dataset.month = viewMonth;
    grid.innerHTML = '';

    const leading = firstWeekdayMon0(viewYear, viewMonth);
    const total = daysInMonth(viewYear, viewMonth);
    const prevTotal = daysInMonth(viewYear, viewMonth - 1 < 0 ? 11 : viewMonth - 1);

    for (let i = leading; i > 0; i--) {
      grid.appendChild(makeDay(prevTotal - i + 1, true));
    }
    for (let d = 1; d <= total; d++) {
      grid.appendChild(makeDay(d, false));
    }
    const trailing = 42 - grid.children.length;
    for (let d = 1; d <= trailing; d++) {
      grid.appendChild(makeDay(d, true));
    }

    picker.dispatchEvent(new CustomEvent('datepicker:rendered', { bubbles: true }));
  }

  function makeDay(day, muted) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = day;
    if (muted) {
      btn.classList.add('muted');
      return btn;
    }
    const isToday = viewYear === today.year && viewMonth === today.month && day === today.day;
    const isSelected = !!selected && viewYear === selected.year && viewMonth === selected.month && day === selected.day;
    if (isToday) btn.classList.add('today');
    if (isSelected) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      selected = { year: viewYear, month: viewMonth, day };
      render();
      picker.dispatchEvent(new CustomEvent('datepicker:change', { bubbles: true }));
    });
    return btn;
  }

  function bounce(el) {
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  let animating = false;

  function navigate(direction) {
    animating = true;
    const outClass = direction === 'next' ? 'slide-out-left' : 'slide-out-right';
    const inClass = direction === 'next' ? 'slide-in-right' : 'slide-in-left';
    grid.classList.add(outClass);
    grid.addEventListener('animationend', function onOut() {
      grid.removeEventListener('animationend', onOut);
      grid.classList.remove(outClass);
      render();
      grid.classList.add(inClass);
      grid.addEventListener('animationend', function onIn() {
        grid.removeEventListener('animationend', onIn);
        grid.classList.remove(inClass);
        animating = false;
      }, { once: true });
    }, { once: true });
  }

  prevBtn.addEventListener('click', () => {
    if (animating) return;
    viewMonth -= 1;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    bounce(prevBtn);
    navigate('prev');
  });
  nextBtn.addEventListener('click', () => {
    if (animating) return;
    viewMonth += 1;
    if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    bounce(nextBtn);
    navigate('next');
  });

  render();
})();

// ==========================================================================
// Time slots
// ==========================================================================
document.querySelectorAll('.time-slots').forEach((group) => {
  group.querySelectorAll('.time-slot').forEach((slot) => {
    if (slot.classList.contains('disabled')) return;
    slot.addEventListener('click', () => {
      group.querySelectorAll('.time-slot').forEach((s) => s.classList.remove('selected'));
      slot.classList.add('selected');
    });
  });
});

// ==========================================================================
// Timezone cards
// ==========================================================================
const tzCards = document.querySelectorAll('.tz-card');
tzCards.forEach((card) => {
  card.addEventListener('click', () => {
    tzCards.forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
  });
});

// ==========================================================================
// Stripe selection cards
// ==========================================================================
const stripeCards = document.querySelectorAll('.stripe-card');
stripeCards.forEach((card) => {
  card.addEventListener('click', () => {
    stripeCards.forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
  });
});

// ==========================================================================
// 3D tilt on mousemove (shared by teacher/course cards, timezone cards, time slots)
// ==========================================================================
function applyTiltEffect(card, intensity = 12) {
  card.addEventListener('mousemove', (e) => {
    if (card.dataset.tiltSuspended === 'true' || card.classList.contains('disabled') || card.classList.contains('locked')) return;
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    const rotateX = (-y * intensity).toFixed(2);
    const rotateY = (x * intensity).toFixed(2);
    card.style.transform = `perspective(700px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    card.style.boxShadow = `${-x * 20}px ${20 - y * 10}px 30px rgba(45,74,107,0.18)`;
  });

  card.addEventListener('mouseleave', () => {
    if (card.dataset.tiltSuspended === 'true' || card.classList.contains('disabled') || card.classList.contains('locked')) return;
    card.style.transform = 'perspective(700px) rotateX(0deg) rotateY(0deg)';
    card.style.boxShadow = '';
  });
}

document.querySelectorAll('.tilt-card').forEach((card) => {
  applyTiltEffect(card);

  card.addEventListener('click', () => {
    if (card.classList.contains('disabled') || card.classList.contains('locked')) return;
    const group = card.dataset.group;
    if (group) {
      document.querySelectorAll(`.tilt-card[data-group="${group}"]`).forEach((c) => {
        if (c !== card) c.classList.remove('selected');
      });
      card.classList.add('selected');
    } else {
      card.classList.toggle('selected');
    }
  });
});

document.querySelectorAll('.tz-card').forEach(applyTiltEffect);
document.querySelectorAll('.time-slot:not(.disabled)').forEach((slot) => applyTiltEffect(slot, 28));
document.querySelectorAll('.entry-card').forEach((card) => applyTiltEffect(card, 6));

// ==========================================================================
// Star rating — starsHtml() renders a read-only 1-5 star row as an HTML
// string, for embedding in card/detail template literals (booking card
// badges, teacher/admin read-only displays). initStarRatingInput() wires a
// clickable picker into a live container — only the student's own rating
// input (booking-history.html) needs this; every other display is read-only
// and just uses starsHtml().
// ==========================================================================
// 「課程回饋」區塊：每個人一段——大頭照＋名字、星星、留言／課堂記錄（還沒填就是空星星＋灰字
// 「尚無留言」）。管理者兩段（學生、老師）都放，老師／學生只放自己那段，可見範圍跟後端
// bookingRowToJson 一致。用 DOM 組而不是拼 HTML 字串：留言是使用者輸入的文字，要用
// textContent 才不會被當成 HTML 執行。
// entries: [{ avatar, name, rating, text }]
function renderFeedbackEntries(container, entries) {
  container.replaceChildren(...entries.map(({ avatar, name, rating, text }) => {
    const entry = document.createElement('div');
    entry.className = 'feedback-entry';
    const label = document.createElement('p');
    label.className = 'feedback-label';
    const img = document.createElement('img');
    img.className = 'feedback-avatar';
    img.src = avatarSrc(avatar);
    img.alt = '';
    const nameEl = document.createElement('span');
    nameEl.className = 'feedback-name';
    nameEl.textContent = name || '';
    label.append(img, nameEl);
    const stars = document.createElement('div');
    stars.className = 'feedback-stars';
    stars.innerHTML = starsHtml(rating);
    const textEl = document.createElement('p');
    textEl.className = `text-small feedback-text${text ? '' : ' is-empty'}`;
    textEl.textContent = text || t('history.feedback.noComment');
    entry.append(label, stars, textEl);
    return entry;
  }));
}

// 已完成課堂卡片上的回饋標籤：「★ 評分」＋「💬 有沒有留言／課堂記錄（0 或 1）」，還沒評分就是 ★ 0。
// 學生的是黃色、老師的是粉紅色——學生卡片只放學生自己的、老師卡片只放老師自己的，管理者兩個都放
// （可見範圍跟後端 bookingRowToJson 一致）。
function feedbackPillHtml(who, tone, rating, text) {
  const hasText = text && text.trim() ? 1 : 0;
  return `<span class="pill ${tone} has-icon booking-card-feedback-pill" aria-label="${who}"><i class="fa-solid fa-star"></i>${rating ?? 0}<img class="pill-icon" src="../assets/icons/chat.png" alt="">${hasText}</span>`;
}
function studentFeedbackPillHtml(booking) {
  return feedbackPillHtml(t('history.feedback.studentRating'), 'rating-star', booking.rating, booking.studentComment);
}
function teacherFeedbackPillHtml(booking) {
  return feedbackPillHtml(t('history.feedback.teacherRating'), 'tone-rose', booking.teacherRating, booking.teacherNote);
}

function starsHtml(value, extraClass = '') {
  const stars = Array.from({ length: 5 }, (_, i) =>
    `<i class="fa-${i < (value || 0) ? 'solid' : 'regular'} fa-star"></i>`
  ).join('');
  return `<span class="star-rating${extraClass ? ` ${extraClass}` : ''}">${stars}</span>`;
}

// 按鈕從「不能按」變成「可以按」的那一下跳一次（.btn-enabled-pop）。呼叫端只在真的從停用
// 變成可按時呼叫，避免重複檢查時一直重播。class 拿掉、強制 reflow 再加回去，確保動畫每次
// 都能從頭播放（同一個 class 持續存在的話瀏覽器不會重播 CSS animation）。
function playEnabledPop(btn) {
  btn.classList.remove('btn-enabled-pop');
  void btn.offsetWidth;
  btn.classList.add('btn-enabled-pop');
}
// 依條件切換按鈕能不能按；從停用變成可按的那一下自動跳一次，已經可按時重複呼叫不會重播。
function setButtonEnabled(btn, enabled) {
  const wasDisabled = btn.disabled;
  btn.disabled = !enabled;
  if (wasDisabled && enabled) playEnabledPop(btn);
}
// 讓按鈕跟著表單內容切換能不能按：container 裡任何輸入（打字、勾選、下拉選單）都會重新用
// isReady() 判斷，從停用變成可按時跳一下。不是表單欄位造成的變動（例如換頭像、儲存成功後
// 更新了「已儲存」的基準）由呼叫端自己呼叫回傳的 refresh()。
function watchForm(container, btn, isReady) {
  const refresh = () => setButtonEnabled(btn, isReady());
  ['input', 'change', 'dropdown:change'].forEach((type) => container.addEventListener(type, refresh));
  btn.disabled = !isReady();
  return refresh;
}

// 星星按鈕只建立一次，hover／點擊時只切換圖示樣式——不能在 hover 時重建按鈕：滑鼠按下跟放開
// 之間如果游標底下的按鈕被換成新的元素，瀏覽器不會觸發 click，真的用滑鼠點星星會點不到。
function initStarRatingInput(container, onChange) {
  let value = 0;
  container.innerHTML = Array.from({ length: 5 }, (_, i) =>
    `<button type="button" class="star-rating-btn" data-value="${i + 1}" aria-label="${t('booking.rating.starLabel', { n: i + 1 })}"><i class="fa-regular fa-star"></i></button>`
  ).join('');
  const buttons = [...container.querySelectorAll('.star-rating-btn')];
  function paint(shown) {
    buttons.forEach((btn, i) => { btn.querySelector('i').className = `fa-${i < shown ? 'solid' : 'regular'} fa-star`; });
  }
  buttons.forEach((btn) => {
    const n = Number(btn.dataset.value);
    btn.addEventListener('mouseenter', () => paint(n));
    btn.addEventListener('mouseleave', () => paint(value));
    btn.addEventListener('click', () => { value = n; paint(value); onChange(n); });
  });
}

// ==========================================================================
// Modal
// ==========================================================================
document.querySelectorAll('[data-modal-open]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.modalOpen).classList.add('open');
  });
});
document.querySelectorAll('[data-modal-close]').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.closest('.modal-overlay').classList.remove('open');
  });
});
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !overlay.hasAttribute('data-modal-persistent')) {
      overlay.classList.remove('open');
    }
  });
});

// ==========================================================================
// Login (email OTP, backed by /api/otp/request + /api/otp/verify)
// ==========================================================================
(() => {
  const card = document.querySelector('[data-login]');
  if (!card) return;

  const emailField = card.querySelector('[data-login-email-field]');
  const emailInput = card.querySelector('#login-email');
  const sendBtn = card.querySelector('[data-login-send]');
  const submitBtn = card.querySelector('[data-login-submit]');
  const otpBoxes = [...card.querySelectorAll('.otp-box')];

  const alertModal = document.getElementById('loginAlertModal');
  const alertIcon = document.getElementById('login-alert-icon');
  const alertIconInner = document.getElementById('login-alert-icon-inner');
  const alertText = document.getElementById('login-alert-text');
  const ALERT_ICON_MAP = {
    success: { tone: 'success', icon: 'fa-check' },
    warning: { tone: 'warning', icon: 'fa-exclamation' },
    error: { tone: 'danger', icon: 'fa-xmark' },
  };
  function showLoginAlert(message, type = 'warning') {
    const cfg = ALERT_ICON_MAP[type] || ALERT_ICON_MAP.warning;
    alertIcon.className = `modal-icon ${cfg.tone}`;
    alertIconInner.className = `fa-solid fa-fw ${cfg.icon}`;
    alertText.textContent = message;
    alertModal.classList.add('open');
  }

  let countdownId = null;
  let cooldownRemaining = 0;
  let isRequesting = false;

  function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  function stopCountdown() {
    clearInterval(countdownId);
    cooldownRemaining = 0;
  }

  function startCountdown() {
    cooldownRemaining = 30;
    clearInterval(countdownId);
    countdownId = setInterval(() => {
      cooldownRemaining -= 1;
      if (cooldownRemaining <= 0) {
        clearInterval(countdownId);
        cooldownRemaining = 0;
      }
    }, 1000);
  }

  async function requestCode(email) {
    isRequesting = true;
    try {
      const res = await fetch('/api/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: card.dataset.role }),
      });
      if (res.status === 429) {
        // 申請太頻繁：冷卻中顯示還要等幾秒，1 小時內申請太多次則請使用者稍後再試
        const data = await res.json().catch(() => ({}));
        showLoginAlert(data.retryAfter
          ? t('login.warning.cooldown', { seconds: data.retryAfter })
          : t('login.error.tooManyRequests'), 'warning');
        return;
      }
      if (!res.ok) {
        // 用翻譯好的訊息（後端的錯誤訊息是中文），例如信件寄送失敗
        showLoginAlert(t('login.error.sendFailed'), 'error');
        return;
      }
      otpBoxes.forEach((b) => { b.disabled = false; b.value = ''; b.classList.remove('filled', 'error'); });
      setButtonEnabled(submitBtn, true); // 第一次寄出驗證碼時「登入」從停用變成可按，跳一下；重寄時已經可按，不會再跳
      card.dataset.step = '2';
      sendBtn.innerHTML = `<i class="fa-solid fa-fw fa-rotate-right"></i> ${t('login.resendCode')}`;
      sendBtn.classList.remove('blue');
      sendBtn.classList.add('outline');
      startCountdown();
      otpBoxes[0].focus();
      showLoginAlert(t('login.success.codeSent'), 'success');
    } catch {
      showLoginAlert(t('login.error.network'), 'error');
    } finally {
      isRequesting = false;
    }
  }

  sendBtn.addEventListener('click', () => {
    if (isRequesting) return;
    if (cooldownRemaining > 0) {
      showLoginAlert(t('login.warning.cooldown', { seconds: cooldownRemaining }), 'warning');
      return;
    }
    const email = emailInput.value.trim();
    if (!isValidEmail(email)) {
      emailField.classList.add('error');
      showLoginAlert(t('login.error.invalidEmail'), 'error');
      return;
    }
    emailField.classList.remove('error');
    requestCode(email);
  });

  // 貼上信件裡複製的 6 碼驗證碼：不管貼在哪一格，都把數字拆開依序填滿
  // 6 格，並讓最後一格拿到焦點；純打字（每格只會收到 1 碼）則完全不受影響。
  function fillOtpFromDigits(digits, startIndex) {
    const chars = digits.split('');
    let i = startIndex;
    while (chars.length && i < otpBoxes.length) {
      otpBoxes[i].value = chars.shift();
      otpBoxes[i].classList.add('filled');
      otpBoxes[i].classList.remove('error');
      i += 1;
    }
    const lastFilledIndex = Math.min(i, otpBoxes.length) - 1;
    otpBoxes[Math.max(lastFilledIndex, startIndex)].focus();
    // 六碼都到齊了，不用再多按一次「登入」——貼上/打完最後一碼就直接送出。
    if (otpBoxes.every((b) => b.value) && !submitBtn.disabled) submitBtn.click();
  }

  otpBoxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
      box.classList.toggle('filled', box.value !== '');
      box.classList.remove('error');
      if (box.value && otpBoxes[i + 1]) otpBoxes[i + 1].focus();
      if (box.value && i === otpBoxes.length - 1 && otpBoxes.every((b) => b.value) && !submitBtn.disabled) {
        submitBtn.click();
      }
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && otpBoxes[i - 1]) otpBoxes[i - 1].focus();
    });
    box.addEventListener('paste', (e) => {
      const digits = (e.clipboardData?.getData('text') || '').replace(/[^0-9]/g, '').slice(0, 6);
      if (!digits) return;
      e.preventDefault();
      fillOtpFromDigits(digits, 0);
    });
  });

  submitBtn.addEventListener('click', async () => {
    const code = otpBoxes.map((b) => b.value).join('');
    if (code.length < 6) {
      otpBoxes.forEach((b) => { if (!b.value) b.classList.add('error'); });
      showLoginAlert(t('login.warning.incompleteOtp'), 'warning');
      return;
    }
    otpBoxes.forEach((b) => b.classList.remove('error'));
    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.value.trim(), role: card.dataset.role, code }),
      });
      if (!res.ok) {
        // 錯誤訊息用翻譯好的文字，不直接顯示後端回傳的中文；錯太多次（429）另外提示要稍後再試
        showLoginAlert(t(res.status === 429 ? 'login.error.tooManyAttempts' : 'login.error.invalidOtp'), 'error');
        submitBtn.disabled = false;
        return;
      }
      // The server already set the real (HttpOnly) session cookie on this
      // response — that cookie, not anything client-readable, is what every
      // protected page/API now checks. Show a brief success message before
      // redirecting so the auto-submit-on-6th-digit path doesn't feel like
      // the page just yanks itself away with zero feedback.
      otpBoxes.forEach((b) => { b.disabled = true; });
      document.getElementById('loginSuccessModal').classList.add('open');
      setTimeout(() => {
        window.location.href = `${card.dataset.role}/`;
      }, 1800);
    } catch {
      showLoginAlert(t('login.error.network'), 'error');
      submitBtn.disabled = false;
    }
  });

  // ------------------------------------------------------------------------
  // Role picker (index.html only): clicking a role card keeps that card as
  // the "title", fades out the other two, and slides the login form in
  // below it.
  // ------------------------------------------------------------------------
  const entryCards = document.querySelector('#entry-cards');
  const loginView = document.querySelector('#login-view');
  const backBtn = document.querySelector('[data-login-back]');

  if (entryCards && loginView) {
    const ROLE_CONFIG = {
      student: {
        testUsers: [
          { img: 'assets/test-users/monkey.png', email: 'student1@jptip.co.jp' },
          { img: 'assets/test-users/fox.png', email: 'student2@jptip.co.jp' },
          { img: 'assets/test-users/walrus.png', email: 'student3@jptip.co.jp' },
          { img: 'assets/test-users/giraffe.png', email: 'student4@jptip.co.jp' },
        ],
      },
      teacher: {
        testUsers: [
          { img: 'assets/test-users/owl.png', email: 'teacher1@jptip.co.jp' },
          { img: 'assets/test-users/penguin.png', email: 'teacher2@jptip.co.jp' },
          { img: 'assets/test-users/chicken.png', email: 'teacher3@jptip.co.jp' },
        ],
      },
      admin: {
        testUsers: [
          { img: 'assets/test-users/llama.png', email: 'admin1@jptip.co.jp' },
        ],
      },
    };
    const roleCards = [...entryCards.querySelectorAll('[data-role]')];
    const quickFill = document.querySelector('[data-test-quick-fill]');
    let activeCard = null;

    // The quick-fill avatars only make sense on a test/dev deployment (where
    // /api/otp/verify accepts any code) — production never sets ALLOW_ANY_OTP,
    // so this stays false there and the row never renders.
    let testMode = false;
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => { testMode = !!data.testMode; })
      .catch(() => {});

    function renderQuickFill(role) {
      if (!quickFill) return;
      quickFill.innerHTML = '';
      quickFill.style.display = testMode ? '' : 'none';
      if (!testMode) return;
      ROLE_CONFIG[role].testUsers.forEach(({ img, email }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = `<span class="avatar-crop"><img src="${img}" alt=""></span>`;
        btn.addEventListener('click', () => {
          emailInput.value = email;
          emailField.classList.remove('error');
          quickFill.querySelectorAll('button').forEach((b) => { if (b !== btn) b.classList.remove('selected'); });
          btn.classList.add('selected');
          btn.classList.remove('pop');
          void btn.offsetWidth; // restart the animation even on repeat clicks
          btn.classList.add('pop');
        });
        quickFill.appendChild(btn);
      });
    }

    function resetLoginCard() {
      stopCountdown();
      card.dataset.step = '1';
      emailField.classList.remove('error');
      otpBoxes.forEach((b) => { b.disabled = true; b.value = ''; b.classList.remove('filled', 'error'); });
      submitBtn.disabled = true;
      sendBtn.innerHTML = `<i class="fa-solid fa-fw fa-paper-plane"></i> ${t('login.sendCode')}`;
      sendBtn.classList.remove('outline');
      sendBtn.classList.add('blue');
    }

    function onTransitionEnd(el, cb, fallbackMs = 400) {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener('transitionend', finish);
        cb();
      };
      el.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, fallbackMs);
    }

    // The vertical shift is exactly half of (gap + everything that appears
    // below the selected card): once that content joins the centered column,
    // the whole group's centering shifts up by that much — regardless of
    // viewport height or the selected card's own height (the math cancels
    // out). The constants below must stay in sync with the CSS: .login-card
    // min-height, plus the dev-only test-quick-fill row's own margin-top +
    // button height sitting right after it.
    const LOGIN_GAP = 24; // var(--space-5), .login-form-area margin-top
    const LOGIN_CARD_HEIGHT = 370; // .login-card min-height
    const QUICK_FILL_HEIGHT = 24 + 64; // .test-quick-fill margin-top + button height
    // The quick-fill row only renders (and only adds height) in testMode —
    // computed as a function, not a constant, so it reflects that at call time.
    function getCardShiftUp() {
      return (LOGIN_GAP + LOGIN_CARD_HEIGHT + (testMode ? QUICK_FILL_HEIGHT : 0)) / 2;
    }
    const STAGE_DELAY = 250; // pause between each of the 3 animation stages

    // Student/teacher/admin travel very different distances in stage 2 (the
    // card closest to its final resting spot barely moves; the farthest one
    // moves a lot). A fixed duration makes the short move look slow and the
    // long move look fast — use a fixed speed instead so every role's card
    // slides at the same rate, with a floor so a near-zero move still animates.
    const SLIDE_SPEED = 600; // px per second
    const MIN_SLIDE_DURATION = 0.15; // seconds
    function slideDuration(distancePx) {
      return Math.max(MIN_SLIDE_DURATION, Math.abs(distancePx) / SLIDE_SPEED);
    }

    function showLoginView(role) {
      card.dataset.role = role;
      emailInput.value = '';
      resetLoginCard();
      renderQuickFill(role);

      const selected = roleCards.find((btn) => btn.dataset.role === role);
      const others = roleCards.filter((btn) => btn.dataset.role !== role);
      activeCard = selected;

      // The mousemove tilt effect writes to the same `transform` property
      // this animation uses to hold/slide the card's position — left alone,
      // moving the mouse over the card mid-animation stomps our transform
      // and throws it off. Suspend the tilt effect for the whole trip (it's
      // re-enabled once showEntryView finishes bringing the card back), and
      // clear any tilt transform already on it before measuring position.
      selected.dataset.tiltSuspended = 'true';
      selected.style.transform = '';
      selected.style.boxShadow = '';
      selected.classList.add('role-locked');

      // `selected`'s position while it's still part of the 3-card list —
      // this is where it should visually stay put through stage 1.
      const originalRect = selected.getBoundingClientRect();

      // Stage 1: fade the other two cards out. Only once BOTH are fully gone
      // do we move on to stage 2.
      let remaining = others.length;
      others.forEach((btn) => {
        btn.classList.add('leaving');
        onTransitionEnd(btn, () => {
          // Hiding this card immediately reflows the layout — if this is the
          // last one, `selected` would otherwise instantly snap to a
          // solo-centered spot for the whole STAGE_DELAY pause before stage 2
          // corrects it. Cancel that jump in the SAME tick as the hide, so
          // there's nothing to see during the pause; stage 2 only needs to
          // pick up the animation from there once the pause ends.
          btn.hidden = true;
          remaining -= 1;
          if (remaining === 0) {
            const soloRect = selected.getBoundingClientRect();
            const snapOffset = originalRect.top - soloRect.top;
            selected.style.transition = 'none';
            selected.style.transform = `translateY(${snapOffset}px)`;
            void selected.offsetHeight; // flush the transition:none before the pause
            setTimeout(() => stageTwo(snapOffset), STAGE_DELAY);
          }
        }, 600);
      });

      // Stage 2: `selected` is already visually holding `originalRect`'s
      // position (stage 1 canceled the solo-centering jump the instant it
      // happened). Animate — in one continuous motion — from there up to its
      // final resting spot.
      function stageTwo(snapOffset) {
        const cardShiftUp = getCardShiftUp();
        const duration = slideDuration(snapOffset + cardShiftUp);

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            selected.style.transition = `transform ${duration}s ease`;
            selected.style.transform = `translateY(-${cardShiftUp}px)`;
          });
        });
        onTransitionEnd(selected, () => setTimeout(stageThree, STAGE_DELAY), duration * 1000 + 100);
      }

      // Stage 3: reveal the login card — a plain fade, no slide.
      //
      // Unhiding the login card grows the page's content height, so the flex
      // centering on body.home shifts `selected` up by CARD_SHIFT_UP all on
      // its own from here on. Drop the stage-2 transform in the same tick
      // (transition disabled) so that automatic shift doesn't stack on top
      // of it — both represent the same final pixel position, so swapping
      // one for the other produces no visible jump.
      function stageThree() {
        selected.style.transition = 'none';
        selected.style.transform = '';
        loginView.hidden = false;
        void selected.offsetHeight; // flush the transition:none before re-enabling it
        selected.style.transition = '';

        requestAnimationFrame(() => {
          requestAnimationFrame(() => loginView.classList.add('active'));
        });
      }
    }

    // Reverse of showLoginView, in the same three stages played backwards:
    // 1) the login card fades out, 2) the selected card slides back down to
    // its original spot in the 3-card row, 3) the other two cards fade in.
    function showEntryView() {
      resetLoginCard();
      const selected = activeCard;
      const others = roleCards.filter((btn) => btn !== selected);

      // Stage 1 (reverse): fade the login card out.
      loginView.classList.remove('active');
      onTransitionEnd(loginView, () => setTimeout(stageTwo, STAGE_DELAY));

      // Stage 2 (reverse): slide `selected` back down to its original spot.
      function stageTwo() {
        // `selected`'s position while it's still the lone card below the
        // (now invisible) login area — this is where it should visually
        // stay put through the next layout change.
        const beforeRect = selected.getBoundingClientRect();

        // Removing the login card from the flow, and restoring the other
        // two cards to the flow (still invisible via .leaving, so this
        // doesn't reveal them yet — only affects layout), changes the
        // layout instantly — `selected` snaps back to its original
        // 3-card-row position as a side effect. Cancel that jump the same
        // way stage 2 of showLoginView does, then animate from
        // `beforeRect`'s position down to 0 in one continuous motion.
        loginView.hidden = true;
        others.forEach((btn) => { btn.hidden = false; });

        const afterRect = selected.getBoundingClientRect();
        const snapOffset = beforeRect.top - afterRect.top;
        const duration = slideDuration(snapOffset);

        selected.style.transition = 'none';
        selected.style.transform = `translateY(${snapOffset}px)`;
        void selected.offsetHeight; // flush the transition:none before animating

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            selected.style.transition = `transform ${duration}s ease`;
            selected.style.transform = '';
          });
        });

        onTransitionEnd(selected, () => {
          selected.style.transition = '';
          setTimeout(stageThree, STAGE_DELAY);
        }, duration * 1000 + 100);
      }

      // Stage 3 (reverse): fade the other two cards back in.
      function stageThree() {
        others.forEach((btn) => btn.classList.remove('leaving'));
        delete selected.dataset.tiltSuspended;
        selected.classList.remove('role-locked');
      }
    }

    roleCards.forEach((btn) => {
      btn.addEventListener('click', () => showLoginView(btn.dataset.role));
    });

    if (backBtn) backBtn.addEventListener('click', showEntryView);
  }
})();

