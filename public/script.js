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

  let viewYear = 2026;
  let viewMonth = 7; // 0-indexed: 7 = August
  const today = { year: 2026, month: 7, day: 26 };
  let selected = { year: 2026, month: 7, day: 1 };

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
    const isSelected = viewYear === selected.year && viewMonth === selected.month && day === selected.day;
    if (isToday) btn.classList.add('today');
    if (isSelected) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      selected = { year: viewYear, month: viewMonth, day };
      render();
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
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    const rotateX = (-y * intensity).toFixed(2);
    const rotateY = (x * intensity).toFixed(2);
    card.style.transform = `perspective(700px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    card.style.boxShadow = `${-x * 20}px ${20 - y * 10}px 30px rgba(45,74,107,0.18)`;
  });

  card.addEventListener('mouseleave', () => {
    card.style.transform = 'perspective(700px) rotateX(0deg) rotateY(0deg)';
    card.style.boxShadow = '';
  });
}

document.querySelectorAll('.tilt-card').forEach((card) => {
  applyTiltEffect(card);

  card.addEventListener('click', () => {
    const group = card.dataset.group;
    if (group) {
      document.querySelectorAll(`.tilt-card[data-group="${group}"]`).forEach((c) => {
        if (c !== card) c.classList.remove('selected');
      });
    }
    card.classList.toggle('selected');
  });
});

document.querySelectorAll('.tz-card').forEach(applyTiltEffect);
document.querySelectorAll('.time-slot:not(.disabled)').forEach((slot) => applyTiltEffect(slot, 28));

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
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// ==========================================================================
// Login (email OTP, backed by /api/otp/request + /api/otp/verify)
// ==========================================================================
(() => {
  const card = document.querySelector('[data-login]');
  if (!card) return;

  const role = card.dataset.role;
  const emailField = card.querySelector('[data-login-email-field]');
  const emailInput = card.querySelector('#login-email');
  const sendBtn = card.querySelector('[data-login-send]');
  const resendBtn = card.querySelector('[data-login-resend]');
  const submitBtn = card.querySelector('[data-login-submit]');
  const otpBoxes = [...card.querySelectorAll('.otp-box')];

  let countdownId = null;

  function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  function startCountdown() {
    let remaining = 30;
    resendBtn.disabled = true;
    resendBtn.textContent = `重新取得驗證碼（${remaining}s）`;
    clearInterval(countdownId);
    countdownId = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(countdownId);
        resendBtn.disabled = false;
        resendBtn.textContent = '重新取得驗證碼';
      } else {
        resendBtn.textContent = `重新取得驗證碼（${remaining}s）`;
      }
    }, 1000);
  }

  async function requestCode(email) {
    sendBtn.disabled = true;
    try {
      const res = await fetch('/api/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || '發送失敗，請稍後再試', 'error');
        return;
      }
      otpBoxes.forEach((b) => { b.disabled = false; b.value = ''; b.classList.remove('filled', 'error'); });
      submitBtn.disabled = false;
      startCountdown();
      otpBoxes[0].focus();
      showToast('已寄出驗證碼，請查看信箱', 'warning');
    } catch {
      showToast('網路錯誤，請稍後再試', 'error');
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', () => {
    const email = emailInput.value.trim();
    if (!isValidEmail(email)) {
      emailField.classList.add('error');
      showToast('請輸入有效的 Email 格式', 'error');
      return;
    }
    emailField.classList.remove('error');
    requestCode(email);
  });

  resendBtn.addEventListener('click', () => {
    if (resendBtn.disabled) return;
    requestCode(emailInput.value.trim());
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
      showToast('請輸入完整 6 碼驗證碼', 'warning');
      return;
    }
    otpBoxes.forEach((b) => b.classList.remove('error'));
    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.value.trim(), role, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || '驗證碼錯誤或已過期', 'error');
        submitBtn.disabled = false;
        return;
      }
      showToast('登入成功，歡迎回來！', 'success');
    } catch {
      showToast('網路錯誤，請稍後再試', 'error');
      submitBtn.disabled = false;
    }
  });
})();
