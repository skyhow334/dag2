/* ПЕКАРНЯ DAG — витрина */
(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var sb = window.sb;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var KEY_CART = 'dag_cart_v1', KEY_ORDERS = 'dag_orders_v1', KEY_CONTACT = 'dag_contact_v1';
  var TILE = ['var(--butter)', 'var(--lilac)', 'var(--peach)', 'var(--mint)'];
  var STEPS = [['new', 'Принят'], ['cooking', 'Готовится'], ['ready', 'Готов'], ['done', 'Выдан']];

  var store = {
    get: function (k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(n) || 0) + '\u00A0' + (cfg.CURRENCY || '₽');
  }
  function tileColor(id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % TILE.length; return TILE[h]; }
  function shortId(id) { return String(id).replace(/-/g, '').slice(0, 4).toUpperCase(); }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  var toastT;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  /* ---------- состояние ---------- */
  var products = [];
  var cart = store.get(KEY_CART, {});
  var activeCat = 'Все';
  var firstRender = true;

  function byId(id) { return products.find(function (p) { return p.id === id; }); }

  /* ---------- Hero: анимация букв, параллакс, контакты ---------- */
  function initHero() {
    var n = 0;
    $$('[data-split]').forEach(function (line) {
      var text = line.textContent; line.textContent = ''; line.setAttribute('aria-hidden', 'true');
      text.split('').forEach(function (ch) {
        var s = document.createElement('span'); s.className = 'ch'; s.style.setProperty('--i', n++); s.textContent = ch; line.appendChild(s);
      });
    });

    var info = $('#heroInfo'), foot = $('#footInfo');
    var items = [];
    if (cfg.HOURS) items.push(['🕐 ' + cfg.HOURS, null]);
    if (cfg.ADDRESS) items.push(['📍 ' + cfg.ADDRESS, null]);
    if (cfg.PHONE) items.push(['📞 ' + cfg.PHONE, 'tel:' + String(cfg.PHONE).replace(/[^\d+]/g, '')]);
    items.forEach(function (it) {
      var el = document.createElement(it[1] ? 'a' : 'span'); el.className = 'chip-info'; el.textContent = it[0]; if (it[1]) el.href = it[1]; info.appendChild(el);
      var li = document.createElement('li'); if (it[1]) { var a = document.createElement('a'); a.href = it[1]; a.textContent = it[0]; li.appendChild(a); } else li.textContent = it[0]; foot.appendChild(li);
    });

    var art = $('#heroArt');
    if (art && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
      var floats = $$('.float', art);
      window.addEventListener('mousemove', function (e) {
        var x = (e.clientX / window.innerWidth - .5), y = (e.clientY / window.innerHeight - .5);
        floats.forEach(function (f) {
          var d = Number(f.dataset.depth) || 10;
          f.style.translate = (x * d * 2) + 'px ' + (y * d * 2) + 'px';
        });
      }, { passive: true });
    }
  }

  /* ---------- Меню ---------- */
  function skeleton() {
    $('#grid').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  }
  function showState(emoji, text, btn) {
    $('#cats').innerHTML = '';
    $('#grid').innerHTML = '<div class="state"><span class="big-emo">' + emoji + '</span><p>' + text + '</p>' + (btn ? '<button class="btn" id="retryBtn" type="button">' + btn + '</button>' : '') + '</div>';
    var r = $('#retryBtn'); if (r) r.addEventListener('click', function () { loadProducts(true); });
  }

  async function loadProducts(showSkel) {
    if (!sb) {
      showState('🔧', 'Сайт ещё не подключён к базе данных.<br>Откройте <b>assets/js/config.js</b> и вставьте ключи Supabase.');
      return;
    }
    if (showSkel) skeleton();
    var res = await sb.from('products').select('*').order('sort', { ascending: true }).order('created_at', { ascending: true });
    if (res.error) { showState('😕', 'Не удалось загрузить меню. Проверьте интернет и попробуйте ещё раз.', 'Повторить'); return; }
    products = res.data || [];
    // убираем из корзины то, чего уже нет
    Object.keys(cart).forEach(function (id) { var p = byId(id); if (!p || !p.available) delete cart[id]; });
    store.set(KEY_CART, cart);
    renderCats();
    renderGrid();
    renderCartBadge();
    if ($('#cartDlg').open) renderCart();
  }

  function renderCats() {
    var cats = ['Все'];
    products.forEach(function (p) { if (cats.indexOf(p.category) < 0) cats.push(p.category); });
    if (cats.indexOf(activeCat) < 0) activeCat = 'Все';
    $('#cats').innerHTML = cats.length > 2 ? cats.map(function (c) {
      return '<button class="cat" type="button" data-cat="' + esc(c) + '" aria-pressed="' + (c === activeCat) + '">' + esc(c) + '</button>';
    }).join('') : '';
  }

  function ctlHTML(p) {
    if (!p.available) return '<span class="soldout">Закончилось</span>';
    var q = cart[p.id] || 0;
    if (!q) return '<button class="btn small" type="button" data-add="' + p.id + '">В корзину</button>';
    return '<span class="stepper"><button type="button" data-dec="' + p.id + '" aria-label="Убрать одну">−</button><b>' + q + '</b><button type="button" data-inc="' + p.id + '" aria-label="Добавить ещё">+</button></span>';
  }

  function renderGrid() {
    var grid = $('#grid');
    var list = products.filter(function (p) { return activeCat === 'Все' || p.category === activeCat; });
    if (!products.length) { showState('🥖', 'Меню скоро появится. Загляните чуть позже.'); return; }
    // сортировка: в наличии выше
    list.sort(function (a, b) { return (b.available ? 1 : 0) - (a.available ? 1 : 0); });
    grid.classList.toggle('still', !firstRender);
    grid.innerHTML = list.map(function (p, i) {
      var media = p.image_url
        ? '<img src="' + esc(p.image_url) + '" alt="' + esc(p.name) + '" loading="lazy" decoding="async">'
        : '<span class="emo" aria-hidden="true">' + esc(p.emoji || '🍞') + '</span>';
      return '<article class="card' + (p.available ? '' : ' off') + '" data-card="' + p.id + '" style="--i:' + Math.min(i, 12) + '">' +
        '<div class="media" style="background:' + tileColor(p.id) + '">' + media + '<span class="tag">' + esc(p.category) + '</span></div>' +
        '<div class="body"><h3>' + esc(p.name) + '</h3>' +
        (p.description ? '<p class="desc">' + esc(p.description) + '</p>' : '<p class="desc"></p>') +
        '<div class="buy"><span class="price">' + money(p.price) + '</span><span class="ctl">' + ctlHTML(p) + '</span></div></div></article>';
    }).join('');
    firstRender = false;
  }

  function updateCtl(id) {
    var p = byId(id); if (!p) return;
    var el = $('[data-card="' + id + '"] .ctl'); if (el) el.innerHTML = ctlHTML(p);
  }

  /* ---------- Корзина ---------- */
  function cartList() {
    return Object.keys(cart).map(function (id) { var p = byId(id); return p && p.available ? { p: p, q: cart[id] } : null; }).filter(Boolean);
  }
  function cartTotal() { return cartList().reduce(function (s, i) { return s + i.p.price * i.q; }, 0); }
  function cartCount() { return cartList().reduce(function (s, i) { return s + i.q; }, 0); }

  function renderCartBadge(bump) {
    var c = $('#cartCount'); c.textContent = cartCount();
    if (bump && !reduceMotion) { c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); }
  }
  function setQty(id, q) {
    if (q <= 0) delete cart[id]; else cart[id] = Math.min(q, 99);
    store.set(KEY_CART, cart);
    updateCtl(id); renderCartBadge(true);
    if ($('#cartDlg').open && !$('#cartView').hidden) renderCart();
  }
  function floatPlus(btn) {
    if (reduceMotion) return;
    var r = btn.getBoundingClientRect();
    var s = document.createElement('span'); s.className = 'plus1'; s.textContent = '+1';
    s.style.left = (r.left + r.width / 2 - 12) + 'px'; s.style.top = (r.top - 6) + 'px';
    document.body.appendChild(s); setTimeout(function () { s.remove(); }, 850);
  }

  function renderCart() {
    var list = cartList();
    var box = $('#cartItems');
    if (!list.length) {
      box.innerHTML = '<div class="state" style="margin-top:8px"><span class="big-emo">🧺</span><p>В корзине пока пусто.</p><button class="btn" type="button" data-close>Выбрать выпечку</button></div>';
      $('#checkout').hidden = true; return;
    }
    box.innerHTML = list.map(function (i, k) {
      var th = i.p.image_url ? '<img src="' + esc(i.p.image_url) + '" alt="">' : esc(i.p.emoji || '🍞');
      return '<div class="citem" style="animation-delay:' + (k * 40) + 'ms"><div class="th" style="background:' + tileColor(i.p.id) + '">' + th + '</div>' +
        '<div><div class="nm">' + esc(i.p.name) + '</div><div class="pr">' + money(i.p.price) + ' × ' + i.q + ' = ' + money(i.p.price * i.q) + '</div></div>' +
        '<span class="stepper"><button type="button" data-dec="' + i.p.id + '" aria-label="Убрать одну">−</button><b>' + i.q + '</b><button type="button" data-inc="' + i.p.id + '" aria-label="Добавить ещё">+</button></span></div>';
    }).join('');
    $('#cartTotal').textContent = money(cartTotal());
    $('#checkout').hidden = false;
  }

  /* ---------- Панели ---------- */
  function openDlg(d) { d.classList.remove('closing'); if (!d.open) d.showModal(); }
  function closeDlg(d) {
    if (!d.open || d.classList.contains('closing')) return;
    d.classList.add('closing');
    var done = false;
    function fin() { if (done) return; done = true; d.close(); d.classList.remove('closing'); }
    d.addEventListener('animationend', function h(e) { if (e.target === d) { d.removeEventListener('animationend', h); fin(); } });
    setTimeout(fin, 400);
  }
  $$('dialog.drawer').forEach(function (d) {
    d.addEventListener('cancel', function (e) { e.preventDefault(); closeDlg(d); });
    d.addEventListener('click', function (e) { if (e.target === d) closeDlg(d); });
    d.addEventListener('close', function () { if (d.id === 'ordersDlg') stopPoll(); });
  });

  function openCart() {
    $('#successView').hidden = true; $('#cartView').hidden = false;
    $('#cartTitle').textContent = 'Корзина';
    var c = store.get(KEY_CONTACT, {});
    if (!$('#fName').value && c.name) $('#fName').value = c.name;
    if (!$('#fPhone').value && c.phone) $('#fPhone').value = c.phone;
    $('#formErr').textContent = '';
    renderCart(); openDlg($('#cartDlg'));
  }

  /* ---------- Оформление заказа ---------- */
  var ERR = {
    invalid_name: 'Укажите имя.',
    invalid_phone: 'Проверьте номер телефона.',
    invalid_address: 'Укажите адрес доставки.',
    invalid_items: 'Корзина пуста.',
    too_many_orders: 'Слишком много заказов с этого номера. Попробуйте через несколько минут.',
    product_unavailable: 'Одна из позиций уже закончилась. Мы обновили меню, проверьте корзину.'
  };

  async function submitOrder(e) {
    e.preventDefault();
    var f = e.target, err = $('#formErr');
    var F = f.elements;
    var name = F['name'].value.trim(), phone = F['phone'].value.trim();
    var method = F['method'].value, address = F['address'].value.trim(), comment = F['comment'].value.trim();
    err.textContent = '';
    function bad(msg, el) {
      err.textContent = msg; if (el) el.focus();
      if (!reduceMotion) { err.classList.remove('shake'); void err.offsetWidth; }
    }
    if (!name) return bad('Укажите имя.', F['name']);
    if (phone.replace(/\D/g, '').length < 6) return bad('Укажите телефон, чтобы мы могли связаться.', F['phone']);
    if (method === 'delivery' && address.length < 3) return bad('Укажите адрес доставки.', F['address']);
    var list = cartList(); if (!list.length) return bad('Корзина пуста.');
    if (!sb) return bad('Сайт ещё не подключён к базе данных.');

    var btn = $('#sendBtn'); btn.disabled = true; btn.textContent = 'Отправляем…';
    var res = await sb.rpc('create_order', {
      p_name: name, p_phone: phone, p_method: method, p_address: address, p_comment: comment,
      p_items: list.map(function (i) { return { id: i.p.id, qty: i.q }; })
    });
    btn.disabled = false; btn.textContent = 'Отправить заказ';

    if (res.error) {
      var key = (res.error.message || '').split(/\s|:/).filter(function (w) { return ERR[w]; })[0];
      err.textContent = ERR[key] || 'Не получилось отправить заказ. Попробуйте ещё раз.';
      if (key === 'product_unavailable') loadProducts(false);
      return;
    }

    var order = res.data;
    var mine = store.get(KEY_ORDERS, []); mine.unshift({ id: order.id, ts: Date.now() }); store.set(KEY_ORDERS, mine.slice(0, 30));
    store.set(KEY_CONTACT, { name: name, phone: phone });
    cart = {}; store.set(KEY_CART, cart); renderCartBadge(); products.forEach(function (p) { updateCtl(p.id); });
    F['comment'].value = '';
    showSuccess(order, phone, method);
  }

  function showSuccess(order, phone, method) {
    $('#cartView').hidden = true; $('#successView').hidden = false; $('#cartTitle').textContent = 'Спасибо!';
    $('#okNum').textContent = '№ ' + shortId(order.id);
    $('#okText').textContent = 'Сумма ' + money(order.total) + '. Мы позвоним на ' + phone + ', чтобы подтвердить. ' + (method === 'delivery' ? 'Привезём по вашему адресу.' : 'Ждём вас за заказом.');
    confetti();
  }

  function confetti() {
    if (reduceMotion) return;
    var colors = ['#1D2BD4', '#FFD84D', '#FF5B3A', '#BDEBD0', '#CBD0FF'];
    var cx = window.innerWidth > 560 ? window.innerWidth - 240 : window.innerWidth / 2;
    for (var i = 0; i < 46; i++) {
      var c = document.createElement('i'); c.className = 'confetti';
      var a = Math.random() * Math.PI * 2, d = 120 + Math.random() * 260;
      c.style.left = cx + 'px'; c.style.top = '260px';
      c.style.background = colors[i % colors.length];
      c.style.borderRadius = i % 3 ? '2px' : '50%';
      c.style.setProperty('--dx', Math.cos(a) * d + 'px');
      c.style.setProperty('--dy', (Math.sin(a) * d + 160) + 'px');
      c.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
      document.body.appendChild(c); setTimeout((function (el) { return function () { el.remove(); }; })(c), 1600);
    }
  }

  /* ---------- Мои заказы ---------- */
  var poll = null;
  function stopPoll() { clearInterval(poll); poll = null; }

  async function loadMyOrders() {
    var body = $('#ordersBody');
    var ids = store.get(KEY_ORDERS, []).map(function (o) { return o.id; });
    if (!ids.length) {
      body.innerHTML = '<div class="state"><span class="big-emo">🥐</span><p>Здесь появятся ваши заказы с этого устройства.</p><button class="btn" type="button" data-close>Выбрать выпечку</button></div>';
      return;
    }
    if (!sb) return;
    var res = await sb.rpc('order_status', { p_ids: ids });
    if (res.error) { body.innerHTML = '<div class="state"><span class="big-emo">😕</span><p>Не удалось загрузить статусы.</p></div>'; return; }
    var rows = res.data || [];
    if (!rows.length) { body.innerHTML = '<div class="state"><span class="big-emo">🔎</span><p>Заказы не найдены.</p></div>'; return; }
    body.innerHTML = rows.map(function (o) {
      var idx = STEPS.map(function (s) { return s[0]; }).indexOf(o.status);
      var track = o.status === 'cancelled'
        ? '<div class="cancelled">Заказ отменён. Если это ошибка, позвоните нам.</div>'
        : '<div class="track">' + STEPS.map(function (s, i) {
            return '<div class="' + (i <= idx ? 'on' : '') + (i === idx && o.status !== 'done' ? ' now' : '') + '">' + s[1] + '</div>';
          }).join('') + '</div>';
      return '<div class="myorder"><div class="top"><span class="num">№ ' + shortId(o.id) + '</span><b class="price">' + money(o.total) + '</b></div><small>' + fmtTime(o.created_at) + '</small>' + track + '</div>';
    }).join('');
  }
  function openOrders() {
    openDlg($('#ordersDlg')); $('#ordersBody').innerHTML = '<div class="skel" style="height:140px"></div>';
    loadMyOrders(); stopPoll(); poll = setInterval(loadMyOrders, 15000);
  }

  /* ---------- События ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button, a'); if (!t) return;
    if (t.dataset.add) { floatPlus(t); setQty(t.dataset.add, 1); }
    else if (t.dataset.inc) { setQty(t.dataset.inc, (cart[t.dataset.inc] || 0) + 1); }
    else if (t.dataset.dec) { setQty(t.dataset.dec, (cart[t.dataset.dec] || 0) - 1); }
    else if (t.dataset.cat) {
      activeCat = t.dataset.cat; firstRender = true;
      $$('.cat').forEach(function (c) { c.setAttribute('aria-pressed', String(c.dataset.cat === activeCat)); });
      renderGrid();
    }
    else if (t.hasAttribute('data-close')) { var d = t.closest('dialog'); if (d) closeDlg(d); }
  });
  $('#cartBtn').addEventListener('click', openCart);
  $('#ordersBtn').addEventListener('click', openOrders);
  $('#ordersBtn2').addEventListener('click', openOrders);
  $('#okOrders').addEventListener('click', function () { closeDlg($('#cartDlg')); setTimeout(openOrders, 280); });
  $('#orderForm').addEventListener('submit', submitOrder);
  $$('input[name=method]').forEach(function (r) {
    r.addEventListener('change', function () { $('#addrBox').hidden = $('#orderForm').elements['method'].value !== 'delivery'; });
  });

  /* ---------- Запуск ---------- */
  initHero();
  renderCartBadge();
  loadProducts(true);
  if (sb) {
    sb.channel('menu-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, function () { loadProducts(false); })
      .subscribe();
  }
})();
