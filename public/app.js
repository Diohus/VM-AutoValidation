// LabReview demo UI. All data synthetic. Every user/LIS string is escaped before rendering.
// Layout: sidebar navigation; primary information first, details behind progressive disclosure.
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
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 4500); }

const DECISION = {
  AUTO_APPROVE_ELIGIBLE: { label: 'Đủ điều kiện tự duyệt', short: 'Tự duyệt', cls: 'auto', icon: '✓' },
  MANUAL_REVIEW: { label: 'Cần người xem xét', short: 'Cần xem', cls: 'review', icon: '!' },
  BLOCKED: { label: 'Bị chặn', short: 'Bị chặn', cls: 'blocked', icon: '■' }
};
const badge = (d, short = false) => { const x = DECISION[d]; return `<span class="badge ${x.cls}"><span aria-hidden="true">${x.icon}</span>${short ? x.short : x.label}</span>`; };
const STATUS_TXT = { PASS: ['✓', 'Đạt'], FAIL: ['✕', 'Không đạt'], NOT_EVALUABLE: ['?', 'Thiếu dữ liệu'], NOT_APPLICABLE: ['–', 'Không áp dụng'] };
const STAGE_TXT = { DATA: 'Dữ liệu bắt buộc', QC: 'QC', INSTRUMENT: 'Cờ máy', SPECIMEN: 'Mẫu', LIMIT: 'Giới hạn & tới hạn', CRITICAL: 'Giới hạn & tới hạn', HISTORY: 'Lịch sử (delta)', CONSISTENCY: 'Nhất quán giữa chỉ số', MODEL: 'Mô hình phát hiện lỗi (chỉ giữ thêm)' };
const WARD = { OPD: 'Ngoại trú', IPD: 'Nội trú', ER: 'Cấp cứu' };
const RESULT_STATUS = { RESULTED: 'Có kết quả', PENDING: 'Chưa có kết quả', FAILED: 'Máy báo lỗi', TRANSMISSION_ERROR: 'Lỗi truyền dữ liệu', NOT_COLLECTED: 'Không thu được mẫu', NOT_APPLICABLE: 'Không áp dụng' };
const REASON_TXT = {
  CONSISTENT_WITH_HISTORY: 'Phù hợp lịch sử', CONSISTENT_WITH_CONTEXT: 'Phù hợp bối cảnh lâm sàng đã xác minh', RERUN_CONFIRMED: 'Chạy lại xác nhận', CRITICAL_NOTIFIED: 'Tới hạn đã thông báo', OTHER: 'Khác (ghi rõ)',
  SUSPECT_SPECIMEN: 'Nghi vấn mẫu', SUSPECT_WBIT: 'Nghi nhầm mẫu', SUSPECT_INSTRUMENT: 'Nghi vấn máy/phân tích', NEED_CONTEXT: 'Cần thêm bối cảnh',
  RERUN: 'Chạy lại mẫu', RECOLLECT: 'Lấy mẫu lại', CHECK_TUBE_LABEL: 'Kiểm tra ống/nhãn', SMEAR_REVIEW: 'Xem lam máu', CONTACT_WARD: 'Liên hệ khoa lâm sàng', CHECK_INTERFACE_CONFIG: 'Kiểm tra cấu hình giao tiếp',
  PHONE_WARD: 'Đã gọi báo khoa lâm sàng', ALL_CONDITIONS_MET: 'Đạt mọi điều kiện'
};
const ACTION_LABEL = { APPROVE: 'Duyệt & ký', HOLD: 'Giữ lại', REQUEST_CHECK: 'Yêu cầu kiểm tra', NOTIFY_CRITICAL: 'Đã báo tới hạn', AUTO_APPROVE: 'Hệ thống tự duyệt' };
const VERIFY_TXT = { NOT_VERIFIED: 'Chưa xác minh', RERUN_SAME: 'Chạy lại: kết quả tương tự', RERUN_DIFFERENT: 'Chạy lại: kết quả khác biệt', RECOLLECT_DIFFERENT: 'Mẫu mới: kết quả khác biệt', RECOLLECT_SAME: 'Mẫu mới: kết quả tương tự', CLINICAL_CONFIRMED: 'Khoa lâm sàng xác nhận phù hợp' };
const SEND_TXT = { SENDING: ['info', 'Đang gửi, chờ ACK'], ACKED: ['auto', 'Đã ký/gửi (có ACK)'], FAILED: ['blocked', 'Gửi thất bại'], SUPERSEDED: ['neutral', 'Đã có phiên bản mới'] };
const ERR_TXT = { wbit: 'Nhầm mẫu (WBIT)', analytical_single: 'Lỗi phân tích đơn chỉ số', edta: 'Nhiễm EDTA', saline: 'Lẫn NaCl 0,9%', d5w: 'Lẫn glucose 5%', hemolysis: 'Tan máu', delayed: 'Chậm xử lý mẫu', qc_window: 'Đo khi QC không đạt', plt_clump: 'Tiểu cầu kết cụm', clot: 'Cục đông', short_sample: 'Thiếu thể tích mẫu' };
const TITLES = { worklist: 'Hàng đợi duyệt', try: 'Nhập thử kết quả', eval: 'Đánh giá mô hình', feedback: 'Phản hồi chuyên môn', audit: 'Nhật ký', rules: 'Rule & cấu hình' };

