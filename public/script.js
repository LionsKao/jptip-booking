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
        showToast(data.error || '發送失敗，請稍後再試', 'error');
        return;
      }
      otpBoxes.forEach((b) => { b.disabled = false; b.value = ''; b.classList.remove('filled', 'error'); });
      submitBtn.disabled = false;
      card.dataset.step = '2';
      sendBtn.textContent = '重新取得驗證碼';
      sendBtn.classList.remove('blue');
      sendBtn.classList.add('outline');
      startCountdown();
      otpBoxes[0].focus();
      showToast('已寄出驗證碼，請查看信箱', 'success');
    } catch {
      showToast('網路錯誤，請稍後再試', 'error');
    } finally {
      isRequesting = false;
    }
  }

  sendBtn.addEventListener('click', () => {
    if (isRequesting) return;
    if (cooldownRemaining > 0) {
      showToast(`還可在 ${cooldownRemaining} 秒後重新取得驗證碼`, 'warning');
      return;
    }
    const email = emailInput.value.trim();
    if (!isValidEmail(email)) {
      emailField.classList.add('error');
      showToast('請輸入有效的 Email 格式', 'error');
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
      showToast('請輸入完整 6 碼驗證碼', 'warning');
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
        showToast(data.error || '驗證碼錯誤或已過期', 'error');
        submitBtn.disabled = false;
        return;
      }
      showToast('登入成功，歡迎回來！', 'success');
      setTimeout(() => { window.location.href = `${card.dataset.role}/`; }, 900);
    } catch {
      showToast('網路錯誤，請稍後再試', 'error');
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
      sendBtn.textContent = '取得驗證碼';
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
