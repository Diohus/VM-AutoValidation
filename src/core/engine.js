// Pre-release evaluation pipeline (pure, isomorphic). Not a clinically validated decision system.
// Order: data → QC → instrument flags → specimen → limits/critical → history → consistency → model.
// The model may only escalate to MANUAL_REVIEW. It can never lift a block or approve on its own.
import { previousResults, parseNumeric, validTime } from './features.js';
import { scoreReport } from './model.js';

export const DECISIONS = { AUTO: 'AUTO_APPROVE_ELIGIBLE', REVIEW: 'MANUAL_REVIEW', BLOCKED: 'BLOCKED' };
export const STATUS = { PASS: 'PASS', FAIL: 'FAIL', NOT_EVALUABLE: 'NOT_EVALUABLE', NOT_APPLICABLE: 'NOT_APPLICABLE' };

export const RESULT_STATUS_LABEL = {
  RESULTED: 'Có kết quả', PENDING: 'Chưa có kết quả', FAILED: 'Máy báo lỗi lần chạy',
  TRANSMISSION_ERROR: 'Lỗi truyền dữ liệu', NOT_COLLECTED: 'Không thu thập được mẫu', NOT_APPLICABLE: 'Không áp dụng',
  MISSING_RECORD: 'Không nhận được bản ghi'
};

const H = 3600000;
const fmt = (v, d = 2) => (typeof v === 'number' ? Number(v.toFixed(d)).toString() : String(v));

function measuredAtOf(report) {
  return report.results.find(r => r.measuredAt)?.measuredAt ?? report.specimen?.receivedAt ?? report.specimen?.collectedAt;
}
// Previous result of one analyte strictly before THAT analyte's own measurement time.
const prevFor = (ctx, u, windowDays) => validTime(u.result?.measuredAt) ? previousResults(ctx.history, u.result.measuredAt, windowDays)[u.test] : undefined;

/** Normalise: which ordered tests have a usable numeric value in the canonical unit. */
export function normalizeReport(report, catalog) {
  const byTest = new Map(report.results.map(r => [r.test, r]));
  const items = report.orderedTests.map(test => {
    const def = catalog.analytes[test];
    const r = byTest.get(test);
    if (!def) return { test, state: 'UNKNOWN_TEST', usable: false };
    if (!r) return { test, state: 'MISSING_RECORD', usable: false };
    if (r.status !== 'RESULTED') return { test, state: RESULT_STATUS_LABEL[r.status] ? r.status : 'UNKNOWN_STATUS', rawStatus: r.status, usable: false, result: r };
    const value = parseNumeric(r.value);
    if (value == null) return { test, state: 'NON_NUMERIC', usable: false, result: r };
    const unit = (r.unit ?? '').trim();
    if (!unit) return { test, state: 'UNIT_MISSING', usable: false, result: r, value };
    if (unit !== def.unit) {
      const factor = def.altUnits?.[unit];
      return { test, state: factor ? 'UNIT_ALT' : 'UNIT_UNKNOWN', usable: false, result: r, value, factor };
    }
    return { test, state: 'OK', usable: true, result: r, value, def };
  });
  const extra = report.results.filter(r => !report.orderedTests.includes(r.test)).map(r => r.test);
  return { items, extra };
}

function refRange(def, sex) { return def.ref[sex] ?? def.ref.M; }

const DAY = 86400000;
export const PERSONAL_MODES = { OFF: 'OFF', TIGHTEN: 'TIGHTEN', ADAPT: 'ADAPT' };

/**
 * Personalized reference interval (prRI) per analyte from the patient's OWN prior results
 * (Coskun et al.; Fraser): set-point = mean of n prior results (log scale),
 * prRI = set-point × exp(± z·√((n+1)/n)·√(CVi²+CVa²)).
 * Usable only when there are ≥ minPoints prior results in the look-back window, the history is
 * stable (observed spread ≤ maxSpreadFactor × expected) and no admission/transfusion happened recently.
 * Diagnoses are NOT inputs: disease state enters only through the patient's measured history.
 */
