// ==========================================================================
// Toast notifications (shared helper — window.showToast(message, type))
// type: 'success' | 'error' | 'warning'
// ==========================================================================
function showToast(message, type = 'warning', duration = 3200) {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  stack.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}

// ==========================================================================
// 共用 mock 資料存取（admin-teachers / admin-students，localStorage）
// TODO: 之後改接真正的 D1/API
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
function randomAvatar() { return AVATAR_LIST[Math.floor(Math.random() * AVATAR_LIST.length)]; }
function avatarSrc(avatar) { return avatar && avatar.startsWith('data:') ? avatar : `../assets/avatars/${avatar}`; }

function loadTeachers() {
  const raw = localStorage.getItem('admin-teachers');
  if (raw) return JSON.parse(raw);

  const now = Date.now();
  const DAY = 86400000;
  const NAMES = ['田中老師', '佐藤老師', '鈴木老師', '山田老師', '高橋老師', '中村老師', '小林老師', '渡辺老師', '伊藤老師', '加藤老師', '吉田老師', '山本老師', '松本老師'];
  const VIEW_OFFSETS = [4, 11, 0, 8, 2, 10, 6, 1, 9, 3, 7, 12, 5];
  // 對應 student/booking.html 靜態老師卡片原本就有的專長/座右銘文字（僅前 8 位老師有對應資料）
  const SPECIALTIES = ['日文會話・5 年教學經驗', '商用日文・JLPT N1', '日文文法・JLPT 檢定專攻', '動漫日文・流行文化會話', '會話練習・生活日文', '聽力訓練・新聞日文', '文法解析・句型整理', '作文指導・寫作技巧'];
  const MOTTOS = ['一緒に学び、共に成長していきましょう。', '失敗を恐れず、新しい世界へ踏み出そう！', '毎日の小さな積み重ねが、大きな力になる。', '臭豆腐の美味しさがわかる人は、もう私の仲間です。', '授業よりも、放課後の台湾夜市グルメが本番です。', '私の体の半分は、タピオカミルクティーとルーロー飯でできています。', '質問は大歓迎！でもパクチーは大盛りでよろしく。', '私の体の半分は、タピオカミルクティーとルーロー飯でできています。'];

  const INACTIVE_IDS = [4, 9, 13];

  const seed = NAMES.map((name, i) => ({
    id: i + 1,
    name,
    phone: `09${String(20 + i).padStart(2, '0')}${String(300 + i * 7).padStart(3, '0')}${String(400 + i * 3).padStart(3, '0')}`,
    email: `teacher${i + 1}@example.com`,
    avatar: AVATAR_LIST[i % AVATAR_LIST.length],
    specialty: SPECIALTIES[i] || '',
    motto: MOTTOS[i] || '',
    lastViewedAt: now - VIEW_OFFSETS[i] * DAY,
    status: INACTIVE_IDS.includes(i + 1) ? 'inactive' : 'active',
  }));

  localStorage.setItem('admin-teachers', JSON.stringify(seed));
  return seed;
}
function saveTeachers(list) { localStorage.setItem('admin-teachers', JSON.stringify(list)); }

const COURSE_NAME_FIX = { 'N4 綜合日本語 J1': 'N4 綜合日本語 J4', 'N4 綜合日本語 J2': 'N4 綜合日本語 J5' };

