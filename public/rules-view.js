// Human-readable rendering of rule configuration: "when does this rule block / send to review", with
// parameters as sentences and small tables instead of raw JSON.
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = v => v == null ? '—' : String(v).replace('.', ',');
const chips = (arr, cls = '') => arr.map(x => `<span class="tag ${cls}">${esc(x)}</span>`).join(' ');

export const OUTCOME = {
  BLOCK: { label: 'Chặn', cls: 'blocked', icon: '■', hint: 'Không ký tự động, không duyệt được cho tới khi xử lý (chạy lại / sửa dữ liệu).' },
  REVIEW: { label: 'Chuyển người xem', cls: 'review', icon: '!', hint: 'Giữ phiếu để người phụ trách quyết định.' },
  CRITICAL: { label: 'Ưu tiên tới hạn', cls: 'crit', icon: '⚠', hint: 'Chuyển người xem ngay, phải ghi nhận đã thông báo lâm sàng.' },
  IGNORE: { label: 'Bỏ qua', cls: 'neutral', icon: '–', hint: 'Rule không áp dụng khi thiếu dữ liệu của nó; các rule khác vẫn kiểm tra.' }
};
export const outcomeBadge = k => { const o = OUTCOME[k] ?? OUTCOME.IGNORE; return `<span class="badge ${o.cls}" title="${esc(o.hint)}"><span aria-hidden="true">${o.icon}</span> ${o.label}</span>`; };