export function personalIntervals(ctx, p) {
  const out = {};
  const t0 = Date.parse(ctx.measuredAt);
  const recent = (ctx.report.context?.events ?? []).find(e => validTime(e.at) && Date.parse(e.knownAt ?? e.at) <= t0
    && Date.parse(e.at) <= t0 && t0 - Date.parse(e.at) <= p.excludeRecentEventDays * DAY);
  for (const u of ctx.usable) {
    if (!p.tests.includes(u.test) || !validTime(u.result?.measuredAt)) continue;
    const tu = Date.parse(u.result.measuredAt);
    const pts = ctx.history.filter(h => h.test === u.test && typeof h.value === 'number' && h.value > 0
      && Date.parse(h.measuredAt) < tu && tu - Date.parse(h.measuredAt) <= p.lookbackDays * DAY).map(h => Math.log(h.value));
    const n = pts.length;
    const sd = Math.sqrt(u.def.cvi ** 2 + (u.def.cva ?? 1) ** 2) / 100;
    if (n < p.minPoints) { out[u.test] = { usable: false, n, reason: `chỉ có ${n} kết quả trước (cần ≥ ${p.minPoints})` }; continue; }
    const mean = pts.reduce((a, b) => a + b, 0) / n;
    const sdObs = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    if (sdObs > p.maxSpreadFactor * sd) { out[u.test] = { usable: false, n, reason: 'lịch sử dao động nhiều, chưa ổn định' }; continue; }
    if (recent) { out[u.test] = { usable: false, n, reason: `có sự kiện "${recent.label}" trong ${p.excludeRecentEventDays} ngày gần đây` }; continue; }
    const k = p.z * Math.sqrt((n + 1) / n);
    out[u.test] = { usable: true, n, setpoint: Math.exp(mean), lo: Math.exp(mean - k * sd), hi: Math.exp(mean + k * sd) };
  }
  return out;
}
const rng = (pi, d) => `${fmt(pi.lo, d)}–${fmt(pi.hi, d)}`;