function loadStudents() {
  const raw = localStorage.getItem('admin-students');
  if (raw) {
    const list = JSON.parse(raw);
    let patched = false;
    list.forEach((s) => {
      if (!s.avatar) { s.avatar = randomAvatar(); patched = true; }
      (s.courses || []).forEach((c) => {
        if (COURSE_NAME_FIX[c.name]) { c.name = COURSE_NAME_FIX[c.name]; patched = true; }
      });
      (s.bookings || []).forEach((b) => {
        if (COURSE_NAME_FIX[b.course]) { b.course = COURSE_NAME_FIX[b.course]; patched = true; }
      });
    });
    if (patched) saveStudents(list);
    return list;
  }

  const now = Date.now();
  const DAY = 86400000;
  const NAMES = ['陳靜怡', '王大明', '李美芳', '張凱文', '林佳穎', '黃俊傑', '吳雅婷', '劉建宏', '蔡欣怡', '楊子軒', '鄭雅雯', '許志明', '謝佩珊'];
  const VIEW_OFFSETS = [5, 12, 1, 9, 3, 11, 0, 7, 4, 10, 2, 8, 6];
  const TEACHERS = ['田中老師', '佐藤老師', '山本老師', '鈴木老師', '渡辺老師'];
  const COURSES = ['N5 綜合日本語 J1', 'N5 綜合日本語 J2', 'N5 綜合日本語 J3', 'N4 綜合日本語 J4', 'N4 綜合日本語 J5', 'N4 綜合日本語 J6', 'N3 綜合日本語 J7', 'N3 綜合日本語 J8', 'N3 綜合日本語 J9', 'N2 綜合日本語 J10', 'N2 綜合日本語 J11', 'N2 綜合日本語 J12', 'N2 綜合日本語 J13', '商務日文 基礎會話篇', '商務日文 應用會話篇'];
  // 對應 admin-courses / admin-teachers 種子資料的 id（同名同序），讓種子預約也帶有真正的 courseId/teacherId 可供比對
  const COURSE_ID_MAP = Object.fromEntries(COURSES.map((name, idx) => [name, idx + 1]));
  const TEACHER_ID_MAP = { '田中老師': 1, '佐藤老師': 2, '鈴木老師': 3, '山田老師': 4, '高橋老師': 5, '中村老師': 6, '小林老師': 7, '渡辺老師': 8, '伊藤老師': 9, '加藤老師': 10, '吉田老師': 11, '山本老師': 12, '松本老師': 13 };

  const seed = NAMES.map((name, i) => {
    const id = i + 1;
    const hasCourse = i % 3 !== 2;
    const courses = [];
    if (hasCourse) {
      courses.push({ id: id * 100 + 1, name: COURSES[i % COURSES.length], status: 'ongoing', attended: `${i % 10}/16`, booked: `${(i % 10) + 1}/16` });
    }
    if (i % 4 === 0) {
      courses.push({ id: id * 100 + 2, name: COURSES[(i + 2) % COURSES.length], status: 'completed', attended: '16/16', booked: '16/16' });
    }
    const bookings = [];
    if (hasCourse) {
      const bookingCount = 1 + (i % 3);
      for (let b = 0; b < bookingCount; b++) {
        const day = 1 + ((i * 3 + b * 5) % 27);
        const dateStr = `2026-09-${String(day).padStart(2, '0')}`;
        const timeStr = `${10 + ((i + b) % 8)}:00`;
        const teacherName = TEACHERS[(i + b) % TEACHERS.length];
        bookings.push({
          id: id * 1000 + b,
          bookingCode: `${dateStr.replace(/-/g, '')}-${timeStr.replace(':', '')}-${String((id + b) % 100).padStart(2, '0')}`,
          course: courses[0].name, courseId: COURSE_ID_MAP[courses[0].name],
          teacher: teacherName, teacherId: TEACHER_ID_MAP[teacherName],
          date: dateStr,
          time: timeStr,
          status: b === 0 ? 'upcoming' : (b % 2 === 0 ? 'attended' : 'cancelled'),
        });
      }
    }
    return {
      id, name,
      phone: `09${String(10 + i).padStart(2, '0')}${String(100 + i * 7).padStart(3, '0')}${String(200 + i * 3).padStart(3, '0')}`,
      email: id <= 4 ? `student${id}@jptip.co.jp` : `student${id}@example.com`, // 前 4 位對齊 D1 種子登入帳號，讓登入快選按鈕能找到對應的學生資料
      teamsLink: '',
      avatar: AVATAR_LIST[i % AVATAR_LIST.length],
      lastViewedAt: now - VIEW_OFFSETS[i] * DAY,
      courses, bookings,
    };
  });

  localStorage.setItem('admin-students', JSON.stringify(seed));
  return seed;
}
function saveStudents(list) { localStorage.setItem('admin-students', JSON.stringify(list)); }

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
  const li = dropdown.querySelector(`.dropdown-menu li[data-value="${value}"]`);
  if (!li) return;
  dropdown.querySelectorAll('.dropdown-menu li').forEach((l) => l.classList.remove('selected'));
  li.classList.add('selected');
  dropdown.querySelector('.dropdown-trigger .label').textContent = li.textContent.trim();
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
        const chosen = [...menu.querySelectorAll('li.selected')].map((li) => li.dataset.value);
        label.textContent = chosen.length ? chosen.join('、') : dropdown.dataset.placeholder;
      } else {
        menu.querySelectorAll('li').forEach((li) => li.classList.remove('selected'));
        item.classList.add('selected');
        label.textContent = item.dataset.value;
        dropdown.classList.remove('open');
      }
    });
  });
});

