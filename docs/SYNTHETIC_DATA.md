# Dữ liệu giả lập

`npm run generate` (seed `20261116`) sinh ra:
- `data/synthetic/dataset.json`: người bệnh giả, phiếu, kết quả, QC log.
- `data/synthetic/results_long.csv`: dạng dài, mỗi kết quả một dòng.

Hai file này nằm trong `.gitignore` vì sinh lại được và cho ra kết quả y hệt.

## Quy mô

| | Số lượng |
|---|---|
| Người bệnh giả (mã `SBJ-xxxxxx`, không có tên, địa chỉ hay giấy tờ) | 3.000 |
| Phiếu | 19.004 (train 11.249 · val 3.867 · test 3.852 · kịch bản 36) |
| Kết quả | 191.372 |
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

Tập train/val/test được chia **theo người bệnh trước khi tiêm lỗi**. Khi mô phỏng WBIT, hai người bị tráo mẫu luôn nằm cùng một tập. Một phiếu có thể mang nhiều lỗi cùng lúc; tất cả được ghi trong `truth.errors`.

| Lỗi | Cách mô phỏng | Tỷ lệ làm giàu |
|---|---|---|
| WBIT | Ống mang nhãn A chứa máu của B. B cùng tập, cùng bảng xét nghiệm, lấy mẫu cách ≤3 giờ (theo Graham 2025). Chỉ phiếu chưa có lỗi nào tham gia. | 3% |
| Lỗi phân tích đơn chỉ số (`analytical_single`) | Một chỉ số đo trực tiếp lệch 8–60% (NEU/LYM: cộng/trừ điểm %), không cờ máy, QC vẫn đạt (kiểu Farrell 2024: bọt khí, kim hút tắc một phần). Với CBC, lỗi lan sang chỉ số tính (HCT, MCH, MCHC). ALT, MG, PLT, RDW **chỉ** bị tiêm ở tập test để kiểm tra khả năng tổng quát. | 1% |
| Nhiễm EDTA | K tăng 0,8–6,8; Ca, Mg, ALP giảm theo mức độ | 1% |
| Lẫn NaCl 0,9% | `C' = (1−f)C + f·C_dịch`, Na = Cl = 154, f = 6–40% | 0,4% ngoại trú, 3% nội trú |
| Lẫn glucose 5% | như trên, glucose 278 mmol/L | 1,2% nội trú |
| Tan máu | H 40–800; K tăng 0,003×H, AST tăng 0,12×H | khoảng 5% (nhãn lỗi khi H > 90) |
| Chậm xử lý | K tăng, glucose giảm theo số giờ; CBC: MCV tăng khi để >24 giờ | khoảng 1% |
| Khoảng QC không đạt | Kết quả đo trong khoảng QC hỏng bị lệch ±6–7% | theo QC log |
| Thiếu thể tích / cục đông / kết cụm tiểu cầu | Có cờ máy (PLT_CLUMPS có cờ 85%) | 0,3–2% |
| Lỗi dữ liệu | mg/dL thay mmol/L, thiếu đơn vị, PENDING / TRANSMISSION_ERROR / FAILED, thiếu HIL | 0,3–0,8% |

## Bốn loại nhãn tách riêng

- `truth.errors` (đa nhãn) và `truth.sampleError` (lỗi chính): lỗi mẫu hoặc lỗi phân tích.
- `truth.dataIssue`: lỗi dữ liệu.
- `truth.criticalValue`: giá trị tới hạn. Không phải lỗi.
- `reviewer.action`: **người duyệt mô phỏng có nhiễu**, ví dụ chỉ giữ 55% số ca WBIT, 50% số ca lỗi phân tích đơn chỉ số và giữ nhầm 5% số ca sạch.

Mục đích là minh họa rằng "người phụ trách đã duyệt" không đồng nghĩa "kết quả đúng". Mô hình được huấn luyện trên nhãn thật của bản mô phỏng, không dùng nhãn người duyệt.

## Mô hình huấn luyện trên dữ liệu này

Mô hình chạy trong app (`models/*.json`) được huấn luyện **ngoại tuyến bằng Python** trên bộ benchmark riêng (`npm run bench:data`: 10.000 người bệnh, seed 20261117), không phải trên bộ demo 3.000 người bệnh. Bộ demo vì vậy là dữ liệu độc lập để kiểm tra toàn luồng (`scripts/evaluate-comparison.mjs`). Chi tiết: [MODEL_REDESIGN_PLAN.md](MODEL_REDESIGN_PLAN.md), `reports/benchmark.json`.

- **Nhầm mẫu (WBIT), hóa sinh và CBC, chỉ khi có lịch sử ≤90 ngày:** XGBoost cấu hình của đồng đội (PR #2), theo hướng Graham 2025 (CBC) và Tortosa-Carreres (hóa sinh) trong tổng quan.
- **Lẫn dịch truyền (NaCl 0,9% / glucose 5%), hóa sinh:** XGBoost cấu hình PR #2 (ngang LightGBM nên giữ lựa chọn của đồng đội). Hướng tiếp cận có giám sát trên nhiễm mô phỏng tham khảo Spies 2025 (Clinical Chemistry) theo tổng quan nghiên cứu.
- **Bất thường đa chỉ số ở người khám lần đầu:** KNN, ngưỡng gắn cờ 5%, theo Farrell 2024 (CCLM) trong tổng quan.
- **Không dùng mô hình:** nhiễm EDTA (rule K–Ca đã bắt hết trên dữ liệu giả lập; mô hình nhiễm mẫu gộp của PR #2 không tốt hơn rõ cách tách), lỗi phân tích đơn chỉ số (quá nhiều báo động giả).

Đây là chuyển phương pháp để thử tính áp dụng trên dữ liệu giả lập, không tái tạo mô hình hay kết quả của các bài báo.

## Giới hạn

- Tham số không lấy từ dữ liệu Vinmec. Phân bố, tỷ lệ bệnh và tỷ lệ lỗi đều là giả định.
- Lỗi được mô phỏng theo cơ chế đã biết, nên dễ phát hiện hơn lỗi thật. Kinh nghiệm trong tổng quan cho thấy AUC trên dữ liệu mô phỏng không dự báo được hiệu năng thật.
- Bộ benchmark mô hình dùng bộ dữ liệu riêng lớn hơn: `npm run bench:data` (10.000 người bệnh, seed 20261117, không có lượt "hôm nay").
- Không mô phỏng trôi máy dần dần (PBRTQC), đổi lô hóa chất, hay kết quả định tính và vi sinh.
