# Dữ liệu giả lập

`npm run generate` (seed `20261116`) sinh ra:
- `data/synthetic/dataset.json`: người bệnh giả, phiếu, kết quả, QC log.
- `data/synthetic/results_long.csv`: dạng dài, mỗi kết quả một dòng.

Hai file này nằm trong `.gitignore` vì sinh lại được và cho ra kết quả y hệt.

## Quy mô

| | Số lượng |
|---|---|
| Người bệnh giả (mã `SBJ-xxxxxx`, không có tên, địa chỉ hay giấy tờ) | 3.000 |
| Phiếu | 18.981 (train 11.207 · val 3.891 · test 3.847 · kịch bản 36) |
| Kết quả | 190.898 |
| Bản ghi QC | 6.097 (QC sáng 06:30 cho mỗi cặp máy–xét nghiệm; khoảng 0,6% có khoảng QC không đạt) |
| Thời gian | 01/03/2026 – 16/11/2026 (ngày 16/11 là hàng đợi "hôm nay") |

## Mô hình mô phỏng ba tầng

Mô hình này theo góp ý của Codex và tổng quan nghiên cứu.

1. **Mức nền cá thể.** Mỗi người bệnh có một set-point được rút từ phân bố quần thể theo CVg: log-normal cho URE, CRE, GLU, men gan, WBC, PLT; gần chuẩn cho Na, Cl, Ca, ALB, MCV. Các tương quan minh họa (URE–CRE, AST–ALT, Na–Cl) được tạo qua nhân tố ẩn chung.
2. **Biến động sinh học và bệnh lý theo thời gian.**
   - Biến thiên trong cá thể là AR(1) với độ lệch dừng bằng CVi, thời gian tương quan 12 ngày. CVi không phải bước random walk.
   - Bệnh nền: ĐTĐ (có thể bắt đầu insulin giữa kỳ, glucose giảm dần), bệnh thận mạn, bệnh gan, thiếu máu thiếu sắt, lợi tiểu. Mỗi bệnh nền có thời điểm biết (`knownAt`).
   - Đợt nhập viện: tổn thương thận cấp, nhiễm khuẩn, xuất huyết có truyền máu. Đây là các **thay đổi thật nhưng mẫu đúng**, đóng vai trò ca âm tính khó.
   - Trạng thái nhịn ăn ảnh hưởng tới glucose.
3. **Sai số phân tích.** CVa khoảng 0,6–3%, minh họa, không phải hiệu năng máy thật.
4. **CBC tính theo quan hệ hằng số.** HCT = RBC×MCV/1000, HGB = HCT×MCHC, MCH = HGB/RBC. Các chỉ số này không được sinh độc lập với nhau.

CVi và CVg lấy gần đúng từ bảng biến thiên sinh học (Westgard/EFLM 2014), làm tròn theo đề xuất của Codex, và chỉ dùng để sinh dữ liệu.

## Lỗi tiêm vào (có nhãn ground truth)

Tập train/val/test được chia **theo người bệnh trước khi tiêm lỗi**. Khi mô phỏng WBIT, hai người bị tráo mẫu luôn nằm cùng một tập.

| Lỗi | Cách mô phỏng | Tỷ lệ làm giàu |
|---|---|---|
| WBIT | Ống mang nhãn A chứa máu của B. B cùng tập, cùng bảng xét nghiệm, lấy mẫu cách ≤3 giờ (theo Graham 2025). | 3% |
| Nhiễm EDTA | K tăng 0,8–6,8; Ca, Mg, ALP giảm theo mức độ | 1% |
| Lẫn NaCl 0,9% | `C' = (1−f)C + f·C_dịch`, Na = Cl = 154, f = 6–40% | 0,4% ngoại trú, 3% nội trú |
| Lẫn glucose 5% | như trên, glucose 278 mmol/L | 1,2% nội trú |
| Tan máu | H 40–800; K tăng 0,003×H, AST tăng 0,12×H | khoảng 5% (nhãn lỗi khi H > 90) |
| Chậm xử lý | K tăng, glucose giảm theo số giờ; CBC: MCV tăng khi để >24 giờ | khoảng 1% |
| Khoảng QC không đạt | Kết quả đo trong khoảng QC hỏng bị lệch ±6–7% | theo QC log |
| Thiếu thể tích / cục đông / kết cụm tiểu cầu | Có cờ máy (PLT_CLUMPS có cờ 85%) | 0,3–2% |
| Lỗi dữ liệu | mg/dL thay mmol/L, thiếu đơn vị, PENDING / TRANSMISSION_ERROR / FAILED, thiếu HIL | 0,3–0,8% |

## Bốn loại nhãn tách riêng

- `truth.sampleError`: lỗi mẫu hoặc lỗi phân tích.
- `truth.dataIssue`: lỗi dữ liệu.
- `truth.criticalValue`: giá trị tới hạn. Không phải lỗi.
- `reviewer.action`: **người duyệt mô phỏng có nhiễu**, ví dụ chỉ giữ 55% số ca WBIT và giữ nhầm 5% số ca sạch.

Mục đích là minh họa rằng "người phụ trách đã duyệt" không đồng nghĩa "kết quả đúng". Mô hình được huấn luyện trên nhãn thật của bản mô phỏng, không dùng nhãn người duyệt.

## Detector XGBoost thử nghiệm

`scripts/train-xgb.mjs` dùng feature từ `src/core/features.js` để huấn luyện ba detector: CBC WBIT, hóa sinh WBIT, và nhiễm EDTA/saline/D5W trong hóa sinh. Chia train/validation/test theo người bệnh; scenario bị loại. Hai detector WBIT chỉ nhận ca có lịch sử trong 90 ngày, trong khi detector nhiễm hóa sinh dùng feature mẫu hiện tại.

`scripts/train-xgb.py` huấn luyện binary XGBoost (hist, depth 3, 200 cây, eta 0,05, scale positive weight); cây xử lý giá trị thiếu bằng nhánh missing. Ngưỡng chọn trên validation theo recall mục tiêu: 80% cho WBIT và 90% cho nhiễm. Kết quả detector ở `reports/xgb_comparison.json`; so sánh ba cấu hình toàn luồng ở `reports/evaluation-comparison.json`.

Các lựa chọn nghiên cứu là: CBC WBIT — Graham et al. (2025), [doi:10.1093/clinchem/hvae210](https://doi.org/10.1093/clinchem/hvae210); hóa sinh WBIT — Tortosa-Carreres et al. (2026), [doi:10.1515/cclm-2025-0564](https://doi.org/10.1515/cclm-2025-0564); nhiễm hóa sinh — Farrell et al. (2026), [doi:10.1177/00045632261488751](https://doi.org/10.1177/00045632261488751), và Spies et al. (2025), [doi:10.1093/clinchem/hvae168](https://doi.org/10.1093/clinchem/hvae168). Đây là chuyển phương pháp để thử tính áp dụng, không tái tạo paper: dữ liệu, nhãn, cách chọn feature và cách huấn luyện thuộc prototype, chỉ mang tính tổng hợp.

## Giới hạn

- Tham số không lấy từ dữ liệu Vinmec. Phân bố, tỷ lệ bệnh và tỷ lệ lỗi đều là giả định.
- Lỗi được mô phỏng theo cơ chế đã biết, nên dễ phát hiện hơn lỗi thật. Kinh nghiệm trong tổng quan cho thấy AUC trên dữ liệu mô phỏng không dự báo được hiệu năng thật.
- Không mô phỏng trôi máy dần dần (PBRTQC), đổi lô hóa chất, hay kết quả định tính và vi sinh.
