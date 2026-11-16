// Scenario evaluator, not a clinical decision model. No diagnostic thresholds.
export function evaluateChecks(c, settings = {history:true, context:true}){return [{name:'Cờ kỹ thuật',pass:!c.flag,info:c.flag?'Có cờ PLT clumps? → kiểm tra theo SOP.':'Không có cờ chặn trong ca giả lập.'},{name:'Dữ liệu bắt buộc',pass:!c.missing,info:c.missing?'Thiếu đơn vị creatinine → chưa đánh giá được.':'Các trường bắt buộc của kịch bản đã có.'},{name:'So sánh lịch sử',pass:!(settings.history&&c.delta),info:!settings.history?'Đã tắt lớp mô phỏng.':c.delta?'Tình huống biến động được dựng sẵn → cần xác minh.':c.history.length?'Có lịch sử; không kích hoạt giữ trong kịch bản.':'Không có lịch sử; dùng nhánh giả lập không yêu cầu lịch sử.'},{name:'Bối cảnh liên quan',pass:!(settings.context&&c.contextMissing),info:!settings.context?'Đã tắt lớp mô phỏng.':c.contextMissing?'Thiếu bối cảnh bắt buộc trong tình huống giả lập.':'Không kích hoạt giữ theo bối cảnh của kịch bản.'}]}

export function evaluateCase(c, settings) {
 const checks = evaluateChecks(c, settings);
 return { decision: checks.some(check => !check.pass) ? "REVIEW" : "ELIGIBLE", checks, ruleVersion: "scenario-v1", simulation: true };
}