const handlers = {
  required_results(rule, ctx) {
    // Allow-list: only a numeric RESULTED value counts (unit problems are reported by the unit rule).
    const bad = ctx.norm.items.filter(i => !['OK', 'UNIT_MISSING', 'UNIT_ALT', 'UNIT_UNKNOWN'].includes(i.state));
    const extra = ctx.norm.extra;
    if (!bad.length && !extra.length) return { status: STATUS.PASS, message: `Đủ ${ctx.norm.items.length}/${ctx.norm.items.length} chỉ số theo chỉ định.` };
    const label = b => b.state === 'NON_NUMERIC' ? `Giá trị không hợp lệ "${String(b.result.value ?? '').slice(0, 20)}"`
      : b.state === 'UNKNOWN_STATUS' ? `Trạng thái lạ "${String(b.rawStatus ?? '').slice(0, 20)}"`
      : b.state === 'NOT_APPLICABLE' ? 'Được chỉ định nhưng đánh dấu không áp dụng — cần xác nhận' : RESULT_STATUS_LABEL[b.state] ?? 'Mã xét nghiệm lạ';
    return { status: STATUS.FAIL, analytes: bad.map(b => b.test),
      message: [...bad.map(b => `${b.test}: ${label(b)}`), ...(extra.length ? [`Có kết quả không thuộc chỉ định: ${extra.join(', ')} — cần đối chiếu chỉ định`] : [])].join('; ') };
  },
  unit_check(rule, ctx) {
    const bad = ctx.norm.items.filter(i => ['UNIT_MISSING', 'UNIT_ALT', 'UNIT_UNKNOWN'].includes(i.state));
    if (!bad.length) return { status: STATUS.PASS, message: 'Đơn vị khớp cấu hình.' };
    return { status: STATUS.FAIL, analytes: bad.map(b => b.test), message: bad.map(b => {
      const def = ctx.catalog.analytes[b.test];
      if (b.state === 'UNIT_MISSING') return `${b.test}: thiếu đơn vị trong bản tin`;
      if (b.state === 'UNIT_ALT') return `${b.test}: nhận "${b.result.unit}" thay vì "${def.unit}" (nếu quy đổi ≈ ${fmt(b.value * b.factor)} ${def.unit}) — cần xác nhận cấu hình giao tiếp, hệ thống không tự quy đổi`;
      return `${b.test}: đơn vị lạ "${b.result.unit}"`;
    }).join('; ') };
  },
  qc_status(rule, ctx) {
    const maxAge = (rule.params?.maxAgeHours ?? 24) * H;
    const pairs = new Map();
    const noMeta = [];
    for (const i of ctx.norm.items) {
      if (!i.result) continue;
      if (i.result.instrument && validTime(i.result.measuredAt)) pairs.set(`${i.result.instrument}|${i.test}`, i);
      else noMeta.push(i.test);
    }
    if (noMeta.length) return { status: STATUS.NOT_EVALUABLE, analytes: noMeta, message: `Thiếu/không hợp lệ máy hoặc thời điểm đo, không đối chiếu được QC: ${noMeta.join(', ')}` };
    if (!pairs.size) return { status: STATUS.NOT_EVALUABLE, message: 'Không xác định được máy/thời điểm đo để đối chiếu QC.' };
    const failed = [], missing = [];
    for (const [key, i] of pairs) {
      const [instrument, test] = key.split('|');
      const t = Date.parse(i.result.measuredAt);
      let last = null;
      for (const q of ctx.qcLog) {
        if (q.instrument !== instrument || q.test !== test) continue;
        const qt = Date.parse(q.at);
        if (qt <= t && (!last || qt > Date.parse(last.at))) last = q;
      }
      if (!last || t - Date.parse(last.at) > maxAge) missing.push(test);
      else if (last.status !== 'PASS') failed.push({ test, last });
    }
    if (failed.length) return { status: STATUS.FAIL, analytes: [...failed.map(f => f.test), ...missing],
      message: failed.map(f => `${f.test}: QC gần nhất (${f.last.at.slice(11, 16)}, ${f.last.level ?? ''}) KHÔNG ĐẠT${f.last.note ? ' — ' + f.last.note : ''}; chưa có QC đạt sau đó trước lúc đo`).join('; ')
        + (missing.length ? `; thiếu QC hiệu lực: ${missing.join(', ')}` : '') };
    if (missing.length) return { status: STATUS.NOT_EVALUABLE, analytes: missing, message: `Không tìm thấy QC hiệu lực (≤24h, trước lúc đo) cho: ${missing.join(', ')}` };
    return { status: STATUS.PASS, message: `QC gần nhất của ${pairs.size} cặp máy–xét nghiệm đều đạt trước thời điểm đo.` };
  },
  instrument_flags(rule, ctx) {
    const flags = [...(ctx.report.instrumentFlags ?? []).map(f => ({ ...f, test: f.test ?? null })),
      ...ctx.report.results.flatMap(r => (r.flags ?? []).map(code => ({ code, test: r.test })))];
    if (!flags.length) return { status: STATUS.PASS, message: 'Máy không gửi cờ kỹ thuật.' };
    const block = flags.filter(f => rule.params.block.includes(f.code));
    const review = flags.filter(f => rule.params.review.includes(f.code));
    const other = flags.filter(f => !block.includes(f) && !review.includes(f));
    const desc = arr => arr.map(f => `${f.code}${f.test ? ` (${f.test})` : ''}`).join(', ');
    if (block.length) return { status: STATUS.FAIL, action: 'BLOCK', analytes: block.map(f => f.test).filter(Boolean), message: `Cờ chặn: ${desc(block)}${review.length ? `; cờ cần xem: ${desc(review)}` : ''}` };
    if (review.length || other.length) return { status: STATUS.FAIL, action: 'REVIEW', analytes: [...review, ...other].map(f => f.test).filter(Boolean),
      message: `Cờ cần xem: ${desc([...review, ...other])}${other.length ? ' (cờ chưa được cấu hình được xử lý như cần xem)' : ''}` };
    return { status: STATUS.PASS, message: 'Không có cờ chặn.' };
  },
  hil_index(rule, ctx) {
    const hil = ctx.report.specimen?.hil;
    if (!hil || [hil.H, hil.L, hil.I].some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return { status: STATUS.NOT_EVALUABLE, message: 'Thiếu chỉ số HIL (H/L/I) của mẫu — không xác định được nhiễu tan máu/đục/vàng.' };
    const hits = [];
    for (const i of ctx.norm.items) {
      const lim = rule.params.limits[i.test] ?? rule.params.limits['*'];
      for (const k of ['H', 'L', 'I']) if (hil[k] > lim[k]) hits.push(`${i.test} (${k}=${hil[k]} > ${lim[k]})`);
    }
    if (hits.length) return { status: STATUS.FAIL, analytes: [...new Set(hits.map(h => h.split(' ')[0]))], message: `Vượt giới hạn nhiễu: ${hits.join(', ')}` };
    return { status: STATUS.PASS, message: `H=${hil.H}, L=${hil.L}, I=${hil.I}: trong giới hạn của các xét nghiệm trên phiếu.` };
  },
  specimen_stability(rule, ctx) {
    const col = ctx.report.specimen?.collectedAt;
    if (!validTime(col)) return { status: STATUS.NOT_EVALUABLE, message: col ? `Thời điểm lấy mẫu không hợp lệ: "${String(col).slice(0, 30)}"` : 'Thiếu thời điểm lấy mẫu.' };
    const late = [], bad = [];
    for (const i of ctx.norm.items) {
      if (!i.result) continue;
      if (!validTime(i.result.measuredAt)) { bad.push(`${i.test} (thiếu/không hợp lệ thời điểm đo)`); continue; }
      const hrs = (Date.parse(i.result.measuredAt) - Date.parse(col)) / H;
      if (hrs < 0) { bad.push(`${i.test} (đo trước khi lấy mẫu ${fmt(-hrs, 1)}h)`); continue; }
      const lim = rule.params.maxHours[i.test] ?? rule.params.maxHours['*'];
      if (hrs > lim) late.push(`${i.test} (${fmt(hrs, 1)}h > ${lim}h)`);
    }
    if (bad.length) return { status: STATUS.FAIL, action: 'BLOCK', analytes: bad.map(l => l.split(' ')[0]), message: `Mốc thời gian mẫu không nhất quán: ${bad.join(', ')}` };
    if (late.length) return { status: STATUS.FAIL, analytes: late.map(l => l.split(' ')[0]), message: `Quá thời gian ổn định minh họa: ${late.join(', ')}` };
    return { status: STATUS.PASS, message: 'Thời gian lấy mẫu → đo trong giới hạn minh họa.' };
  },
  amr(rule, ctx) {
    const out = ctx.usable.filter(i => i.value < i.def.amr[0] || i.value > i.def.amr[1]);
    if (out.length) return { status: STATUS.FAIL, analytes: out.map(o => o.test), message: out.map(o => `${o.test}=${o.value} ngoài dải đo [${o.def.amr.join('–')}]`).join('; ') };
    return { status: ctx.usable.length ? STATUS.PASS : STATUS.NOT_EVALUABLE, message: 'Các giá trị nằm trong dải đo.' };
  },
  critical_value(rule, ctx) {
    const hits = ctx.usable.filter(i => {
      const [lo, hi] = i.def.critical ?? [];
      return (lo != null && i.value < lo) || (hi != null && i.value > hi);
    });
    if (hits.length) return { status: STATUS.FAIL, analytes: hits.map(h => h.test),
      message: hits.map(h => `${h.test}=${h.value} ${h.def.unit} vượt ngưỡng tới hạn minh họa [${(h.def.critical ?? []).map(v => v ?? '—').join(' / ')}]`).join('; ') };
    return { status: STATUS.PASS, message: 'Không có giá trị tới hạn theo cấu hình minh họa.' };
  },
  av_limits(rule, ctx) {
    const sex = ctx.report.context?.sex ?? 'M';
    let out = ctx.usable.filter(i => i.value < i.def.avLimits[0] || i.value > i.def.avLimits[1]);
    const explained = [];
    if (ctx.settings.personalMode === PERSONAL_MODES.ADAPT && ctx.personal) {
      const pp = ctx.personalParams;
      out = out.filter(i => {
        const pi = ctx.personal[i.test];
        const [clo, chi] = i.def.critical ?? [];
        const ok = pi?.usable && pp.widenTests.includes(i.test) && i.value >= pi.lo && i.value <= pi.hi
          && !(clo != null && i.value < clo) && !(chi != null && i.value > chi);
        if (ok) explained.push(`${i.test}=${i.value} trong khoảng cá nhân ${rng(pi, i.def.decimals)} (n=${pi.n})`);
        return !ok;
      });
    }
    const expNote = explained.length ? ` Ngoài giới hạn chung nhưng được giải thích bởi ngưỡng cá nhân: ${explained.join('; ')}.` : '';
    const abnormal = ctx.usable.filter(i => { const [lo, hi] = refRange(i.def, sex); return i.value < lo || i.value > hi; });
    const note = abnormal.length ? ` Ngoài khoảng tham chiếu: ${abnormal.map(a => a.test).join(', ')} — tự nó không phải lỗi, vẫn phải qua các kiểm tra khác.` : '';
    if (out.length) return { status: STATUS.FAIL, analytes: out.map(o => o.test), message: out.map(o => `${o.test}=${o.value} ngoài giới hạn tự duyệt [${o.def.avLimits.join('–')}]`).join('; ') + '.' + expNote + note };
    return { status: STATUS.PASS, message: 'Trong giới hạn tự duyệt minh họa.' + expNote + note };
  },
  delta_check(rule, ctx) {
    const win = rule.params.windowDays;
    const prev = Object.fromEntries(ctx.usable.map(u => [u.test, prevFor(ctx, u, win)]));
    const tests = rule.params.tests ?? ctx.usable.map(u => u.test);
    const comparable = ctx.usable.filter(u => tests.includes(u.test) && prev[u.test]);
    if (!comparable.length) return { status: STATUS.NOT_APPLICABLE, message: `Không có kết quả trước trong ${win} ngày để so sánh (lần đầu hoặc quá cửa sổ) — rule không áp dụng.` };
    const hits = [];
    for (const u of comparable) {
      const p = prev[u.test];
      if (p.value === 0) { // 0 is a real result: % change is undefined, so any change from 0 is surfaced, never Infinity%
        if (u.value !== 0) hits.push({ test: u.test, text: `${u.test}: ${p.value} → ${u.value} (lần trước = 0, không tính được % thay đổi — cần xem, lần trước ${p.measuredAt.slice(0, 10)})` });
        continue;
      }
      const pct = (u.value - p.value) / p.value * 100;
      const lim = rule.params.rcvOverridePct?.[u.test] ?? Number((u.def.rcvPct * (rule.params.rcvMultiplier ?? 1)).toFixed(1));
      if (Math.abs(pct) > lim) hits.push({ test: u.test, text: `${u.test}: ${p.value} → ${u.value} (${pct > 0 ? '+' : ''}${fmt(pct, 0)}%, giới hạn ±${lim}%, lần trước ${p.measuredAt.slice(0, 10)})` });
    }
    if (hits.length) return { status: STATUS.FAIL, analytes: hits.map(h => h.test), message: hits.map(h => h.text).join('; ') };
    return { status: STATUS.PASS, message: `${comparable.length} chỉ số có lịch sử, biến động trong giới hạn RCV minh họa.` };
  },
  history_required_if_abnormal(rule, ctx) {
    // firstVisitAbnormalPolicy: only ALWAYS_REVIEW runs in the app. MODEL_FLAG_ONLY (hold only when the first-visit model flags)
    // is evaluated offline in ml/benchmark.py and awaits the department's decision — it would let a model release a hold.
    const policy = rule.params.firstVisitAbnormalPolicy ?? 'ALWAYS_REVIEW';
    if (policy !== 'ALWAYS_REVIEW') return { status: STATUS.FAIL, message: `Chính sách "${policy}" chưa được phép chạy (chỉ dùng trong benchmark) — giữ phiếu để người phụ trách xem.` };
    const sex = ctx.report.context?.sex ?? 'M';
    const prev = Object.fromEntries(ctx.usable.map(u => [u.test, prevFor(ctx, u, rule.params.windowDays)]));
    const targets = ctx.usable.filter(u => rule.params.tests.includes(u.test));
    if (!targets.length) return { status: STATUS.NOT_APPLICABLE, message: 'Phiếu không có chỉ số thuộc phạm vi rule.' };
    const abn = targets.filter(u => { const [lo, hi] = refRange(u.def, sex); return u.value < lo || u.value > hi; });
    if (!abn.length) return { status: STATUS.NOT_APPLICABLE, message: 'Các chỉ số trong phạm vi rule nằm trong khoảng tham chiếu — không yêu cầu lịch sử.' };
    const noHist = abn.filter(u => !prev[u.test]);
    if (noHist.length) return { status: STATUS.FAIL, analytes: noHist.map(u => u.test), message: `Bất thường nhưng không có lịch sử ${rule.params.windowDays} ngày: ${noHist.map(u => `${u.test}=${u.value}`).join(', ')}` };
    return { status: STATUS.PASS, message: `Chỉ số bất thường đều có lịch sử để đối chiếu: ${abn.map(u => u.test).join(', ')}.` };
  },
  personal_interval(rule, ctx) {
    if (!ctx.personal) return { status: STATUS.NOT_APPLICABLE, message: 'Ngưỡng cá nhân đang tắt — chỉ dùng ngưỡng chung.' };
    const entries = Object.entries(ctx.personal);
    const usable = entries.filter(([, pi]) => pi.usable);
    if (!usable.length) return { status: STATUS.NOT_APPLICABLE, message: `Chưa đủ cơ sở tính ngưỡng cá nhân: ${entries.map(([t, pi]) => `${t} — ${pi.reason}`).join('; ') || 'không có chỉ số trong phạm vi'}.` };
    const hits = usable.filter(([t, pi]) => { const v = ctx.usable.find(u => u.test === t).value; return v < pi.lo || v > pi.hi; });
    const dec = t => ctx.catalog.analytes[t].decimals;
    if (hits.length) return { status: STATUS.FAIL, analytes: hits.map(([t]) => t), message: hits.map(([t, pi]) => {
      const v = ctx.usable.find(u => u.test === t).value;
      return `${t}=${v} ${v > pi.hi ? 'cao' : 'thấp'} hơn khoảng thường gặp của chính người bệnh ${rng(pi, dec(t))} (n=${pi.n})`;
    }).join('; ') + '. Khác thường so với chính người bệnh — chưa phải bằng chứng lỗi.' };
    return { status: STATUS.PASS, message: `${usable.length} chỉ số nằm trong khoảng cá nhân (${usable.map(([t, pi]) => `${t} ${rng(pi, dec(t))}`).join('; ')}).` };
  },
  consistency(rule, ctx) {
    const v = Object.fromEntries(ctx.usable.map(u => [u.test, u.value]));
    const p = rule.params;
    switch (p.check) {
      case 'edta_pattern':
        if (v.K == null || v.CA == null) return { status: STATUS.NOT_APPLICABLE, message: v.K == null ? 'Không có K hợp lệ.' : 'Ca không được chỉ định/không hợp lệ → không đánh giá được kiểu hình K–Ca (lưu ý: thiếu dữ liệu, không phải đạt).' };
        if (v.K > p.kAbove && v.CA < p.caBelow) return { status: STATUS.FAIL, analytes: ['K', 'CA'], message: `K=${v.K} > ${p.kAbove} và Ca=${v.CA} < ${p.caBelow}: kiểu hình gợi ý nhiễm EDTA — cần kiểm tra ống/mẫu.` };
        return { status: STATUS.PASS, message: `K=${v.K}, Ca=${v.CA}: không có kiểu hình K↑ Ca↓.` };
      case 'na_cl_gap': {
        if (v.NA == null || v.CL == null) return { status: STATUS.NOT_APPLICABLE, message: 'Thiếu Na hoặc Cl hợp lệ.' };
        const gap = v.NA - v.CL;
        if (gap < p.minGap || gap > p.maxGap) return { status: STATUS.FAIL, analytes: ['NA', 'CL'], message: `Na − Cl = ${gap} ngoài [${p.minGap}–${p.maxGap}] (minh họa).` };
        return { status: STATUS.PASS, message: `Na − Cl = ${gap}, trong vùng minh họa.` };
      }
      case 'dextrose_pattern': {
        if (v.GLU == null) return { status: STATUS.NOT_APPLICABLE, message: 'Không có glucose hợp lệ.' };
        if (v.GLU <= p.gluAbove) return { status: STATUS.PASS, message: `Glucose ${v.GLU} ≤ ${p.gluAbove}: không áp dụng kiểu hình lẫn dịch glucose.` };
        const prev = Object.fromEntries(ctx.usable.map(u => [u.test, prevFor(ctx, u, 30)]));
        const others = ctx.usable.filter(u => u.test !== 'GLU' && prev[u.test]);
        if (!others.length) return { status: STATUS.NOT_EVALUABLE, message: 'Glucose rất cao nhưng không có lịch sử 30 ngày để xét kiểu hình pha loãng.' };
        const diluted = others.filter(u => (u.value - prev[u.test].value) / prev[u.test].value * 100 < -p.dilutionPct);
        if (diluted.length >= p.minDilutedTests) return { status: STATUS.FAIL, analytes: ['GLU', ...diluted.map(d => d.test)], message: `Glucose ${v.GLU} kèm ${diluted.length} chỉ số giảm >${p.dilutionPct}% so với lần trước (${diluted.map(d => d.test).join(', ')}).` };
        return { status: STATUS.PASS, message: 'Glucose cao nhưng không kèm kiểu hình pha loãng.' };
      }
      case 'mchc_range':
        if (v.MCHC == null) return { status: STATUS.NOT_APPLICABLE, message: 'Không có MCHC.' };
        if (v.MCHC > p.max || v.MCHC < p.min) return { status: STATUS.FAIL, analytes: ['MCHC'], message: `MCHC=${v.MCHC} ngoài [${p.min}–${p.max}] (minh họa).` };
        return { status: STATUS.PASS, message: `MCHC=${v.MCHC} trong vùng minh họa.` };
      default:
        return { status: STATUS.NOT_EVALUABLE, message: `Kiểu kiểm tra chưa hỗ trợ: ${p.check}` };
    }
  },
  model_score(rule, ctx) {
    // A rule may name one model, or one model per panel (first-visit anomaly detectors are panel-specific).
    const key = rule.params.modelByPanel ? rule.params.modelByPanel[ctx.report.panel] : rule.params.model;
    if (!ctx.settings.modelEnabled) return { status: STATUS.NOT_APPLICABLE, message: 'Lớp mô hình đang tắt (chỉ chạy rule).' };
    if (!key) return { status: STATUS.NOT_APPLICABLE, message: `Không có mô hình cấu hình cho bảng xét nghiệm ${ctx.report.panel}.` };
    const model = ctx.models?.[key];
    if (!model) return { status: STATUS.NOT_APPLICABLE, message: `Chưa có mô hình "${key}" (models/${key}.json) — phiếu chỉ được đánh giá bằng rule.` };
    const res = { key, ruleCode: rule.code, name: model.name, kind: model.kind, targets: model.targets, ...scoreReport(ctx.report, ctx.history, ctx.catalog, model) };
    ctx.modelResults.push(res);
    const cov = `Dữ liệu: dùng ${res.coverage.used}/${res.coverage.total} chỉ số${res.coverage.missing.length ? ` (thiếu ${res.coverage.missing.map(m => `${m.test}${m.reason === 'NOT_ORDERED' ? ' — không chỉ định' : ' — chưa có kết quả'}`).join(', ')})` : ''}. Lịch sử: ${res.history.label}.`;
    if (res.status === 'OUT_OF_SCOPE') return { status: STATUS.NOT_APPLICABLE, message: `${res.reason} ${cov}` };
    if (res.status === 'NOT_EVALUABLE') return { status: STATUS.NOT_EVALUABLE, message: `${res.reason} Phiếu được chuyển người phụ trách xem (thiếu dữ liệu không được coi là đạt). ${cov}` };
    const desc = res.top.map(t => t.label).join('; ');
    const how = model.kind === 'knn_anomaly' ? 'ngưỡng = tỷ lệ gắn cờ 5% ở người khám lần đầu của tập validation giả lập' : 'ngưỡng chọn theo recall định trước trên tập validation giả lập';
    if (res.flagged) return { status: STATUS.FAIL, message: `Điểm ${fmt(res.score, 3)} ≥ ngưỡng ${fmt(res.threshold, 3)} (${how}). Yếu tố đóng góp nhiều nhất: ${desc || '—'}. Nghi ngờ, chưa xác định nguyên nhân. ${cov}` };
    return { status: STATUS.PASS, message: `Điểm ${fmt(res.score, 3)} < ngưỡng ${fmt(res.threshold, 3)}. ${cov}` };
  }
};

function hashInput(obj) {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Evaluate one report (phiếu). The whole report is the signing unit:
 * any BLOCK → BLOCKED; else any REVIEW/CRITICAL → MANUAL_REVIEW; else AUTO_APPROVE_ELIGIBLE.
 */
export function evaluateReport(report, env) {
  const { catalog, rulesets, qcLog = [], history = [], models = {}, settings = {}, now = new Date().toISOString() } = env;
  const ruleset = rulesets[report.discipline];
  if (!ruleset) throw new Error(`Không có bộ rule cho nhóm ${report.discipline}`);
  const norm = normalizeReport(report, catalog);
  const ctx = { report, catalog, qcLog, history, models, settings: { modelEnabled: true, ...settings }, norm,
    usable: norm.items.filter(i => i.usable), measuredAt: measuredAtOf(report), modelResults: [] };
  ctx.settings.personalMode ??= PERSONAL_MODES.OFF;
  const prRule = ruleset.rules.find(r => r.type === 'personal_interval');
  if (prRule && ctx.settings.personalMode !== PERSONAL_MODES.OFF) { ctx.personalParams = prRule.params; ctx.personal = personalIntervals(ctx, prRule.params); }
  const checks = [];
  for (const rule of [...ruleset.rules].sort((a, b) => a.priority - b.priority)) {
    const h = handlers[rule.type];
    const out = h ? h(rule, ctx) : { status: STATUS.NOT_EVALUABLE, message: `Loại rule chưa hỗ trợ: ${rule.type}` };
    let action = null;
    if (out.status === STATUS.FAIL) action = out.action ?? rule.onFail;
    else if (out.status === STATUS.NOT_EVALUABLE) action = rule.onNotEvaluable === 'IGNORE' ? null : rule.onNotEvaluable;
    checks.push({ code: rule.code, name: rule.name, stage: rule.stage, type: rule.type, status: out.status, action, analytes: out.analytes ?? [], message: out.message });
  }
  const blocking = checks.filter(c => c.action === 'BLOCK');
  const critical = checks.filter(c => c.action === 'CRITICAL');
  const review = checks.filter(c => c.action === 'REVIEW');
  const decision = blocking.length ? DECISIONS.BLOCKED : (critical.length || review.length) ? DECISIONS.REVIEW : DECISIONS.AUTO;
  const priority = critical.length ? 'CRITICAL' : blocking.length ? 'HIGH' : review.length ? 'NORMAL' : 'LOW';

  const analyteStatus = {};
  for (const i of norm.items) analyteStatus[i.test] = 'OK';
  const rank = { OK: 0, REVIEW: 1, CRITICAL: 2, BLOCKED: 3 };
  const mark = (t, s) => { if (t in analyteStatus && rank[s] > rank[analyteStatus[t]]) analyteStatus[t] = s; };
  for (const c of checks) {
    const s = c.action === 'BLOCK' ? 'BLOCKED' : c.action === 'CRITICAL' ? 'CRITICAL' : c.action === 'REVIEW' ? 'REVIEW' : null;
    if (!s) continue;
    if (c.analytes.length) c.analytes.forEach(t => mark(t, s));
    else if (c.action === 'BLOCK') Object.keys(analyteStatus).forEach(t => mark(t, s));
  }
  return {
    reportId: report.reportId,
    reportVersion: report.version ?? 1,
    discipline: report.discipline,
    decision,
    priority,
    criticalValue: critical.length > 0,
    reasons: [...blocking, ...critical, ...review].map(c => `[${c.code}] ${c.message}`),
    checks,
    analyteStatus,
    models: ctx.modelResults,
    rulesetVersion: ruleset.version,
    modelVersions: ctx.modelResults.map(m => m.version),
    modelEnabled: ctx.settings.modelEnabled,
    personalMode: ctx.settings.personalMode,
    personal: ctx.personal ?? null,
    catalogVersion: catalog.version,
    signingUnit: 'Cả phiếu (không ký từng phần)',
    evaluatedAt: now,
    inputHash: hashInput({ r: report.results, s: report.specimen, f: report.instrumentFlags, o: report.orderedTests, v: report.version }),
    simulation: true
  };
}