function table(head, rows) {
  return `<table class="mini"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
const testsOf = (catalog, disc) => Object.entries(catalog.analytes).filter(([, a]) => a.discipline === disc);
const name = (catalog, t) => `${esc(catalog.analytes[t]?.name ?? t)} <span class="muted mono">${esc(t)}</span>`;

/** Returns { when, missing, details } — HTML strings. */
export function describeRule(rule, { catalog, discipline, models = [] }) {
  const p = rule.params ?? {};
  switch (rule.type) {
    case 'required_results':
      return { when: 'Có chỉ số <b>được chỉ định</b> nhưng chưa có kết quả số hợp lệ: chưa có kết quả, lỗi truyền dữ liệu, máy báo lỗi, trạng thái lạ, giá trị không phải số; hoặc phiếu có kết quả <b>không thuộc chỉ định</b>.',
        missing: 'Ô trống không bao giờ được coi là 0 hay "bình thường".' };
    case 'unit_check': {
      const rows = testsOf(catalog, discipline).map(([t, a]) => [name(catalog, t), `<b>${esc(a.unit)}</b>`, Object.keys(a.altUnits ?? {}).filter(u => u !== a.unit).map(esc).join(', ') || '—']);
      return { when: 'Đơn vị trong bản tin <b>thiếu</b>, <b>lạ</b> hoặc <b>khác đơn vị chuẩn</b>. Hệ thống chỉ gợi ý giá trị quy đổi, không tự quy đổi.',
        details: table(['Xét nghiệm', 'Đơn vị chuẩn', 'Đơn vị khác nhận diện được (vẫn chặn)'], rows) };
    }
    case 'qc_status':
      return { when: `Lần QC <b>gần nhất trước thời điểm đo</b>, cùng máy và cùng xét nghiệm, <b>không đạt</b>.`,
        missing: `Không có QC nào trong <b>${n(p.maxAgeHours)} giờ</b> trước lúc đo, hoặc kết quả thiếu thông tin máy/thời điểm đo → chặn.` };
    case 'instrument_flags':
      return { when: `Máy gửi một trong các cờ chặn: ${chips(p.block, 'blocked')}`,
        extra: `Chuyển người xem khi có: ${chips(p.review, 'review')} — cờ chưa có trong cấu hình cũng được chuyển người xem, không bị bỏ qua.` };
    case 'hil_index': {
      const L = p.limits ?? {};
      const rows = Object.entries(L).filter(([t]) => t !== '*').map(([t, l]) => [name(catalog, t), n(l.H), n(l.L), n(l.I)]);
      if (L['*']) rows.push(['<i>Các xét nghiệm khác</i>', n(L['*'].H), n(L['*'].L), n(L['*'].I)]);
      return { when: 'Chỉ số tan máu (<b>H</b>), đục (<b>L</b>) hoặc vàng (<b>I</b>) của mẫu <b>lớn hơn</b> giới hạn của <b>bất kỳ</b> xét nghiệm nào trên phiếu → chặn cả phiếu.',
        missing: 'Bản tin không có đủ H, L, I (hoặc giá trị âm/không hợp lệ) → chặn.',
        details: table(['Xét nghiệm', 'H (tan máu) &gt;', 'L (đục) &gt;', 'I (vàng) &gt;'], rows) };
    }
    case 'specimen_stability': {
      const M = p.maxHours ?? {};
      const list = Object.entries(M).map(([t, h]) => t === '*' ? `các xét nghiệm khác: <b>${n(h)} giờ</b>` : `${esc(catalog.analytes[t]?.name ?? t)}: <b>${n(h)} giờ</b>`).join(' · ');
      return { when: `Thời gian từ <b>lấy mẫu</b> đến <b>đo</b> vượt: ${list}.`,
        extra: 'Thời điểm không hợp lệ hoặc <b>đo trước khi lấy mẫu</b> → <b>chặn</b>.', missing: 'Thiếu thời điểm lấy mẫu → chuyển người xem.' };
    }
    case 'amr':
      return { when: 'Giá trị nằm <b>ngoài dải đo</b> (AMR) của phương pháp — cần pha loãng/chạy lại.',
        details: table(['Xét nghiệm', 'Dải đo', 'Đơn vị'], testsOf(catalog, discipline).map(([t, a]) => [name(catalog, t), `${n(a.amr[0])} – ${n(a.amr[1])}`, esc(a.unit)])) };
    case 'critical_value':
      return { when: 'Giá trị <b>thấp hơn</b> ngưỡng tới hạn dưới hoặc <b>cao hơn</b> ngưỡng tới hạn trên. Giá trị tới hạn <b>không có nghĩa là kết quả sai</b>.',
        details: table(['Xét nghiệm', 'Tới hạn dưới', 'Tới hạn trên', 'Đơn vị'], testsOf(catalog, discipline).filter(([, a]) => a.critical?.some(v => v != null)).map(([t, a]) => [name(catalog, t), a.critical[0] != null ? `&lt; ${n(a.critical[0])}` : '—', a.critical[1] != null ? `&gt; ${n(a.critical[1])}` : '—', esc(a.unit)])) };
    case 'av_limits':
      return { when: 'Giá trị nằm <b>ngoài giới hạn tự duyệt</b>. Giới hạn này rộng hơn khoảng tham chiếu: kết quả chỉ ngoài khoảng tham chiếu vẫn có thể tự duyệt nếu qua mọi kiểm tra khác.',
        details: table(['Xét nghiệm', 'Khoảng tham chiếu (Nam / Nữ)', 'Giới hạn tự duyệt', 'Đơn vị'], testsOf(catalog, discipline).map(([t, a]) => [name(catalog, t), `${n(a.ref.M[0])}–${n(a.ref.M[1])} / ${n(a.ref.F[0])}–${n(a.ref.F[1])}`, `<b>${n(a.avLimits[0])} – ${n(a.avLimits[1])}</b>`, esc(a.unit)])) };
    case 'delta_check': {
      const tests = p.tests ?? testsOf(catalog, discipline).map(([t]) => t);
      const rows = tests.map(t => { const a = catalog.analytes[t]; const ov = p.rcvOverridePct?.[t]; const lim = ov ?? Number((a.rcvPct * (p.rcvMultiplier ?? 1)).toFixed(1));
        return [name(catalog, t), `± ${n(lim)} %`, ov != null ? 'Giới hạn riêng' : `RCV ${n(a.rcvPct)}% × ${n(p.rcvMultiplier ?? 1)}`]; });
      return { when: `Kết quả thay đổi so với <b>lần gần nhất trong ${n(p.windowDays)} ngày</b> nhiều hơn giới hạn của chỉ số đó.`,
        missing: 'Không có kết quả trước trong cửa sổ → rule <b>không áp dụng</b> (hiển thị rõ, không coi là đạt).', details: table(['Xét nghiệm', 'Thay đổi tối đa', 'Cách tính'], rows) };
    }
    case 'history_required_if_abnormal':
      return { when: `${p.tests.map(t => `<b>${esc(catalog.analytes[t]?.name ?? t)}</b>`).join(', ')} nằm <b>ngoài khoảng tham chiếu</b> nhưng <b>không có kết quả trước</b> trong ${n(p.windowDays)} ngày để đối chiếu.` };
    case 'consistency': {
      const map = {
        edta_pattern: `<b>Kali &gt; ${n(p.kAbove)} mmol/L</b> đồng thời <b>Calci &lt; ${n(p.caBelow)} mmol/L</b> (kiểu hình gợi ý nhiễm EDTA).`,
        na_cl_gap: `Hiệu <b>Na − Cl &lt; ${n(p.minGap)}</b> hoặc <b>&gt; ${n(p.maxGap)}</b> mmol/L (gợi ý lẫn NaCl 0,9% hoặc lỗi điện cực).`,
        dextrose_pattern: `<b>Glucose &gt; ${n(p.gluAbove)} mmol/L</b> và có <b>≥ ${n(p.minDilutedTests)} chỉ số khác giảm &gt; ${n(p.dilutionPct)}%</b> so với lần trước trong 30 ngày (gợi ý lẫn dịch glucose).`,
        mchc_range: `<b>MCHC &lt; ${n(p.min)}</b> hoặc <b>&gt; ${n(p.max)} g/L</b> (gợi ý ngưng kết, đục, tan máu).`
      };
      return { when: map[p.check] ?? esc(p.check), missing: 'Thiếu một trong các chỉ số cần cho phép so sánh → không áp dụng (ghi rõ "không đánh giá được").' };
    }
    case 'personal_interval': {
      const tests = p.tests.map(t => `<b>${esc(catalog.analytes[t]?.name ?? t)}</b>`).join(', ');
      return {
        when: `Kết quả nằm <b>ngoài khoảng thường gặp của chính người bệnh</b> — khoảng này tính từ ≥ ${n(p.minPoints)} kết quả trước trong ${n(p.lookbackDays)} ngày: điểm đặt cá nhân ± ${n(p.z)}·√((n+1)/n)·√(CVi² + CVa²).`,
        extra: `Chỉ chạy khi bật "Ngưỡng cá nhân" (mặc định tắt). Chế độ <b>Siết</b> chỉ thêm lý do để xem. Chế độ <b>Siết + nới</b> còn cho phép ${p.widenTests.map(t => `<b>${esc(catalog.analytes[t]?.name ?? t)}</b>`).join(', ')} vượt giới hạn tự duyệt chung nếu vẫn nằm trong khoảng cá nhân — không bao giờ nới qua ngưỡng tới hạn, không nới cho QC/HIL/cờ máy. Bệnh nền không phải đầu vào: bệnh lý ảnh hưởng qua chính kết quả đo trước đó.`,
        missing: `Có &lt; ${n(p.minPoints)} kết quả trước, lịch sử dao động nhiều, hoặc có nhập viện/truyền máu trong ${n(p.excludeRecentEventDays)} ngày → không dùng ngưỡng cá nhân, quay về ngưỡng chung.`,
        details: table(['Phạm vi', 'Chỉ số'], [['Áp dụng (siết)', tests], ['Được phép nới', p.widenTests.map(t => esc(catalog.analytes[t]?.name ?? t)).join(', ')]])
      };
    }
    case 'model_score': {
      const m = models.find(x => x.key === p.model);
      return { when: `Điểm của mô hình <b>${esc(m?.name ?? p.model)}</b> ≥ <b>${m ? n(Number(m.threshold).toFixed(3)) : '—'}</b>.`,
        extra: `Mô hình <b>chỉ được giữ thêm</b>: không thể chặn, không thể vượt qua điều kiện chặn và không tự duyệt. ${m?.scope ? 'Phạm vi: ' + esc(m.scope) + '.' : ''}` };
    }
    default:
      return { when: esc(rule.reason) };
  }
}
