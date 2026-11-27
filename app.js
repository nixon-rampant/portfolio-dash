/* Dashboard: decrypts data.enc.json in the browser and renders it. No data leaves the device.
   Holdings, names and accounts come only from the encrypted data; nothing about them is hard-coded here. */
(function () {
  'use strict';

  // ---------- small utils ----------
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var b64d = function (s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  var b64e = function (u) { var s = ''; u = new Uint8Array(u); for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  var uniq = function (a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); };
  var sum = function (a, f) { return a.reduce(function (t, x) { var v = f(x); return t + (v == null || !isFinite(v) ? 0 : v); }, 0); };

  // ---------- theme (Light / Dark / System) ----------
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  var THEME_LABEL = { light: 'Light', dark: 'Dark', system: 'System' };
  function themePref() { var p = LS.get('idash.theme'); return p === 'light' || p === 'dark' ? p : 'system'; }
  function applyTheme() {
    var p = themePref();
    var dark = p === 'dark' || (p === 'system' && mq && mq.matches);
    var root = document.documentElement, prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-pref', p);
    $('#theme-label').textContent = 'Appearance: ' + THEME_LABEL[p];
    $('#theme-ico').className = 'ico ' + (p === 'light' ? 'ico-sun' : p === 'dark' ? 'ico-moon' : 'ico-system');
    $$('[data-theme-pref]').forEach(function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-theme-pref') === p)); });
    if (prev !== root.getAttribute('data-theme') && D) { renderPerf(); if (S.sel) renderSheetChart(); if (S.tab === 'lookup' && LK.syms.length) renderLookup(); }
  }
  function setupThemeMenu() {
    var btn = $('#theme-btn'), list = $('#theme-list');
    function close() { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    function open() { list.hidden = false; btn.setAttribute('aria-expanded', 'true'); var cur = $('[aria-checked="true"]', list); (cur || $('button', list)).focus(); }
    btn.addEventListener('click', function (e) { e.stopPropagation(); list.hidden ? open() : close(); });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-theme-pref]'); if (!b) return;
      LS.set('idash.theme', b.getAttribute('data-theme-pref')); applyTheme(); close(); btn.focus();
    });
    list.addEventListener('keydown', function (e) {
      var items = $$('button', list), i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Escape') { close(); btn.focus(); }
    });
    document.addEventListener('click', function (e) { if (!list.hidden && !e.target.closest('#theme-menu')) close(); });
    if (mq) { var on = function () { if (themePref() === 'system') applyTheme(); }; mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on); }
    window.addEventListener('storage', function (e) { if (e.key === 'idash.theme') applyTheme(); });
    applyTheme();
  }

  // ---------- crypto ----------
  var ENC = null, KEY = null;
  async function fetchEnc() {
    var r = await fetch('data.enc.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('Could not load data (' + r.status + ')');
    return r.json();
  }
  async function deriveKey(pw, enc) {
    var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64d(enc.salt), iterations: enc.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }
  async function decrypt(enc, key) {
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(enc.iv), additionalData: new TextEncoder().encode(enc.aad) }, key, b64d(enc.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function storedKey(enc) {
    var raw = LS.get('idash.key'); if (!raw) return null;
    try { var o = JSON.parse(raw); if (o.salt !== enc.salt) return null; return await crypto.subtle.importKey('raw', b64d(o.k), { name: 'AES-GCM' }, true, ['decrypt']); } catch (e) { return null; }
  }
  async function remember(key, enc) { var k = await crypto.subtle.exportKey('raw', key); LS.set('idash.key', JSON.stringify({ salt: enc.salt, k: b64e(k) })); }

  // ---------- formatting ----------
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function money(v, dec) { dec = dec || 0; return v == null || !isFinite(v) ? '–' : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
  function smoney(v, dec) { return v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : '') + money(v, dec); }
  function short$(v) { if (v == null || !isFinite(v)) return '–'; var a = Math.abs(v), s = v < 0 ? '−$' : '$'; return a >= 1e6 ? s + (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? s + (a / 1e3).toFixed(0) + 'K' : a >= 1e3 ? s + (a / 1e3).toFixed(1) + 'K' : s + a.toFixed(0); }
  function sshort$(v) { return (v > 0 ? '+' : '') + short$(v); }
  function pct(v, dec, sign) { if (dec == null) dec = 1; if (sign == null) sign = true; return v == null || !isFinite(v) ? '–' : (sign && v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(dec) + '%'; }
  function apct(v, dec) { return pct(Math.abs(v), dec, false); }
  function cls(v) { return v == null || Math.abs(v) < 1e-9 ? 'flat' : v > 0 ? 'up' : 'down'; }
  function dotOf(t) { return t === 'success' ? 'g' : t === 'warning' ? 'y' : t === 'danger' ? 'r' : ''; }
  function recLabel(m) { return m < 1.5 ? 'Strong buy' : m < 2.5 ? 'Buy' : m < 3.5 ? 'Hold' : m < 4.5 ? 'Sell' : 'Strong sell'; }
  function recTone(m) { return m < 2.5 ? 'success' : m < 3.5 ? 'warning' : 'danger'; }
  function dlabel(iso, yr) { var p = iso.split('-'); return MON[+p[1] - 1] + ' ' + (yr ? "'" + p[0].slice(2) : String(+p[2])); }
  function dfull(iso) { var p = iso.split('-'); return MON[+p[1] - 1] + ' ' + (+p[2]) + ', ' + p[0]; }
  function etTime(d) { return new Date(d + ':00Z').toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'; }
  function clock(hm) { var h = +hm.slice(0, 2), m = hm.slice(3, 5); return (h % 12 || 12) + (m === '00' ? '' : ':' + m) + (h < 12 ? ' AM' : ' PM'); }
  function clockFull(hm) { var h = +hm.slice(0, 2), m = hm.slice(3, 5); return (h % 12 || 12) + ':' + m + (h < 12 ? ' AM' : ' PM'); }
  function mdLabel(md) { return MON[+md.slice(0, 2) - 1] + ' ' + (+md.slice(3, 5)); }
  function chg(v, txt) { return '<span class="chg ' + cls(v) + '">' + esc(txt) + '</span>'; }
  function methodLong(p) {
    switch (p.mc) {
      case 'S': return 'Wall Street analyst consensus (Yahoo Finance / LSEG).';
      case 'H': return "Fund: average analyst view of its top 10 holdings, weighted by size (Yahoo Finance).";
      case 'L': return 'Fund: average analyst view of the top 10 holdings of ' + p.via + ', the index fund it is built on.';
      case 'M': return 'Morningstar overall star rating (via Yahoo Finance). Analysts do not rate this fund.';
      case 'NE': return 'Not rated: no usable holdings data (options-based, or too few rated holdings).';
      case 'NB': return 'Not rated: analysts do not rate bond, cash, commodity, crypto or alternative funds.';
      default: return 'Cash is not rated.';
    }
  }

  // ---------- state ----------
  var S = { tab: 'overview', acct: 'all', period: '1Y', q: '', cls: 'all', flt: 'all', sortKey: 'mv', asc: false, news: 'all', tone: 'all', sel: '', dv: 'today', open: {}, more: {}, src: 'bt', editT: null };
  var D = null, ALL = [], POS = [], X = {};

  function prepare(d) {
    D = d;
    ALL = d.P.map(function (r) { var o = {}; d.PC.forEach(function (k, i) { o[k] = r[i]; }); return o; });
    X.ACCOUNTS = uniq(ALL.map(function (p) { return p.a; })).sort();
    var saved = LS.get('idash.acct');
    S.acct = saved && X.ACCOUNTS.indexOf(saved) >= 0 ? saved : 'all';
    X.ASOF_T = d.I && d.I.asOf ? d.I.asOf.slice(11, 16) : null;
    X.AS_OF = X.ASOF_T ? clockFull(X.ASOF_T) + ' ET, ' + mdLabel(d.I.asOf.slice(5, 10)) : d.asOf;
    X.PULLED = clockFull(d.gen.slice(11, 16)) + ' ET, ' + mdLabel(d.gen.slice(5, 10));
    X.NEWS = (d.news || []).slice().sort(function (a, b) { return a.d < b.d ? 1 : -1; });
    var s = d.ser && d.ser.spy; X.BENCH_DAY = s && s.length > 1 ? s[s.length - 1] / s[s.length - 2] - 1 : null;
    scope();
  }
  // Positions in the selected account(s) plus the totals everything else is measured against.
  function scope() {
    if (S.acct === 'all') {
      // The same holding in several accounts shows as one line (quantities, value and cost added up).
      var m = {}; POS = [];
      ALL.forEach(function (p) {
        var o = m[p.s];
        if (!o) { o = m[p.s] = Object.assign({}, p, { accts: [[p.a, p.mv, p.q]] }); POS.push(o); return; }
        ['q', 'mv', 'd', 'cb', 'g'].forEach(function (k) { o[k] = o[k] == null && p[k] == null ? null : (o[k] || 0) + (p[k] || 0); });
        o.accts.push([p.a, p.mv, p.q]); o.a = o.accts.length + ' accounts';
        o.gp = o.g != null && o.cb ? o.g / o.cb : null;
      });
    } else POS = ALL.filter(function (p) { return p.a === S.acct; }).map(function (p) { return Object.assign({}, p, { accts: [[p.a, p.mv, p.q]] }); });
    X.TOTAL = sum(POS, function (p) { return p.mv; });
    X.DAY = sum(POS, function (p) { return p.d; });
    X.GAIN = sum(POS, function (p) { return p.g; });
    X.COST = sum(POS.filter(function (p) { return p.g != null; }), function (p) { return p.cb; });
    POS.forEach(function (p) { p.wt = X.TOTAL ? p.mv / X.TOTAL : 0; });
    var g = {};
    POS.forEach(function (p) { (g[p.c] = g[p.c] || []).push(p); });
    X.GROUPS = Object.keys(g).map(function (c) {
      var ps = g[c].sort(function (a, b) { return b.mv - a.mv; }), mv = sum(ps, function (p) { return p.mv; }), day = sum(ps, function (p) { return p.d; });
      return { name: c, pos: ps, mv: mv, day: day, dayPct: mv - day ? day / (mv - day) : 0, w: X.TOTAL ? mv / X.TOTAL : 0 };
    }).sort(function (a, b) { return b.mv - a.mv; });
    // Materiality: a move has to be worth at least 0.05% of the portfolio (min $500) to make the briefing.
    X.MAT = Math.max(500, X.TOTAL * 0.0005);
  }
  function bySym(s) { return POS.find(function (p) { return p.s === s; }) || ALL.find(function (p) { return p.s === s; }); }

  // ---------- "worth your attention" (rule-based, from the data only) ----------
  function attention() {
    var M = X.MAT, items = [], newsFor = {}, minor = [];
    X.NEWS.forEach(function (n) { if (n.sc && n.sc !== 'Market' && !newsFor[n.sc]) newsFor[n.sc] = n; });
    POS.forEach(function (p) {
      if (p.s === 'CASH' || !p.mv) return;
      var A = D.A && D.A[p.s], st = A && A.st, lines = [], score = 0, tone = 0, title = null, amt = null, amtSub = '';
      var mover = p.d != null && Math.abs(p.d) >= M;
      var anSig = st && (st.tone === 'danger' || st.tone === 'success') && p.wt >= 0.005;
      var below200 = p.last != null && p.m200 != null && p.last < p.m200 * 0.95 && p.tr === 'Downtrend';
      var news = newsFor[p.s];
      if (anSig) {
        lines.push(st.tone === 'danger'
          ? 'Analysts are turning more cautious: ' + st.down + ' downgrade' + (st.down === 1 ? '' : 's') + ', ' + st.up + ' upgrade' + (st.up === 1 ? '' : 's') + ' and ' + st.ptCut + ' target cut' + (st.ptCut === 1 ? '' : 's') + ' in 90 days.'
          : 'Analysts are turning more positive: ' + st.up + ' upgrade' + (st.up === 1 ? '' : 's') + ', ' + st.down + ' downgrade' + (st.down === 1 ? '' : 's') + ' and ' + st.ptRaised + ' target raise' + (st.ptRaised === 1 ? '' : 's') + ' in 90 days.');
        score += p.mv * 0.02;
      }
      if (below200 && (mover || anSig)) lines.push('Trading ' + apct(p.last / p.m200 - 1, 0) + ' below its 200-day average.');
      if (news && (mover || anSig || p.wt >= 0.01)) { lines.push(news.why); score += p.mv * 0.005; }
      if (mover) {
        var extra = lines.length > 0, big = Math.abs(p.d) >= 2 * M;
        if (!extra && !big) { minor.push(p); return; }
        title = p.s + ' ' + (p.d < 0 ? 'down ' : 'up ') + apct(p.dp, 1) + ' today';
        amt = smoney(p.d); amtSub = 'today'; tone = p.d < 0 ? -1 : 1; score += Math.abs(p.d);
        if (!extra) lines.push(p.n + ', ' + apct(p.wt, 1) + ' of the portfolio.');
      } else if (anSig) {
        title = 'Analysts ' + (st.tone === 'danger' ? 'cooling on ' : 'warming to ') + p.s;
        tone = st.tone === 'danger' ? -1 : 1; amt = short$(p.mv); amtSub = 'position';
      } else if (news && p.wt >= 0.01) {
        title = p.s + ' in the news'; amt = short$(p.mv); amtSub = 'position';
      } else return;
      items.push({ sym: p.s, tone: tone, title: title, why: lines.join(' '), amt: amt, amtSub: amtSub, score: score });
    });
    if (minor.length) {
      minor.sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
      var mdn = minor.filter(function (p) { return p.d < 0; }), mup = minor.filter(function (p) { return p.d > 0; });
      var net = sum(minor, function (p) { return p.d; });
      var part = function (l, w) { return l.length ? w + ' ' + l.slice(0, 4).map(function (p) { return p.s + ' ' + sshort$(p.d); }).join(', ') + (l.length > 4 ? ' and ' + (l.length - 4) + ' more' : '') + '.' : ''; };
      items.push({ tone: net < 0 ? -1 : 1, title: 'Other notable moves today', why: (part(mdn, 'Down:') + ' ' + part(mup, 'Up:')).trim(), amt: smoney(net), amtSub: 'combined', score: Math.abs(net) * 0.5, go: 'holdings' });
    }
    var listed = items.map(function (i) { return i.sym; });
    var trend = POS.filter(function (p) { return listed.indexOf(p.s) < 0 && p.wt >= 0.015 && p.last != null && p.m200 != null && p.last < p.m200 * 0.95 && p.tr === 'Downtrend'; })
      .sort(function (a, b) { return b.mv - a.mv; });
    if (trend.length) {
      var tv = sum(trend, function (p) { return p.mv; });
      items.push({ tone: -1, title: trend.length === 1 ? trend[0].s + ' is in a downtrend' : trend.length + ' large holdings are in downtrends',
        why: trend.slice(0, 4).map(function (p) { return p.s + ' ' + apct(p.last / p.m200 - 1, 0) + ' below its 200-day average'; }).join(', ') + (trend.length > 4 ? ', and ' + (trend.length - 4) + ' more' : '') + '.',
        amt: short$(tv), amtSub: apct(tv / X.TOTAL, 0) + ' of total', score: tv * 0.01, sym: trend.length === 1 ? trend[0].s : null, go: trend.length > 1 ? 'downtrend' : null });
    }
    POS.forEach(function (p) {
      if ((p.t === 'Equity' && p.wt > 0.08) || p.wt > 0.2)
        items.push({ sym: p.s, tone: 0, title: p.s + ' is ' + apct(p.wt, 0) + ' of the portfolio', why: 'Your largest single-' + (p.t === 'Equity' ? 'stock' : 'fund') + ' exposure; a 10% move in it changes the total by ' + short$(p.mv * 0.1) + '.', amt: short$(p.mv), amtSub: 'position', score: p.mv * 0.01 });
    });
    X.GROUPS.forEach(function (g) { if (g.w > 0.6) items.push({ tone: 0, title: g.name + ' are ' + apct(g.w, 0) + ' of the total', why: 'Most of the portfolio rides on one asset class.', amt: short$(g.mv), amtSub: '', score: M * 3 }); });
    var mk = X.NEWS.find(function (n) { return n.sc === 'Market'; });
    if (mk) items.push({ tone: 0, market: true, title: mk.why, why: '', news: mk, amt: '', amtSub: '', score: M * 1.2 });

    // alerts fired today (insights.py, rules in alerts.json) always lead the briefing
    ((D.X && D.X.alerts) || []).forEach(function (a) {
      if (a.symbol ? !POS.some(function (p) { return p.s === a.symbol; }) : S.acct !== 'all') return;
      var it = a.symbol && items.find(function (i) { return i.sym === a.symbol; });
      if (it) { it.alert = a; it.score += 1e12; }
      else items.push({ sym: a.symbol, tone: a.tone, title: a.title, why: a.detail, amt: a.value != null ? smoney(a.value) : '', amtSub: a.value != null ? 'today' : '', score: 1e12, alert: a });
    });
    items.sort(function (a, b) { return b.score - a.score; });
    var pick = items.slice(0, 5);
    var need = function (pred) {
      if (pick.some(pred)) return;
      var cand = items.find(pred); if (!cand) return;
      for (var i = pick.length - 1; i >= 0; i--) if (!pick[i].keep && pick.length >= 5) { pick.splice(i, 1); break; }
      cand.keep = true; pick.push(cand);
    };
    pick.forEach(function (i) { i.keep = false; });
    need(function (i) { return i.tone > 0; });
    if (!pick.some(function (i) { return i.tone > 0; })) {
      var best = POS.filter(function (p) { return p.d > 0; }).sort(function (a, b) { return b.d - a.d; })[0];
      if (best && best.d >= M / 2) { var it = { sym: best.s, tone: 1, title: best.s + ' up ' + apct(best.dp, 1) + ' today', why: 'Your biggest gainer today.', amt: smoney(best.d), amtSub: 'today', score: best.d, keep: true }; if (pick.length >= 5) pick.pop(); pick.push(it); }
    }
    need(function (i) { return i.market; });
    pick.sort(function (a, b) { return b.score - a.score; });
    return pick;
  }

  // ---------- rendering: overview ----------
  function renderHero() {
    $('#hero-label').textContent = S.acct === 'all' ? (X.ACCOUNTS.length > 1 ? 'Total value · all accounts' : 'Total value') : 'Total value · ' + S.acct;
    $('#hero-value').textContent = money(X.TOTAL);
    var dayPct = X.TOTAL - X.DAY ? X.DAY / (X.TOTAL - X.DAY) : 0, gPct = X.COST ? X.GAIN / X.COST : null;
    $('#hero-stats').innerHTML =
      '<div class="stat"><div class="k">Today</div><div class="v ' + cls(X.DAY) + '">' + esc(smoney(X.DAY)) + '<small>' + esc(pct(dayPct, 2)) + '</small></div></div>' +
      '<div class="stat"><div class="k">Gain since purchase</div><div class="v ' + cls(X.GAIN) + '">' + esc(smoney(X.GAIN)) + '<small>' + esc(pct(gPct, 1)) + '</small></div></div>' +
      (X.BENCH_DAY != null ? '<div class="stat"><div class="k">S&amp;P 500 today</div><div class="v ' + cls(X.BENCH_DAY) + '">' + esc(pct(X.BENCH_DAY, 2)) + '</div></div>' : '');
    $('#asof').innerHTML = '<span class="badge">DELAYED</span><span>Prices as of ' + esc(X.AS_OF) + '. Updates every 30 min in market hours; mutual funds at last NAV.</span>';
  }
  function renderAttention() {
    var list = attention();
    $('#att-sub').textContent = 'Ranked by dollar impact · moves under ' + short$(X.MAT) + ' left out';
    $('#att-list').innerHTML = list.length ? list.map(function (i) {
      var ico = i.tone < 0 ? '<span class="att-ico neg">↓</span>' : i.tone > 0 ? '<span class="att-ico pos">↑</span>' : '<span class="att-ico neu">' + (i.market ? '◎' : '!') + '</span>';
      var attr = i.sym ? ' class="att click" data-sym="' + esc(i.sym) + '" tabindex="0"' : i.go ? ' class="att click" data-go="' + esc(i.go) + '" tabindex="0"' : ' class="att"';
      var why = i.market ? '<a href="' + esc(i.news.u) + '" target="_blank" rel="noopener noreferrer">' + esc(i.news.t) + '</a> · ' + esc(i.news.s) : esc(i.why);
      return '<li' + attr + '>' + ico + '<div><div class="att-title">' + (i.alert ? '<span class="badge-alert" title="Alert rule: ' + esc(i.alert.threshold || '') + '">Alert</span>' : '') + esc(i.market ? 'Market: ' + i.title : i.title) + '</div><div class="att-why">' + why + '</div></div>' +
        '<div class="att-amt ' + (i.amtSub === 'position' || i.amtSub === '' || /of total/.test(i.amtSub) ? '' : i.tone < 0 ? 'down' : i.tone > 0 ? 'up' : '') + '">' + esc(i.amt) + (i.amtSub ? '<small>' + esc(i.amtSub) + '</small>' : '') + '</div></li>';
    }).join('') : '<li class="att-empty">Nothing stands out today. No move is bigger than ' + esc(short$(X.MAT)) + ', and analyst views are steady.</li>';
    var attNews = $('#att-news');
    if (attNews) {
      var held = {}; POS.forEach(function (p) { held[p.s] = 1; });
      var etDay = function (d) {
        var raw = String(d || ''), iso = /Z$|[+-]\d\d:\d\d$/.test(raw) ? raw : raw.length <= 16 ? raw + ':00Z' : raw;
        var t = Date.parse(iso);
        return isFinite(t) ? new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : raw.slice(0, 10);
      };
      var today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      var hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
      var yest = new Date(Date.now() - 36e5 * 24).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      var onHoldings = function (n) { return n.sc === 'Market' || (n.h && n.h.some(function (h) { return held[h]; })); };
      var word = 'today', neg = X.NEWS.filter(function (n) { return n.sn === 'negative' && onHoldings(n) && etDay(n.d) === today; });
      if (!neg.length && hour < 8) { word = 'yesterday'; neg = X.NEWS.filter(function (n) { return n.sn === 'negative' && onHoldings(n) && etDay(n.d) === yest; }); }
      if (neg.length) {
        attNews.hidden = false;
        attNews.innerHTML = '<button type="button" data-go="news-negative">' + neg.length + ' negative stor' + (neg.length === 1 ? 'y' : 'ies') + ' on your holdings ' + word + '</button>';
      } else { attNews.hidden = true; attNews.textContent = ''; }
    }
  }
  function renderGroups() {
    $('#grp-sub').textContent = POS.length + ' holdings in ' + X.GROUPS.length + ' groups · tap to open';
    $('#grp-list').innerHTML = X.GROUPS.map(function (g) {
      var open = !!S.open[g.name], n = g.pos.length;
      var body = open ? '<div class="grp-body">' + g.pos.map(function (p) {
        var nav = p.dp == null && p.s !== 'CASH';
        return '<div class="prow" data-sym="' + esc(p.s) + '" tabindex="0"><div style="min-width:0"><div class="psym">' + (p.s === 'CASH' ? 'Cash' : esc(p.s)) + (p.s !== 'CASH' ? '<span class="dot ' + dotOf(p.at) + '" title="Analysts: ' + esc(p.al || 'not rated') + '"></span>' : '') + '</div><div class="pname">' + esc(p.n) + '</div></div>' +
          '<div class="pval">' + esc(money(p.mv)) + '<small>' + esc(apct(p.wt, 1)) + '</small></div>' +
          '<div class="pday">' + (p.s === 'CASH' ? '' : nav ? '<span class="chg flat">NAV</span>' : chg(p.dp, pct(p.dp, 2))) + '</div></div>';
      }).join('') + '</div>' : '';
      return '<div class="grp' + (open ? ' open' : '') + '"><button class="grp-row" data-grp="' + esc(g.name) + '" aria-expanded="' + open + '"><span class="chev"></span>' +
        '<span style="min-width:0"><div class="grp-name">' + esc(g.name) + '</div><div class="grp-meta">' + n + ' holding' + (n === 1 ? '' : 's') + ' · ' + esc(apct(g.w, 1)) + ' of total</div><div class="wbar"><span style="width:' + (g.w * 100).toFixed(1) + '%"></span></div></span>' +
        '<span class="grp-val">' + esc(short$(g.mv)) + '<small class="d ' + cls(g.day) + '">' + esc(sshort$(g.day) + ' today') + '</small></span>' +
        '<span class="grp-day ' + cls(g.day) + '">' + esc(sshort$(g.day)) + '<small>' + esc(pct(g.dayPct, 2)) + '</small></span></button>' + body + '</div>';
    }).join('');
  }
  function renderAbout() {
    var LI = (D.gaps && D.gaps.lateInception) || {};
    $('#about').innerHTML = 'What this can and can’t do: prices are delayed snapshots (last 5-minute bar, ' + esc(X.AS_OF) + '), not live quotes. Quantities and cost basis come from the brokerage export of ' + esc(D.asOf) +
      ' (' + esc(X.ACCOUNTS.join(', ')) + '); upload a new export to change them. Prices, analyst ratings and news: Yahoo Finance, pulled ' + esc(X.PULLED) + '. The briefing is rule-based: it flags large moves, analyst rating shifts, downtrends and news; it is not advice.' +
      Object.keys(LI).map(function (k) { return ' ' + esc(k) + ' launched ' + esc(dfull(LI[k])) + '.'; }).join('');
  }

  // ---------- charts (uPlot) ----------
  var CHARTS = {};
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function killChart(id) { if (CHARTS[id]) { CHARTS[id].u.destroy(); CHARTS[id].ro.disconnect(); delete CHARTS[id]; } }
  function drawCandles(u, k) {
    var ctx = u.ctx, n = k.c.length, bw = Math.max(1, Math.min(14, u.bbox.width / Math.max(1, n) * 0.62)), up = cssVar('--line-pos'), dn = cssVar('--line-neg');
    ctx.save(); ctx.beginPath(); ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height); ctx.clip();
    for (var i = 0; i < n; i++) {
      var o = k.o[i], h = k.h[i], l = k.l[i], c = k.c[i]; if (c == null || o == null) continue;
      var x = Math.round(u.valToPos(i, 'x', true)), yo = u.valToPos(o, 'y', true), yc = u.valToPos(c, 'y', true);
      var col = c >= o ? up : dn; ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, devicePixelRatio || 1);
      if (h != null && l != null) { ctx.beginPath(); ctx.moveTo(x, u.valToPos(h, 'y', true)); ctx.lineTo(x, u.valToPos(l, 'y', true)); ctx.stroke(); }
      ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    }
    ctx.restore();
  }
  function lineChart(el, cfg) {
    // cfg: labels[] (sparse tick labels), full[] (hover labels), series[{label, values, color, dash, fill, width}], fmt(y), readout(el, idx)
    killChart(el.id);
    el.innerHTML = '';
    var w = el.clientWidth || 600, height = function (w) { return cfg.h || (w < 520 ? 210 : 260); };
    var n = cfg.labels.length, idx = [];
    cfg.labels.forEach(function (l, i) { if (l) idx.push(i); });
    var ticks = function () {
      var t = idx.slice(), m = Math.max(2, Math.floor((el.clientWidth || w) / 90));
      if (t.length > m) { var st = Math.ceil(t.length / m), last = t[t.length - 1]; t = t.filter(function (_, j) { return j % st === 0; }); if (t[t.length - 1] !== last) { if (last - t[t.length - 1] < n / m * 0.6) t.pop(); t.push(last); } }
      return t;
    };
    var font = '11px ' + cssVar('--font'), muted = cssVar('--muted'), grid = cssVar('--grid');
    var tip = document.createElement('div'); tip.className = 'chart-tip'; tip.hidden = true;
    var u = new uPlot({
      width: w, height: height(w), padding: [8, 8, 0, 0],
      cursor: { drag: { x: false, y: false }, points: { size: 7 }, y: false },
      legend: { show: false },
      scales: { x: { time: false } },
      series: [{}].concat(cfg.series.map(function (s) { return { stroke: s.color, width: s.width == null ? 2 : s.width, dash: s.dash, fill: s.fill, points: { show: false }, spanGaps: !!s.spanGaps }; })),
      axes: [
        { stroke: muted, font: font, grid: { show: false }, ticks: { show: false }, gap: 4, size: 28, splits: ticks, values: function (u, sp) { return sp.map(function (i) { return cfg.labels[i] || ''; }); } },
        { side: 1, stroke: muted, font: font, grid: { stroke: grid, width: 1 }, ticks: { show: false }, gap: 6,
          values: function (u, sp) { return sp.map(cfg.fmt); },
          size: function (u, vals) { if (!vals) return 44; return Math.ceil(Math.max.apply(null, vals.map(function (v) { return String(v).length; })) * 6.6) + 12; } }
      ],
      hooks: { draw: cfg.candles ? [function (u) { drawCandles(u, cfg.candles); }] : [], setCursor: [function (u) {
        var i = u.cursor.idx;
        if (i == null || u.cursor.left < 0) { tip.hidden = true; return; }
        tip.innerHTML = '<b>' + esc(cfg.full[i] || '') + '</b>' + (cfg.tip ? cfg.tip(i) : cfg.series.map(function (s) { var v = s.values[i]; return v == null || s.noTip ? '' : '<div><span style="color:' + s.color + '">●</span> ' + esc(s.label) + ' ' + esc(cfg.tipFmt ? cfg.tipFmt(v) : cfg.fmt(v)) + '</div>'; }).join(''));
        tip.hidden = false;
        var x = u.cursor.left + u.over.offsetLeft, tw = tip.offsetWidth;
        tip.style.left = Math.max(0, Math.min(x - tw / 2, el.clientWidth - tw)) + 'px'; tip.style.top = '-6px';
      }] }
    }, [cfg.labels.map(function (_, i) { return i; })].concat(cfg.series.map(function (s) { return s.values.map(function (v) { return v == null || !isFinite(v) ? null : v; }); })), el);
    el.style.position = 'relative'; el.appendChild(tip);
    var ro = new ResizeObserver(function () { var cw = el.clientWidth; if (cw && Math.abs(cw - u.width) > 1) u.setSize({ width: cw, height: height(cw) }); });
    ro.observe(el);
    CHARTS[el.id] = { u: u, ro: ro };
  }
  function periodStart(p) {
    var d = D.ser.d, last = d[d.length - 1].split('-').map(Number);
    if (p === '1Y') return 0;
    var i = 0;
    if (p === 'YTD') { d.forEach(function (x, k) { if (x < last[0] + '-01-01') i = k; }); return i; }
    var months = p === '1M' ? 1 : p === '3M' ? 3 : 6;
    var iso = new Date(Date.UTC(last[0], last[1] - 1 - months, last[2])).toISOString().slice(0, 10);
    d.forEach(function (x, k) { if (x <= iso) i = k; }); return i;
  }
  function renderPerf() {
    $$('#perf-seg button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-period') === S.period)); });
    if (!D.ser || !D.ser.d || D.ser.d.length < 2) { $('#perf').hidden = true; return; }
    var act = (D.X && D.X.actual) || [];
    $('#perf-src').hidden = act.length < 2;
    if (act.length < 2) S.src = 'bt';
    $$('#perf-src button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-src') === S.src)); });
    $('#perf-seg').hidden = S.src === 'actual';
    if (S.src === 'actual') return renderActual(act);
    var i0 = periodStart(S.period), d = D.ser.d.slice(i0), v = D.ser.v.slice(i0), s = D.ser.spy.slice(i0), n = d.length;
    var long = S.period === '1Y' || S.period === 'YTD';
    var labels = d.map(function (x, k) {
      if (k === 0) return '';
      if (long) return x.slice(5, 7) !== d[k - 1].slice(5, 7) ? MON[+x.slice(5, 7) - 1] : '';
      return x.slice(0, 7) !== d[k - 1].slice(0, 7) || (n < 40 ? k % 5 === 0 : k % 15 === 0) ? dlabel(x, false) : '';
    });
    var retP = v[n - 1] / v[0] - 1, retS = s[n - 1] / s[0] - 1;
    var color = cssVar(retP >= 0 ? '--line-pos' : '--line-neg'), bench = cssVar('--bench');
    var fill = function (u) { var g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height); g.addColorStop(0, color + '33'); g.addColorStop(1, color + '00'); return g; };
    $('#perf-summary').innerHTML = '<span><span class="key" style="background:' + color + '"></span><b class="' + cls(retP) + '">' + esc(pct(retP, 1)) + '</b>Your holdings · ' + esc(sshort$(v[n - 1] - v[0])) + '</span>' +
      '<span><span class="key" style="background:' + bench + '"></span><b>' + esc(pct(retS, 1)) + '</b>S&amp;P 500</span>';
    lineChart($('#perf-chart'), { labels: labels, full: d.map(dfull), fmt: function (y) { return (y > 0 ? '+' : '') + (+y).toFixed(Math.abs(y) < 10 ? 1 : 0) + '%'; },
      tipFmt: function (y) { return (y > 0 ? '+' : '') + (+y).toFixed(2) + '%'; },
      series: [{ label: 'Holdings', values: v.map(function (x) { return (x / v[0] - 1) * 100; }), color: color, fill: fill },
               { label: 'S&P 500', values: s.map(function (x) { return (x / s[0] - 1) * 100; }), color: bench, width: 1.25 }] });
    var LI = (D.gaps && D.gaps.lateInception) || {};
    $('#perf-note').textContent = 'Backtest of today’s holdings across ' + (X.ACCOUNTS.length > 1 ? 'all accounts' : 'the account') + ': current quantities × daily closes with distributions reinvested, cash flat. Not your actual account history.' +
      (Object.keys(LI).length ? ' Funds that launched later are held flat before launch.' : '') + (S.acct !== 'all' ? ' The account filter does not apply to this chart.' : '') +
      (act.length < 2 ? ' Actual history: recording one value per market day since ' + (act.length ? dfull(act[0][0]) : 'the next refresh') + '; an Actual view appears here once two days exist.' : '');
  }

  function renderActual(act) {
    var d = act.map(function (a) { return a[0]; }), v = act.map(function (a) { return a[1]; }), n = v.length;
    var ch = v[n - 1] - v[0], color = cssVar(ch >= 0 ? '--line-pos' : '--line-neg');
    $('#perf-summary').innerHTML = '<span><span class="key" style="background:' + color + '"></span><b class="' + cls(ch) + '">' + esc(sshort$(ch)) + '</b>recorded value change since ' + esc(dfull(d[0])) + '</span>';
    lineChart($('#perf-chart'), { labels: d.map(function (x, k) { return k === 0 ? '' : n < 12 || k % Math.ceil(n / 8) === 0 ? dlabel(x, false) : ''; }), full: d.map(dfull),
      fmt: function (y) { return '$' + (y / 1e6).toFixed(2) + 'M'; }, tipFmt: function (y) { return money(y); },
      series: [{ label: 'Recorded value', values: v, color: color, fill: color + '22' }] });
    $('#perf-note').textContent = 'Actual: the total recorded at the last refresh of each market day (all accounts), since ' + dfull(d[0]) + '. It includes deposits, withdrawals and position changes, so it is not a pure return. Days before recording started are not shown.';
  }

  // ---------- holdings tab ----------
  var FLT = {
    all: function () { return true; }, up: function (p) { return (p.d || 0) > 0; }, down: function (p) { return (p.d || 0) < 0; },
    loss: function (p) { return (p.g || 0) < 0; }, red: function (p) { var A = D.A && D.A[p.s]; return p.at === 'danger' || p.at === 'warning' || (A && A.st && A.st.tone === 'danger'); },
    downtrend: function (p) { return p.tr === 'Downtrend'; }
  };
  function renderHoldings() {
    var opts = [['all', 'All asset classes']].concat(X.GROUPS.map(function (g) { return [g.name, g.name]; }));
    if (S.cls !== 'all' && !X.GROUPS.some(function (g) { return g.name === S.cls; })) S.cls = 'all';
    $('#f-cls').innerHTML = opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === S.cls ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
    $('#f-sort').value = S.sortKey;
    $$('#f-chips button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-flt') === S.flt)); });
    var q = S.q.trim().toLowerCase();
    var list = POS.filter(function (p) { return (S.cls === 'all' || p.c === S.cls) && FLT[S.flt](p) && (!q || (p.s + ' ' + p.n + ' ' + p.c).toLowerCase().indexOf(q) >= 0); });
    var key = S.sortKey === 'w' ? 'mv' : S.sortKey;
    var val = function (p) { return key === 's' ? p.s : p[key] == null ? -1e15 : p[key]; };
    list.sort(function (a, b) { var x = val(a), y = val(b); var c = typeof x === 'string' ? x.localeCompare(y) : x - y; return S.asc ? c : -c; });
    var multi = X.ACCOUNTS.length > 1 && S.acct === 'all';
    var cols = [['s', 'Holding', ''], ['mv', 'Value', ''], ['w', 'Weight', 'opt'], ['dp', 'Today', ''], ['d', 'Today $', 'opt'], ['gp', 'Gain', 'opt'], [null, '', 'c-an'], [null, 'Trend', 'opt']];
    var th = cols.map(function (c) {
      var on = c[0] && (S.sortKey === c[0]);
      return '<th class="' + c[2] + (on ? ' on' : '') + '"' + (c[0] ? ' data-sort="' + c[0] + '" tabindex="0" aria-sort="' + (on ? (S.asc ? 'ascending' : 'descending') : 'none') + '"' : '') + '>' + (c[2] === 'c-an' ? '<span class="lg">Analysts</span><span class="sm" aria-label="Analysts">●</span>' : esc(c[1])) + (on ? (S.asc ? ' ↑' : ' ↓') : '') + '</th>';
    }).join('');
    var rows = list.map(function (p) {
      var nav = p.dp == null && p.s !== 'CASH';
      return '<tr data-sym="' + esc(p.s) + '" tabindex="0"><td class="sym"><b>' + (p.s === 'CASH' ? 'Cash' : esc(p.s)) + '</b><div class="pname">' + esc(p.n + (multi ? ' · ' + p.a : '')) + '</div></td>' +
        '<td>' + esc(money(p.mv)) + '</td><td class="opt">' + esc(apct(p.wt, 1)) + '</td>' +
        '<td>' + (p.s === 'CASH' ? '' : nav ? '<span class="chg flat">NAV</span>' : chg(p.dp, pct(p.dp, 2))) + '</td>' +
        '<td class="opt ' + cls(p.d) + '">' + (p.s === 'CASH' ? '' : esc(smoney(p.d))) + '</td>' +
        '<td class="opt ' + cls(p.gp) + '">' + (p.gp == null ? '–' : esc(pct(p.gp, 1))) + '</td>' +
        '<td class="c-an">' + (p.s === 'CASH' ? '' : '<span class="dot ' + dotOf(p.at) + '" title="' + esc(p.al || 'Not rated') + '"></span>') + '</td>' +
        '<td class="opt">' + esc(p.tr || '–') + '</td></tr>';
    }).join('');
    var mv = sum(list, function (p) { return p.mv; }), day = sum(list, function (p) { return p.d; });
    $('#htable').innerHTML = '<thead><tr>' + th + '</tr></thead><tbody>' + (rows || '<tr><td colspan="8" style="text-align:left;color:var(--muted)">No holdings match.</td></tr>') + '</tbody>' +
      '<tfoot><tr><td>' + list.length + ' shown</td><td>' + esc(money(mv)) + '</td><td class="opt">' + esc(apct(X.TOTAL ? mv / X.TOTAL : 0, 1)) + '</td><td></td><td class="opt ' + cls(day) + '">' + esc(smoney(day)) + '</td><td class="opt"></td><td></td><td class="opt"></td></tr></tfoot>';
    $('#h-note').textContent = 'Prices as of ' + X.AS_OF + ' (delayed). Analyst light: green = buy, yellow = hold, red = sell, gray = not rated. Trend compares the price with its 50- and 200-day averages. NAV = mutual fund, priced once a day. Tap a row for details.';
  }

  // ---------- news tab ----------
  function newsTone(n) { return n && (n.sn === 'positive' || n.sn === 'negative') ? n.sn : 'neutral'; }
  function renderNews() {
    var held = {}; POS.forEach(function (p) { held[p.s] = 1; });
    var all = X.NEWS.filter(function (n) { return n.sc === 'Market' || (n.h && n.h.some(function (h) { return held[h]; })); });
    var byTone = { positive: 0, negative: 0, neutral: 0 };
    all.forEach(function (n) { byTone[newsTone(n)]++; });
    var tones = [['all', 'All', all.length], ['positive', 'Positive', byTone.positive], ['negative', 'Negative', byTone.negative], ['neutral', 'Neutral', byTone.neutral]];
    if (!tones.some(function (c) { return c[0] === S.tone; })) S.tone = 'all';
    $('#n-tone-chips').innerHTML = tones.map(function (c) { return '<button data-ntone="' + c[0] + '" aria-pressed="' + (S.tone === c[0]) + '">' + esc(c[1]) + '<span class="n">' + c[2] + '</span></button>'; }).join('');
    var syms = uniq(all.filter(function (n) { return n.sc !== 'Market'; }).map(function (n) { return n.sc; })).sort();
    var chips = [['all', 'All', all.length], ['Market', 'Market', all.filter(function (n) { return n.sc === 'Market'; }).length]].concat(syms.map(function (s) { return [s, s, all.filter(function (n) { return n.sc === s; }).length]; }));
    if (!chips.some(function (c) { return c[0] === S.news; })) S.news = 'all';
    $('#n-chips').innerHTML = chips.map(function (c) { return '<button data-news="' + esc(c[0]) + '" aria-pressed="' + (S.news === c[0]) + '">' + esc(c[1]) + '<span class="n">' + c[2] + '</span></button>'; }).join('');
    $('#n-legend').innerHTML = '<span><span class="dot g" aria-hidden="true"></span>Positive</span>' +
      '<span><span class="dot r" aria-hidden="true"></span>Negative</span>' +
      '<span><span class="dot n" aria-hidden="true"></span>Neutral</span>';
    var list = all.filter(function (n) { return (S.tone === 'all' || newsTone(n) === S.tone) && (S.news === 'all' || n.sc === S.news); });
    $('#news-list').innerHTML = list.length ? list.map(newsItem).join('') : '<li class="muted">No stories in this filter.</li>';
    $('#n-note').textContent = 'Tone of the story, not a prediction. Hand-picked from the last 7 days of Yahoo Finance for your holdings and the market. Pulled ' + X.PULLED + '.';
  }
  function newsItem(n) {
    var held = {}; POS.forEach(function (p) { held[p.s] = 1; });
    var tone = newsTone(n), lab = tone === 'positive' ? 'Positive' : tone === 'negative' ? 'Negative' : 'Neutral';
    var dot = tone === 'positive' ? 'g' : tone === 'negative' ? 'r' : 'n';
    var owned = (n.h || []).filter(function (h) { return held[h]; });
    var reason = (n.sw || 'No strong tone signal') + (owned.length ? ' · ' + owned.join(', ') : (n.sc === 'Market' ? ' · Market' : ''));
    return '<li class="n-item n-' + tone + '"><div class="n-row">' +
      '<button type="button" class="n-tone" aria-expanded="false" title="' + esc(reason) + '">' +
      '<span class="dot ' + dot + '" aria-hidden="true"></span><span class="n-lab">' + lab + '</span></button>' +
      '<div class="n-main"><div class="why">' + esc(n.why) + '</div>' +
      '<a class="t" href="' + esc(n.u) + '" target="_blank" rel="noopener noreferrer">' + esc(n.t) + '</a>' +
      '<div class="m"><span>' + esc(n.s + ' · ' + etTime(n.d)) + '</span>' + (n.sc === 'Market' ? '<span class="tag mkt">Market</span>' : '') +
      owned.map(function (h) { return '<button class="tag" data-sym="' + esc(h) + '">' + esc(h) + '</button>'; }).join('') + '</div>' +
      '<div class="n-tip">' + esc(reason) + '</div></div></div></li>';
  }

  // ---------- detail sheet ----------
  function intraView(p, v) {
    var raw = D.I && (v === 'today' ? D.I.v : D.I.v5)[p.s];
    if (!raw || p.pc == null) return null;
    var pc = p.pc, lab = v === 'today' ? D.I.t : D.I.t5, n = lab.length;
    var vals = raw.map(function (b) { return b == null ? null : Math.round(pc * (1 + b / 1e4) * 1e4) / 1e4; });
    var fk = vals.findIndex(function (x) { return x != null; }); if (fk < 0) return null;
    var labels = lab.map(function (t, k) {
      if (v === 'today') return k > 0 && t.slice(3) === '00' ? clock(t) : '';
      return k > 0 && lab[k - 1].slice(0, 5) !== t.slice(0, 5) ? mdLabel(t.slice(0, 5)) : '';
    });
    var full = lab.map(function (t) { return v === 'today' ? clockFull(t) + ' ET' : mdLabel(t.slice(0, 5)) + ', ' + clockFull(t.slice(6)) + ' ET'; });
    return { vals: vals, labels: labels, full: full, pc: pc, first: vals[fk], firstLabel: full[fk] };
  }
  function kv(items) { return '<div class="kv">' + items.map(function (i) { return '<div><div class="k">' + esc(i[0]) + '</div><div class="v ' + (i[2] || '') + '">' + esc(i[1]) + '</div></div>'; }).join('') + '</div>'; }
  function mini(cols, rows) { return '<table class="mini"><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (i === 1 && cols.length > 4 ? ' class="l"' : '') + '>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>'; }
  function openSheet(sym) {
    var p = bySym(sym); if (!p) return;
    S.sel = sym; S.dv = p.dp == null || !(D.I && D.I.v[p.s]) ? (p.sp && p.sp.length > 1 ? '1y' : 'today') : 'today';
    renderSheet();
    $('#scrim').hidden = false; $('#sheet').hidden = false; document.body.classList.add('sheet-open');
    $('#sh-body').scrollTop = 0;
    renderSheetChart();
    $('#sh-close').focus({ preventScroll: true });
  }
  function closeSheet() { $('#scrim').hidden = true; $('#sheet').hidden = true; document.body.classList.remove('sheet-open'); killChart('sh-chart'); S.sel = ''; }
  function renderSheet() {
    var p = bySym(S.sel); if (!p) return closeSheet();
    var A = D.A && D.A[p.s], hold = D.H && D.H[p.via || p.s], cash = p.s === 'CASH', nav = p.dp == null && !cash;
    $('#sh-title').textContent = cash ? 'Cash' : p.s;
    $('#sh-sub').textContent = [p.n, p.c, X.ACCOUNTS.length > 1 ? (p.accts && p.accts.length > 1 ? p.accts.map(function (a) { return a[0]; }).join(' + ') : p.a) : null].filter(Boolean).join(' · ');
    var h = '';
    if (!cash) {
      var perShare = p.pc != null && p.px != null ? p.px - p.pc : null;
      h += '<div class="sh-price"><span class="p">' + esc(money(p.px, 2)) + '</span>' + (nav ? '<span class="c muted">NAV</span>' : '<span class="c ' + cls(perShare) + '">' + esc(smoney(perShare, 2) + ' (' + pct(p.dp, 2) + ')') + '</span>') + '</div>' +
        '<div class="sh-note">' + (nav ? 'Mutual fund: one price a day after the close, no intraday.' : 'Delayed · as of ' + esc(X.AS_OF)) + '</div>';
      var segs = [['today', 'Today'], ['5d', '5D'], ['1y', '1Y']].filter(function (s) { return s[0] === '1y' ? p.sp && p.sp.length > 1 : !nav && D.I && D.I.v[p.s]; });
      if (segs.length) h += '<div class="seg small" id="sh-seg">' + segs.map(function (s) { return '<button data-dv="' + s[0] + '" aria-pressed="' + (S.dv === s[0]) + '">' + s[1] + '</button>'; }).join('') + '</div><div class="chart" id="sh-chart" style="margin-top:10px"></div><div class="sh-note" id="sh-chart-note"></div>';
    }
    h += kv([
      ['Your position', money(p.mv)], ['Share of portfolio', apct(p.wt, 2)],
      ['Today', cash ? '–' : smoney(p.d), cls(p.d)], ['Gain since purchase', p.g == null ? '–' : smoney(p.g) + ' (' + pct(p.gp, 1) + ')', cls(p.g)]
    ].concat(cash ? [] : [['Quantity', p.q == null ? '–' : p.q.toLocaleString('en-US')], ['Cost basis', money(p.cb)]])
     .concat(p.accts && p.accts.length > 1 ? p.accts.map(function (a) { return [a[0], money(a[1])]; }) : []));
    if (!cash) {
      // analyst lights
      var lt = p.al ? { dot: dotOf(p.at), label: p.al + (p.mc === 'M' && p.stars ? '' : ''), d: A ? 'Score ' + A.mean.toFixed(2) + ' (1 = strong buy, 5 = strong sell), ' + A.n + ' analysts. Avg 12-mo target ' + money(A.tgt[0]) + ' (' + pct(A.up, 0) + ').' : p.am != null ? 'Score ' + p.am.toFixed(2) + ' (1 = strong buy, 5 = strong sell).' : p.stars ? p.stars + ' of 5 Morningstar stars.' : '' } : { dot: '', label: 'Not rated', d: '' };
      if (p.al === 'Not rated') lt.d = '';
      var stl = A && A.st ? { dot: dotOf(A.st.tone), label: A.st.label, d: 'Last 90 days: ' + A.st.up + ' up, ' + A.st.down + ' down; targets ' + A.st.ptRaised + ' raised, ' + A.st.ptCut + ' cut.' }
        : { dot: '', label: 'n/a', d: p.mc === 'S' ? 'No recent rating changes.' : 'Only tracked for individual stocks.' };
      h += '<h3>Analysts</h3><div class="lights">' +
        '<div class="light"><div class="k">Long-term view</div><div class="v"><span class="dot ' + lt.dot + '"></span>' + esc(lt.label) + '</div><div class="d">' + esc(lt.d) + '</div></div>' +
        '<div class="light"><div class="k">Short-term direction</div><div class="v"><span class="dot ' + stl.dot + '"></span>' + esc(stl.label) + '</div><div class="d">' + esc(stl.d) + '</div></div></div>' +
        '<p class="fine">' + esc(methodLong(p) + (p.cov != null ? ' The rated holdings are ' + apct(p.cov, 0) + ' of the fund.' : '')) + '</p>';
      if (A) {
        h += '<details class="src"><summary>Source data</summary><div>' +
          '<div class="mini-cap">Ratings by month</div>' + mini(['Month', 'Str buy', 'Buy', 'Hold', 'Sell', 'Str sell', 'Score'], A.tr.map(function (t, k) { return [k === 0 ? 'Now' : k + ' mo ago', t[0], t[1], t[2], t[3], t[4], '<span class="' + (t[5] < 2.5 ? 'up' : t[5] >= 3.5 ? 'down' : '') + '">' + t[5].toFixed(2) + '</span>']; })) +
          '<div class="mini-cap">Price targets: mean ' + esc(money(A.tgt[0], 2)) + ', median ' + esc(money(A.tgt[1])) + ', high ' + esc(money(A.tgt[2])) + ', low ' + esc(money(A.tgt[3])) + '</div>' +
          '<div class="mini-cap">Latest analyst actions</div>' + mini(['Date', 'Firm', 'Action', 'Rating', 'Target'], A.act.map(function (a) {
            var act = a[2] === 'up' ? '<span class="up">Upgrade</span>' : a[2] === 'down' ? '<span class="down">Downgrade</span>' : a[2] === 'init' ? 'Initiated' : a[2] === 'reit' ? 'Reiterated' : 'Maintained';
            return [esc(dlabel(String(a[0]), false)), esc(a[1]), act, esc(a[4] && a[4] !== a[3] ? a[4] + ' → ' + a[3] : a[3]), esc(a[5] == null ? '–' : (a[6] != null && a[6] !== a[5] ? money(a[6]) + ' → ' : '') + money(a[5]))];
          })) + '<div class="mini-cap">Source: Yahoo Finance analyst data (LSEG), pulled ' + esc(X.PULLED) + '.</div></div></details>';
      } else if (hold) {
        h += '<details class="src"><summary>Source data: holdings behind the rating</summary><div>' + mini(['Holding', 'Weight', 'Score', 'Analysts'], hold.map(function (x) { return [esc(x[0] + ' · ' + x[1]), esc(apct(x[2], 1)), '<span class="' + (x[3] < 2.5 ? 'up' : x[3] >= 3.5 ? 'down' : '') + '">' + x[3].toFixed(2) + ' ' + esc(recLabel(x[3])) + '</span>', x[4]]; })) +
          '<div class="mini-cap">Top 10 holdings' + (p.via ? ' of ' + esc(p.via) : '') + ', Yahoo Finance. Score: 1 = strong buy, 5 = strong sell.</div></div></details>';
      }
      // trend
      if (p.tr || (p.r && p.r.some(function (x) { return x != null; }))) {
        h += '<h3>Trend</h3>';
        if (p.last != null && p.m50 != null) {
          var rel = function (ma) { var r = p.last / ma - 1; return apct(r, 0) + (r < 0 ? ' below' : ' above'); };
          h += '<p class="para"><b>' + esc(p.tr || '') + '.</b> ' + esc('Price ' + money(p.last, 2) + ' is ' + rel(p.m50) + ' its 50-day average (' + money(p.m50, 2) + ')' + (p.m200 != null ? ' and ' + rel(p.m200) + ' its 200-day (' + money(p.m200, 2) + ').' : '; too new for a 200-day average.')) + '</p>';
        }
        if (p.r) h += '<div style="margin-top:10px">' + mini(['1M', '3M', '6M', 'YTD', '1Y'], [p.r.map(function (x) { return x == null ? '–' : '<span class="' + cls(x) + '">' + esc(pct(x, 1)) + '</span>'; })]) + '</div>';
      }
      var nn = X.NEWS.filter(function (n) { return n.sc === p.s || n.h.indexOf(p.s) >= 0; });
      if (nn.length) h += '<h3>News</h3><ul class="sh-news">' + nn.slice(0, 6).map(function (n) {
        var tone = newsTone(n), lab = tone === 'positive' ? 'Positive' : tone === 'negative' ? 'Negative' : 'Neutral';
        var dot = tone === 'positive' ? 'g' : tone === 'negative' ? 'r' : 'n';
        return '<li><div class="sh-nhead"><span class="dot ' + dot + '" aria-hidden="true"></span><span class="n-lab">' + lab + '</span> <b>' + esc(n.why) + '</b></div><div><a href="' + esc(n.u) + '" target="_blank" rel="noopener noreferrer">' + esc(n.t) + '</a></div><div class="m">' + esc(n.s + ' · ' + etTime(n.d)) + (n.sw ? ' · ' + esc(n.sw) : '') + '</div></li>';
      }).join('') + '</ul>';
    }
    $('#sh-body').innerHTML = h;
  }
  function renderSheetChart() {
    var el = $('#sh-chart'); if (!el || !S.sel) return;
    var p = bySym(S.sel); if (!p) return;
    $$('#sh-seg button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-dv') === S.dv)); });
    var note = $('#sh-chart-note');
    if (S.dv === '1y') {
      var n = p.sp.length, r = p.sp[n - 1] / p.sp[0] - 1, col = cssVar(r >= 0 ? '--line-pos' : '--line-neg');
      lineChart(el, { h: 190, labels: p.sp.map(function (_, k) { return k === Math.round((n - 1) / 2) && !p.inc ? '6 mo ago' : k === n - 1 ? 'Now' : ''; }),
        full: p.sp.map(function (_, k) { return k === n - 1 ? 'Now' : k === 0 && p.inc ? 'Launch' : 'About ' + Math.round((n - 1 - k) * 52 / (n - 1)) + ' weeks ago'; }),
        fmt: function (y) { return (+y).toFixed(0); }, series: [{ label: 'Index', values: p.sp, color: col, fill: col + '22' }] });
      note.textContent = 'Last year, weekly, start = 100' + (p.inc ? ' (since launch ' + p.inc + ')' : '') + '.';
      return;
    }
    var IV = intraView(p, S.dv); if (!IV) { killChart('sh-chart'); el.innerHTML = '<p class="fine">No intraday prices.</p>'; note.textContent = ''; return; }
    var last = IV.vals.filter(function (x) { return x != null; }).pop(), base = S.dv === 'today' ? IV.pc : IV.first;
    var col2 = cssVar(last >= base ? '--line-pos' : '--line-neg'), dec = Math.abs(p.px) >= 100 ? 0 : 2;
    lineChart(el, { h: 190, labels: IV.labels, full: IV.full, fmt: function (y) { return '$' + (+y).toFixed(dec === 0 && (Math.max.apply(null, IV.vals.filter(function (x) { return x != null; })) - Math.min.apply(null, IV.vals.filter(function (x) { return x != null; }))) < 5 ? 1 : dec); },
      tipFmt: function (y) { return money(y, 2); },
      series: [{ label: 'Price', values: IV.vals, color: col2, fill: col2 + '22' }, { label: 'Prev close', values: IV.vals.map(function () { return IV.pc; }), color: cssVar('--bench'), dash: [4, 4], width: 1.2 }] });
    note.textContent = S.dv === 'today'
      ? '5-minute bars from 9:30 AM ET; dashed line = previous close ' + money(IV.pc, 2) + '. Position impact today: ' + smoney(p.d) + '.'
      : 'Last 5 sessions, 30-minute bars. ' + smoney(last - IV.first, 2) + ' a share (' + pct(last / IV.first - 1, 2) + ') since ' + IV.firstLabel + '; position impact ' + smoney(p.q * (last - IV.first)) + '.';
  }

  // ---------- insights (precomputed by insights.py; targets editable per device) ----------
  var MONTHS_LONG = MON;
  function XS() { var x = D.X; return x ? (x.scopes[S.acct] || x.scopes.all) : null; }
  function more(key, n, lim) { return n > lim ? '<button class="more-btn" data-more="' + key + '">' + (S.more[key] ? 'Show less' : 'Show all ' + n) + '</button>' : ''; }
  function hbar(rows, opt) {
    // rows: [label, value$, frac, sub]
    opt = opt || {};
    var mx = Math.max.apply(null, rows.map(function (r) { return r[2] || 0; })) || 1;
    return '<div class="hbars">' + rows.map(function (r) {
      return '<div class="hb"' + (r[4] ? ' data-sym="' + esc(r[4]) + '" tabindex="0"' : '') + '><div class="hb-l"><span class="hb-name">' + esc(r[0]) + '</span>' + (r[3] ? '<span class="hb-sub">' + esc(r[3]) + '</span>' : '') + '</div>' +
        '<div class="hb-track"><span style="width:' + Math.max(1.5, (r[2] || 0) / mx * 100).toFixed(1) + '%"></span></div>' +
        '<div class="hb-v">' + esc(opt.pct === false ? short$(r[1]) : apct(r[2], 1)) + (opt.pct === false ? '' : '<small>' + esc(short$(r[1])) + '</small>') + '</div></div>';
    }).join('') + '</div>';
  }
  function tiles(list) { return '<div class="tiles">' + list.map(function (t) { return '<div class="tile"><div class="k">' + esc(t[0]) + '</div><div class="v ' + (t[2] || '') + '">' + esc(t[1]) + '</div>' + (t[3] ? '<div class="d">' + esc(t[3]) + '</div>' : '') + '</div>'; }).join('') + '</div>'; }

  // targets: device override in localStorage, else the build default (targets.json)
  var PRESETS = {
    conservative: { name: 'Conservative (~40/60 stocks/bonds)', t: { 'US stocks': 26, 'International stocks': 10, 'Real estate & MLPs': 2, 'Alternatives': 2, 'Taxable bonds & credit': 25, 'Municipal bonds': 22, 'T-bills & cash': 10, 'Gold & commodities': 3, 'Bitcoin': 0 } },
    balanced: { name: 'Balanced (~60/40)', t: { 'US stocks': 40, 'International stocks': 15, 'Real estate & MLPs': 3, 'Alternatives': 2, 'Taxable bonds & credit': 16, 'Municipal bonds': 14, 'T-bills & cash': 7, 'Gold & commodities': 3, 'Bitcoin': 0 } },
    growth: { name: 'Growth (~80/20)', t: { 'US stocks': 55, 'International stocks': 20, 'Real estate & MLPs': 3, 'Alternatives': 2, 'Taxable bonds & credit': 7, 'Municipal bonds': 6, 'T-bills & cash': 4, 'Gold & commodities': 2, 'Bitcoin': 1 } }
  };
  function allGroups() { // asset-class values across all accounts
    var g = {}, tot = 0; ALL.forEach(function (p) { g[p.c] = (g[p.c] || 0) + p.mv; tot += p.mv; });
    return { g: g, tot: tot };
  }
  function currentMix() {
    var a = allGroups(), raw = {}, fl = {}, rest = 100;
    Object.keys(a.g).forEach(function (k) { raw[k] = a.g[k] / a.tot * 100; fl[k] = Math.floor(raw[k]); rest -= fl[k]; });
    Object.keys(raw).sort(function (x, y) { return (raw[y] - fl[y]) - (raw[x] - fl[x]); }).slice(0, rest).forEach(function (k) { fl[k] += 1; });
    return fl;
  }
  function savedTargets() { try { var o = JSON.parse(LS.get('idash.targets') || 'null'); return o && o.t ? o : null; } catch (e) { return null; } }
  function activeTargets() {
    var s = savedTargets();
    if (s) return { t: s.t, label: s.label || 'Your targets', device: true, saved: s.saved };
    var b = D.X && D.X.targets;
    return { t: b ? b.targets : currentMix(), label: 'My current mix' + (b && b.source && /\d{4}-\d\d-\d\d/.test(b.source) ? ' (as of ' + dfull(b.source.match(/\d{4}-\d\d-\d\d/)[0]) + ')' : ''), device: false };
  }
  function band() { return (D.X && D.X.targets && D.X.targets.band) || 2; }
  function driftRows() {
    var a = allGroups(), T = activeTargets().t, keys = uniq(Object.keys(a.g).concat(Object.keys(T).filter(function (k) { return T[k] > 0; })));
    return keys.map(function (k) { var act = (a.g[k] || 0) / a.tot * 100, tg = +T[k] || 0; return { cls: k, actual: act, target: tg, drift: act - tg, usd: (tg - act) / 100 * a.tot }; })
      .sort(function (x, y) { return Math.max(y.actual, y.target) - Math.max(x.actual, x.target); });
  }
  function driftStatus() {
    var r = driftRows(), b = band(), off = r.filter(function (x) { return Math.abs(x.drift) > b; });
    if (!off.length) return { ok: true, text: 'Within targets', sub: 'All classes within ±' + b + ' pts' };
    var w = off.sort(function (x, y) { return Math.abs(y.drift) - Math.abs(x.drift); })[0];
    return { ok: false, text: off.length + ' class' + (off.length > 1 ? 'es' : '') + ' off target', sub: w.cls + ' ' + (w.drift > 0 ? '+' : '−') + Math.abs(w.drift).toFixed(1) + ' pts' };
  }
  function renderAlloc() {
    var el = $('#ins-alloc'), at = activeTargets(), rows = driftRows(), st = driftStatus(), b = band();
    if (S.editT) return renderTargetEditor();
    var mx = Math.max.apply(null, rows.map(function (r) { return Math.max(r.actual, r.target); })) || 1;
    var trade = rows.reduce(function (t, r) { return t + Math.max(0, r.usd); }, 0);
    el.innerHTML = '<div class="card-head"><h2>Allocation vs targets</h2><button class="link-btn" id="t-edit">Edit targets</button></div>' +
      '<div class="tbanner' + (st.ok ? '' : ' warn') + '"><b>' + esc(st.text) + '</b> · ' + esc(st.sub) + '<div class="fine" style="margin:4px 0 0">Targets: ' + esc(at.label) + (at.device ? ' · saved on this device only' : ' · the default until you set your own') + '</div></div>' +
      '<div class="drift">' + rows.map(function (r) {
        var off = Math.abs(r.drift) > b;
        return '<div class="dr"><div class="dr-top"><span class="dr-name">' + esc(r.cls) + '</span><span class="dr-nums"><b>' + r.actual.toFixed(1) + '%</b> <span class="muted">/ ' + r.target.toFixed(0) + '%</span> <span class="dr-d ' + (off ? (r.drift > 0 ? 'over' : 'under') : '') + '">' + (r.drift >= 0 ? '+' : '−') + Math.abs(r.drift).toFixed(1) + '</span></span></div>' +
          '<div class="dr-track"><span class="dr-fill' + (off ? ' off' : '') + '" style="width:' + (r.actual / mx * 100).toFixed(1) + '%"></span><span class="dr-mark" style="left:' + (r.target / mx * 100).toFixed(1) + '%"></span></div>' +
          (off ? '<div class="dr-usd">To match target: ' + esc((r.usd > 0 ? '+' : '−') + short$(Math.abs(r.usd)).replace('−', '')) + '</div>' : '') + '</div>';
      }).join('') + '</div>' +
      '<p class="fine">Bar = actual share of all accounts, tick = target. Drift is shown when a class is more than ±' + b + ' percentage points off. ' +
      (trade > 1 && !st.ok ? 'Moving about ' + esc(short$(trade)) + ' would bring every class to target. ' : '') + 'This is arithmetic, not a recommendation; trades can have tax costs.</p>';
  }
  function renderTargetEditor() {
    var el = $('#ins-alloc'), E = S.editT;
    var AG = allGroups().g, keys = uniq(Object.keys(AG).concat(Object.keys(E.t))).sort(function (a, b) { return (AG[b] || 0) - (AG[a] || 0); });
    var tot = keys.reduce(function (s, k) { return s + (+E.t[k] || 0); }, 0), ok = Math.abs(tot - 100) < 0.01;
    var presets = [['current', 'My current mix']].concat(Object.keys(PRESETS).map(function (k) { return [k, PRESETS[k].name]; }));
    el.innerHTML = '<div class="card-head"><h2>Edit targets</h2></div>' +
      '<div class="fine" style="margin-top:0">Start from a preset, then adjust. Presets are common examples, not recommendations. Saved on this device only.</div>' +
      '<div class="chips" id="t-presets">' + presets.map(function (p) { return '<button data-preset="' + p[0] + '" aria-pressed="' + (E.preset === p[0]) + '">' + esc(p[1]) + '</button>'; }).join('') + '</div>' +
      '<div class="ted">' + keys.map(function (k) {
        var v = +E.t[k] || 0;
        return '<div class="ted-row"><label for="tr-' + esc(k) + '">' + esc(k) + '</label><input type="range" min="0" max="100" step="1" value="' + v + '" data-tk="' + esc(k) + '" id="tr-' + esc(k) + '" aria-label="' + esc(k) + ' target">' +
          '<span class="ted-num"><input type="number" inputmode="decimal" min="0" max="100" step="0.5" value="' + v + '" data-tkn="' + esc(k) + '" aria-label="' + esc(k) + ' percent">%</span></div>';
      }).join('') + '</div>' +
      '<div class="ted-total ' + (ok ? 'ok' : 'bad') + '" id="t-total">Total ' + (+tot.toFixed(1)) + '%' + (ok ? ' ✓' : ' — must equal 100%') + '</div>' +
      '<div class="ted-btns"><button class="btn primary sm" id="t-save"' + (ok ? '' : ' disabled') + '>Save</button><button class="btn sm" id="t-cancel">Cancel</button><button class="btn sm ghost" id="t-reset">Reset to default</button></div>';
  }
  function updateEditorTotal() {
    var E = S.editT, tot = Object.keys(E.t).reduce(function (s, k) { return s + (+E.t[k] || 0); }, 0), ok = Math.abs(tot - 100) < 0.01;
    var t = $('#t-total'); t.className = 'ted-total ' + (ok ? 'ok' : 'bad'); t.textContent = 'Total ' + (+tot.toFixed(1)) + '%' + (ok ? ' ✓' : ' — must equal 100%');
    $('#t-save').disabled = !ok;
  }
  function presetTargets(k) {
    if (k === 'current') return currentMix();
    var t = Object.assign({}, PRESETS[k].t); Object.keys(allGroups().g).forEach(function (c) { if (!(c in t)) t[c] = 0; });
    return t;
  }

  function renderLT() {
    var x = XS(); if (!x) return;
    var lt = x.lt, open = S.more.comp ? 25 : 8;
    var mixBar = '<div class="mixbar">' + lt.mix.map(function (m, i) { return '<span class="mx mx' + i + '" style="width:' + (m[2] * 100).toFixed(2) + '%" title="' + esc(m[0]) + '"></span>'; }).join('') + '</div>' +
      '<div class="mixkey">' + lt.mix.map(function (m, i) { return '<span><i class="mx' + i + '"></i>' + esc(m[0]) + ' ' + apct(m[2], 0) + '</span>'; }).join('') + '</div>';
    $('#ins-lt').innerHTML = '<div class="card-head"><h2>What you own, underneath</h2><span class="card-sub">Funds opened up</span></div>' +
      '<h3 style="margin-top:8px">Underlying asset mix</h3>' + mixBar +
      '<h3>Top companies</h3>' + hbar(lt.companies.slice(0, open).map(function (c) { return [c[0], c[2], c[3], c[1] + (c[4].indexOf('direct') >= 0 ? ' · held directly' + (c[4].length > 1 ? ' + ' + (c[4].length - 1) + ' funds' : '') : ' · via ' + c[4].length + ' fund' + (c[4].length > 1 ? 's' : ''))]; })) +
      more('comp', lt.companies.length, 8) +
      '<p class="fine">% of your total portfolio. Funds report only their top 10 holdings, so this list sees ' + apct(lt.cov.companies, 0) + ' of your stock exposure (' + short$(lt.stock) + '); smaller positions inside funds are missing. Buffer ETFs are looked through to the index fund they track.</p>' +
      '<div class="grid2c"><div><h3>Sectors (stocks)</h3>' + hbar(lt.sectors.slice(0, S.more.sec ? 20 : 6).map(function (s) { return [s[0], s[1], s[2]]; })) + more('sec', lt.sectors.length, 6) +
      '<p class="fine">Share of the stock part. Uses each fund\'s full sector breakdown; covers ' + apct(lt.cov.sectors, 0) + ' of it.</p></div>' +
      '<div><h3>Regions (stocks)</h3>' + hbar(lt.regions.map(function (r) { return [r[0], r[1], r[2]]; })) + '<p class="fine">By each fund\'s category (country for single stocks), not country-by-country holdings.</p></div></div>';
  }
  function renderIncome() {
    var x = XS(); if (!x) return; var I = x.income;
    var mx = Math.max.apply(null, I.cal.map(function (c) { return c[1]; })) || 1;
    var lim = S.more.inc ? I.rows.length : 6;
    $('#ins-income').innerHTML = '<div class="card-head"><h2>Income</h2><span class="card-sub">Estimate</span></div>' +
      tiles([['Per year', '~' + short$(I.total), '', apct(I.yld, 2) + ' of value'], ['Per month, average', '~' + short$(I.total / 12), '', 'payouts are lumpy']]) +
      '<h3>Next 12 months, by month</h3><div class="cal">' + I.cal.map(function (c) { return '<div class="cal-m"><div class="cal-b"><span style="height:' + Math.max(2, c[1] / mx * 100).toFixed(1) + '%"></span></div><div class="cal-v">' + esc(c[1] >= 1000 ? Math.round(c[1] / 1000) + 'K' : c[1] ? Math.round(c[1]) : '–') + '</div><div class="cal-l">' + MONTHS_LONG[c[0] - 1].slice(0, 1) + '</div></div>'; }).join('') + '</div>' +
      '<h3>Biggest payers</h3>' + mini(['Holding', 'Per year', 'Yield', 'Payments'], I.rows.slice(0, lim).map(function (r) { return ['<a href="#" data-sym="' + esc(r[0]) + '">' + esc(r[0]) + '</a>', esc(short$(r[2])), esc(r[3] == null ? '–' : apct(r[3], 1)), r[5] === 'T12M' ? r[4] + '/yr' : 'yield est.']; })) + more('inc', I.rows.length, 6) +
      '<p class="fine">Estimate: each holding\'s distributions over the last 12 months × your current shares (Yahoo Finance), with the calendar assuming the same months repeat. Year-end special distributions inflate December. Not guaranteed; funds change payouts. ' +
      (I.zero.length ? I.zero.length + ' holdings paid nothing in the last year (gold, bitcoin, buffer ETFs and some stocks). ' : '') + (I.nodata.indexOf('CASH') >= 0 ? 'Interest on cash is not included (rate unknown). ' : '') + (I.unsched ? short$(I.unsched) + ' is estimated from fund yield because no payment history was found. ' : '') + 'Muni income may be federally tax-exempt.</p>';
  }
  function renderRisk() {
    var x = XS(), R = D.X && D.X.risk; if (!x || !R) return; var F = x.fees, lim = S.more.fee ? F.rows.length : 5;
    $('#ins-risk').innerHTML = '<div class="card-head"><h2>Risk &amp; fees</h2></div>' +
      tiles([['Beta vs S&P 500', R.beta == null ? '–' : R.beta.toFixed(2), '', R.beta == null ? '' : 'Moves ~' + Math.round(R.beta * 100) + '% as much as the S&P'],
             ['Volatility (1Y)', apct(R.vol, 1), '', 'S&P 500 ' + apct(R.spyVol, 1)],
             ['Worst drop (1Y)', pct(R.mdd, 1), 'down', dfull(R.mddFrom).replace(/, \d{4}/, '') + ' → ' + dfull(R.mddTo).replace(/, \d{4}/, '') + ' · S&P ' + pct(R.spyMdd, 1)],
             ['Return (1Y)', pct(R.ret1y, 1), cls(R.ret1y), 'S&P 500 ' + pct(R.spyRet1y, 1)]]) +
      '<p class="fine">From the 1-year backtest of today\'s holdings across all accounts (not your real history). Holdings-weighted beta from Yahoo (3-year fund betas): ' + (R.betaW == null ? '–' : R.betaW.toFixed(2)) + '.</p>' +
      '<h3>Fund fees</h3>' + tiles([['Per year', '~' + short$(F.total), '', 'paid inside fund prices'], ['Weighted expense ratio', F.wer == null ? '–' : apct(F.wer, 2), '', 'of ' + short$(F.coveredMv) + ' in funds']]) +
      mini(['Fund', 'Expense ratio', 'Per year'], F.rows.slice(0, lim).map(function (r) { return ['<a href="#" data-sym="' + esc(r[0]) + '">' + esc(r[0]) + '</a>', esc(apct(r[2], 2)), esc(money(r[3]))]; })) + more('fee', F.rows.length, 5) +
      '<p class="fine">Expense ratios from Yahoo Finance (net). Individual stocks and cash have no fund fee. ' + (F.missing.length ? 'No expense ratio found for: ' + esc(F.missing.join(', ')) + '.' : 'Every fund had an expense ratio.') + ' Trading commissions and advisory fees are not included.</p>';
  }
  function renderTax() {
    var x = XS(); if (!x) return; var T = x.tax, lim = S.more.tax ? T.candidates.length : 6, multi = X.ACCOUNTS.length > 1;
    $('#ins-tax').innerHTML = '<div class="card-head"><h2>Taxes</h2><span class="card-sub">Unrealized</span></div>' +
      tiles([['Unrealized gains', smoney(T.gains), 'up'], ['Unrealized losses', smoney(T.losses), 'down'], ['Net', smoney(T.net), cls(T.net)]]) +
      '<h3>Possible tax-loss harvesting candidates</h3>' +
      (T.candidates.length ? mini(['Holding', multi ? 'Account' : 'Cost', 'Loss', '%'], T.candidates.slice(0, lim).map(function (r) { return ['<a href="#" data-sym="' + esc(r[0]) + '">' + esc(r[0]) + '</a>', esc(multi ? r[2] : short$(r[3])), '<span class="down">' + esc(money(r[5])) + '</span>', esc(pct(r[6], 1))]; })) + more('tax', T.candidates.length, 6)
        : '<p class="muted">No holdings are more than $1,000 below cost.</p>') +
      '<p class="fine">Holdings at least $1,000 below cost. Selling one could realize a loss that offsets gains, and you could buy a similar (not substantially identical) fund to stay invested; buying the same fund within 30 days triggers the wash-sale rule. Only relevant in taxable accounts. The export has total cost basis only, no purchase dates or lots, so short- vs long-term can\'t be told here; your broker\'s lot detail (or a CPA) can. Not tax advice.</p>';
  }
  function renderGlance() {
    var x = XS(), el = $('#glance'); if (!x) { el.hidden = true; return; }
    var st = driftStatus(), R = D.X.risk;
    var t = [['ins-income', 'Income', '~' + short$(x.income.total) + '/yr', apct(x.income.yld, 1) + ' yield, est.'],
             ['ins-risk', 'Fund fees', '~' + short$(x.fees.total) + '/yr', x.fees.wer == null ? '' : apct(x.fees.wer, 2) + ' weighted'],
             ['ins-alloc', 'Allocation', st.text, savedTargets() ? st.sub : 'vs your current mix'],
             ['ins-risk', 'Risk', R && R.beta != null ? 'Beta ' + R.beta.toFixed(2) : '–', R ? 'Worst 1Y drop ' + pct(R.mdd, 1) : '']];
    el.innerHTML = t.map(function (g) { return '<button class="gl" data-jump="' + g[0] + '"><span class="k">' + esc(g[1]) + '</span><span class="v">' + esc(g[2]) + '</span><span class="d">' + esc(g[3]) + '</span></button>'; }).join('');
  }
  function renderInsights() {
    if (!D.X) { $('#ins-scope').textContent = 'Insights are not in this build yet.'; return; }
    $('#ins-scope').textContent = (S.acct === 'all' ? (X.ACCOUNTS.length > 1 ? 'All accounts. ' : '') : S.acct + ' only for look-through, income, fees and taxes; allocation and risk always use all accounts. ') + 'Prices as of ' + X.AS_OF + '.';
    renderAlloc(); renderLT(); renderIncome(); renderRisk(); renderTax();
  }
  function bindInsights() {
    var root = $('#v-insights');
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('#t-edit')) { var at = activeTargets(); S.editT = { preset: at.device ? (savedTargets().preset || '') : 'current', t: Object.assign({}, at.t) }; renderAlloc(); return; }
      var pr = t.closest('[data-preset]'); if (pr) { S.editT = { preset: pr.getAttribute('data-preset'), t: presetTargets(pr.getAttribute('data-preset')) }; renderAlloc(); return; }
      if (t.closest('#t-cancel')) { S.editT = null; renderAlloc(); return; }
      if (t.closest('#t-reset')) { LS.del('idash.targets'); S.editT = null; renderAlloc(); renderGlance(); return; }
      if (t.closest('#t-save')) {
        var E = S.editT, clean = {}; Object.keys(E.t).forEach(function (k) { clean[k] = +E.t[k] || 0; });
        var name = E.preset && E.preset !== 'current' ? PRESETS[E.preset].name + (E.edited ? ', adjusted' : '') : E.preset === 'current' && !E.edited ? 'My current mix (' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ')' : 'Your targets';
        LS.set('idash.targets', JSON.stringify({ t: clean, preset: E.preset, label: name, saved: new Date().toISOString() }));
        S.editT = null; renderAlloc(); renderGlance(); return;
      }
    });
    root.addEventListener('input', function (e) {
      var k = e.target.getAttribute('data-tk') || e.target.getAttribute('data-tkn'); if (!k || !S.editT) return;
      var v = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
      S.editT.t[k] = v; S.editT.edited = true;
      var other = e.target.hasAttribute('data-tk') ? root.querySelector('[data-tkn="' + CSS.escape(k) + '"]') : root.querySelector('[data-tk="' + CSS.escape(k) + '"]');
      if (other) other.value = v;
      updateEditorTotal();
    });
  }

  // ---------- Lookup: any ticker(s), fetched from the browser at view time ----------
  // Source: CNBC's public quote + chart feeds (CORS-enabled, keyless, unofficial). Only the symbols typed here,
  // plus the S&P 500 when the overlay is on, are sent. Holdings never leave the device.
  var LKQ = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?requestMethod=itv&noform=0&partnerId=2&fund=1&exthrs=1&output=json&events=1&symbols=';
  var LKC = 'https://ts-api.cnbc.com/harmony/app/charts/';
  var LK_SPX = '.SPX';
  var LK_ALIAS = { '^GSPC': '.SPX', 'SPX': '.SPX', 'S&P': '.SPX', 'S&P500': '.SPX', '^DJI': '.DJI', 'DJI': '.DJI', 'DJIA': '.DJI', '^IXIC': '.IXIC', 'COMP': '.IXIC', '^RUT': '.RUT', 'RUT': '.RUT', '^VIX': '.VIX', 'VIX': '.VIX' };
  var LK_RANGES = [['1D', '1D', '1-minute'], ['5D', '5D', '5-minute'], ['1M', '1M', 'daily'], ['6M', '1M', 'daily'], ['YTD', '1M', 'daily'], ['1Y', '1M', 'daily'], ['5Y', '5Y', 'weekly'], ['Max', 'ALL', 'monthly']];
  var LK_COLORS = ['--accent', '#ff9f0a', '#bf5af2', '#64d2ff', '#ff375f', '#30b0c7', '#ac8e68', '#5e5ce6'];
  var LK = { syms: [], focus: null, range: LS.get('idash.lk.range') || '1D', mode: LS.get('idash.lk.mode') || 'line', spx: LS.get('idash.lk.spx') === '1', quotes: {}, bars: {}, updated: null, err: '', busy: false, seq: 0 };
  var lnum = function (v) { if (v == null || v === '') return null; var x = parseFloat(String(v).replace(/[,%+$]/g, '')); return isFinite(x) ? x : null; };
  function lkParse(q) {
    return uniq(String(q || '').split(/[,\s;]+/).map(function (s) {
      s = s.trim().toUpperCase().replace(/^\$/, ''); if (!s) return null;
      if (LK_ALIAS[s]) return LK_ALIAS[s];
      s = s.replace(/-/g, '.');
      return /^[A-Z0-9.^=]{1,15}$/.test(s) ? s : null;
    }).filter(Boolean)).slice(0, 8);
  }
  function lkName(s) { return s === LK_SPX ? 'S&P 500' : s; }
  async function lkFetchJSON(url) {
    var ctl = window.AbortController ? new AbortController() : null, t = ctl && setTimeout(function () { ctl.abort(); }, 15000);
    try { var r = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl && ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { if (t) clearTimeout(t); }
  }
  async function lkQuotes(syms) {
    var d = await lkFetchJSON(LKQ + syms.map(encodeURIComponent).join('|'));
    var out = {};
    ((d.FormattedQuoteResult || {}).FormattedQuote || []).forEach(function (q) {
      if (!q || !q.symbol) return;
      out[q.symbol] = q.code === 0 && q.last != null ? {
        ok: true, name: q.name, last: lnum(q.last), chg: lnum(q.change), pct: lnum(q.change_pct) / 100, prev: lnum(q.previous_day_closing),
        open: lnum(q.open), high: lnum(q.high), low: lnum(q.low), time: q.last_time, status: q.curmktstatus, ext: q.ExtendedMktQuote, cur: q.currencyCode
      } : { ok: false };
    });
    return out;
  }
  async function lkBars(sym, ep) {
    var d = await lkFetchJSON(LKC + ep + '.json?symbol=' + encodeURIComponent(sym));
    var bd = d.barData || {}, ex = bd.exchange;
    var bars = (bd.priceBars || []).map(function (b) { return { k: String(b.tradeTime).slice(0, 12), o: lnum(b.open), h: lnum(b.high), l: lnum(b.low), c: lnum(b.close) }; }).filter(function (b) { return b.c != null; });
    return { bars: bars, hours: ex && ex.exchangeOpenTime ? [ex.exchangeOpenTime.replace(/:/g, '').slice(0, 4), ex.exchangeCloseTime.replace(/:/g, '').slice(0, 4)] : (sym.charAt(0) === '.' ? ['0930', '1600'] : null) };
  }
  // Cut the feed's (generous) history down to the chosen range; add today's bar to daily ranges from the quote.
  function lkSlice(sym, raw, range, q) {
    var b = raw.bars.slice(); if (!b.length) return b;
    var intraday = range === '1D' || range === '5D';
    if (intraday) {
      if (raw.hours) b = b.filter(function (x) { var hm = x.k.slice(8, 12); return hm >= raw.hours[0] && hm < raw.hours[1]; });
      var days = uniq(b.map(function (x) { return x.k.slice(0, 8); })).sort(), keep = days.slice(range === '1D' ? -1 : -5);
      return b.filter(function (x) { return keep.indexOf(x.k.slice(0, 8)) >= 0; });
    }
    var lastDay = b[b.length - 1].k.slice(0, 8);
    if ((range !== '5Y' && range !== 'Max') && q && q.ok && q.time && q.open) {
      var qd = String(q.time).slice(0, 10).replace(/-/g, '');
      if (qd > lastDay) b.push({ k: qd + '0000', o: q.open, h: q.high || q.last, l: q.low || q.last, c: q.last, live: true });
    }
    var end = b[b.length - 1].k.slice(0, 8), y = +end.slice(0, 4), m = +end.slice(4, 6), dd = end.slice(6, 8), cut;
    var back = function (months) { var t = y * 12 + (m - 1) - months; return String(Math.floor(t / 12)) + ('0' + (t % 12 + 1)).slice(-2) + dd; };
    if (range === '1M') cut = back(1); else if (range === '6M') cut = back(6); else if (range === '1Y') cut = back(12); else if (range === 'YTD') cut = y + '0101'; else if (range === '5Y') cut = back(60); else cut = '0';
    return b.filter(function (x) { return x.k.slice(0, 8) >= cut; });
  }
  async function lkLoad(force) {
    if (!LK.syms.length) return;
    var my = ++LK.seq, ep = LK_RANGES.find(function (r) { return r[0] === LK.range; })[1];
    var want = LK.syms.slice(); if (LK.spx && want.indexOf(LK_SPX) < 0) want.push(LK_SPX);
    LK.busy = true; lkStatus();
    try {
      var q = await lkQuotes(want);
      var res = await Promise.all(want.map(function (s) { return q[s] && q[s].ok === false ? Promise.resolve(null) : lkBars(s, ep).catch(function () { return null; }); }));
      if (my !== LK.seq) return;
      LK.quotes = q; LK.bars = {};
      want.forEach(function (s, i) { if (res[i]) LK.bars[s] = lkSlice(s, res[i], LK.range, q[s]); });
      LK.updated = new Date(); LK.err = '';
    } catch (e) {
      if (my !== LK.seq) return;
      LK.err = 'Could not reach the quote service (' + (e.name === 'AbortError' ? 'timed out' : e.message) + '). Showing the last data.';
    }
    LK.busy = false; renderLookup();
  }
  function lkStatus() {
    var el = $('#lk-status'); if (!el) return;
    var t = LK.updated ? LK.updated.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' ET' : '–';
    el.innerHTML = (LK.err ? '<span class="down">' + esc(LK.err) + '</span> ' : '') + (LK.busy ? 'Updating… ' : '') + 'Updated ' + esc(t) + ' · refreshes every 60 s while this tab is open · quotes may be delayed';
  }
  function lkSubmit(q) {
    var syms = lkParse(q); if (!syms.length) { $('#lk-msg').textContent = 'Type one or more ticker symbols, separated by commas.'; return; }
    $('#lk-msg').textContent = '';
    LK.syms = syms; LK.focus = syms.length === 1 ? syms[0] : null; LK.quotes = {}; LK.bars = {};
    var label = syms.map(lkName).join(', '), rec = [label].concat(lkRecent().filter(function (r) { return r !== label; })).slice(0, 8);
    LS.set('idash.lookups', JSON.stringify(rec)); $('#lk-q').value = label;
    renderLookup(); lkLoad(true);
  }
  function lkRecent() { try { var r = JSON.parse(LS.get('idash.lookups') || '[]'); return Array.isArray(r) ? r.filter(function (x) { return typeof x === 'string'; }) : []; } catch (e) { return []; } }
  function lkColor(i) { var c = LK_COLORS[i % LK_COLORS.length]; return c.charAt(0) === '-' ? cssVar(c) : c; }
  function renderLookup() {
    $('#lk-recent').innerHTML = lkRecent().map(function (r) { return '<button data-lkq="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + (lkRecent().length ? '<button class="ghost" data-lkclear="1" aria-label="Clear recent lookups">Clear</button>' : '');
    $$('#lk-range button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lkr') === LK.range)); });
    var compare = LK.syms.length > 1 && !LK.focus, pctMode = compare || LK.spx;
    $$('#lk-mode button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lkm') === (pctMode ? 'line' : LK.mode))); b.disabled = pctMode && b.getAttribute('data-lkm') === 'candle'; });
    $('#lk-spx').setAttribute('aria-pressed', String(LK.spx));
    $('#lk-empty').hidden = !!LK.syms.length; $('#lk-main').hidden = !LK.syms.length;
    if (!LK.syms.length) { lkStatus(); return; }
    // quote cards
    $('#lk-cards').innerHTML = (LK.syms.length > 1 ? '<button class="lk-card all" data-lkf="" aria-pressed="' + compare + '"><span class="lk-sym">Compare</span><span class="lk-name">' + LK.syms.length + ' symbols, % change</span></button>' : '') +
      LK.syms.map(function (s, i) {
        var q = LK.quotes[s], own = ALL.filter(function (p) { return p.s === s; }), ownMv = sum(own, function (p) { return p.mv; });
        var body = !q ? '<span class="lk-name">Loading…</span>' : !q.ok ? '<span class="lk-name down">Symbol not found</span>' :
          '<span class="lk-name">' + esc(q.name || '') + '</span><span class="lk-px">' + esc(q.last == null ? '–' : q.last.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + '</span>' +
          '<span class="lk-chg ' + cls(q.chg) + '">' + esc(smoney(q.chg, 2).replace('$', '') + ' (' + pct(q.pct, 2) + ')') + '</span>' +
          (q.ext && q.status !== 'REG_MKT' && q.ext.last ? '<span class="lk-ext">' + esc((q.ext.type === 'POST_MKT' ? 'After hours ' : 'Pre-market ') + q.ext.last + ' (' + q.ext.change_pct + ')') + '</span>' : '') +
          (own.length ? '<span class="lk-own">You own ' + esc(short$(ownMv)) + '</span>' : '');
        return '<button class="lk-card" data-lkf="' + esc(s) + '" aria-pressed="' + (LK.focus === s) + '"><span class="lk-sym"><i style="background:' + lkColor(i) + '"></i>' + esc(lkName(s)) + '</span>' + body + '</button>';
      }).join('');
    $('#lk-title').textContent = compare ? 'Compare' : lkName(LK.focus || LK.syms[0]);
    lkChart(compare, pctMode);
    lkStatus();
  }
  function lkChart(compare, pctMode) {
    var el = $('#lk-chart'), shown = compare ? LK.syms.slice() : [LK.focus || LK.syms[0]];
    if (LK.spx && shown.indexOf(LK_SPX) < 0) shown.push(LK_SPX);
    var have = shown.filter(function (s) { return LK.bars[s] && LK.bars[s].length; });
    if (!have.length) { killChart('lk-chart'); el.innerHTML = '<p class="fine" style="padding:40px 0;text-align:center">' + (LK.busy || !LK.updated ? 'Loading chart…' : 'No chart data for this range.') + '</p>'; $('#lk-sum').innerHTML = ''; return; }
    var keys = uniq([].concat.apply([], have.map(function (s) { return LK.bars[s].map(function (b) { return b.k; }); }))).sort(), n = keys.length;
    var idx = {}; keys.forEach(function (k, i) { idx[k] = i; });
    var col = function (s, f) { var a = new Array(n).fill(null); LK.bars[s].forEach(function (b) { a[idx[b.k]] = f(b); }); return a; };
    var intra = LK.range === '1D' || LK.range === '5D', longR = LK.range === '5Y' || LK.range === 'Max';
    var lab = function (k) { var y = k.slice(0, 4), m = +k.slice(4, 6), d = +k.slice(6, 8), hm = k.slice(8, 10) + ':' + k.slice(10, 12); return { md: MON[m - 1] + ' ' + d, y: y, hm: hm }; };
    var labels = keys.map(function (k, i) {
      var L = lab(k), P = i ? lab(keys[i - 1]) : null; if (!i) return '';
      if (LK.range === '1D') return k.slice(10, 12) === '00' ? clock(L.hm) : '';
      if (LK.range === '5D') return P.md !== L.md ? L.md : '';
      if (longR) return P.y !== L.y ? L.y : '';
      return k.slice(4, 6) !== keys[i - 1].slice(4, 6) ? (LK.range === '1M' ? L.md : MON[+k.slice(4, 6) - 1] + (k.slice(4, 6) === '01' ? " '" + L.y.slice(2) : '')) : (LK.range === '1M' && i % 5 === 0 ? L.md : '');
    });
    var full = keys.map(function (k) { var L = lab(k); return intra ? L.md + ', ' + clockFull(L.hm) + ' ET' : LK.range === 'Max' ? MON[+k.slice(4, 6) - 1] + ' ' + L.y : L.md + ', ' + L.y + (LK.range === '5Y' ? ' (week)' : ''); });
    var sumParts = [];
    if (pctMode) {
      var series = have.map(function (s) {
        var c = col(s, function (b) { return b.c; }), qq = LK.quotes[s], base = LK.range === '1D' && qq && qq.prev ? qq.prev : c.find(function (v) { return v != null; });
        var i0 = LK.syms.indexOf(s), color = s === LK_SPX && LK.syms.indexOf(s) < 0 ? cssVar('--bench') : lkColor(i0 < 0 ? 0 : i0);
        var vals = c.map(function (v) { return v == null ? null : (v / base - 1) * 100; }), last = vals.filter(function (v) { return v != null; }).pop();
        sumParts.push('<span><span class="key" style="background:' + color + '"></span><b class="' + cls(last) + '">' + esc((last > 0 ? '+' : '') + last.toFixed(2) + '%') + '</b>' + esc(lkName(s)) + '</span>');
        return { label: lkName(s), values: vals, color: color, width: s === LK_SPX && LK.syms.indexOf(s) < 0 ? 1.5 : 2, dash: s === LK_SPX && LK.syms.indexOf(s) < 0 ? [4, 4] : null, spanGaps: true };
      });
      lineChart(el, { h: 300, labels: labels, full: full, series: series, fmt: function (y) { return (y > 0 ? '+' : '') + (+y).toFixed(Math.abs(y) < 10 ? 1 : 0) + '%'; }, tipFmt: function (y) { return (y > 0 ? '+' : '') + (+y).toFixed(2) + '%'; } });
    } else {
      var s0 = have[0], C = col(s0, function (b) { return b.c; }), first = C.find(function (v) { return v != null; }), lastv = C.filter(function (v) { return v != null; }).pop();
      var q = LK.quotes[s0], base = LK.range === '1D' && q && q.prev ? q.prev : first, ch = lastv - base, color = cssVar(ch >= 0 ? '--line-pos' : '--line-neg');
      var dec = Math.abs(lastv) >= 1000 ? 0 : 2, f = function (y) { return (+y).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); };
      sumParts.push('<span><b class="' + cls(ch) + '">' + esc((ch >= 0 ? '+' : '−') + Math.abs(ch).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' (' + pct(ch / base, 2) + ')') + '</b>' + esc(LK.range === '1D' ? 'vs previous close' : 'over ' + (LK.range === 'Max' ? 'all available history' : LK.range)) + '</span>');
      if (LK.mode === 'candle') {
        var O = col(s0, function (b) { return b.o; }), H = col(s0, function (b) { return b.h; }), Lw = col(s0, function (b) { return b.l; });
        lineChart(el, { h: 300, labels: labels, full: full, fmt: f, candles: { o: O, h: H, l: Lw, c: C },
          tip: function (i) { return C[i] == null ? '' : '<div>O ' + esc(f(O[i])) + ' · H ' + esc(f(H[i])) + '</div><div>L ' + esc(f(Lw[i])) + ' · C ' + esc(f(C[i])) + '</div>'; },
          series: [{ label: 'High', values: H, color: 'transparent', width: 0, noTip: true }, { label: 'Low', values: Lw, color: 'transparent', width: 0, noTip: true }, { label: 'Close', values: C, color: 'transparent', width: 0 }] });
      } else {
        var ser = [{ label: lkName(s0), values: C, color: color, fill: color + '22', spanGaps: true }];
        if (LK.range === '1D' && q && q.prev) ser.push({ label: 'Prev close', values: C.map(function () { return q.prev; }), color: cssVar('--bench'), dash: [4, 4], width: 1.2 });
        lineChart(el, { h: 300, labels: labels, full: full, fmt: f, tipFmt: f, series: ser });
      }
    }
    var intr = LK_RANGES.find(function (r) { return r[0] === LK.range; })[2];
    $('#lk-sum').innerHTML = sumParts.join('') + '<span class="muted">' + esc(intr + ' bars' + (intra ? ', regular hours' : '') + (pctMode ? (LK.range === '1D' ? ' · % change from the previous close' : ' · % change from the start of the range') : '')) + '</span>';
  }
  function bindLookup() {
    $('#lk-form').addEventListener('submit', function (e) { e.preventDefault(); $('#lk-q').blur(); lkSubmit($('#lk-q').value); });
    $('#v-lookup').addEventListener('click', function (e) {
      var t = e.target, b;
      if ((b = t.closest('[data-lkq]'))) { lkSubmit(b.getAttribute('data-lkq')); return; }
      if (t.closest('[data-lkclear]')) { LS.del('idash.lookups'); renderLookup(); return; }
      if ((b = t.closest('[data-lkr]'))) { LK.range = b.getAttribute('data-lkr'); LS.set('idash.lk.range', LK.range); renderLookup(); lkLoad(); return; }
      if ((b = t.closest('[data-lkm]'))) { if (b.disabled) return; LK.mode = b.getAttribute('data-lkm'); LS.set('idash.lk.mode', LK.mode); renderLookup(); return; }
      if (t.closest('#lk-spx')) { LK.spx = !LK.spx; LS.set('idash.lk.spx', LK.spx ? '1' : '0'); renderLookup(); if (LK.spx && !LK.bars[LK_SPX]) lkLoad(); return; }
      if ((b = t.closest('[data-lkf]'))) { LK.focus = b.getAttribute('data-lkf') || null; renderLookup(); return; }
    });
    setInterval(function () { if (S.tab === 'lookup' && !document.hidden && LK.syms.length && !LK.busy) lkLoad(); }, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && S.tab === 'lookup' && LK.syms.length && (!LK.updated || Date.now() - LK.updated > 55000)) lkLoad(); });
  }

  // ---------- tabs, events ----------
  function setTab(t, push) {
    S.tab = t;
    $$('.view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== t; });
    $$('[data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (push !== false && location.hash !== '#' + t) history.replaceState(null, '', t === 'overview' ? location.pathname : '#' + t);
    if (t === 'overview') renderPerf();
    if (t === 'lookup') { renderLookup(); if (LK.syms.length && (!LK.updated || Date.now() - LK.updated > 55000)) lkLoad(); }
    window.scrollTo(0, 0);
  }
  function renderAll() {
    renderHero(); renderAttention(); renderPerf(); renderGlance(); renderGroups(); renderAbout(); renderHoldings(); renderInsights(); renderNews();
    if (S.sel && !$('#sheet').hidden) { renderSheet(); renderSheetChart(); }
  }
  function setupAccounts() {
    var sel = $('#acct');
    sel.innerHTML = '<option value="all">All accounts</option>' + X.ACCOUNTS.map(function (a) { return '<option value="' + esc(a) + '">' + esc(a) + '</option>'; }).join('');
    sel.value = S.acct; $('#acct-wrap').hidden = false;
  }
  function bindEvents() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      var tab = t.closest('[data-tab]'); if (tab) { setTab(tab.getAttribute('data-tab')); return; }
      var jp = t.closest('[data-jump]'); if (jp) { var id = jp.getAttribute('data-jump'); if (S.tab !== 'insights') setTab('insights'); var target = document.getElementById(id); if (target) target.scrollIntoView({ behavior: S.tab === 'insights' && jp.closest('#ins-jump') ? 'smooth' : 'auto', block: 'start' }); return; }
      var mo = t.closest('[data-more]'); if (mo) { var mk = mo.getAttribute('data-more'); S.more[mk] = !S.more[mk]; renderInsights(); return; }
      var src = t.closest('[data-src]'); if (src) { S.src = src.getAttribute('data-src'); renderPerf(); return; }
      var per = t.closest('[data-period]'); if (per) { S.period = per.getAttribute('data-period'); renderPerf(); return; }
      var dv = t.closest('[data-dv]'); if (dv) { S.dv = dv.getAttribute('data-dv'); renderSheetChart(); return; }
      var grp = t.closest('[data-grp]'); if (grp) { var g = grp.getAttribute('data-grp'); S.open[g] = !S.open[g]; renderGroups(); return; }
      var f = t.closest('[data-flt]'); if (f) { S.flt = f.getAttribute('data-flt'); renderHoldings(); return; }
      var ntone = t.closest('[data-ntone]'); if (ntone) { S.tone = ntone.getAttribute('data-ntone'); renderNews(); return; }
      var nbtn = t.closest('.n-tone'); if (nbtn) { var item = nbtn.closest('.n-item'); if (item) { item.classList.toggle('open'); nbtn.setAttribute('aria-expanded', item.classList.contains('open') ? 'true' : 'false'); } return; }
      var nw = t.closest('[data-news]'); if (nw) { S.news = nw.getAttribute('data-news'); renderNews(); return; }
      var th = t.closest('th[data-sort]'); if (th) { sortBy(th.getAttribute('data-sort')); return; }
      var go = t.closest('[data-go]'); if (go && !t.closest('a')) {
        var k = go.getAttribute('data-go');
        if (k === 'news' || k === 'news-negative') { if (k === 'news-negative') S.tone = 'negative'; setTab('news'); return; }
        S.flt = k === 'downtrend' ? 'downtrend' : 'all'; if (k !== 'downtrend') { S.sortKey = 'd'; S.asc = true; } renderHoldings(); setTab('holdings'); return;
      }
      var sym = t.closest('[data-sym]'); if (sym && sym.tagName === 'A') e.preventDefault();
      if (sym && (!t.closest('a') || sym.tagName === 'A')) { openSheet(sym.getAttribute('data-sym')); return; }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); return; }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var el = e.target; if (!el.closest || el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
      var th = el.closest('th[data-sort]'); if (th) { e.preventDefault(); sortBy(th.getAttribute('data-sort')); return; }
      if (el.closest('[data-sym],[data-go]')) { e.preventDefault(); el.click(); }
    });
    $('#scrim').addEventListener('click', closeSheet);
    $('#sh-close').addEventListener('click', closeSheet);
    // swipe the sheet down to close (iPhone)
    var y0 = null, sheet = $('#sheet');
    sheet.addEventListener('touchstart', function (e) { y0 = $('#sh-body').scrollTop <= 0 || e.target.closest('.sheet-head,.sheet-grab') ? e.touches[0].clientY : null; }, { passive: true });
    sheet.addEventListener('touchmove', function (e) { if (y0 == null) return; var dy = e.touches[0].clientY - y0; if (dy > 0) sheet.style.transform = 'translateY(' + dy + 'px)'; }, { passive: true });
    sheet.addEventListener('touchend', function (e) { if (y0 == null) return; var dy = (e.changedTouches[0].clientY - y0); sheet.style.transform = ''; y0 = null; if (dy > 110) closeSheet(); });
    $('#acct').addEventListener('change', function (e) { S.acct = e.target.value; if (S.acct === 'all') LS.del('idash.acct'); else LS.set('idash.acct', S.acct); scope(); renderAll(); });
    $('#q').addEventListener('input', function (e) { S.q = e.target.value; renderHoldings(); });
    $('#f-cls').addEventListener('change', function (e) { S.cls = e.target.value; renderHoldings(); });
    $('#f-sort').addEventListener('change', function (e) { S.sortKey = e.target.value; S.asc = S.sortKey === 's'; renderHoldings(); });
    window.addEventListener('hashchange', function () { var h = location.hash.slice(1); setTab(['holdings', 'insights', 'lookup', 'news'].indexOf(h) >= 0 ? h : 'overview', false); });
  }
  function sortBy(k) { if (S.sortKey === k) S.asc = !S.asc; else { S.sortKey = k; S.asc = k === 's'; } renderHoldings(); }

  var started = false;
  function start(data) {
    prepare(data);
    $('#lock').hidden = true; $('#app').hidden = false; $('#lock-btn').hidden = false; $('#tabs').hidden = false; $('#tabbar').hidden = false;
    setupAccounts();
    if (!started) {
      bindEvents(); bindInsights(); bindLookup(); renderLookup(); started = true;
      var h = location.hash.slice(1); setTab(['holdings', 'insights', 'lookup', 'news'].indexOf(h) >= 0 ? h : 'overview', false);
    }
    renderAll();
  }

  // Re-check for fresh data every 5 minutes while visible (the refresh routine redeploys every 30).
  async function poll() {
    if (!KEY || document.hidden) return;
    try { var enc = await fetchEnc(); if (enc.iv === ENC.iv) return; if (enc.salt !== ENC.salt) return lock(); var d = await decrypt(enc, KEY); ENC = enc; start(d); } catch (e) { /* keep showing current data */ }
  }
  function lock() { LS.del('idash.key'); KEY = null; location.reload(); }

  async function boot() {
    setupThemeMenu();
    $('#lock-btn').addEventListener('click', lock);
    var err = $('#lock-err');
    if (!window.crypto || !crypto.subtle) { err.textContent = 'This browser cannot decrypt the data (needs HTTPS and a current browser).'; return; }
    try { ENC = await fetchEnc(); } catch (e) { err.textContent = e.message; return; }
    var k = await storedKey(ENC);
    if (k) { try { var d0 = await decrypt(ENC, k); KEY = k; start(d0); } catch (e) { LS.del('idash.key'); } }
    $('#lock-form').addEventListener('submit', async function (e) {
      e.preventDefault(); err.textContent = '';
      var btn = $('#unlock-btn'); btn.disabled = true; btn.textContent = 'Unlocking…';
      try {
        var key = await deriveKey($('#pw').value, ENC); var d = await decrypt(ENC, key);
        KEY = key; if ($('#remember').checked) await remember(key, ENC);
        $('#pw').value = ''; start(d);
      } catch (ex) { err.textContent = 'Wrong password.'; }
      btn.disabled = false; btn.textContent = 'Unlock';
    });
    setInterval(poll, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  }
  boot();
})();