let meta, worklist = [], selected = null, current = null, decisionFilter = 'ACTION';

// ---------------- boot & navigation ----------------
async function boot() {
  meta = await api('/api/meta');
  $('#today').textContent = `Ngày ${fmtDate(meta.today + 'T12:00:00+07:00')} (mô phỏng)`;
  $('#mode').value = meta.settings.mode; $('#modelEnabled').checked = meta.settings.modelEnabled; $('#showTruth').checked = meta.settings.showTruth;
  $('#personalMode').value = meta.settings.personalMode ?? 'OFF';
  $('#llmStatus').innerHTML = meta.llm?.configured ? `<span class="dot-on"></span>LLM: ${esc(meta.llm.model)} sẵn sàng` : `<span class="dot-off"></span>LLM chưa cấu hình (.env)`;
  $('#llmStatus').title = meta.llm?.reason ?? '';
  for (const id of ['mode', 'personalMode', 'modelEnabled', 'showTruth']) $('#' + id).addEventListener('change', async e => {
    const v = ['mode', 'personalMode'].includes(id) ? e.target.value : e.target.checked;
    meta.settings = await post('/api/settings', { [id]: v });
    toast(['mode', 'personalMode'].includes(id) ? `${id === 'mode' ? 'Chế độ' : 'Ngưỡng'}: ${e.target.selectedOptions[0].text}` : id === 'modelEnabled' ? (v ? 'Đã bật lớp mô hình' : 'Đã tắt lớp mô hình — chỉ chạy rule') : (v ? 'Đang hiện nhãn giả lập (chỉ dùng để đào tạo/thử)' : 'Đã ẩn nhãn giả lập'));
    await refresh();
  });
  $('#batch').addEventListener('click', async () => {
    const r = await post('/api/batch');
    toast(meta.settings.mode === 'SHADOW' ? `Chạy ngầm: ${r.autoEligible}/${r.evaluated} phiếu đủ điều kiện — chỉ ghi đề xuất, không ký.` : `Tự ký mô phỏng: đã gửi ${r.sent} phiếu, chờ ACK.`);
    await refresh(); setTimeout(refresh, 2200);
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
  $('#menuBtn').addEventListener('click', () => { const open = !document.body.classList.contains('menu-open'); document.body.classList.toggle('menu-open', open); $('#menuBtn').setAttribute('aria-expanded', String(open)); });
  for (const id of ['fDisc', 'fScenario', 'fSearch']) $('#' + id).addEventListener('input', renderList);
  $('#fScenario').checked = true; decisionFilter = 'all';
  await refresh();
  const h = location.hash.slice(1);
  const linked = location.hash.startsWith('#r=') ? decodeURIComponent(location.hash.slice(3)) : null;
  if (linked && worklist.some(w => w.reportId === linked)) { $('#fScenario').checked = false; renderList(); }
  const first = worklist.find(w => w.reportId === linked) ?? worklist.find(w => w.scenario?.code === 'KB1') ?? worklist[0];
  if (first) await select(first.reportId);
  if (TITLES[h] && h !== 'worklist') showView(h);
}
function closeMenu() { document.body.classList.remove('menu-open'); $('#menuBtn').setAttribute('aria-expanded', 'false'); }

function showView(v) {
  if (history.replaceState) history.replaceState(null, '', v === 'worklist' ? location.pathname : '#' + v);
  document.querySelectorAll('.nav button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  document.querySelectorAll('.view').forEach(s => s.hidden = s.id !== 'view-' + v);
  $('#pageTitle').textContent = TITLES[v];
  $('#batch').hidden = v !== 'worklist';
  ({ try: renderTry, eval: renderEval, feedback: renderFeedback, audit: renderAudit, rules: renderRules }[v])?.();
}

async function refresh() {
  worklist = await api('/api/worklist');
  renderStats(); renderList();
  if (selected) await select(selected);
}

// ---------------- worklist ----------------
function renderStats() {
  const c = d => worklist.filter(w => w.decision === d).length;
  const tiles = [
    ['all', 'Tất cả phiếu', worklist.length, ''],
    ['CRITICAL', 'Giá trị tới hạn', worklist.filter(w => w.criticalValue).length, 'crit'],
    ['BLOCKED', 'Bị chặn', c('BLOCKED'), 'blocked'],
    ['MANUAL_REVIEW', 'Cần người xem', c('MANUAL_REVIEW'), 'review'],
    ['AUTO_APPROVE_ELIGIBLE', 'Đủ điều kiện tự duyệt', c('AUTO_APPROVE_ELIGIBLE'), 'auto']
  ];
  $('#navCount').textContent = worklist.filter(w => w.decision !== 'AUTO_APPROVE_ELIGIBLE' && !w.review).length || '';
  $('#stats').innerHTML = tiles.map(([k, label, n, cls]) => `<button type="button" class="stat ${cls} ${decisionFilter === k ? 'active' : ''}" data-filter="${k}" aria-pressed="${decisionFilter === k}"><span>${label}</span><strong>${n}</strong></button>`).join('');
  document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { decisionFilter = b.dataset.filter; renderStats(); renderList(); }));
}

function renderList() {
  const fdisc = $('#fDisc').value, fs = $('#fScenario').checked, q = $('#fSearch').value.trim().toLowerCase();
  const order = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  const items = worklist.filter(w => (decisionFilter === 'all' || (decisionFilter === 'CRITICAL' ? w.criticalValue : w.decision === decisionFilter)) && (fdisc === 'all' || w.discipline === fdisc) && (!fs || w.scenario)
    && (!q || [w.reportId, w.subjectToken, w.panelName, w.scenario?.title, w.scenario?.code].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => order[a.priority] - order[b.priority] || (a.scenario?.code ?? 'ZZ').localeCompare(b.scenario?.code ?? 'ZZ', 'vi', { numeric: true }) || a.collectedAt.localeCompare(b.collectedAt));
  $('#list').innerHTML = items.length ? items.map(w => `
    <button class="item ${w.reportId === selected ? 'selected' : ''} pri-${w.criticalValue ? 'crit' : DECISION[w.decision].cls}" data-id="${esc(w.reportId)}" type="button">
      <span class="item-top"><strong>${esc(w.scenario?.title ?? w.panelName)}</strong>${w.criticalValue ? '<span class="badge crit">⚠ Tới hạn</span>' : badge(w.decision, true)}</span>
      <span class="item-sub">${esc(w.scenario?.code ? w.scenario.code + ' · ' : '')}${esc(w.reportId)} · ${w.discipline === 'CHEM' ? 'Hóa sinh' : 'Huyết học'} · ${fmtHour(w.collectedAt)}${w.version > 1 ? ` · v${w.version}` : ''}
        ${w.send ? ` · <span class="status-txt ${SEND_TXT[w.send.status][0]}">${SEND_TXT[w.send.status][1]}</span>` : w.review ? ` · <span class="status-txt neutral">${esc(ACTION_LABEL[w.review.action])}</span>` : ''}</span>
    </button>`).join('') : '<div class="empty">Không có phiếu phù hợp bộ lọc.</div>';
  document.querySelectorAll('.item').forEach(b => b.addEventListener('click', () => select(b.dataset.id)));
}

async function select(id) {
  selected = id;
  if (history.replaceState && !$('#view-worklist').hidden) history.replaceState(null, '', '#r=' + encodeURIComponent(id));
  document.querySelectorAll('.item').forEach(b => b.classList.toggle('selected', b.dataset.id === id));
  current = await api('/api/reports/' + encodeURIComponent(id));
  renderDetail();
}

// ---------------- report detail ----------------
// Short, scannable reason: rule name + compact message (full text stays in "Các bước kiểm tra").
function reasonList(ev) {
  const failing = ev.checks.filter(c => c.action);
  if (!failing.length) return '';
  const order = { BLOCK: 0, CRITICAL: 1, REVIEW: 2 };
  return `<ul class="reasons">${failing.sort((a, b) => order[a.action] - order[b.action]).map(c => `<li class="r-${c.action}"><span class="r-ic" aria-hidden="true">${OUTCOME[c.action].icon}</span>
    <div><strong>${esc(c.name)}</strong><span>${esc(c.message.split('. Ngoài khoảng tham chiếu')[0])}</span></div></li>`).join('')}</ul>`;
}

function resultsTable(d, ev, { collapse = true } = {}) {
  const r = d.report, info = d.analyteInfo, hist = d.history ?? {};
  const okCount = r.orderedTests.filter(t => (ev.analyteStatus[t] ?? 'OK') === 'OK').length;
  const folded = collapse && okCount > 0 && okCount < r.orderedTests.length;
  const toggle = folded ? `<button type="button" class="link-btn" data-toggle-ok>Hiện ${okCount} kết quả bình thường khác</button>` : '';
  return `<div class="tablewrap"><table class="results ${folded ? 'collapsed' : ''}"><thead><tr><th>Xét nghiệm</th><th class="num">Kết quả</th><th>Đơn vị</th><th>Tham chiếu</th>${ev.personal ? '<th>Khoảng cá nhân</th>' : ''}<th>Lần trước</th><th class="center">Trạng thái</th></tr></thead><tbody>
  ${r.orderedTests.map(t => {
    const x = r.results.find(q => q.test === t), i = info[t], st = ev.analyteStatus[t] ?? 'OK';
    const out = x && typeof x.value === 'number' && x.unit === i.unit && (x.value < i.ref[0] || x.value > i.ref[1]);
    const prev = (hist[t] ?? []).at?.(-1);
    const stIc = { OK: '<span class="dot ok" title="Đạt" aria-label="Đạt">✓</span>', REVIEW: '<span class="dot review" title="Cần xem" aria-label="Cần xem">!</span>', CRITICAL: '<span class="dot crit" title="Tới hạn" aria-label="Tới hạn">⚠</span>', BLOCKED: '<span class="dot blocked" title="Bị chặn" aria-label="Bị chặn">■</span>' }[st];
    const valTxt = !x ? '<span class="muted">Không có</span>' : x.status !== 'RESULTED' ? `<span class="status-txt blocked">${esc(RESULT_STATUS[x.status] ?? x.status)}</span>` : `<span class="${out ? 'val-out' : ''}">${val(x.value)}${out ? (x.value > i.ref[1] ? ' ↑' : ' ↓') : ''}</span>`;
    const unitTxt = !x ? '' : !x.unit ? '<span class="status-txt blocked">thiếu</span>' : x.unit !== i.unit ? `<span class="status-txt blocked">${esc(x.unit)}</span>` : esc(x.unit);
    return `<tr class="st-${st} ${st === 'OK' ? 'okrow' : ''}"><td>${esc(i.name)}</td><td class="num">${valTxt}</td><td class="muted">${unitTxt}</td><td class="muted">${val(i.ref[0])} – ${val(i.ref[1])}</td>
      ${ev.personal ? `<td>${personalCell(ev.personal[t], i)}</td>` : ''}
      <td class="muted">${prev ? `${val(prev.value)} <small>(${fmtDate(prev.measuredAt)})</small>` : '—'}</td><td class="center">${stIc}</td></tr>`;
  }).join('')}</tbody></table></div>${toggle}`;
}
// Delegated toggle for "show normal results".
document.addEventListener('click', e => {
  const b = e.target.closest('[data-toggle-ok]');
  if (!b) return;
  const t = b.previousElementSibling?.querySelector('table');
  if (!t) return;
  b.dataset.label ??= b.textContent;
  b.textContent = t.classList.toggle('collapsed') ? b.dataset.label : 'Ẩn kết quả bình thường';
});

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
  if (!ev.modelEnabled) return '<p class="muted">Lớp mô hình đang tắt — quyết định chỉ dựa trên rule.</p>';
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
      <div class="small">Điểm <b>${num(m.score)}</b> / ngưỡng ${num(m.threshold)} — ${m.flagged ? '<b>giữ thêm để xem</b>' : 'không gắn cờ'}${why}</div>${meta}</div></div>`;
  }).join('') + '<p class="muted small">Điểm phát hiện trên dữ liệu giả lập, không phải xác suất an toàn. Mô hình chỉ có thể giữ thêm phiếu, không chặn và không tự duyệt. Thiếu dữ liệu then chốt → "không đánh giá được", không bao giờ là "đạt".</p>';
}

function contextBlock(r) {
  const c = r.context;
  const li = (arr, f) => arr?.length ? arr.map(f).join('') : '<li class="muted">Chưa ghi nhận</li>';
  const yn = { YES: 'Có', NO: 'Không', UNKNOWN: 'Không rõ' };
  return `<div class="kv-grid">
    <div><h4>Người bệnh (không định danh)</h4><dl class="kv"><dt>Mã giả</dt><dd class="mono">${esc(r.subjectToken)}</dd><dt>Nhóm tuổi</dt><dd>${esc(c.ageGroup || c.age)}</dd><dt>Giới</dt><dd>${c.sex === 'F' ? 'Nữ' : 'Nam'}</dd><dt>Nhịn ăn</dt><dd>${yn[c.fasting]}</dd><dt>Truyền dịch</dt><dd>${yn[c.ivInfusion]}</dd></dl>
      <h4>Bệnh nền · thuốc · sự kiện</h4><ul class="plain">${li([...c.conditions.map(x => ({ t: x.label, d: x.knownAt })), ...c.medications.map(x => ({ t: x.label, d: x.startedAt })), ...c.events.map(x => ({ t: x.label, d: x.at }))], x => `<li>${esc(x.t)} <span class="muted">· ${fmtDate(x.d)}</span></li>`)}</ul>
      <p class="muted small">Bối cảnh chỉ hỗ trợ người duyệt; hệ thống không dùng riêng chẩn đoán để quyết định ký.</p></div>
    <div><h4>Mẫu & thiết bị</h4><dl class="kv"><dt>Mã mẫu</dt><dd class="mono">${esc(r.specimen.specimenId)}</dd><dt>Lấy / nhận</dt><dd>${fmtHour(r.specimen.collectedAt)} / ${fmtHour(r.specimen.receivedAt)}</dd><dt>Đo</dt><dd>${fmtHour(r.results.find(x => x.measuredAt)?.measuredAt)}</dd>
      ${r.discipline === 'CHEM' ? `<dt>HIL</dt><dd>${r.specimen.hil ? `H ${esc(r.specimen.hil.H)} · L ${esc(r.specimen.hil.L)} · I ${esc(r.specimen.hil.I)}` : '<span class="status-txt blocked">Thiếu</span>'}</dd>` : ''}
      <dt>Cờ máy</dt><dd>${r.instrumentFlags.length ? r.instrumentFlags.map(f => `<span class="tag review">${esc(f.code)}</span>`).join(' ') : 'Không có'}</dd>
      <dt>Máy</dt><dd>${[...new Set(r.results.map(x => x.instrument))].map(esc).join(', ')}</dd></dl>
      ${current.qcRelevant.length ? `<p class="small">QC hôm nay: ${current.qcRelevant.map(q => `${esc(q.test)} ${fmtHour(q.at)} ${q.status === 'PASS' ? 'đạt' : '<b>không đạt</b>'}`).join(' · ')}</p>` : ''}</div></div>`;
}

function sendBlock(d) {
  const s = d.send.current;
  const sup = d.send.superseded.length ? `<p class="muted small">Phiên bản cũ: ${d.send.superseded.map(x => `${esc(x.key)} — ${esc(SEND_TXT[x.status]?.[1] ?? x.status)}`).join('; ')}. ACK của phiên bản cũ không xác nhận phiên bản hiện tại.</p>` : '';
  if (!s) return `<p class="muted">Chưa gửi. "Đã ký/đã gửi" chỉ hiện khi hệ thống tiếp nhận (mô phỏng) trả ACK.</p>${sup}`;
  return `<p><span class="badge ${SEND_TXT[s.status][0]}">${SEND_TXT[s.status][1]}</span> <span class="muted small mono">${esc(s.idempotencyKey)} · lần ${s.attempts}${s.ackId ? ' · ' + esc(s.ackId) : ''}</span></p>
    ${s.status === 'FAILED' ? `<p class="small">${esc(s.error)}</p><button class="btn" type="button" id="retrySend">Gửi lại</button>` : ''}${sup}`;
}

function timeline(list) {
  if (!list.length) return '<p class="muted">Chưa có sự kiện.</p>';
  return `<ul class="timeline">${[...list].reverse().map(a => `<li><span class="t">${fmtHour(a.at)}</span><span><b>${esc(a.type)}</b>${a.version ? ' · v' + esc(a.version) : ''} — ${esc(a.actor)}<br><span class="muted">${esc(a.note ?? '')}</span></span></li>`).join('')}</ul>`;
}

function actionPanel(d, ev) {
  const crit = ev.criticalValue, notified = d.review?.criticalNotified;
  const acts = [...(crit ? ['NOTIFY_CRITICAL'] : []), 'APPROVE', 'HOLD', 'REQUEST_CHECK'];
  const disabled = a => a === 'APPROVE' && (ev.decision === 'BLOCKED' || (crit && !notified));
  const def = crit && !notified ? 'NOTIFY_CRITICAL' : ev.decision === 'BLOCKED' ? 'REQUEST_CHECK' : ev.decision === 'AUTO_APPROVE_ELIGIBLE' ? 'APPROVE' : 'HOLD';
  const hint = ev.decision === 'BLOCKED' ? 'Phiếu bị chặn: xử lý bằng "Cập nhật kết quả" (chạy lại, sửa đơn vị, lấy mẫu mới) rồi hệ thống đánh giá lại.'
    : crit && !notified ? 'Giá trị tới hạn: ghi nhận đã thông báo lâm sàng trước khi duyệt.' : '';
  return `<form class="action-panel" id="actForm">
    <div class="seg" role="radiogroup" aria-label="Hành động">${acts.map(a => `<label class="${disabled(a) ? 'disabled' : ''}"><input type="radio" name="action" value="${a}" ${a === def ? 'checked' : ''} ${disabled(a) ? 'disabled' : ''}><span>${ACTION_LABEL[a]}</span></label>`).join('')}</div>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
    <div class="form-grid">
      <label>Lý do <select name="reasonCode" id="reasonCode"></select></label>
      <label>Xác minh <select name="verification">${Object.entries(VERIFY_TXT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="span2">Ghi chú <textarea name="note" maxlength="1000" rows="2" placeholder="Bắt buộc khi giữ lại / yêu cầu kiểm tra"></textarea></label>
    </div>
    <div class="row-between"><span class="muted small">Phản hồi được lưu để rà soát; rule đang chạy không thay đổi.</span><button class="btn primary" type="submit">Ghi nhận</button></div>
  </form>`;
}

function amendForm(d, ev) {
  const r = d.report;
  const problem = new Set(ev.checks.filter(c => c.action).flatMap(c => c.analytes));
  const tests = [...r.orderedTests.filter(t => problem.has(t)), ...r.orderedTests.filter(t => !problem.has(t))];
  return `<form id="amendForm" class="stack">
    <div class="form-grid"><label>Loại cập nhật <select name="kind"><option value="RERUN">Chạy lại mẫu</option><option value="UNIT_FIX">Sửa lỗi đơn vị/giao tiếp</option><option value="RECOLLECT">Lấy mẫu mới</option><option value="MANUAL_CORRECTION">Hiệu chỉnh thủ công</option></select></label>
      <label class="toggle"><input type="checkbox" name="clearFlags"><span>Xóa cờ máy sau chạy lại</span></label></div>
    ${r.discipline === 'CHEM' ? `<div class="form-grid three">${['H', 'L', 'I'].map(k => `<label>HIL mới ${k}<input type="number" name="hil${k}" min="0"></label>`).join('')}</div>` : ''}
    <div class="tablewrap"><table class="results"><thead><tr><th>Xét nghiệm</th><th>Hiện tại</th><th>Giá trị mới</th></tr></thead><tbody>
    ${tests.map(t => { const x = r.results.find(q => q.test === t); return `<tr><td>${esc(d.analyteInfo[t].name)}${problem.has(t) ? ' <span class="tag review">liên quan</span>' : ''}</td><td class="muted">${esc(x?.status === 'RESULTED' ? `${x.value} ${x.unit || '(thiếu đơn vị)'}` : RESULT_STATUS[x?.status] ?? '—')}</td>
      <td><input type="number" step="any" name="v_${esc(t)}" aria-label="Giá trị mới ${esc(t)}" placeholder="${esc(d.analyteInfo[t].unit)}"></td></tr>`; }).join('')}
    </tbody></table></div>
    <label>Lý do cập nhật <textarea name="note" required maxlength="1000" rows="2" placeholder="VD: QC đạt lại lúc 11:40, chạy lại K"></textarea></label>
    <div class="row-end"><button class="btn" type="submit">Lưu phiên bản mới & đánh giá lại</button></div>
  </form>`;
}

const fold = (title, body, { open = false, count = '' } = {}) => `<details class="fold" ${open ? 'open' : ''}><summary><span>${title}</span>${count !== '' ? `<em>${count}</em>` : ''}</summary><div class="fold-body">${body}</div></details>`;

function renderDetail() {
  const d = current, r = d.report, ev = d.evaluation, s = r.scenario, tr = d.simulationTruth;
  const failing = ev.checks.filter(c => c.action).length;
  const passCount = ev.checks.filter(c => c.status === 'PASS').length;
  $('#detail').innerHTML = `
    <header class="detail-head">
      <div><p class="eyebrow">${r.discipline === 'CHEM' ? 'Hóa sinh' : 'Huyết học'} · ${esc(r.panelName)} · ${WARD[r.ward]}</p>
        <h2>${esc(s?.title ?? r.reportId)}</h2>
        <p class="muted small mono">${esc(r.reportId)} · v${r.version} · ${esc(ev.rulesetVersion)} · ${{ OFF: 'ngưỡng chung', TIGHTEN: 'ngưỡng cá nhân (siết)', ADAPT: 'ngưỡng cá nhân (siết + nới)' }[ev.personalMode] ?? ''}</p></div>
      <div class="decision ${ev.criticalValue ? 'crit' : DECISION[ev.decision].cls}"><span class="decision-ic" aria-hidden="true">${ev.criticalValue ? '⚠' : DECISION[ev.decision].icon}</span><div><strong>${DECISION[ev.decision].label}</strong>${ev.criticalValue ? '<span>Ưu tiên: giá trị tới hạn</span>' : '<span>Đơn vị ký: cả phiếu</span>'}</div></div>
    </header>
    ${s ? `<p class="scenario-note"><span class="tag gold">${esc(s.code)}</span> ${esc(s.story)}</p>` : ''}
    <section class="block">
      <h3>${failing ? `Vì sao ${ev.decision === 'BLOCKED' ? 'bị chặn' : 'cần xem'}` : 'Đạt mọi điều kiện'}</h3>
      ${failing ? reasonList(ev) : `<p class="ok-line">✓ ${passCount} kiểm tra đạt, đủ dữ liệu bắt buộc. ${meta.settings.mode === 'SHADOW' ? 'Chế độ chạy ngầm: chỉ ghi đề xuất.' : 'Sẽ được ký mô phỏng khi chạy lô.'}</p>`}
      ${llmBlock()}
    </section>
    <section class="block"><h3>Kết quả <span class="muted small">${r.results.filter(x => x.status === 'RESULTED').length}/${r.orderedTests.length} chỉ số</span></h3>${resultsTable(d, ev)}</section>
    <section class="block"><h3>Thao tác</h3>
      ${d.review ? `<p class="done-line">Đã ghi nhận: <b>${esc(ACTION_LABEL[d.review.action])}</b> · ${esc(REASON_TXT[d.review.reasonCode] ?? d.review.reasonCode)} · ${fmtHour(d.review.at)}${d.review.note ? ' — ' + esc(d.review.note) : ''}</p>` : ''}
      ${actionPanel(d, ev)}
      ${d.send.current || d.send.superseded.length ? `<div class="send-line">${sendBlock(d)}</div>` : ''}
    </section>
    <div class="folds">
      ${fold('Bối cảnh, mẫu & thiết bị', contextBlock(r))}
      ${fold('Tất cả bước kiểm tra', allChecks(ev), { count: `${passCount} đạt · ${failing} không đạt` })}
      ${fold('Mô hình phát hiện lỗi (cục bộ)', modelsBlock(ev), { count: ev.models?.some(m => m.flagged) ? 'có gắn cờ' : '' })}
      ${fold('Cập nhật kết quả (tạo phiên bản mới)', amendForm(d, ev), { open: ev.decision === 'BLOCKED' && !d.amendments.length })}
      ${fold('Ký/gửi & nhật ký phiếu', sendBlock(d) + timeline(d.audit), { count: d.audit.length || '' })}
      ${tr ? fold('Nhãn giả lập (ground truth)', `<dl class="kv"><dt>Lỗi mẫu</dt><dd>${esc(tr.truth.sampleError ? ERR_TXT[tr.truth.sampleError] ?? tr.truth.sampleError : 'Không')}</dd><dt>Lỗi dữ liệu</dt><dd>${esc(tr.truth.dataIssue ?? 'Không')}</dd><dt>Tới hạn</dt><dd>${tr.truth.criticalValue ? 'Có' : 'Không'}</dd><dt>Người duyệt mô phỏng</dt><dd>${esc(tr.simulatedReviewer?.action ?? '—')}</dd><dt>Tập</dt><dd>${esc(tr.split)}</dd></dl>${tr.truth.details ? `<p class="small">${esc(tr.truth.details)}</p>` : ''}<p class="muted small">"Người duyệt đã duyệt" khác "kết quả đúng".</p>`, { open: true }) : ''}
    </div>`;
  wireDetail(d);
}

function llmBlock() {
  const st = meta.llm ?? { configured: false, reason: 'Server chưa hỗ trợ LLM.' };
  return `<div class="llm-box" id="llmBox">
    <div class="row-between"><div><strong>Diễn giải bằng LLM</strong> <span class="muted small">${esc(st.model ?? '')} · tùy chọn</span></div>
      <button type="button" class="btn ghost" id="llmBtn" ${st.configured ? '' : 'disabled'}>Diễn giải</button></div>
    <div id="llmOut" class="small">${st.configured ? '<span class="muted">LLM chỉ diễn giải lý do hệ thống đã đưa ra và gợi ý kiểm tra; không quyết định ký. Dữ liệu gửi đi đã khử định danh.</span>' : `<span class="muted">${esc(st.reason)}</span>`}</div></div>`;
}

function wireDetail(d) {
  $('#llmBtn')?.addEventListener('click', async e => {
    const btn = e.currentTarget; btn.disabled = true; $('#llmOut').innerHTML = '<span class="muted">Đang gọi LLM…</span>';
    try {
      const r = await post(`/api/reports/${encodeURIComponent(d.report.reportId)}/explain`, {});
      $('#llmOut').innerHTML = `<div class="llm-text">${esc(r.text).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replaceAll('\n', '<br>')}</div><p class="muted small">${esc(r.model)} · ${r.latencyMs} ms · ${esc(r.disclaimer)}</p>`;
    } catch (err) { $('#llmOut').innerHTML = `<span class="status-txt blocked">${esc(err.message)}</span>`; }
    finally { btn.disabled = false; }
  });
  const form = $('#actForm');
  const fillReasons = () => { $('#reasonCode').innerHTML = meta.reasons[form.action.value].map(code => `<option value="${code}">${esc(REASON_TXT[code] ?? code)}</option>`).join(''); };
  form.querySelectorAll('input[name=action]').forEach(i => i.addEventListener('change', fillReasons));
  fillReasons();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      current = await post(`/api/reports/${encodeURIComponent(d.report.reportId)}/action`, Object.fromEntries(fd));
      toast(fd.get('action') === 'APPROVE' ? 'Đã duyệt — đang gửi, chờ ACK…' : 'Đã ghi nhận. Rule đang chạy không thay đổi.');
      await refresh(); if (fd.get('action') === 'APPROVE') setTimeout(refresh, 2200);
    } catch (err) { toast(err.message); }
  });
  $('#amendForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const changes = d.report.orderedTests.filter(t => fd.get('v_' + t)).map(t => ({ test: t, value: Number(fd.get('v_' + t)), unit: d.analyteInfo[t].unit }));
    const hil = ['H', 'L', 'I'].every(k => fd.get('hil' + k)) ? { H: Number(fd.get('hilH')), L: Number(fd.get('hilL')), I: Number(fd.get('hilI')) } : null;
    try {
      current = await post(`/api/reports/${encodeURIComponent(d.report.reportId)}/amend`, { kind: fd.get('kind'), changes, note: fd.get('note'), clearFlags: fd.get('clearFlags') === 'on', hil });
      toast(`Đã tạo v${current.report.version} → ${DECISION[current.evaluation.decision].label}`);
      await refresh();
    } catch (err) { toast(err.message); }
  });
  $('#retrySend')?.addEventListener('click', async () => {
    try { current = await post(`/api/reports/${encodeURIComponent(d.report.reportId)}/retry-send`, {}); toast('Đang gửi lại…'); await refresh(); setTimeout(refresh, 2200); } catch (err) { toast(err.message); }
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
    <div class="card"><p class="lead">Nhập vài kết quả để xem hệ thống quyết định thế nào. Ô trống nghĩa là <b>chưa có kết quả</b>, không phải 0. Dữ liệu nhập thử không vào hàng đợi.</p>
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
    <div class="card" id="tryOut"><p class="empty">Kết quả đánh giá sẽ hiện ở đây.</p></div></div>`;
  const form = $('#tryForm');
  const drawTable = () => {
    const panel = meta.panels[form.panel.value];
    $('#hilRow').hidden = panel.discipline !== 'CHEM';
    $('#tryTable').innerHTML = `<div class="tablewrap"><table class="results"><thead><tr><th>Xét nghiệm</th><th>Kết quả</th><th>Đơn vị</th><th>Lần trước</th><th>Cách (ngày)</th></tr></thead><tbody>
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
      $('#tryOut').innerHTML = `<div class="decision ${ev.criticalValue ? 'crit' : DECISION[ev.decision].cls}"><span class="decision-ic" aria-hidden="true">${DECISION[ev.decision].icon}</span><div><strong>${DECISION[ev.decision].label}</strong><span>${ev.criticalValue ? 'Có giá trị tới hạn' : 'Đánh giá thử, không lưu vào hàng đợi'}</span></div></div>
        <section class="block">${ev.checks.some(c => c.action) ? reasonList(ev) : '<p class="ok-line">✓ Đạt mọi điều kiện áp dụng.</p>'}</section>
        <section class="block">${resultsTable({ report: out.report, analyteInfo: out.analyteInfo, history: histMap }, ev)}</section>
        ${fold('Tất cả bước kiểm tra', allChecks(ev))}${fold('Mô hình phát hiện lỗi (cục bộ)', modelsBlock(ev))}`;
    } catch (err) { toast(err.message); }
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
  $('#view-feedback').innerHTML = `<div class="notice">Mỗi thao tác của người phụ trách được lưu kèm phiên bản rule/mô hình. Phản hồi <b>không</b> thay đổi rule đang chạy: rà soát nhãn → huấn luyện ngoại tuyến → đánh giá độc lập → phê duyệt phiên bản mới.</div>
    <div class="stats static"><div class="stat"><span>Bản ghi phản hồi</span><strong>${fb.length}</strong></div><div class="stat"><span>Đồng ý với hệ thống</span><strong>${agree}</strong></div><div class="stat"><span>Khác hệ thống</span><strong>${fb.length - agree}</strong></div><div class="stat"><span>Đã xác minh</span><strong>${fb.filter(f => f.verification !== 'NOT_VERIFIED').length}</strong></div></div>
    <div class="row-end"><a class="btn" href="/api/feedback.csv" download>Xuất CSV</a></div>
    ${fb.length ? `<div class="card flush"><div class="tablewrap"><table class="results"><thead><tr><th>Phiếu</th><th>Hệ thống</th><th>Người phụ trách</th><th>Lý do</th><th>Xác minh</th><th>Nhãn</th></tr></thead><tbody>
    ${[...fb].reverse().map(f => `<tr><td><a href="#" data-open="${esc(f.reportId)}">${esc(f.reportId)}</a> <span class="muted">v${esc(f.version)}</span></td><td>${badge(f.systemDecision, true)}</td>
      <td>${esc(ACTION_LABEL[f.reviewerAction])} ${f.agreement === 'ĐỒNG Ý' ? '' : '<span class="tag gold">khác</span>'}</td><td>${esc(REASON_TXT[f.reasonCode] ?? f.reasonCode)}${f.note ? `<div class="muted small">${esc(f.note)}</div>` : ''}</td><td>${esc(VERIFY_TXT[f.verification] ?? f.verification)}</td><td><span class="tag">${esc(f.labelStatus)}</span></td></tr>`).join('')}</tbody></table></div></div>` : '<div class="card"><p class="empty">Chưa có phản hồi. Mở một phiếu trong hàng đợi và ghi nhận thao tác.</p></div>'}`;
  document.querySelectorAll('[data-open]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); showView('worklist'); select(a.dataset.open); }));
}

async function renderAudit() {
  const list = await api('/api/audit');
  $('#view-audit').innerHTML = `<div class="row-between"><p class="muted">Đánh giá, thao tác, gửi/ACK và thay đổi cấu hình (500 sự kiện gần nhất).</p><button class="btn danger" type="button" id="reset">Xóa trạng thái demo</button></div>
    ${list.length ? `<div class="card flush"><div class="tablewrap"><table class="results"><thead><tr><th>Thời điểm</th><th>Sự kiện</th><th>Phiếu</th><th>Nội dung</th></tr></thead><tbody>
    ${list.map(a => `<tr><td class="muted">${fmtTime(a.at)}</td><td><span class="mono small">${esc(a.type)}</span><div class="muted small">${esc(a.actor)}</div></td><td>${a.reportId ? esc(a.reportId) + (a.version ? ' v' + esc(a.version) : '') : '—'}</td><td>${esc(a.note ?? '')}</td></tr>`).join('')}</tbody></table></div></div>` : '<div class="card"><p class="empty">Chưa có sự kiện.</p></div>'}`;
  $('#reset').addEventListener('click', async () => { if (!confirm('Xóa toàn bộ phản hồi, nhật ký và phiên bản sửa của demo?')) return; await post('/api/reset'); toast('Đã xóa trạng thái demo'); await refresh(); renderAudit(); });
}

// ---------------- rules (human-readable) ----------------
let rulesTab = 'CHEM';
const TODO = {
  BLOCK: 'Xử lý nguyên nhân theo SOP (chạy lại, sửa dữ liệu, lấy mẫu mới…) rồi "Cập nhật kết quả" để hệ thống đánh giá lại. Không thể duyệt trực tiếp.',
  REVIEW: 'Người phụ trách xem lý do và quyết định: duyệt, giữ lại hoặc yêu cầu kiểm tra bổ sung — ghi lý do.',
  CRITICAL: 'Thông báo lâm sàng ngay, bấm "Đã báo tới hạn" trên phiếu, sau đó mới duyệt.'
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
      <div class="legend-out">${outcomeBadge('BLOCK')} <span class="muted small">không ký được</span> ${outcomeBadge('REVIEW')} <span class="muted small">người phụ trách quyết định</span> ${outcomeBadge('CRITICAL')} <span class="muted small">ưu tiên, phải báo lâm sàng</span></div>
    </div>
    <div class="card ruleset-head"><div><h3>${esc(s.rulesetId)} <span class="muted mono small">${esc(s.version)}</span></h3><p class="muted small">${esc(s.note)}</p></div>
      <dl class="kv compact"><dt>Trạng thái</dt><dd><span class="tag gold">${esc(s.status)}</span></dd><dt>Người phê duyệt</dt><dd>${s.approvedBy ? esc(s.approvedBy) : '<b>Chưa có</b>'}</dd><dt>Hiệu lực từ</dt><dd>${esc(s.effectiveFrom)}</dd>
      <dt>Số rule</dt><dd>${s.rules.length} — ${byOutcome('BLOCK')} chặn · ${byOutcome('REVIEW')} chuyển xem · ${byOutcome('CRITICAL')} tới hạn</dd></dl></div>
    <p class="muted small">Đánh giá theo thứ tự từ trên xuống. Một phiếu bị <b>chặn</b> nếu có bất kỳ rule chặn nào; nếu không, phiếu <b>cần xem</b> nếu có rule chuyển xem/tới hạn; chỉ khi không rule nào kích hoạt phiếu mới đủ điều kiện tự duyệt.</p>
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