document.addEventListener('click', (e) => {
  document.querySelectorAll('.dropdown.open').forEach((dropdown) => {
    if (!dropdown.contains(e.target)) dropdown.classList.remove('open');
  });
});

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

  const now = new Date();
  let viewYear = now.getFullYear();
  let viewMonth = now.getMonth();
  const today = { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
  let selected = null;

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function firstWeekdayMon0(y, m) { const d = new Date(y, m, 1).getDay(); return (d + 6) % 7; }

  function render() {
    monthLabel.textContent = `${viewYear} 年 ${String(viewMonth + 1).padStart(2, '0')} 月`;
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
    warning: { tone: 'warning', icon: 'fa-triangle-exclamation' },
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
      const data = await res.json();
      if (!res.ok) {
        showLoginAlert(data.error || '發送失敗，請稍後再試', 'error');
        return;
      }
      otpBoxes.forEach((b) => { b.disabled = false; b.value = ''; b.classList.remove('filled', 'error'); });
      submitBtn.disabled = false;
      card.dataset.step = '2';
      sendBtn.innerHTML = '<i class="fa-solid fa-fw fa-rotate-right"></i> 重新取得驗證碼';
      sendBtn.classList.remove('blue');
      sendBtn.classList.add('outline');
      startCountdown();
      otpBoxes[0].focus();
      showLoginAlert('已寄出驗證碼，請查看信箱', 'success');
    } catch {
      showLoginAlert('網路錯誤，請稍後再試', 'error');
    } finally {
      isRequesting = false;
    }
  }

  sendBtn.addEventListener('click', () => {
    if (isRequesting) return;
    if (cooldownRemaining > 0) {
      showLoginAlert(`還可在 ${cooldownRemaining} 秒後重新取得驗證碼`, 'warning');
      return;
    }
    const email = emailInput.value.trim();
    if (!isValidEmail(email)) {
      emailField.classList.add('error');
      showLoginAlert('請輸入有效的 Email 格式', 'error');
      return;
    }
    emailField.classList.remove('error');
    requestCode(email);
  });

  otpBoxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
      box.classList.toggle('filled', box.value !== '');
      if (box.value && otpBoxes[i + 1]) otpBoxes[i + 1].focus();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && otpBoxes[i - 1]) otpBoxes[i - 1].focus();
    });
  });

  submitBtn.addEventListener('click', async () => {
    const code = otpBoxes.map((b) => b.value).join('');
    if (code.length < 6) {
      otpBoxes.forEach((b) => { if (!b.value) b.classList.add('error'); });
      showLoginAlert('請輸入完整 6 碼驗證碼', 'warning');
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
      const data = await res.json();
      if (!res.ok) {
        showLoginAlert(data.error || '驗證碼錯誤或已過期', 'error');
        submitBtn.disabled = false;
        return;
      }
      sessionStorage.setItem('session', JSON.stringify({ role: card.dataset.role, email: emailInput.value.trim() }));
      window.location.href = `${card.dataset.role}/`;
    } catch {
      showLoginAlert('網路錯誤，請稍後再試', 'error');
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
      sendBtn.innerHTML = '<i class="fa-solid fa-fw fa-paper-plane"></i> 取得驗證碼';
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
