// LabReview demo UI. All data synthetic. Every user/LIS string is escaped before rendering.
// Flow: instrument → LIS → system reads the report and highlights what looks wrong (suggestion only)
//       → doctor reads, then Ký / Cần xem xét lại / Yêu cầu chạy lại mẫu
//       → signed reports go to a background FIFO queue for the hospital signing system; the doctor moves on at once.
import { describeRule, outcomeBadge, OUTCOME } from './rules-view.js';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = iso => iso ? new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—';
const fmtHour = iso => iso ? new Date(iso).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';
const pct = (v, d = 1) => v == null ? '—' : (v * 100).toFixed(d).replace('.', ',') + '%';
const num = (v, d = 3) => v == null ? '—' : Number(v).toFixed(d).replace('.', ',');
const val = v => typeof v === 'number' ? String(v).replace('.', ',') : esc(v);

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Lỗi ${res.status}`);
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

let toastTimer;
function toast(msg, kind = '') { const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 4500); }

// System output is a SUGGESTION, worded for the doctor.
const DECISION = {
  AUTO_APPROVE_ELIGIBLE: { label: 'Không thấy bất thường', short: 'Bình thường', cls: 'auto', icon: '✓' },
  MANUAL_REVIEW: { label: 'Có điểm cần chú ý', short: 'Cần chú ý', cls: 'review', icon: '!' },
  BLOCKED: { label: 'Chưa nên ký', short: 'Chưa nên ký', cls: 'blocked', icon: '■' }
};
const badge = (d, short = false) => { const x = DECISION[d]; return `<span class="badge ${x.cls}"><span aria-hidden="true">${x.icon}</span>${short ? x.short : x.label}</span>`; };
const WORK = {
  PENDING: ['neutral', 'Chờ duyệt'], SIGN_FAILED: ['blocked', 'Ký lỗi'], IN_QUEUE: ['info', 'Đang chờ ký'], SIGNED: ['auto', 'Đã ký'],
  FLAGGED: ['review', 'Cần xem xét lại'], RERUN_REQUESTED: ['info', 'Chờ chạy lại']
};
const TABS = [
  ['todo', 'Chờ duyệt', w => w.workState === 'PENDING' || w.workState === 'SIGN_FAILED'],
  ['flagged', 'Xem lại', w => w.workState === 'FLAGGED'],
  ['rerun', 'Chạy lại', w => w.workState === 'RERUN_REQUESTED'],
  ['queue', 'Đang ký', w => w.workState === 'IN_QUEUE'],
  ['signed', 'Đã ký', w => w.workState === 'SIGNED']
];
const STATUS_TXT = { PASS: ['✓', 'Đạt'], FAIL: ['✕', 'Không đạt'], NOT_EVALUABLE: ['?', 'Thiếu dữ liệu'], NOT_APPLICABLE: ['–', 'Không áp dụng'] };
const STAGE_TXT = { DATA: 'Dữ liệu bắt buộc', QC: 'QC', INSTRUMENT: 'Cờ máy', SPECIMEN: 'Mẫu', LIMIT: 'Giới hạn & tới hạn', CRITICAL: 'Giới hạn & tới hạn', HISTORY: 'Lịch sử (delta)', CONSISTENCY: 'Nhất quán giữa chỉ số', MODEL: 'Mô hình phát hiện lỗi' };
const WARD = { OPD: 'Ngoại trú', IPD: 'Nội trú', ER: 'Cấp cứu' };
const RESULT_STATUS = { RESULTED: 'Có kết quả', PENDING: 'Chưa có kết quả', FAILED: 'Máy báo lỗi', TRANSMISSION_ERROR: 'Lỗi truyền dữ liệu', NOT_COLLECTED: 'Không thu được mẫu', NOT_APPLICABLE: 'Không áp dụng' };
const REASON_TXT = {
  SUSPECT_SPECIMEN: 'Nghi vấn mẫu', SUSPECT_WBIT: 'Nghi nhầm mẫu', SUSPECT_INSTRUMENT: 'Nghi vấn máy', NEED_CONTEXT: 'Cần thêm thông tin lâm sàng', ASK_COLLEAGUE: 'Hỏi ý kiến đồng nghiệp',
  RERUN: 'Chạy lại cùng mẫu', RECOLLECT: 'Lấy mẫu mới', DILUTE: 'Pha loãng rồi chạy lại', SMEAR_REVIEW: 'Xem lam máu', CHECK_TUBE_LABEL: 'Kiểm tra ống/nhãn', OTHER: 'Khác'
};
const ACTION_LABEL = { SIGN: 'Ký', FLAG_REVIEW: 'Cần xem xét lại', REQUEST_RERUN: 'Yêu cầu chạy lại mẫu' };
const SEND_TXT = { QUEUED: ['info', 'Trong hàng đợi ký'], SIGNING: ['info', 'Đang gửi ký'], SIGNED: ['auto', 'Đã ký (hệ thống bệnh viện xác nhận)'], FAILED: ['blocked', 'Ký lỗi'], SUPERSEDED: ['neutral', 'Bỏ — đã có phiên bản mới'], CANCELLED: ['neutral', 'Bác sĩ rút lệnh ký'] };
const ERR_TXT = { wbit: 'Nhầm mẫu (WBIT)', analytical_single: 'Lỗi phân tích đơn chỉ số', edta: 'Nhiễm EDTA', saline: 'Lẫn NaCl 0,9%', d5w: 'Lẫn glucose 5%', hemolysis: 'Tan máu', delayed: 'Chậm xử lý mẫu', qc_window: 'Đo khi QC không đạt', plt_clump: 'Tiểu cầu kết cụm', clot: 'Cục đông', short_sample: 'Thiếu thể tích mẫu' };
const TITLES = { worklist: 'Duyệt kết quả', try: 'Nhập thử kết quả', eval: 'Đánh giá mô hình', feedback: 'Phản hồi chuyên môn', audit: 'Nhật ký', rules: 'Rule & cấu hình' };
const PRIORITY = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

let meta, worklist = [], queue = null, notes = [], selected = null, current = null, tab = 'todo';
const seenNotes = new Set();

// ---------------- boot & navigation ----------------
async function boot() {
  meta = await api('/api/meta');
  $('#today').textContent = `Ngày ${fmtDate(meta.today + 'T12:00:00+07:00')} (mô phỏng)`;
  $('#modelEnabled').checked = meta.settings.modelEnabled; $('#showTruth').checked = meta.settings.showTruth;
  $('#personalMode').value = meta.settings.personalMode ?? 'OFF';
  $('#llmStatus').innerHTML = meta.llm?.configured ? `<span class="dot-on"></span>LLM sẵn sàng` : `<span class="dot-off"></span>LLM chưa cấu hình (.env)`;
  $('#llmStatus').title = meta.llm?.reason ?? '';
  for (const id of ['personalMode', 'modelEnabled', 'showTruth']) $('#' + id).addEventListener('change', async e => {
    const v = id === 'personalMode' ? e.target.value : e.target.checked;
    meta.settings = await post('/api/settings', { [id]: v });
    toast(id === 'personalMode' ? `Ngưỡng: ${e.target.selectedOptions[0].text}` : id === 'modelEnabled' ? (v ? 'Đã bật lớp mô hình' : 'Đã tắt lớp mô hình — chỉ chạy rule') : (v ? 'Đang hiện nhãn giả lập (chỉ dùng để đào tạo/thử)' : 'Đã ẩn nhãn giả lập'));
    await refresh();
  });
  document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => { showView(b.dataset.view); closeMenu(); }));
  const setCollapsed = on => {
    document.body.classList.toggle('side-collapsed', on);
    const b = $('#collapseBtn');
    b.setAttribute('aria-expanded', String(!on));
    b.title = b.ariaLabel = on ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên';
    try { localStorage.setItem('labreview-sidebar', on ? 'collapsed' : 'open'); } catch { /* storage unavailable */ }
  };
  try { if (localStorage.getItem('labreview-sidebar') === 'collapsed') setCollapsed(true); } catch { /* ignore */ }
  $('#collapseBtn').addEventListener('click', () => setCollapsed(!document.body.classList.contains('side-collapsed')));
  setupListResize();
  $('#menuBtn').addEventListener('click', () => { const open = !document.body.classList.contains('menu-open'); document.body.classList.toggle('menu-open', open); $('#menuBtn').setAttribute('aria-expanded', String(open)); });
  for (const id of ['fDisc', 'fScenario', 'fSearch']) $('#' + id).addEventListener('input', renderList);
  $('#queuePill').addEventListener('click', () => { showView('worklist'); tab = queue?.failed ? 'todo' : 'queue'; renderStats(); renderList(); });
  $('#bellBtn').addEventListener('click', e => { e.stopPropagation(); toggleBell(); });
  document.addEventListener('click', e => { if (!e.target.closest('.bell-wrap')) toggleBell(false); });
  $('#fScenario').checked = true;
  await refresh();
  for (const n of notes) seenNotes.add(n.id); // do not re-announce old notifications on load
  const h = location.hash.slice(1);
  const linked = location.hash.startsWith('#r=') ? decodeURIComponent(location.hash.slice(3)) : null;
  if (linked && worklist.some(w => w.reportId === linked)) { $('#fScenario').checked = false; const w = worklist.find(x => x.reportId === linked); tab = TABS.find(([, , f]) => f(w))?.[0] ?? 'todo'; renderStats(); renderList(); }
  const first = worklist.find(w => w.reportId === linked) ?? visibleItems()[0];
  if (first) await select(first.reportId); else renderDetailEmpty();
  if (TITLES[h] && h !== 'worklist') showView(h);
  setInterval(poll, 2500);
}
function closeMenu() { document.body.classList.remove('menu-open'); $('#menuBtn').setAttribute('aria-expanded', 'false'); }

function showView(v) {
  if (history.replaceState) history.replaceState(null, '', v === 'worklist' ? location.pathname : '#' + v);
  document.querySelectorAll('.nav button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  document.querySelectorAll('.view').forEach(s => s.hidden = s.id !== 'view-' + v);
  $('#pageTitle').textContent = TITLES[v];
  ({ try: renderTry, eval: renderEval, feedback: renderFeedback, audit: renderAudit, rules: renderRules }[v])?.();
}

async function refresh() {
  [worklist, queue, notes] = await Promise.all([api('/api/worklist'), api('/api/queue'), api('/api/notifications')]);
  renderStats(); renderList(); renderQueuePill(); renderBell();
  if (selected) await select(selected, { keepScroll: true });
}

// Background refresh: sign queue progress, failures and notifications arrive without the doctor reloading.
let lastSig = '';
async function poll() {
  if (document.hidden) return;
  try {
    const [wl, q, ns] = await Promise.all([api('/api/worklist'), api('/api/queue'), api('/api/notifications')]);
    const sig = JSON.stringify([wl.map(w => [w.workState, w.version, w.send?.status, w.send?.position]), q, ns.map(n => [n.id, n.read])]);
    if (sig === lastSig) return;
    lastSig = sig;
    const prevSel = worklist.find(w => w.reportId === selected);
    worklist = wl; queue = q; notes = ns;
    renderStats(); renderList(); renderQueuePill(); renderBell();
    announce(ns);
    const nowSel = worklist.find(w => w.reportId === selected);
    const busy = $('#subForm')?.childElementCount || document.activeElement?.closest?.('#detail form');
    if (nowSel && prevSel && (nowSel.workState !== prevSel.workState || nowSel.version !== prevSel.version || nowSel.send?.position !== prevSel.send?.position) && !busy) await select(selected, { keepScroll: true });
  } catch { /* offline for a moment: next tick retries */ }
}

// ---------------- notifications ----------------
function announce(ns) {
  for (const n of [...ns].reverse()) {
    if (seenNotes.has(n.id)) continue;
    seenNotes.add(n.id);
    if (n.read) continue;
    toast(n.text, 'error');
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('LabReview — ký lỗi', { body: n.text, tag: 'labreview-' + n.id }); } catch { /* not supported */ }
  }
}
function renderBell() {
  const unread = notes.filter(n => !n.read).length;
  $('#bellCount').hidden = !unread; $('#bellCount').textContent = unread;
  $('#bellBtn').classList.toggle('has-unread', unread > 0);
  if (!$('#bellPanel').hidden) drawBellPanel();
}
function drawBellPanel() {
  $('#bellPanel').innerHTML = `<div class="bell-head"><strong>Thông báo</strong>${notes.some(n => !n.read) ? '<button type="button" class="link-btn" id="readAll">Đánh dấu đã đọc</button>' : ''}</div>
    ${notes.length ? `<ul class="bell-list">${notes.slice(0, 20).map(n => `<li class="${n.read ? '' : 'unread'}"><button type="button" data-note="${n.id}" data-report="${esc(n.reportId)}"><span>${esc(n.text)}</span><small>${fmtTime(n.at)}</small></button></li>`).join('')}</ul>` : '<p class="empty small">Chưa có thông báo.</p>'}`;
  $('#readAll')?.addEventListener('click', async () => { await post('/api/notifications/read', {}); notes.forEach(n => n.read = true); renderBell(); });
  $('#bellPanel').querySelectorAll('[data-note]').forEach(b => b.addEventListener('click', async () => {
    await post('/api/notifications/read', { ids: [Number(b.dataset.note)] });
    toggleBell(false); showView('worklist'); tab = 'todo'; $('#fScenario').checked = false;
    await refresh(); await select(b.dataset.report);
  }));
}
function toggleBell(open) {
  const p = $('#bellPanel');
  const on = open ?? p.hidden;
  p.hidden = !on; $('#bellBtn').setAttribute('aria-expanded', String(on));
  if (on) drawBellPanel();
}
function askNotificationPermission() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
}

function renderQueuePill() {
  const p = $('#queuePill');
  if (!queue) return;
  const n = (queue.signing ? 1 : 0) + queue.queued.length;
  p.hidden = !n && !queue.failed;
  p.className = 'queue-pill' + (queue.failed ? ' has-failed' : '') + (n ? ' busy' : '');
  p.innerHTML = [n ? `<span class="spin" aria-hidden="true"></span>Đang ký ${n} phiếu` : '', queue.failed ? `<b>${queue.failed} ký lỗi</b>` : ''].filter(Boolean).join(' · ');
}

// ---------------- worklist ----------------
// Kéo thanh giữa để đổi độ rộng cột danh sách; kéo hẳn sang trái (hoặc bấm nút) để thu gọn.
function setupListResize() {
  const split = $('.split'), handle = $('#splitHandle'), btn = $('#listToggle');
  const MIN = 240, MAX = 640, KEY = 'labreview-listw';
  const save = v => { try { localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } };
  const setW = w => { w = Math.round(Math.min(MAX, Math.max(MIN, w))); split.style.setProperty('--list-w', w + 'px'); handle.setAttribute('aria-valuenow', String(w)); return w; };
  const setCollapsed = on => {
    document.body.classList.toggle('list-collapsed', on);
    btn.textContent = on ? '›' : '‹';
    btn.title = btn.ariaLabel = on ? 'Mở danh sách phiếu' : 'Thu gọn danh sách phiếu';
  };
  try { const v = localStorage.getItem(KEY); if (v === 'collapsed') setCollapsed(true); else if (v) setW(Number(v)); } catch { /* ignore */ }
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const on = !document.body.classList.contains('list-collapsed'); setCollapsed(on);
    save(on ? 'collapsed' : parseInt(getComputedStyle(split).getPropertyValue('--list-w')) || 360);
  });
  btn.addEventListener('pointerdown', e => e.stopPropagation());
  handle.addEventListener('pointerdown', e => {
    e.preventDefault(); handle.setPointerCapture(e.pointerId); document.body.classList.add('resizing');
    const left = split.getBoundingClientRect().left;
    const move = ev => {
      const w = ev.clientX - left;
      if (w < MIN - 80) setCollapsed(true); else { setCollapsed(false); setW(w); }
    };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      save(document.body.classList.contains('list-collapsed') ? 'collapsed' : parseInt(split.style.getPropertyValue('--list-w')) || 360);
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); setCollapsed(false);
    save(setW((parseInt(getComputedStyle(split).getPropertyValue('--list-w')) || 360) + (e.key === 'ArrowLeft' ? -24 : 24)));
  });
}

function filtered() {
  const fdisc = $('#fDisc').value, fs = $('#fScenario').checked, q = $('#fSearch').value.trim().toLowerCase();
  return worklist.filter(w => (fdisc === 'all' || w.discipline === fdisc) && (!fs || w.scenario)
    && (!q || [w.reportId, w.subjectToken, w.panelName, w.scenario?.title, w.scenario?.code].join(' ').toLowerCase().includes(q)));
}
function visibleItems() {
  const f = TABS.find(t => t[0] === tab)[2];
  return filtered().filter(f).sort((a, b) =>
    (b.workState === 'SIGN_FAILED') - (a.workState === 'SIGN_FAILED')
    || (tab === 'queue' ? (a.send?.position ?? 0) - (b.send?.position ?? 0) : 0)
    || (tab === 'signed' ? String(b.send?.signedAt).localeCompare(String(a.send?.signedAt)) : 0)
    || PRIORITY[a.priority] - PRIORITY[b.priority]
    || (a.scenario?.code ?? 'ZZ').localeCompare(b.scenario?.code ?? 'ZZ', 'vi', { numeric: true })
    || a.collectedAt.localeCompare(b.collectedAt));
}

function renderStats() {
  const base = filtered();
  const todo = worklist.filter(TABS[0][2]).length;
  $('#navCount').textContent = todo || '';
  $('#stats').innerHTML = TABS.map(([k, label, f]) => {
    const n = base.filter(f).length, failed = k === 'todo' ? base.filter(w => w.workState === 'SIGN_FAILED').length : 0;
    return `<button type="button" role="tab" class="tab ${tab === k ? 'active' : ''}" aria-selected="${tab === k}" data-tab="${k}">${label}<em>${n}</em>${failed ? `<i class="dot-fail" title="${failed} phiếu ký lỗi"></i>` : ''}</button>`;
  }).join('');
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; renderStats(); renderList(); }));
}

function itemChip(w) {
  if (w.workState === 'SIGN_FAILED') return '<span class="badge blocked">Ký lỗi</span>';
  if (w.workState === 'IN_QUEUE') return `<span class="badge info">${w.send?.status === 'SIGNING' ? 'Đang ký…' : `Chờ ký #${w.send?.position ?? ''}`}</span>`;
  if (w.workState === 'SIGNED') return '<span class="badge auto">✓ Đã ký</span>';
  if (w.workState === 'FLAGGED') return '<span class="badge review">Xem lại</span>';
  if (w.workState === 'RERUN_REQUESTED') return '<span class="badge info">Chờ chạy lại</span>';
  return w.criticalValue ? '<span class="badge crit">⚠ Tới hạn</span>' : badge(w.decision, true);
}
function itemLine(w) {
  if (w.workState === 'SIGN_FAILED') return `<span class="item-note err">${esc(w.send?.error ?? 'Ký lỗi')}</span>`;
  if (w.workState === 'RERUN_REQUESTED') return `<span class="item-note">Chạy lại: ${esc((w.review?.tests ?? []).join(', '))}</span>`;
  if (w.workState === 'FLAGGED' && w.review?.note) return `<span class="item-note">${esc(w.review.note)}</span>`;
  if (w.workState === 'PENDING' && w.flaggedTests.length) return `<span class="item-note ${DECISION[w.decision].cls}">Chú ý: ${esc(w.flaggedTests.slice(0, 5).join(', '))}${w.flaggedTests.length > 5 ? ` +${w.flaggedTests.length - 5}` : ''}</span>`;
  if (w.workState === 'PENDING' && w.nIssues) return `<span class="item-note ${DECISION[w.decision].cls}">${w.nIssues} điểm cần chú ý</span>`;
  return '';
}

function renderList() {
  const items = visibleItems();
  $('#list').innerHTML = items.length ? items.map(w => `
    <button class="item ${w.reportId === selected ? 'selected' : ''} pri-${w.workState === 'SIGN_FAILED' ? 'blocked' : w.workState !== 'PENDING' ? 'none' : w.criticalValue ? 'crit' : DECISION[w.decision].cls}" data-id="${esc(w.reportId)}" type="button">
      <span class="item-top"><strong>${esc(w.scenario?.title ?? w.panelName)}</strong>${itemChip(w)}</span>
      <span class="item-sub">${esc(w.scenario?.code ? w.scenario.code + ' · ' : '')}${esc(w.subjectToken)} · ${w.discipline === 'CHEM' ? 'Hóa sinh' : 'Huyết học'} · ${fmtHour(w.collectedAt)}${w.version > 1 ? ` · v${w.version}` : ''}</span>
      ${itemLine(w)}
    </button>`).join('') : `<div class="empty">${tab === 'todo' ? 'Không còn phiếu chờ duyệt.' : 'Không có phiếu.'}</div>`;
  document.querySelectorAll('.item').forEach(b => b.addEventListener('click', () => select(b.dataset.id)));
}

async function select(id, { keepScroll = false } = {}) {
  selected = id;
  if (history.replaceState && !$('#view-worklist').hidden) history.replaceState(null, '', '#r=' + encodeURIComponent(id));
  document.querySelectorAll('.item').forEach(b => b.classList.toggle('selected', b.dataset.id === id));
  const y = scrollY;
  current = await api('/api/reports/' + encodeURIComponent(id));
  renderDetail();
  if (keepScroll) scrollTo(0, y);
}

// After an action the doctor goes straight to the next report of the same list (no waiting for signing).
async function advance(fromId) {
  const before = visibleItems().map(w => w.reportId);
  const i = before.indexOf(fromId);
  await refresh();
  const after = visibleItems();
  const next = after.find(w => before.indexOf(w.reportId) > i && w.reportId !== fromId) ?? after.find(w => w.reportId !== fromId);
  if (next) { await select(next.reportId); scrollTo({ top: 0, behavior: 'smooth' }); }
  else { selected = null; renderList(); renderDetailEmpty(); }
}
function renderDetailEmpty() {
  current = null;
  $('#detail').innerHTML = `<div class="empty"><p><b>Đã duyệt hết phiếu trong danh sách này.</b></p><p class="small">Phiếu đã ký đang được gửi lần lượt sang hệ thống bệnh viện. Nếu có phiếu ký lỗi, phiếu sẽ quay lại đầu danh sách "Chờ duyệt" và có thông báo.</p></div>`;
}

// ---------------- report detail ----------------
// Per-analyte notes: which check flagged this row, and why (only the part of the message about this analyte).
function analyteNotes(ev) {
  const out = {};
  for (const c of ev.checks.filter(c => c.action)) for (const t of c.analytes) {
    const segs = c.message.split('; ').filter(s => new RegExp(`^${t}[=: ]`).test(s));
    const text = (segs.length ? segs.join('; ') : c.message).split('. Ngoài khoảng tham chiếu')[0].replace(new RegExp(`^${t}: `), '');
    (out[t] ??= []).push({ action: c.action, name: c.name, text });
  }
  return out;
}
const RANK = { REVIEW: 1, CRITICAL: 2, BLOCK: 3 };
const worst = list => list.reduce((a, n) => RANK[n.action] > RANK[a] ? n.action : a, 'REVIEW');

function suggestionBox(ev, report, { llm = true } = {}) {
  const issues = ev.checks.filter(c => c.action);
  const general = issues.filter(c => !c.analytes.length).sort((a, b) => RANK[b.action] - RANK[a.action]);
  const flagged = Object.entries(ev.analyteStatus).filter(([, v]) => v !== 'OK').map(([t]) => t);
  const resulted = report.results.filter(x => x.status === 'RESULTED').length;
  const cls = ev.criticalValue ? 'crit' : DECISION[ev.decision].cls;
  const head = ev.criticalValue ? 'Có giá trị tới hạn' : DECISION[ev.decision].label;
  const lead = !issues.length ? 'Không thấy điểm bất thường theo rule và mô hình. Bác sĩ vẫn là người xem và quyết định ký.'
    : [flagged.length ? `${flagged.length} chỉ số được tô màu trong bảng, kèm lý do.` : '', general.length ? 'Vấn đề chung của phiếu:' : ''].filter(Boolean).join(' ');
  return `<section class="suggest ${cls}" aria-label="Đề xuất của hệ thống">
    <div class="suggest-head"><span class="suggest-ic" aria-hidden="true">${ev.criticalValue ? '⚠' : DECISION[ev.decision].icon}</span>
      <div><span class="suggest-kicker">Hệ thống đề xuất · đã đọc ${resulted}/${report.orderedTests.length} kết quả</span><strong>${head}</strong></div></div>
    <p class="suggest-lead">${lead}</p>
    ${general.length ? `<ul class="suggest-list">${general.map(c => `<li class="a-${c.action}"><b>${esc(c.name)}</b> — ${esc(c.message)}</li>`).join('')}</ul>` : ''}
    ${llm ? llmBlock() : ''}
  </section>`;
}

function resultsTable(d, ev) {
  const r = d.report, info = d.analyteInfo, hist = d.history ?? {};
  const notesBy = analyteNotes(ev);
  const cols = 6 + (ev.personal ? 1 : 0);
  return `<div class="tablewrap"><table class="lab"><thead><tr><th>Xét nghiệm</th><th class="num">Kết quả</th><th class="flag"></th><th>Đơn vị</th><th>Khoảng tham chiếu</th>${ev.personal ? '<th>Khoảng cá nhân</th>' : ''}<th>Lần trước</th></tr></thead><tbody>
  ${r.orderedTests.map(t => {
    const x = r.results.find(q => q.test === t), i = info[t];
    const ok = x && x.status === 'RESULTED' && typeof x.value === 'number' && x.unit === i.unit;
    const hi = ok && x.value > i.ref[1], lo = ok && x.value < i.ref[0];
    const prev = (hist[t] ?? []).at?.(-1);
    const ns = notesBy[t] ?? [];
    const hl = ns.length ? `hl hl-${worst(ns)}` : '';
    const valTxt = !x ? '<span class="muted">Không có</span>' : x.status !== 'RESULTED' ? `<span class="status-txt blocked">${esc(RESULT_STATUS[x.status] ?? x.status)}</span>` : `<span class="${hi || lo ? 'v-out' : ''}">${val(x.value)}</span>`;
    const unitTxt = !x ? '' : !x.unit ? '<span class="status-txt blocked">thiếu</span>' : x.unit !== i.unit ? `<span class="status-txt blocked">${esc(x.unit)}</span>` : esc(x.unit);
    const row = `<tr class="${hl}"><td><span class="t-name">${esc(i.name)}</span> <span class="t-code">${esc(t)}</span></td><td class="num">${valTxt}</td>
      <td class="flag">${hi ? '<span class="hf h" title="Cao hơn khoảng tham chiếu">H</span>' : lo ? '<span class="hf l" title="Thấp hơn khoảng tham chiếu">L</span>' : ''}</td>
      <td class="muted">${unitTxt}</td><td class="muted">${val(i.ref[0])} – ${val(i.ref[1])}</td>
      ${ev.personal ? `<td>${personalCell(ev.personal[t], i)}</td>` : ''}
      <td class="muted">${prev ? `${val(prev.value)} <small>${fmtDate(prev.measuredAt)}</small>` : '—'}</td></tr>`;
    const note = ns.length ? `<tr class="note-row hl-${worst(ns)}"><td colspan="${cols}">${ns.map(n => `<div class="anote a-${n.action}"><span class="anote-ic" aria-hidden="true">${n.action === 'CRITICAL' ? '⚠' : n.action === 'BLOCK' ? '■' : '!'}</span><span><b>${esc(n.name)}:</b> ${esc(n.text)}</span></div>`).join('')}</td></tr>` : '';
    return row + note;
  }).join('')}</tbody></table></div>`;
}

function personalCell(pi, info) {
  if (!pi) return '<span class="muted">—</span>';
  if (!pi.usable) return `<span class="muted small" title="${esc(pi.reason)}">chưa đủ cơ sở</span>`;
  const d = Math.max(0, (String(info.ref[1]).split('.')[1] ?? '').length);
  return `<span class="tag info-tag" title="Tính từ ${pi.n} kết quả trước">${val(Number(pi.lo.toFixed(d)))} – ${val(Number(pi.hi.toFixed(d)))}</span>`;
}

function allChecks(ev) {
  let last = null;
  return `<div class="checks">${ev.checks.map(c => {
    const hdr = STAGE_TXT[c.stage] !== last ? `<div class="stage">${STAGE_TXT[c.stage] ?? c.stage}</div>` : '';
    last = STAGE_TXT[c.stage];
    const [ic, txt] = STATUS_TXT[c.status];
    return `${hdr}<div class="check ${c.status} act-${c.action ?? 'NONE'}"><span class="ic" aria-hidden="true">${ic}</span>
      <div><strong>${esc(c.name)}</strong> <span class="code">${esc(c.code)}</span><div class="msg">${esc(c.message)}</div></div>
      <div class="check-out">${c.action ? outcomeBadge(c.action) : `<span class="muted small">${txt}</span>`}</div></div>`;
  }).join('')}</div>`;
}

function modelsBlock(ev) {
  if (!ev.modelEnabled) return '<p class="muted">Lớp mô hình đang tắt — đề xuất chỉ dựa trên rule.</p>';
  if (!ev.models?.length) return '<p class="muted">Không có mô hình cho nhóm này (hoặc chưa có models/*.json — đang chỉ chạy rule).</p>';
  const covTxt = c => `Dữ liệu: dùng <b>${c.used}/${c.total}</b> chỉ số${c.missing.length ? ` <span class="muted">(thiếu: ${c.missing.map(m => `${esc(m.test)} — ${m.reason === 'NOT_ORDERED' ? 'không chỉ định' : 'chưa có kết quả'}`).join(', ')})</span>` : ''}`;
  return ev.models.map(m => {
    const scale = m.kind === 'knn_anomaly' ? 2 * m.threshold : 1; // KNN distance is not in [0,1]: threshold drawn at the middle
    const head = `<div><strong>${esc(m.name)}</strong><div class="muted small mono">${esc(m.version)}</div></div>`;
    const meta = `<div class="small">${covTxt(m.coverage)} · Lịch sử: ${esc(m.history.label)}</div>`;
    if (m.status !== 'SCORED') return `<div class="model-row">${head}<div class="small"><b>${m.status === 'NOT_EVALUABLE' ? 'Không đánh giá được' : 'Không áp dụng'}</b> — ${esc(m.reason)}</div>${meta}</div>`;
    const why = m.top.length ? `<br><span class="muted">Yếu tố ảnh hưởng nhiều nhất: ${m.top.map(t => `${t.direction === 'DOWN' ? '↓' : '↑'} ${esc(t.label)}${t.value != null ? ` (${num(t.value, 2)})` : ''}`).join('; ')}</span><br><span class="muted small">↑ làm tăng điểm nghi ngờ, ↓ làm giảm.</span>` : '<br><span class="muted small">Không có yếu tố nào làm đổi điểm so với mức nền.</span>';
    return `<div class="model-row">${head}<div class="meter-wrap">
      <div class="meter" role="img" aria-label="Điểm ${num(m.score)}, ngưỡng ${num(m.threshold)}"><span class="fill ${m.flagged ? 'hot' : ''}" style="width:${Math.min(100, m.score / scale * 100)}%"></span><span class="thr" style="left:${Math.min(100, m.threshold / scale * 100)}%"></span></div>
      <div class="small">Điểm <b>${num(m.score)}</b> / ngưỡng ${num(m.threshold)} — ${m.flagged ? '<b>gắn cờ để bác sĩ chú ý</b>' : 'không gắn cờ'}${why}</div>${meta}</div></div>`;
  }).join('') + '<p class="muted small">Điểm phát hiện trên dữ liệu giả lập, không phải xác suất an toàn. Mô hình chỉ gắn cờ để bác sĩ chú ý. Thiếu dữ liệu then chốt → "không đánh giá được", không bao giờ là "đạt".</p>';
}

function contextBlock(r) {
  const c = r.context;
  const li = (arr, f) => arr?.length ? arr.map(f).join('') : '<li class="muted">Chưa ghi nhận</li>';
  const yn = { YES: 'Có', NO: 'Không', UNKNOWN: 'Không rõ' };
  return `<div class="kv-grid">
    <div><h4>Người bệnh (không định danh)</h4><dl class="kv"><dt>Mã giả</dt><dd class="mono">${esc(r.subjectToken)}</dd><dt>Nhóm tuổi</dt><dd>${esc(c.ageGroup || c.age)}</dd><dt>Giới</dt><dd>${c.sex === 'F' ? 'Nữ' : 'Nam'}</dd><dt>Nhịn ăn</dt><dd>${yn[c.fasting]}</dd><dt>Truyền dịch</dt><dd>${yn[c.ivInfusion]}</dd></dl>
      <h4>Bệnh nền · thuốc · sự kiện</h4><ul class="plain">${li([...c.conditions.map(x => ({ t: x.label, d: x.knownAt })), ...c.medications.map(x => ({ t: x.label, d: x.startedAt })), ...c.events.map(x => ({ t: x.label, d: x.at }))], x => `<li>${esc(x.t)} <span class="muted">· ${fmtDate(x.d)}</span></li>`)}</ul></div>
    <div><h4>Mẫu & thiết bị</h4><dl class="kv"><dt>Mã mẫu</dt><dd class="mono">${esc(r.specimen.specimenId)}</dd><dt>Lấy / nhận</dt><dd>${fmtHour(r.specimen.collectedAt)} / ${fmtHour(r.specimen.receivedAt)}</dd><dt>Đo</dt><dd>${fmtHour(r.results.find(x => x.measuredAt)?.measuredAt)}</dd>
      ${r.discipline === 'CHEM' ? `<dt>HIL</dt><dd>${r.specimen.hil ? `H ${esc(r.specimen.hil.H)} · L ${esc(r.specimen.hil.L)} · I ${esc(r.specimen.hil.I)}` : '<span class="status-txt blocked">Thiếu</span>'}</dd>` : ''}
      <dt>Cờ máy</dt><dd>${r.instrumentFlags.length ? r.instrumentFlags.map(f => `<span class="tag review">${esc(f.code)}</span>`).join(' ') : 'Không có'}</dd>
      <dt>Máy</dt><dd>${[...new Set(r.results.map(x => x.instrument))].map(esc).join(', ')}</dd></dl>
      ${current?.qcRelevant?.length ? `<p class="small">QC hôm nay: ${current.qcRelevant.map(q => `${esc(q.test)} ${fmtHour(q.at)} ${q.status === 'PASS' ? 'đạt' : '<b>không đạt</b>'}`).join(' · ')}</p>` : ''}</div></div>`;
}

function sendHistory(d) {
  const rows = [...(d.send.current ? [{ key: d.send.current.idempotencyKey, ...d.send.current }] : []), ...d.send.superseded];
  if (!rows.length) return '<p class="muted">Chưa gửi ký. "Đã ký" chỉ hiện khi hệ thống bệnh viện (mô phỏng) xác nhận.</p>';
  return `<ul class="plain small">${rows.map(s => `<li><span class="status-txt ${SEND_TXT[s.status]?.[0] ?? ''}">${esc(SEND_TXT[s.status]?.[1] ?? s.status)}</span> <span class="muted mono">${esc(s.key)} · lần ${s.attempts}${s.signId ? ' · ' + esc(s.signId) : ''}</span>${s.error ? `<br><span class="muted">${esc(s.error)}</span>` : ''}</li>`).join('')}</ul>`;
}

function timeline(list) {
  if (!list.length) return '<p class="muted">Chưa có sự kiện.</p>';
  return `<ul class="timeline">${[...list].reverse().map(a => `<li><span class="t">${fmtHour(a.at)}</span><span><b>${esc(a.type)}</b>${a.version ? ' · v' + esc(a.version) : ''} — ${esc(a.actor)}<br><span class="muted">${esc(a.note ?? '')}</span></span></li>`).join('')}</ul>`;
}

// Status of the doctor's decision for this version (shown above the suggestion).
function statusBanner(d) {
  const s = d.send.current, rv = d.review;
  switch (d.workState) {
    case 'SIGN_FAILED': return `<div class="banner blocked"><div><b>Ký lỗi — phiếu chưa được ký.</b> ${esc(s.error)}<div class="small muted">Bác sĩ đã bấm ký lúc ${fmtHour(rv.at)}; lỗi lúc ${fmtHour(s.failedAt)}. Bấm "Ký lại" bên dưới, hoặc chọn thao tác khác.</div></div></div>`;
    case 'IN_QUEUE': return `<div class="banner info"><div><span class="spin" aria-hidden="true"></span><b>${s.status === 'SIGNING' ? 'Đang gửi sang hệ thống ký của bệnh viện…' : `Trong hàng đợi ký — vị trí ${d.queuePosition ?? '?'}`}</b><div class="small muted">Bác sĩ bấm ký lúc ${fmtHour(rv.at)}. Có thể chuyển sang phiếu khác, không cần chờ.</div></div>${s.status === 'QUEUED' ? '<button type="button" class="btn" id="cancelSignBtn">Rút lệnh ký</button>' : ''}</div>`;
    case 'SIGNED': return `<div class="banner auto"><div><b>✓ Đã ký</b> lúc ${fmtHour(s.signedAt)} <span class="muted small mono">${esc(s.signId)}</span></div></div>`;
    case 'FLAGGED': return `<div class="banner review"><div><b>Đã đánh dấu cần xem xét lại</b> lúc ${fmtHour(rv.at)}${rv.reasonCode ? ' · ' + esc(REASON_TXT[rv.reasonCode]) : ''}${rv.note ? `<div class="small">${esc(rv.note)}</div>` : ''}</div></div>`;
    case 'RERUN_REQUESTED': return `<div class="banner info"><div><b>Đã yêu cầu chạy lại:</b> ${esc((rv.tests ?? []).join(', '))}${rv.reasonCode ? ' · ' + esc(REASON_TXT[rv.reasonCode]) : ''}${rv.note ? `<div class="small">${esc(rv.note)}</div>` : ''}<div class="small muted">Khi máy gửi kết quả mới, phiếu thành phiên bản mới và quay về "Chờ duyệt".</div></div></div>`;
    default: return '';
  }
}

function actionBar(d, ev) {
  if (['IN_QUEUE', 'SIGNED'].includes(d.workState)) return '';
  const blocked = ev.decision === 'BLOCKED', crit = ev.criticalValue;
  return `<div class="action-bar" id="actionBar">
    ${crit && !blocked ? `<label class="crit-confirm"><input type="checkbox" id="critOk"><span>Đã thông báo giá trị tới hạn cho lâm sàng</span></label>` : ''}
    ${blocked ? '<p class="hint">Phiếu có lỗi dữ liệu/QC/mẫu nên chưa ký được. Hãy yêu cầu chạy lại mẫu (hoặc xử lý), hệ thống sẽ đọc lại phiên bản mới.</p>' : ''}
    <div class="btn-row">
      <button type="button" class="btn sign" ${d.workState === 'SIGN_FAILED' ? 'id="resignBtn"' : 'data-act="SIGN"'} ${blocked ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18"/><path d="m5 17 4-1 9.5-9.5a2.1 2.1 0 0 0-3-3L6 13l-1 4Z"/></svg>${d.workState === 'SIGN_FAILED' ? 'Ký lại' : 'Ký'}</button>
      <button type="button" class="btn" data-act="FLAG_REVIEW" ${d.workState === 'FLAGGED' ? 'disabled' : ''}>Cần xem xét lại</button>
      <button type="button" class="btn" data-act="REQUEST_RERUN">Yêu cầu chạy lại mẫu</button>
    </div>
    <div id="subForm"></div>
  </div>`;
}

function subForm(kind, d, ev) {
  const reasons = meta.reasons[kind] ?? [];
  const chips = `<div class="chips" role="radiogroup" aria-label="Lý do">${reasons.map(r => `<label class="chip"><input type="radio" name="reasonCode" value="${r}"><span>${esc(REASON_TXT[r] ?? r)}</span></label>`).join('')}</div>`;
  if (kind === 'FLAG_REVIEW') return `<form class="sub" id="actSub"><p class="sub-title">Cần xem xét lại — lý do (không bắt buộc)</p>${chips}
    <textarea name="note" rows="2" maxlength="1000" placeholder="Ghi chú cho lần xem lại (không bắt buộc)"></textarea>
    <div class="row-end"><button type="button" class="btn ghost" data-cancel>Hủy</button><button type="submit" class="btn primary">Đánh dấu xem lại</button></div></form>`;
  const flagged = new Set(Object.entries(ev.analyteStatus).filter(([, v]) => v !== 'OK').map(([t]) => t));
  return `<form class="sub" id="actSub"><p class="sub-title">Chạy lại xét nghiệm nào?</p>
    <div class="chips">${d.report.orderedTests.map(t => `<label class="chip ${flagged.has(t) ? 'flagged' : ''}"><input type="checkbox" name="tests" value="${esc(t)}" ${flagged.has(t) ? 'checked' : ''}><span>${esc(d.analyteInfo[t].name)}</span></label>`).join('')}</div>
    <p class="sub-title">Cách làm (không bắt buộc)</p>${chips}
    <textarea name="note" rows="2" maxlength="1000" placeholder="Ghi chú cho kỹ thuật viên (không bắt buộc)"></textarea>
    <div class="row-end"><button type="button" class="btn ghost" data-cancel>Hủy</button><button type="submit" class="btn primary">Gửi yêu cầu chạy lại</button></div></form>`;
}

function amendForm(d, ev) {
  const r = d.report;
  const want = new Set(d.review?.action === 'REQUEST_RERUN' ? d.review.tests : Object.entries(ev.analyteStatus).filter(([, v]) => v !== 'OK').map(([t]) => t));
  const tests = [...r.orderedTests.filter(t => want.has(t)), ...r.orderedTests.filter(t => !want.has(t))];
  return `<p class="muted small">Dùng để mô phỏng máy gửi kết quả chạy lại / kỹ thuật viên sửa dữ liệu. Mỗi lần lưu tạo phiên bản mới, hệ thống đọc lại và phiếu quay về "Chờ duyệt".</p>
  <form id="amendForm" class="stack">
    <div class="form-grid"><label>Loại cập nhật <select name="kind"><option value="RERUN">Chạy lại mẫu</option><option value="UNIT_FIX">Sửa lỗi đơn vị/giao tiếp</option><option value="RECOLLECT">Lấy mẫu mới</option><option value="MANUAL_CORRECTION">Hiệu chỉnh thủ công</option></select></label>
      <label class="toggle"><input type="checkbox" name="clearFlags"><span>Xóa cờ máy sau chạy lại</span></label></div>
    ${r.discipline === 'CHEM' ? `<div class="form-grid three">${['H', 'L', 'I'].map(k => `<label>HIL mới ${k}<input type="number" name="hil${k}" min="0"></label>`).join('')}</div>` : ''}
    <div class="tablewrap"><table class="lab"><thead><tr><th>Xét nghiệm</th><th>Hiện tại</th><th>Giá trị mới</th></tr></thead><tbody>
    ${tests.map(t => { const x = r.results.find(q => q.test === t); return `<tr><td>${esc(d.analyteInfo[t].name)}${want.has(t) ? ' <span class="tag review">cần chạy lại</span>' : ''}</td><td class="muted">${esc(x?.status === 'RESULTED' ? `${x.value} ${x.unit || '(thiếu đơn vị)'}` : RESULT_STATUS[x?.status] ?? '—')}</td>
      <td><input type="number" step="any" name="v_${esc(t)}" aria-label="Giá trị mới ${esc(t)}" placeholder="${esc(d.analyteInfo[t].unit)}"></td></tr>`; }).join('')}
    </tbody></table></div>
    <label>Lý do cập nhật <textarea name="note" required maxlength="1000" rows="2" placeholder="VD: QC đạt lại lúc 11:40, chạy lại K"></textarea></label>
    <div class="row-end"><button class="btn" type="submit">Lưu phiên bản mới</button></div>
  </form>`;
}

const fold = (title, body, { open = false, count = '' } = {}) => `<details class="fold" ${open ? 'open' : ''}><summary><span>${title}</span>${count !== '' ? `<em>${count}</em>` : ''}</summary><div class="fold-body">${body}</div></details>`;

function renderDetail() {
  const d = current, r = d.report, ev = d.evaluation, s = r.scenario, tr = d.simulationTruth, c = r.context;
  const failing = ev.checks.filter(x => x.action).length, passCount = ev.checks.filter(x => x.status === 'PASS').length;
  const [wcls, wtxt] = WORK[d.workState];
  $('#detail').innerHTML = `
    <header class="rpt-head">
      <div><p class="eyebrow">${r.discipline === 'CHEM' ? 'Hóa sinh' : 'Huyết học'} · ${esc(r.panelName)} · ${WARD[r.ward] ?? esc(r.ward)}</p>
        <h2>${esc(r.subjectToken)} <span class="who">${c.sex === 'F' ? 'Nữ' : 'Nam'} · ${esc(c.ageGroup || c.age)} tuổi</span></h2>
        <p class="muted small">Phiếu <span class="mono">${esc(r.reportId)}</span>${r.version > 1 ? ` · phiên bản ${r.version}` : ''} · Lấy mẫu ${fmtHour(r.specimen.collectedAt)} · Nhận ${fmtHour(r.specimen.receivedAt)}</p></div>
      <span class="badge ${wcls}">${wtxt}</span>
    </header>
    ${statusBanner(d)}
    ${resultsTable(d, ev)}
    <p class="legend-line muted small"><span class="hf h">H</span>/<span class="hf l">L</span> cao/thấp hơn khoảng tham chiếu · dòng tô màu: hệ thống thấy cần chú ý (đỏ: lỗi chặn, tím: tới hạn, cam: cần xem).</p>
    ${suggestionBox(ev, r)}
    ${actionBar(d, ev)}
    <div class="folds">
      ${fold('Thông tin mẫu & bối cảnh', (s ? `<p class="scenario-note"><span class="tag gold">${esc(s.code)}</span> ${esc(s.story)}</p>` : '') + contextBlock(r))}
      ${fold('Chi tiết các bước kiểm tra của hệ thống', allChecks(ev) + '<h4 class="sub-h">Mô hình phát hiện lỗi</h4>' + modelsBlock(ev), { count: `${passCount} đạt · ${failing} cần chú ý` })}
      ${fold('Nhận kết quả chạy lại (mô phỏng máy gửi lên LIS)', amendForm(d, ev), { open: d.workState === 'RERUN_REQUESTED' })}
      ${fold('Lịch sử ký & thao tác', sendHistory(d) + timeline(d.audit), { count: d.audit.length || '' })}
      ${tr ? fold('Nhãn giả lập (ground truth)', `<dl class="kv"><dt>Lỗi mẫu</dt><dd>${esc(tr.truth.sampleError ? ERR_TXT[tr.truth.sampleError] ?? tr.truth.sampleError : 'Không')}</dd><dt>Lỗi dữ liệu</dt><dd>${esc(tr.truth.dataIssue ?? 'Không')}</dd><dt>Tới hạn</dt><dd>${tr.truth.criticalValue ? 'Có' : 'Không'}</dd><dt>Người duyệt mô phỏng</dt><dd>${esc(tr.simulatedReviewer?.action ?? '—')}</dd><dt>Tập</dt><dd>${esc(tr.split)}</dd></dl>${tr.truth.details ? `<p class="small">${esc(tr.truth.details)}</p>` : ''}<p class="muted small">"Người duyệt đã duyệt" khác "kết quả đúng".</p>`, { open: true }) : ''}
    </div>`;
  wireDetail(d);
}

function llmBlock() {
  const st = meta.llm ?? { configured: false, reason: 'Server chưa hỗ trợ LLM.' };
  return `<div class="llm-box" id="llmBox">
    <div class="row-between"><span class="small"><b>Diễn giải chi tiết bằng LLM</b> <span class="muted">tùy chọn</span></span>
      <button type="button" class="btn ghost small-btn" id="llmBtn" ${st.configured ? '' : 'disabled'} title="${esc(st.configured ? 'LLM chỉ diễn giải, không quyết định ký' : st.reason)}">Diễn giải</button></div>
    <div id="llmOut" class="small"></div></div>`;
}

async function doAction(d, body, okMsg) {
  try {
    await post(`/api/reports/${encodeURIComponent(d.report.reportId)}/action`, body);
    toast(okMsg);
    await advance(d.report.reportId);
  } catch (err) { toast(err.message, 'error'); }
}

function wireDetail(d) {
  const ev = d.evaluation, id = encodeURIComponent(d.report.reportId);
  $('#llmBtn')?.addEventListener('click', async e => {
    const btn = e.currentTarget; btn.disabled = true; $('#llmOut').innerHTML = '<span class="muted">Đang gọi LLM…</span>';
    try {
      const r = await post(`/api/reports/${id}/explain`, {});
      $('#llmOut').innerHTML = `<div class="llm-text">${esc(r.text).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replaceAll('\n', '<br>')}</div><p class="muted small">${r.latencyMs} ms · ${esc(r.disclaimer)}</p>`;
    } catch (err) { $('#llmOut').innerHTML = `<span class="status-txt blocked">${esc(err.message)}</span>`; }
    finally { btn.disabled = false; }
  });
  document.querySelectorAll('#actionBar [data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'SIGN') {
      const crit = $('#critOk');
      if (crit && !crit.checked) { crit.closest('label').classList.add('need'); crit.focus(); toast('Phiếu có giá trị tới hạn: xác nhận đã thông báo lâm sàng trước khi ký.', 'error'); return; }
      askNotificationPermission();
      b.disabled = true;
      return doAction(d, { action: 'SIGN', criticalNotified: !!crit?.checked }, 'Đã đưa vào hàng đợi ký — chuyển sang phiếu tiếp theo.');
    }
    const box = $('#subForm');
    if (box.dataset.kind === act) { box.innerHTML = ''; box.dataset.kind = ''; return; }
    box.dataset.kind = act; box.innerHTML = subForm(act, d, ev);
    document.querySelectorAll('#actionBar [data-act]').forEach(x => x.classList.toggle('active', x.dataset.act === act));
    const f = $('#actSub');
    f.querySelector('[data-cancel]').addEventListener('click', () => { box.innerHTML = ''; box.dataset.kind = ''; document.querySelectorAll('#actionBar [data-act]').forEach(x => x.classList.remove('active')); });
    f.addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(f);
      const body = { action: act, reasonCode: fd.get('reasonCode') || null, note: fd.get('note') ?? '' };
      if (act === 'REQUEST_RERUN') body.tests = fd.getAll('tests');
      doAction(d, body, act === 'FLAG_REVIEW' ? 'Đã chuyển sang "Xem xét lại".' : `Đã gửi yêu cầu chạy lại: ${body.tests.join(', ')}.`);
    });
    f.querySelector('input, textarea')?.focus();
  }));
  $('#resignBtn')?.addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    try { await post(`/api/reports/${id}/resign`, {}); toast('Đã đưa lại vào hàng đợi ký.'); await advance(d.report.reportId); } catch (err) { toast(err.message, 'error'); await refresh(); }
  });
  $('#cancelSignBtn')?.addEventListener('click', async () => {
    try { current = await post(`/api/reports/${id}/cancel-sign`, {}); toast('Đã rút lệnh ký — phiếu trở về "Chờ duyệt".'); tab = 'todo'; await refresh(); } catch (err) { toast(err.message, 'error'); await refresh(); }
  });
  $('#amendForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const changes = d.report.orderedTests.filter(t => fd.get('v_' + t)).map(t => ({ test: t, value: Number(fd.get('v_' + t)), unit: d.analyteInfo[t].unit }));
    const hil = ['H', 'L', 'I'].every(k => fd.get('hil' + k)) ? { H: Number(fd.get('hilH')), L: Number(fd.get('hilL')), I: Number(fd.get('hilI')) } : null;
    try {
      current = await post(`/api/reports/${id}/amend`, { kind: fd.get('kind'), changes, note: fd.get('note'), clearFlags: fd.get('clearFlags') === 'on', hil });
      toast(`Phiên bản ${current.report.version}: ${DECISION[current.evaluation.decision].label} — đã về "Chờ duyệt"`);
      tab = 'todo'; await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------- manual try ----------------
const EXAMPLES = {
  normal: { CHEM_EXT: { GLU: 5.2, URE: 4.8, CRE: 80, NA: 140, K: 4.2, CL: 103, CA: 2.35, MG: 0.85, ALB: 43, ALP: 75, AST: 22, ALT: 20 }, CHEM_BASIC: { GLU: 5.2, URE: 4.8, CRE: 80, NA: 140, K: 4.2, CL: 103 },
    CBC: { WBC: 6.5, RBC: 4.8, HGB: 142, HCT: 0.43, MCV: 89.5, MCH: 29.6, MCHC: 331, RDW: 12.8, PLT: 250, NEU: 58, LYM: 31 } },
  edta: { CHEM_EXT: { GLU: 5.0, URE: 4.6, CRE: 78, NA: 141, K: 7.4, CL: 103, CA: 1.52, MG: 0.55, ALB: 42, ALP: 38, AST: 21, ALT: 19 } }
};

function renderTry() {
  const v = $('#view-try');
  if (v.dataset.ready) return;
  v.dataset.ready = '1';
  v.innerHTML = `<div class="two-col">
    <div class="card"><p class="lead">Nhập vài kết quả để xem hệ thống đề xuất thế nào. Ô trống nghĩa là <b>chưa có kết quả</b>, không phải 0. Dữ liệu nhập thử không vào danh sách duyệt.</p>
    <form id="tryForm" class="stack">
      <div class="form-grid">
        <label>Bảng xét nghiệm <select name="panel">${Object.entries(meta.panels).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>QC gần nhất <select name="qc"><option value="PASS">Đạt</option><option value="FAIL">Không đạt</option><option value="NONE">Không có dữ liệu</option></select></label>
        <label>Giới <select name="sex"><option value="M">Nam</option><option value="F">Nữ</option></select></label>
        <label>Tuổi <input type="number" name="age" value="50" min="18" max="110"></label>
      </div>
      <details class="fold"><summary><span>Mẫu, HIL & cờ máy</span></summary><div class="fold-body stack">
        <div class="form-grid"><label>Phút từ lấy mẫu tới đo <input type="number" name="collectedMinutesAgo" value="60" min="0"></label></div>
        <div class="form-grid three" id="hilRow">${['H', 'L', 'I'].map((k, i) => `<label>HIL ${k}<input type="number" name="hil${k}" value="${[8, 15, 2][i]}" min="0"></label>`).join('')}</div>
        <div class="chips-row">${['PLT_CLUMPS', 'SAMPLE_SHORT', 'CLOT_DETECTED', 'ABOVE_AMR', 'VARIANT_LYMPH'].map(f => `<label class="toggle small"><input type="checkbox" name="flag" value="${f}"><span>${f}</span></label>`).join('')}</div>
      </div></details>
      <div id="tryTable"></div>
      <div class="row-between"><span><button class="btn ghost" type="button" id="fillNormal">Điền mẫu bình thường</button> <button class="btn ghost" type="button" id="fillEdta">Ví dụ nghi EDTA</button></span><button class="btn primary" type="submit">Đánh giá</button></div>
    </form></div>
    <div class="card" id="tryOut"><p class="empty">Đề xuất của hệ thống sẽ hiện ở đây.</p></div></div>`;
  const form = $('#tryForm');
  const drawTable = () => {
    const panel = meta.panels[form.panel.value];
    $('#hilRow').hidden = panel.discipline !== 'CHEM';
    $('#tryTable').innerHTML = `<div class="tablewrap"><table class="lab"><thead><tr><th>Xét nghiệm</th><th>Kết quả</th><th>Đơn vị</th><th>Lần trước</th><th>Cách (ngày)</th></tr></thead><tbody>
      ${panel.tests.map(t => { const a = meta.analytes[t]; const units = [a.unit, ...Object.keys(a.altUnits ?? {}).filter(u => u !== a.unit), '']; return `<tr><td>${esc(a.name)}</td>
        <td><input type="number" step="any" name="v_${t}" aria-label="${esc(a.name)}"></td>
        <td><select name="u_${t}" aria-label="Đơn vị ${esc(a.name)}">${units.map(u => `<option value="${esc(u)}">${u ? esc(u) : '(thiếu)'}</option>`).join('')}</select></td>
        <td><input type="number" step="any" name="p_${t}" aria-label="Lần trước ${esc(a.name)}"></td><td><input type="number" name="d_${t}" value="14" min="1" class="narrow" aria-label="Số ngày"></td></tr>`; }).join('')}</tbody></table></div>`;
  };
  form.panel.addEventListener('change', drawTable); drawTable();
  const fill = ex => { if (!EXAMPLES[ex][form.panel.value]) { form.panel.value = 'CHEM_EXT'; drawTable(); }
    for (const [t, x] of Object.entries(EXAMPLES[ex][form.panel.value])) { if (form['v_' + t]) form['v_' + t].value = x; if (ex === 'edta' && form['p_' + t]) form['p_' + t].value = EXAMPLES.normal.CHEM_EXT[t]; } };
  $('#fillNormal').addEventListener('click', () => fill('normal'));
  $('#fillEdta').addEventListener('click', () => fill('edta'));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form); const panel = meta.panels[fd.get('panel')];
    const values = {}, hist = [];
    for (const t of panel.tests) { values[t] = { value: fd.get('v_' + t), unit: fd.get('u_' + t) }; if (fd.get('p_' + t) !== '') hist.push({ test: t, value: fd.get('p_' + t), daysAgo: fd.get('d_' + t) }); }
    try {
      const out = await post('/api/evaluate', { panel: fd.get('panel'), sex: fd.get('sex'), age: fd.get('age'), qc: fd.get('qc'), collectedMinutesAgo: fd.get('collectedMinutesAgo'),
        hil: { H: fd.get('hilH'), L: fd.get('hilL'), I: fd.get('hilI') }, flags: fd.getAll('flag'), values, history: hist });
      const ev = out.evaluation;
      const histMap = {}; for (const h of hist) (histMap[h.test] ??= []).push({ value: Number(h.value), measuredAt: new Date(Date.now() - h.daysAgo * 864e5).toISOString() });
      $('#tryOut').innerHTML = `${suggestionBox(ev, out.report, { llm: false })}
        ${resultsTable({ report: out.report, analyteInfo: out.analyteInfo, history: histMap }, ev)}
        ${fold('Chi tiết các bước kiểm tra', allChecks(ev))}${fold('Mô hình phát hiện lỗi', modelsBlock(ev))}`;
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------- evaluation ----------------
function barChart(rows, series) {
  const W = 580, rowH = 34, left = 175, right = 50, top = 8, H = top + rows.length * rowH + 22;
  const x = v => left + v * (W - left - right);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(g => `<line class="grid" x1="${x(g)}" x2="${x(g)}" y1="${top}" y2="${H - 18}"/><text class="lbl" x="${x(g)}" y="${H - 4}" text-anchor="middle">${g * 100}%</text>`).join('');
  const bars = rows.map((r, i) => {
    const y0 = top + i * rowH;
    return `<text class="lbl" x="${left - 8}" y="${y0 + rowH / 2 + 4}" text-anchor="end">${esc(r.label)} (n=${r.n})</text>` + series.map((s, j) => {
      const v = r.values[j], w = Math.max(2, x(v) - left), y = y0 + 4 + j * 13;
      return `<g class="bar" data-tip="${esc(`${r.label} · ${s.name}: ${pct(v)} (${r.counts[j]}/${r.n})`)}"><rect x="${left}" y="${y - 2}" width="${W - left - right}" height="15" fill="transparent"/>
        <path d="M${left},${y} h${w - 4} a4,4 0 0 1 4,4 v3 a4,4 0 0 1 -4,4 h-${w - 4} z" fill="var(${s.color})"/>
        ${j === series.length - 1 || v < 0.999 ? `<text class="val" x="${left + w + 4}" y="${y + 9}">${pct(v, 0)}</text>` : ''}</g>`;
    }).join('');
  }).join('');
  return `<div class="chart"><div class="legend">${series.map(s => `<span><i style="background:var(${s.color})"></i>${esc(s.name)}</span>`).join('')}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tỷ lệ phát hiện theo loại lỗi">${grid}${bars}</svg></div>`;
}
function wireTips(root) {
  const tip = $('#tip');
  root.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('mousemove', e => { tip.textContent = el.dataset.tip; tip.hidden = false; tip.style.left = Math.min(e.clientX + 12, innerWidth - 290) + 'px'; tip.style.top = e.clientY + 12 + 'px'; });
    el.addEventListener('mouseleave', () => tip.hidden = true);
  });
}

