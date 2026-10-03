/* ПЕКАРНЯ DAG — админ-панель
   Настоящая защита находится в базе (RLS + функция is_admin()).
   Проверка здесь нужна, чтобы не показывать посторонним интерфейс. */
(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var sb = window.sb;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var STATUS = [['new', 'Новый'], ['cooking', 'Готовится'], ['ready', 'Готов'], ['done', 'Выдан'], ['cancelled', 'Отменён']];
  var BUCKET = 'product-images';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(n) || 0) + '\u00A0' + (cfg.CURRENCY || '₽');
  }
  function shortId(id) { return String(id).replace(/-/g, '').slice(0, 4).toUpperCase(); }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  var toastT;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 3400);
  }
  function firstGlyph(v) {
    v = (v || '').trim(); if (!v) return '🍞';
    try { if (window.Intl && Intl.Segmenter) return new Intl.Segmenter().segment(v)[Symbol.iterator]().next().value.segment; } catch (e) {}
    return Array.from(v)[0];
  }

  /* ---------- звук нового заказа ---------- */
  var audioCtx = null;
  var soundOn = localStorage.getItem('dag_sound') !== '0';
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  document.addEventListener('click', unlockAudio, { once: true });
  function beep() {
    if (!soundOn || !audioCtx) return;
    var t = audioCtx.currentTime;
    [[880, 0], [1175, 0.16], [1480, 0.32]].forEach(function (n) {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = n[0];
      g.gain.setValueAtTime(0.0001, t + n[1]);
      g.gain.exponentialRampToValueAtTime(0.25, t + n[1] + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + n[1] + 0.4);
      o.connect(g); g.connect(audioCtx.destination); o.start(t + n[1]); o.stop(t + n[1] + 0.45);
    });
  }
  function renderSoundBtn() {
    var b = $('#soundBtn'); b.setAttribute('aria-pressed', String(soundOn));
    b.textContent = soundOn ? '🔔 Звук включён' : '🔕 Звук выключен';
  }

  /* ---------- вход ---------- */
  var orders = [], products = [], filter = 'active', editingId = null, channel = null, started = false;

  function showGate(msg) {
    $('#panel').hidden = true; $('#gate').hidden = false;
    if (msg) $('#gateLead').textContent = msg;
  }
  function showPanel() { $('#gate').hidden = true; $('#panel').hidden = false; }

  async function enter() {
    // 1) есть ли сессия, 2) является ли пользователь админом (проверка на стороне базы)
    var res = await sb.rpc('is_admin');
    if (res.error || res.data !== true) {
      await sb.auth.signOut();
      showGate('У этой учётной записи нет прав администратора.');
      return false;
    }
    showPanel();
    if (!started) { started = true; await Promise.all([loadOrders(), loadProducts()]); subscribe(); }
    return true;
  }

  $('#loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    unlockAudio();
    var email = $('#lEmail').value.trim(), pass = $('#lPass').value;
    var err = $('#loginErr'); err.textContent = '';
    if (!email || !pass) { err.textContent = 'Введите почту и пароль.'; return; }
    var btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'Входим…';
    var res = await sb.auth.signInWithPassword({ email: email, password: pass });
    if (res.error) {
      btn.disabled = false; btn.textContent = 'Войти';
      err.textContent = 'Неверная почта или пароль.';
      var card = $('#gateCard'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      return;
    }
    var ok = await enter();
    btn.disabled = false; btn.textContent = 'Войти';
    $('#lPass').value = '';
    if (!ok) { var c = $('#gateCard'); c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); }
  });

  $('#logoutBtn').addEventListener('click', async function () {
    if (channel) { sb.removeChannel(channel); channel = null; }
    started = false; orders = []; products = [];
    await sb.auth.signOut();
    $('#gateLead').textContent = 'Вход только для администратора.';
    showGate();
  });

  $('#soundBtn').addEventListener('click', function () {
    soundOn = !soundOn; localStorage.setItem('dag_sound', soundOn ? '1' : '0'); unlockAudio(); renderSoundBtn(); if (soundOn) beep();
  });

  /* ---------- вкладки ---------- */
  $$('.a-tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('.a-tabs button').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      $('#tab-orders').hidden = b.dataset.tab !== 'orders';
      $('#tab-menu').hidden = b.dataset.tab !== 'menu';
    });
  });

  /* ---------- заказы ---------- */
  async function loadOrders() {
    var res = await sb.from('orders').select('*').order('created_at', { ascending: false }).limit(300);
    if (res.error) { toast('Не удалось загрузить заказы.'); return; }
    orders = res.data || [];
    renderOrders();
  }

  function isActive(o) { return o.status === 'new' || o.status === 'cooking' || o.status === 'ready'; }

  function renderStats() {
    var start = new Date(); start.setHours(0, 0, 0, 0);
    var today = orders.filter(function (o) { return new Date(o.created_at) >= start; });
    $('#stNew').textContent = orders.filter(function (o) { return o.status === 'new'; }).length;
    $('#stToday').textContent = today.length;
    $('#stSum').textContent = money(today.filter(function (o) { return o.status !== 'cancelled'; }).reduce(function (s, o) { return s + Number(o.total); }, 0));
    var n = orders.filter(function (o) { return o.status === 'new'; }).length;
    var badge = $('#newCount'); badge.hidden = !n; badge.textContent = n;
    document.title = (n ? '(' + n + ') ' : '') + 'Панель — ПЕКАРНЯ DAG';
  }

  function orderHTML(o, i) {
    var tel = String(o.phone).replace(/[^\d+]/g, '');
    return '<article class="order' + (o.status === 'new' ? ' is-new' : '') + '" data-oid="' + o.id + '" style="animation-delay:' + Math.min(i, 10) * 40 + 'ms">' +
      '<div class="head"><span class="num">№ ' + shortId(o.id) + '</span><span class="time">' + fmtTime(o.created_at) + '</span></div>' +
      '<p class="who"><b>' + esc(o.customer_name) + '</b><br><a href="tel:' + esc(tel) + '">' + esc(o.phone) + '</a><br>' +
      (o.method === 'delivery' ? '🛵 Доставка: ' + esc(o.address) : '🏪 Самовывоз') + '</p>' +
      (o.comment ? '<p class="note">' + esc(o.comment) + '</p>' : '') +
      '<ul>' + (o.items || []).map(function (it) {
        return '<li><span>' + esc(it.name) + ' × ' + Number(it.qty) + '</span><span>' + money(it.price * it.qty) + '</span></li>';
      }).join('') + '</ul>' +
      '<div class="sum"><span>Итого</span><span class="price">' + money(o.total) + '</span></div>' +
      '<div class="seg">' + STATUS.map(function (s) {
        return '<button type="button" data-st="' + s[0] + '" aria-pressed="' + (o.status === s[0]) + '">' + s[1] + '</button>';
      }).join('') + '</div></article>';
  }

  function renderOrders(flashId) {
    renderStats();
    var list = orders.filter(function (o) {
      return filter === 'all' ? true : filter === 'done' ? (o.status === 'done' || o.status === 'cancelled') : isActive(o);
    });
    var box = $('#orders');
    if (!list.length) {
      box.innerHTML = '<div class="empty-a">' + (orders.length ? 'В этой вкладке заказов нет.' : 'Заказов пока нет. Новые появятся здесь сами, страницу обновлять не нужно.') + '</div>';
      return;
    }
    box.innerHTML = list.map(orderHTML).join('');
    if (flashId && !reduceMotion) {
      var el = $('[data-oid="' + flashId + '"]', box);
      if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
  }

  $('#filters').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-f]'); if (!b) return;
    filter = b.dataset.f;
    $$('#filters button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    renderOrders();
  });

  $('#orders').addEventListener('click', async function (e) {
    var b = e.target.closest('button[data-st]'); if (!b) return;
    var id = b.closest('[data-oid]').dataset.oid;
    var o = orders.find(function (x) { return x.id === id; }); if (!o || o.status === b.dataset.st) return;
    var prev = o.status; o.status = b.dataset.st; renderOrders();
    var res = await sb.from('orders').update({ status: o.status }).eq('id', id);
    if (res.error) { o.status = prev; renderOrders(); toast('Не удалось сменить статус.'); }
  });

  function subscribe() {
    channel = sb.channel('orders-admin')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, function (p) {
        if (p.eventType === 'INSERT') {
          if (!orders.some(function (o) { return o.id === p.new.id; })) orders.unshift(p.new);
          filter = filter === 'done' ? 'active' : filter;
          $$('#filters button').forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.f === filter)); });
          renderOrders(p.new.id); beep();
          toast('Новый заказ № ' + shortId(p.new.id) + ' на ' + money(p.new.total));
        } else if (p.eventType === 'UPDATE') {
          var i = orders.findIndex(function (o) { return o.id === p.new.id; });
          if (i >= 0) { if (orders[i].status !== p.new.status || true) orders[i] = p.new; } else orders.unshift(p.new);
          renderOrders();
        } else if (p.eventType === 'DELETE') {
          orders = orders.filter(function (o) { return o.id !== p.old.id; }); renderOrders();
        }
      })
      .subscribe();
  }

  /* ---------- меню ---------- */
  async function loadProducts() {
    var res = await sb.from('products').select('*').order('category').order('created_at');
    if (res.error) { toast('Не удалось загрузить меню.'); return; }
    products = res.data || [];
    renderProducts();
  }

  function renderProducts() {
    var cats = []; products.forEach(function (p) { if (cats.indexOf(p.category) < 0) cats.push(p.category); });
    $('#catList').innerHTML = cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');
    var box = $('#mlist');
    if (!products.length) { box.innerHTML = '<div class="empty-a">Меню пока пустое. Добавьте первую позицию в форме выше.</div>'; return; }
    box.innerHTML = products.map(function (p) {
      var th = p.image_url ? '<img src="' + esc(p.image_url) + '" alt="">' : esc(p.emoji || '🍞');
      return '<div class="mrow' + (p.available ? '' : ' hidden-item') + '" data-pid="' + p.id + '">' +
        '<div class="th">' + th + '</div>' +
        '<div><div class="nm">' + esc(p.name) + '</div><small>' + esc(p.category) + ' · ' + money(p.price) + (p.available ? '' : ' · нет в наличии') + '</small></div>' +
        '<div class="acts">' +
        '<button class="btn small paper" type="button" data-act="toggle">' + (p.available ? 'Скрыть' : 'Вернуть') + '</button>' +
        '<button class="btn small paper" type="button" data-act="edit">Изменить</button>' +
        '<button class="btn small red" type="button" data-act="del">Удалить</button></div></div>';
    }).join('');
  }

  function pathFromUrl(url) {
    if (!url) return null;
    var i = url.indexOf('/' + BUCKET + '/'); if (i < 0) return null;
    return decodeURIComponent(url.slice(i + BUCKET.length + 2).split('?')[0]);
  }

  function resizeImage(file, max) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var r = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('blob')); }, 'image/jpeg', 0.86);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('img')); };
      img.src = url;
    });
  }

  function resetForm() {
    editingId = null;
    $('#prodForm').reset(); $('#pCat').value = 'Выпечка'; $('#pEmoji').value = '🥐'; $('#pAvail').checked = true;
    $('#formTitle').textContent = 'Новая позиция'; $('#prodSave').textContent = 'Добавить в меню';
    $('#prodCancel').hidden = true; $('#rmImgBox').hidden = true; $('#prodErr').textContent = '';
    setPreview(null, '🥐');
  }
  function setPreview(url, emoji) {
    var pv = $('#pPreview');
    if (url) { pv.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")'; pv.textContent = ''; }
    else { pv.style.backgroundImage = ''; pv.textContent = emoji || '🍞'; }
  }

  $('#pFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (f) setPreview(URL.createObjectURL(f)); else setPreview(null, $('#pEmoji').value);
  });
  $('#pEmoji').addEventListener('input', function () { if (!$('#pFile').files.length) setPreview(null, firstGlyph(this.value)); });
  $('#prodCancel').addEventListener('click', resetForm);

  $('#prodForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#prodErr'); err.textContent = '';
    var name = $('#pName').value.trim();
    var price = parseFloat(String($('#pPrice').value).replace(',', '.'));
    if (!name) { err.textContent = 'Введите название.'; return; }
    if (!isFinite(price) || price < 0) { err.textContent = 'Введите цену числом.'; return; }

    var btn = $('#prodSave'), label = btn.textContent; btn.disabled = true; btn.textContent = 'Сохраняем…';
    try {
      var existing = editingId ? products.find(function (p) { return p.id === editingId; }) : null;
      var imageUrl = existing ? existing.image_url : null;
      var oldPath = pathFromUrl(imageUrl);
      var file = $('#pFile').files[0];

      if (file) {
        var blob = await resizeImage(file, 1200);
        var path = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) + '.jpg';
        var up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
        if (up.error) throw up.error;
        imageUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      } else if ($('#pRmImg').checked) {
        imageUrl = null;
      }

      var row = {
        name: name,
        description: $('#pDesc').value.trim(),
        price: Math.round(price * 100) / 100,
        category: $('#pCat').value.trim() || 'Выпечка',
        emoji: firstGlyph($('#pEmoji').value),
        image_url: imageUrl,
        available: $('#pAvail').checked
      };
      var res = editingId
        ? await sb.from('products').update(row).eq('id', editingId)
        : await sb.from('products').insert(row);
      if (res.error) throw res.error;

      if (oldPath && imageUrl !== (existing && existing.image_url)) await sb.storage.from(BUCKET).remove([oldPath]);
      toast(editingId ? 'Изменения сохранены' : 'Добавлено в меню');
      resetForm(); await loadProducts();
    } catch (ex) {
      err.textContent = 'Не удалось сохранить: ' + (ex && ex.message ? ex.message : 'ошибка');
    }
    btn.disabled = false; if (btn.textContent === 'Сохраняем…') btn.textContent = label;
  });

  var armed = null;
  $('#mlist').addEventListener('click', async function (e) {
    var b = e.target.closest('button[data-act]'); if (!b) return;
    var id = b.closest('[data-pid]').dataset.pid;
    var p = products.find(function (x) { return x.id === id; }); if (!p) return;

    if (b.dataset.act === 'toggle') {
      var res = await sb.from('products').update({ available: !p.available }).eq('id', id);
      if (res.error) toast('Не удалось изменить.'); else await loadProducts();
    } else if (b.dataset.act === 'edit') {
      editingId = id;
      $('#pName').value = p.name; $('#pPrice').value = p.price; $('#pCat').value = p.category;
      $('#pEmoji').value = p.emoji || '🍞'; $('#pDesc').value = p.description || ''; $('#pAvail').checked = p.available;
      $('#pFile').value = ''; $('#pRmImg').checked = false; $('#rmImgBox').hidden = !p.image_url;
      setPreview(p.image_url, p.emoji);
      $('#formTitle').textContent = 'Изменить позицию'; $('#prodSave').textContent = 'Сохранить'; $('#prodCancel').hidden = false;
      $('#formTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (b.dataset.act === 'del') {
      if (armed !== id) {
        armed = id; b.textContent = 'Точно удалить?';
        setTimeout(function () { if (armed === id) { armed = null; if (b.isConnected) b.textContent = 'Удалить'; } }, 3500);
        return;
      }
      armed = null;
      var d = await sb.from('products').delete().eq('id', id);
      if (d.error) { toast('Не удалось удалить.'); return; }
      var path = pathFromUrl(p.image_url); if (path) await sb.storage.from(BUCKET).remove([path]);
      toast('Позиция удалена'); await loadProducts();
    }
  });

  /* ---------- запуск ---------- */
  renderSoundBtn();
  (async function init() {
    if (!sb) {
      showGate('Сайт не подключён к Supabase. Заполните assets/js/config.js.');
      $('#loginForm').hidden = true; return;
    }
    var s = await sb.auth.getSession();
    if (s.data && s.data.session) await enter(); else showGate();
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT') { started = false; showGate(); } });
  })();
})();