async function renderEval() {
  const v = $('#view-eval');
  const { evaluation: E, stale, models: loaded } = await api('/api/evaluation');
  if (!E) { v.innerHTML = '<div class="notice">Chưa có báo cáo đánh giá (reports/evaluation-comparison.json). Chạy <span class="mono">node scripts/evaluate-comparison.mjs</span>.</div>'; return; }
  const key = [
    ['autoApproveRate', 'Đủ điều kiện tự duyệt', 'cao hơn = bớt việc duyệt tay'],
    ['falsePassPerAutoApproved', 'Cho qua nhầm / phiếu tự duyệt', 'thấp hơn = an toàn hơn'],
    ['missedSampleErrors', 'Lỗi mẫu/phân tích bị cho qua', 'thấp hơn = an toàn hơn'],
    ['holdCleanOther', 'Báo động giả', 'phiếu không lỗi bị giữ bởi delta/nhất quán/mô hình']
  ];
  const more = [['missedAmongNeedsReview', 'Ca cần xem xét bị cho qua'], ['unnecessaryHold', 'Giữ phiếu không lỗi (tổng)'], ['holdCleanPolicyOnly', '· do rule chính sách'], ['blockedRate', 'Tỷ lệ bị chặn']];
  const cell = r => `${pct(r.value)}<div class="muted small">${r.k}/${r.n}</div>`;
  const ci = r => `${pct(r.value)} <span class="muted small">(${pct(r.ci95[0])}–${pct(r.ci95[1])})</span>`;
  const series = [{ key: 'ruleOnly', label: 'Chỉ rule', color: '--series-1' }, { key: 'ruleModel', label: 'Rule + mô hình', color: '--series-2' }];
  const disc = (k, label) => {
    const D = E.disciplines[k], types = Object.entries(D.perErrorType);
    return `<div class="card"><h3>${label}</h3><p class="muted small">Tập test: ${D.reports} phiếu. ${esc(E.endToEndNote)}</p>
      <div class="tablewrap"><table class="results"><thead><tr><th>Chỉ số</th>${series.map(x => `<th class="num">${x.label}</th>`).join('')}</tr></thead><tbody>${key.map(([m, l, n]) => `<tr><td>${l}<div class="muted small">${n}</div></td>${series.map(x => `<td class="num">${cell(D[x.key][m])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <h4 class="sub-h">Ngưỡng chung vs ngưỡng cá nhân</h4><div class="tablewrap"><table class="results"><thead><tr><th>Cấu hình</th><th class="num">Tự duyệt</th><th class="num">Lỗi bị cho qua</th><th class="num">Báo động giả</th></tr></thead><tbody>
        ${D.variants.map(x => `<tr><td>${{ OFF: 'Ngưỡng chung', TIGHTEN: 'Cá nhân: siết', ADAPT: 'Cá nhân: siết + nới' }[x.personalMode]}${x.modelEnabled ? ' + mô hình' : ''}</td><td class="num">${pct(x.autoApproveRate.value)}</td><td class="num">${pct(x.missedSampleErrors.value)}</td><td class="num">${pct(x.holdCleanOther.value)}</td></tr>`).join('')}</tbody></table></div>
      <h4 class="sub-h">Tỷ lệ phát hiện theo loại lỗi</h4><p class="muted small">n là số phiếu mang loại lỗi đó (một phiếu có thể có nhiều lỗi).</p>
      ${barChart(types.map(([t, x]) => ({ label: ERR_TXT[t] ?? t, n: x.n, values: [x.ruleOnlyCaught.value, x.ruleModelCaught.value], counts: [x.ruleOnlyCaught.k, x.ruleModelCaught.k] })), series.map(x => ({ name: x.label, color: x.color })))}
      ${fold('Thêm chỉ số, khoảng tin cậy, mức dùng mô hình', `<table class="results"><thead><tr><th>Chỉ số</th>${series.map(x => `<th class="num">${x.label}</th>`).join('')}</tr></thead><tbody>${[...key.map(([m, l]) => [m, l]), ...more].map(([m, l]) => `<tr><td>${l}</td>${series.map(x => `<td class="num">${ci(D[x.key][m])}</td>`).join('')}</tr>`).join('')}</tbody></table>
        <table class="results"><thead><tr><th>Mô hình</th><th class="num">Chấm điểm</th><th class="num">Không đánh giá được</th><th class="num">Ngoài phạm vi</th><th class="num">Gắn cờ</th><th class="num">Giữ thêm (rule cho qua)</th></tr></thead><tbody>${Object.entries(D.modelUse).map(([m, u]) => `<tr><td class="mono small">${esc(m)}</td><td class="num">${u.scored}</td><td class="num">${u.notEvaluable}</td><td class="num">${u.outOfScope}</td><td class="num">${u.flagged}</td><td class="num">${u.flaggedRuleAuto}</td></tr>`).join('')}</tbody></table>`)}
    </div>`;
  };
  const B = E.benchmark;
  const algoName = { logreg: 'Logistic regression', xgboost: 'XGBoost (CV)', xgb_teammate: 'XGBoost — cấu hình PR #2', lightgbm: 'LightGBM', gaussian: 'Gaussian đa biến', knn: 'KNN', ocsvm: 'One-class SVM' };
  const brow = (name, r) => r ? `<tr><td>${name}</td><td class="num">${num(r.prAuc)}</td><td class="num">${pct(r.sensitivity?.value)}</td><td class="num">${r.addedCatchOfRuleMissed ? `${r.addedCatchOfRuleMissed.k}/${r.addedCatchOfRuleMissed.n}` : '—'}</td><td class="num">${r.extraFalseAlarmOnCleanRuleAuto ? pct(r.extraFalseAlarmOnCleanRuleAuto.value) : '—'}</td></tr>` : '';
  const bhead = '<thead><tr><th>Thuật toán</th><th class="num">PR-AUC</th><th class="num">Độ nhạy</th><th class="num">Bắt thêm (rule bỏ sót)</th><th class="num">Báo động giả thêm</th></tr></thead>';
  const bench = !B ? '' : `<h3 class="section-h">Benchmark ngoại tuyến (Python): so sánh thuật toán</h3>
    <div class="notice">${esc(B.disclaimer)} ${esc(B.data.note)} Mô hình đang nạp: ${loaded.length ? loaded.map(m => `<span class="mono small">${esc(m.key)}</span>`).join(', ') : '<b>không có — app đang chạy chỉ bằng rule</b>'}. Không triển khai: ${Object.entries(B.notDeployed).map(([k, t]) => `<span class="mono small">${esc(k)}</span> (${esc(t)})`).join('; ')}</div>
    <div class="grid-2">${Object.entries(B.detectors).map(([k, d]) => `<div class="card"><h3>${esc(d.name)}</h3><p class="muted small">Test: ${d.split.test.n} phiếu, ${d.split.test.positives} ca dương tính. Được chọn: <b>${esc(algoName[B.selection[k]?.chosen] ?? '—')}</b>${B.deployed[k] ? ' (đang dùng)' : ' (không triển khai)'}. <span class="muted">${esc(B.selection[k]?.reason ?? '')}</span></p>
      <div class="tablewrap"><table class="results">${bhead}<tbody>${Object.entries(d.algorithms).map(([al, r]) => brow(algoName[al], r)).join('')}</tbody></table></div></div>`).join('')}</div>
    <h3 class="section-h">Phát hiện bất thường — người khám lần đầu (ngưỡng gắn cờ 5%)</h3>
    <div class="grid-3">${Object.entries(B.firstVisitAnomaly).map(([pn, d]) => `<div class="card"><h3>${esc(pn)}</h3><p class="muted small">${d.testFirstVisit} phiếu không có lịch sử ≤90 ngày, ${d.testPositives} ca nhiễm mẫu/lỗi phân tích.</p>
      <div class="tablewrap"><table class="results">${bhead}<tbody>${Object.entries(d.models).map(([al, r]) => brow(algoName[al], r)).join('')}</tbody></table></div></div>`).join('')}</div>
    ${fold('Chính sách người khám lần đầu có kết quả bất thường (đề xuất, chờ khoa)', `<p class="small">Mặc định <b>ALWAYS_REVIEW</b> (luôn chuyển người duyệt). <b>MODEL_FLAG_ONLY</b> chỉ chạy trong benchmark, không có trên giao diện.</p>
      <table class="results"><thead><tr><th>Chính sách</th><th class="num">Tự duyệt</th><th class="num">Lỗi bị cho qua</th></tr></thead><tbody>${Object.entries(B.firstVisitPolicy.policies).map(([nm, x]) => `<tr><td>${nm}</td><td class="num">${cell(x.autoApprove)}</td><td class="num">${cell(x.missedSampleErrors)}</td></tr>`).join('')}</tbody></table>
      <p class="muted small">MODEL_FLAG_ONLY thả thêm ${B.firstVisitPolicy.releasedByModelFlagOnly.n} phiếu, trong đó ${B.firstVisitPolicy.releasedByModelFlagOnly.withSampleError} phiếu có lỗi.</p>`)}`;
  const staleNote = stale ? `<div class="notice"><b>Báo cáo này không khớp với mô hình/rule đang chạy</b> (đã đổi models/ hoặc config/ sau khi tính). Số liệu "Rule + mô hình" có thể sai; chạy lại <span class="mono">npm run evaluate</span>. Mô hình đang nạp: ${loaded.length ? loaded.map(m => esc(m.key)).join(', ') : 'không có (chỉ rule)'}.</div>` : '';
  v.innerHTML = `${staleNote}<div class="notice">${esc(E.disclaimer)} Mô hình chỉ được phép giữ thêm phiếu, không thể vượt qua điều kiện chặn hay tự duyệt — điều cần chứng minh là bắt thêm lỗi với mức tăng việc duyệt tay chấp nhận được.</div>
    <div class="grid-2">${disc('CHEM', 'Hóa sinh')}${disc('HEME', 'Huyết học (CBC)')}</div>${bench}
    ${fold('Định nghĩa chỉ số', `<ul class="plain">${Object.entries(E.definitions).map(([k, d]) => `<li><span class="mono small">${k}</span> — ${esc(d)}</li>`).join('')}</ul>`)}`;
  wireTips(v);
}
// ---------------- feedback / audit ----------------
async function renderFeedback() {
  const fb = await api('/api/feedback');
  const agree = fb.filter(f => f.agreement === 'ĐỒNG Ý').length;
  $('#view-feedback').innerHTML = `<div class="notice">Mỗi quyết định của bác sĩ (ký / xem xét lại / chạy lại) được lưu cạnh đề xuất của hệ thống và phiên bản rule/mô hình. Phản hồi <b>không</b> thay đổi rule đang chạy: rà soát nhãn → huấn luyện ngoại tuyến → đánh giá độc lập → phê duyệt phiên bản mới.</div>
    <div class="stats static"><div class="stat"><span>Bản ghi phản hồi</span><strong>${fb.length}</strong></div><div class="stat"><span>Đồng ý với hệ thống</span><strong>${agree}</strong></div><div class="stat"><span>Khác hệ thống</span><strong>${fb.length - agree}</strong></div><div class="stat"><span>Yêu cầu chạy lại</span><strong>${fb.filter(f => f.reviewerAction === 'REQUEST_RERUN').length}</strong></div></div>
    <div class="row-end"><a class="btn" href="/api/feedback.csv" download>Xuất CSV</a></div>
    ${fb.length ? `<div class="card flush"><div class="tablewrap"><table class="results"><thead><tr><th>Phiếu</th><th>Hệ thống đề xuất</th><th>Bác sĩ</th><th>Lý do / ghi chú</th><th>Nhãn</th></tr></thead><tbody>
    ${[...fb].reverse().map(f => `<tr><td><a href="#" data-open="${esc(f.reportId)}">${esc(f.reportId)}</a> <span class="muted">v${esc(f.version)}</span></td><td>${badge(f.systemDecision, true)}</td>
      <td>${esc(ACTION_LABEL[f.reviewerAction])} ${f.agreement === 'ĐỒNG Ý' ? '' : '<span class="tag gold">khác</span>'}</td><td>${f.tests?.length ? `Chạy lại: ${esc(f.tests.join(", "))}. ` : ""}${esc(f.reasonCode ? REASON_TXT[f.reasonCode] ?? f.reasonCode : "—")}${f.note ? `<div class="muted small">${esc(f.note)}</div>` : ''}</td><td><span class="tag">${esc(f.labelStatus)}</span></td></tr>`).join('')}</tbody></table></div></div>` : '<div class="card"><p class="empty">Chưa có phản hồi. Mở một phiếu và bấm Ký / Cần xem xét lại / Yêu cầu chạy lại mẫu.</p></div>'}`;
  document.querySelectorAll('[data-open]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); showView('worklist'); select(a.dataset.open); }));
}

async function renderAudit() {
  const list = await api('/api/audit');
  $('#view-audit').innerHTML = `<div class="row-between"><p class="muted">Đánh giá, thao tác, gửi/ACK và thay đổi cấu hình (500 sự kiện gần nhất).</p><button class="btn danger" type="button" id="reset">Xóa trạng thái demo</button></div>
    ${list.length ? `<div class="card flush"><div class="tablewrap"><table class="results"><thead><tr><th>Thời điểm</th><th>Sự kiện</th><th>Phiếu</th><th>Nội dung</th></tr></thead><tbody>
    ${list.map(a => `<tr><td class="muted">${fmtTime(a.at)}</td><td><span class="mono small">${esc(a.type)}</span><div class="muted small">${esc(a.actor)}</div></td><td>${a.reportId ? esc(a.reportId) + (a.version ? ' v' + esc(a.version) : '') : '—'}</td><td>${esc(a.note ?? '')}</td></tr>`).join('')}</tbody></table></div></div>` : '<div class="card"><p class="empty">Chưa có sự kiện.</p></div>'}`;
  $('#reset').addEventListener('click', async () => { if (!confirm('Xóa toàn bộ phản hồi, nhật ký và phiên bản sửa của demo?')) return; try { await post('/api/reset'); toast('Đã xóa trạng thái demo'); tab = 'todo'; await refresh(); renderAudit(); } catch (err) { toast(err.message, 'error'); } });
}

// ---------------- rules (human-readable) ----------------
let rulesTab = 'CHEM';
const TODO = {
  BLOCK: 'Hệ thống đề xuất chưa ký: bác sĩ bấm "Yêu cầu chạy lại mẫu" (hoặc xử lý dữ liệu/QC). Kết quả mới thành phiên bản mới, hệ thống đọc lại và phiếu quay về chờ duyệt.',
  REVIEW: 'Dòng kết quả liên quan được tô màu kèm lý do. Bác sĩ đọc và quyết định: Ký, Cần xem xét lại hoặc Yêu cầu chạy lại mẫu.',
  CRITICAL: 'Thông báo lâm sàng ngay; khi ký, bác sĩ tick "Đã thông báo giá trị tới hạn cho lâm sàng".'
};
async function renderRules() {
  const { rulesets, catalog } = await api('/api/rules');
  const s = rulesets[rulesTab];
  const byOutcome = k => s.rules.filter(r => r.onFail === k).length;
  const groups = [];
  for (const r of s.rules) { const g = STAGE_TXT[r.stage] ?? r.stage; let grp = groups.find(x => x.name === g); if (!grp) groups.push(grp = { name: g, rules: [] }); grp.rules.push(r); }
  $('#view-rules').innerHTML = `
    <div class="row-between wrap">
      <div class="seg tabs-seg" role="tablist">${[['CHEM', 'Hóa sinh'], ['HEME', 'Huyết học (CBC)']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${rulesTab === k}" data-rt="${k}">${l}</button>`).join('')}</div>
      <div class="legend-out">${outcomeBadge('BLOCK')} <span class="muted small">đề xuất chưa ký</span> ${outcomeBadge('REVIEW')} <span class="muted small">tô màu để bác sĩ chú ý</span> ${outcomeBadge('CRITICAL')} <span class="muted small">ưu tiên, phải báo lâm sàng</span></div>
    </div>
    <div class="card ruleset-head"><div><h3>${esc(s.rulesetId)} <span class="muted mono small">${esc(s.version)}</span></h3><p class="muted small">${esc(s.note)}</p></div>
      <dl class="kv compact"><dt>Trạng thái</dt><dd><span class="tag gold">${esc(s.status)}</span></dd><dt>Người phê duyệt</dt><dd>${s.approvedBy ? esc(s.approvedBy) : '<b>Chưa có</b>'}</dd><dt>Hiệu lực từ</dt><dd>${esc(s.effectiveFrom)}</dd>
      <dt>Số rule</dt><dd>${s.rules.length} — ${byOutcome('BLOCK')} chặn · ${byOutcome('REVIEW')} chuyển xem · ${byOutcome('CRITICAL')} tới hạn</dd></dl></div>
    <p class="muted small">Đánh giá theo thứ tự từ trên xuống. Một phiếu bị <b>chặn</b> nếu có bất kỳ rule chặn nào; nếu không, phiếu <b>có điểm cần chú ý</b> nếu có rule chuyển xem/tới hạn. Đây chỉ là đề xuất: mọi phiếu đều do bác sĩ đọc và ký.</p>
    ${groups.map((g, gi) => `<section class="rule-group"><h3 class="section-h"><span class="step">${gi + 1}</span>${esc(g.name)}</h3>
      ${g.rules.map(r => { const dsc = describeRule(r, { catalog, discipline: rulesTab, models: meta.models });
        return `<article class="rule-card"><header><div><span class="code">${esc(r.code)}</span><h4>${esc(r.name)}</h4></div>${outcomeBadge(r.onFail)}</header>
          <div class="rule-when"><span class="lbl-when">${OUTCOME[r.onFail]?.label ?? ''} khi</span><p>${dsc.when}</p></div>
          ${dsc.extra ? `<p class="rule-extra">${dsc.extra}</p>` : ''}
          <p class="rule-missing"><span class="lbl-when">Việc cần làm</span><span>${TODO[r.onFail] ?? ''}</span></p>
          <p class="rule-missing"><span class="lbl-when">Thiếu dữ liệu</span><span>${r.onNotEvaluable === 'IGNORE' ? 'Rule không áp dụng (hiển thị rõ, không coi là đạt).' : `${OUTCOME[r.onNotEvaluable].label}.`} ${dsc.missing ?? ''}</span></p>
          ${dsc.details ? fold('Ngưỡng chi tiết', dsc.details) : ''}</article>`; }).join('')}</section>`).join('')}
    <p class="muted small">Engine chỉ diễn giải các loại rule định nghĩa sẵn (không dùng eval). Mọi ngưỡng là minh họa, phải được người phụ trách chuyên môn xác nhận.</p>`;
  document.querySelectorAll('[data-rt]').forEach(b => b.addEventListener('click', () => { rulesTab = b.dataset.rt; renderRules(); }));
}

boot().catch(e => { $('#detail').innerHTML = `<div class="empty">Không tải được dữ liệu: ${esc(e.message)}</div>`; });
