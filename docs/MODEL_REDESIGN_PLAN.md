# Kế hoạch làm lại lớp mô hình (bản nháp, chờ review)

Toàn bộ là dữ liệu giả lập. Không dùng cho người bệnh.

## 0. Quyết định đã chốt (từ người dùng)
1. Không mô hình hóa WBIT. Gỡ `chem_wbit`, `heme_wbit`, CHEM-M01, HEME-M01, tắt tiêm WBIT. Giữ delta check.
2. Bỏ điền trung bình. Phân biệt 3 kiểu thiếu: A (có chỉ định, không có kết quả → D01 BLOCK), B (không chỉ định → không phải lỗi, mô hình không giả định giá trị), C (không có lịch sử → đặc trưng delta "không đánh giá được", không cho ra điểm). Mỗi điểm hiển thị mức phủ dữ liệu. Thiếu đặc trưng then chốt → NOT_EVALUABLE.
3. Giá trị 0 là giá trị thật.
4. Huấn luyện và benchmark bằng Python. Phần chạy thật vẫn là JS không dependency: xuất mô hình ra JSON và viết suy luận bằng JS.

## 1. Kiến trúc dữ liệu: JS tính đặc trưng, Python học
- `scripts/export-features.mjs` (JS) dùng **đúng** `extractFeatures` và `evaluateReport` của engine để xuất mỗi phiếu thành 1 dòng: id phiếu, mã giả người bệnh, split, panel, nhóm lịch sử (có/không), nhãn thật (`truth.sampleError`, `dataIssue`), quyết định **chỉ rule** (mô hình tắt) và các rule đã giữ phiếu, cùng toàn bộ đặc trưng (thiếu = `null`, không điền).
- Python (`ml/`) chỉ đọc file này. Nhờ vậy đặc trưng lúc huấn luyện và lúc chạy thật là một, không viết lại bằng hai ngôn ngữ.
- Rule-only baseline lấy từ engine JS thật, nên "số lỗi bắt thêm so với rule" đo đúng hệ thống đang chạy.

## 2. Dữ liệu giả lập
- Tắt `injectWbit`. Kịch bản KB3b (WBIT trên CBC) đổi thành **"Thay đổi lớn MCV/RDW so với lần trước, chưa rõ nguyên nhân"**: `truth.sampleError = null`, `requiresReview = true`, kỳ vọng vẫn MANUAL_REVIEW qua delta check (HEME-H01). Mô tả không nhắc nhầm mẫu.
- **Đề xuất thêm (cần chốt):** lỗi phân tích hiện chỉ có `qc_window` (đo trong cửa sổ QC hỏng), mà rule QC đã chặn gần như 100%. Mô hình gần như không thể bắt thêm. Theo Farrell 2024 ("lỗi đơn chỉ số"), thêm loại `analytical_single`: một chỉ số lệch lớn ngẫu nhiên (±25–60%, hoặc cộng/trừ cố định với chỉ số dạng %), không có cờ máy, QC vẫn đạt (ví dụ bọt khí, kim hút tắc một phần). Tỷ lệ làm giàu: CHEM 1%, HEME 1%.
- Số ca dương tính hiện quá ít (EDTA test = 16 ca). Benchmark dùng một **bộ dữ liệu riêng lớn hơn**: `--subjects=10000 --seed=20261117 --out=data/synthetic/bench/`. Bộ 3.000 người bệnh cho server giữ nguyên để giao diện nhẹ. Hai bộ độc lập (khác seed).
- Chia tập theo người bệnh **trước khi tiêm lỗi** (đã có): train/val/test ≈ 60/20/20.

## 3. Đặc trưng (sửa `src/core/features.js`)
### Giá trị 0
- Bỏ `val = c.value > 0 ? ... : null`. Mọi giá trị số hữu hạn ≥ 0 đều là giá trị thật.
- Chỉ số `dist = lognormal` (GLU, URE, CRE, ALP, AST, ALT, WBC, PLT): `z = (log(x + ε) − log(centre + ε)) / (CVg/100)` (CV lưu dạng %), với ε = độ phân giải báo cáo (10^−decimals; với chỉ số 0 chữ số thập phân thì ε = 1).
- Chỉ số `normal`/`derived` và chỉ số dạng % (NEU, LYM, RDW, MCHC…): không lấy log, `z = (x − centre) / (centre × CVg/100)`.
- Delta: lognormal → `(log(x+ε) − log(p+ε)) / SDΔ`; còn lại → `(x − p) / (p_ref × SDΔ)` với `p_ref = max(p, ε)`. Không chia cho 0.
### Ba kiểu thiếu
- **A** (có chỉ định, không có kết quả): D01 chặn như cũ. Mô hình vẫn chạy với chỉ số đó = thiếu, nhưng phiếu đã BLOCKED.
- **B** (không chỉ định): đặc trưng = `null`. Thêm cờ `m_<test>` = 1/0 ("có đo"). Không điền.
- **C** (không có lịch sử): `d_<test>` = `null`, `hist_avail = 0`; giao diện ghi "Lịch sử: không đánh giá được — chưa có lịch sử ≤90 ngày". Các đặc trưng tổng hợp delta (`delta_ms`, `n_deltas`…) cũng `null` chứ không phải 0.
- Mỗi điểm mô hình trả kèm `coverage = { used, total, missing: [...] }` trên tập chỉ số của mô hình ("dùng 7/12 chỉ số"), và trạng thái lịch sử.
- Bỏ `age_dec` mặc định 50 khi thiếu tuổi (đang là một kiểu điền giá trị): thiếu tuổi → `null`.

## 4. Mô hình
### 4.1 Bộ phát hiện có giám sát (mỗi họ lỗi một bộ)
| Bộ | Nhóm | Nhãn dương | Đặc trưng then chốt (thiếu → NOT_EVALUABLE) | Recall đích trên val |
|---|---|---|---|---|
| `chem_edta` | CHEM | edta | K **và** CA | 0,90 |
| `chem_ivfluid` | CHEM | saline, d5w | NA, CL, GLU | 0,90 |
| `chem_analytical` | CHEM | analytical_single (+ qc_window) | ≥ 6 chỉ số | 0,80 |
| `heme_analytical` | HEME | analytical_single (+ qc_window) | ≥ 6 chỉ số | 0,80 |

- Phạm vi huấn luyện và đánh giá: phiếu cùng nhóm, không có `dataIssue`. Phiếu có lỗi **khác** họ (tan máu, chậm xử lý…) giữ lại làm âm tính (giống thực tế).
- Đặc trưng: `z_*`, `m_*`, tỷ số (Na−Cl, K−Ca, K−ALP, MCHC lệch), `d_*` và tổng hợp delta khi có lịch sử, `hist_avail`, bối cảnh (nội trú/cấp cứu, tuổi, giới).
- Ba thuật toán trên **cùng** đặc trưng, **cùng** split:
  - **Logistic regression (baseline hiện tại):** không nhận được giá trị thiếu, nên tách mô hình theo (panel × có/không lịch sử) để mỗi mô hình con chỉ dùng đặc trưng luôn có. Trong mô hình con "có lịch sử", delta từng chỉ số có thể vẫn thiếu (lần trước khác panel) → chỉ dùng đặc trưng delta tổng hợp cho LR. Không điền.
  - **XGBoost** và **LightGBM:** một mô hình mỗi bộ, nhận `NaN` trực tiếp, kèm cờ `m_*` và `hist_avail`.
- Siêu tham số: lưới nhỏ cố định, chọn bằng GroupKFold 5 lần theo người bệnh **trên train**. Val **chỉ** dùng để chọn ngưỡng. Test chạm đúng 1 lần.
- Ngưỡng: ngưỡng **lớn nhất** sao cho `score ≥ ngưỡng` vẫn đạt recall đích trên các ca dương tính của val (giữ nguyên nguyên tắc cũ).
- Nhãn: `truth.sampleError` của bản giả lập. Không dùng hành động của người duyệt mô phỏng.

### 4.2 Phát hiện bất thường cho người khám lần đầu (không cần lịch sử)
- Theo Farrell 2024: Gaussian đa biến (khoảng cách Mahalanobis), KNN-distance (trung bình khoảng cách tới k láng giềng, k = 10), one-class SVM (RBF).
- Tách theo panel (CHEM_BASIC 6 chỉ số, CHEM_EXT 12, CBC 10) nên không có thiếu kiểu B. Đầu vào: `z_*` của panel.
- Dữ liệu huấn luyện: mọi phiếu train của panel đó, **không lọc theo nhãn** (giống Farrell: dữ liệu thường quy, có lẫn lỗi). Ghi chú biến thể có lọc nhãn để so sánh.
- Ngưỡng: tỷ lệ gắn cờ cố định 5% trên các phiếu **lần đầu** của val.
- Đánh giá: trên phiếu lần đầu của test, với nhãn = nhiễm mẫu + lỗi phân tích. Báo cả tỷ lệ gắn cờ nhầm ở ca bệnh lý thật (nhập viện AKI, nhiễm khuẩn…), vì mô hình bất thường sẽ gắn cờ cả bệnh thật.
- Chính sách người khám lần đầu có kết quả ngoài khoảng tham chiếu: tùy chọn cấu hình `firstVisitAbnormalPolicy`:
  - `ALWAYS_REVIEW` (**mặc định**): rule hiện có (HEME/CHEM "cần lịch sử khi bất thường") giữ nguyên. Mô hình bất thường chỉ thêm cờ.
  - `MODEL_FLAG_ONLY`: rule đó tắt; chỉ giữ khi mô hình bất thường gắn cờ. **Lưu ý:** chế độ này cho mô hình quyết định *không* giữ một phiếu mà rule mặc định sẽ giữ, tức là đi ngược nguyên tắc "mô hình chỉ được nâng". Benchmark báo cả hai chế độ. Ghi vào `docs/OPEN_QUESTIONS.md`.

## 5. Đánh giá → `reports/benchmark.json` và README
Cho từng bộ × thuật toán, trên test:
- PR-AUC (kèm bootstrap 95% theo người bệnh, 1.000 lần), ROC-AUC.
- Độ nhạy, độ đặc hiệu tại ngưỡng, Wilson 95%.
- PPV ở tỷ lệ lỗi giả định 1%, 0,1%, 0,03%.
- **Tiêu chí chính:** so với **chỉ rule** (engine JS, mô hình tắt):
  - số lỗi mục tiêu bắt thêm = phiếu lỗi mà rule cho AUTO nhưng mô hình gắn cờ (k/n, Wilson);
  - mức tăng báo động giả = phiếu không có lỗi mẫu/dữ liệu/tới hạn/cờ bệnh lý mà rule cho AUTO nhưng mô hình gắn cờ (k/n, Wilson), và số tuyệt đối trên 1.000 phiếu.
- Tách theo loại lỗi, và theo nhóm có lịch sử / khám lần đầu.
- Ghi rõ: mọi con số chỉ đúng trên dữ liệu giả lập, tỷ lệ lỗi đã làm giàu.

## 6. Chống rò rỉ dữ liệu
- Split theo người bệnh, gán trước khi tiêm lỗi. Không còn cặp WBIT nên không có liên kết chéo giữa người bệnh.
- Lịch sử chỉ lấy kết quả đo **trước** thời điểm đo của từng chỉ số (đã có test hồi quy).
- Thống kê chuẩn hóa (`centre`, CVg) lấy từ cấu hình, không từ dữ liệu. Thống kê của LR/one-class SVM/Gaussian chỉ tính trên train.
- Siêu tham số chọn trên train (CV theo người bệnh), ngưỡng trên val, test dùng một lần.
- Không dùng đặc trưng phản ánh nhãn: không dùng `context.ivInfusion` (generator đặt giá trị này **sau** khi tiêm lỗi saline/d5w → rò rỉ nhãn), không dùng chẩn đoán, không dùng HIL/cờ máy (đã có rule riêng; nếu dùng thì bộ tiêm lỗi tan máu sẽ rò sang).

## 7. Suy luận JS (bước 3, sau khi người dùng xác nhận benchmark)
- Xuất cây: XGBoost `get_dump(dump_format='json')`, LightGBM `dump_model()`. JS duyệt cây theo nhánh mặc định khi thiếu; so sánh ngưỡng theo float32 (`Math.fround`) để khớp Python. Test so khớp điểm JS và Python trên ~500 phiếu (sai số ≤ 1e-6).
- Gaussian: lưu trung bình + ma trận hiệp phương sai nghịch đảo. One-class SVM: vector hỗ trợ + hệ số + gamma. KNN: tập tham chiếu (lấy mẫu con ≤ 3.000 điểm mỗi panel) trong JSON.
- `model_score` trả `NOT_EVALUABLE` (chỉ ghi chú, không giữ phiếu) khi thiếu đặc trưng then chốt; hiển thị mức phủ.
- `vectorize` không còn trả 0 cho giá trị thiếu.

## 8. Test hồi quy cần thêm/sửa
- Không còn rule M01 / mô hình WBIT; KB3b vẫn MANUAL_REVIEW qua delta check.
- NEU = 0, CA = 0 cho đặc trưng hữu hạn (không phải `null`); delta khi lần trước = 0 không ra vô cực.
- CHEM_BASIC: `chem_edta` → NOT_EVALUABLE (không phải PASS); mức phủ đúng.
- Người bệnh không có lịch sử: `d_*` = null, trạng thái lịch sử "không đánh giá được".
- `firstVisitAbnormalPolicy` mặc định `ALWAYS_REVIEW`.
- Suy luận cây JS khớp Python.

## 9. Góp ý Codex vòng 1 và cách xử lý (đã áp dụng vào kế hoạch)
| # | Góp ý | Xử lý |
|---|---|---|
| 1 | `MODEL_FLAG_ONLY` có thể cho qua khi mô hình không đánh giá được. CHEM-H02 chỉ áp K/NA/CA (365 ngày); HEME không có rule tương đương. | Khi mô hình NOT_EVALUABLE hoặc lỗi suy luận → quay về `ALWAYS_REVIEW`. Chính sách chỉ tác động tới đúng phạm vi CHEM-H02. Đo riêng số phiếu được thả và số lỗi trong đó. |
| 2 | "Ngưỡng nhỏ nhất đạt recall" diễn đạt ngược. | Ngưỡng = **lớn nhất** sao cho `score ≥ ngưỡng` vẫn đạt recall đích trên val. Ghi số dương tính val; < 10 ca → đánh dấu "ngưỡng không tin cậy". |
| 3 | Mẫu số của "bắt thêm" chưa chốt; Wilson bỏ qua tương quan trong cùng người bệnh. | Báo k / tổng lỗi mục tiêu **và** k / lỗi rule bỏ sót; báo động thêm / ca sạch rule-AUTO và / 1.000 phiếu; đếm hợp các bộ một lần; thêm mọi lượt giữ thêm (gồm bệnh thật). Bootstrap theo người bệnh cho các chênh lệch. |
| 4 | Rò nhãn qua bảng xuất; `ward` mang dấu vết tỷ lệ tiêm; nhãn một lỗi duy nhất. | Danh sách đặc trưng cho phép cố định trong mã. Ablation bỏ `acute_setting`. Thêm `truth.errors` (đa lỗi); nhãn dương = có lỗi mục tiêu trong danh sách. |
| 5 | Lịch sử lọc theo thời điểm đo, chưa theo thời điểm khả dụng; `log_days_since_prev` lệch khi phiếu nhiều thời điểm đo. | Khoảng cách tới lần trước tính theo từng chỉ số rồi lấy nhỏ nhất. Thời điểm khả dụng: dữ liệu giả lập không có, ghi vào OPEN_QUESTIONS. |
| 6 | Giờ OPD gán sau khi sort; `--out` bị bỏ qua. | Gán giờ trước khi sort. Sửa `--out`. Early stopping/siêu tham số chỉ trong CV trên train. |
| 7 | Công thức z thiếu `/100`; delta tuyến tính chia `max(p, ε)` vẫn phóng đại; rule delta chia trực tiếp cho p. | Ghi rõ CV ở dạng %, chia 100. Delta tuyến tính dùng thang tuyệt đối: `(x − p) / (centre × SDΔ)`. Rule delta: lần trước = 0 → FAIL kèm giải thích, không ra `Infinity%`. |
| 8 | So LR với cây không cùng đầu vào. | Hai bảng: **(a) cùng đầu vào**: cả 3 thuật toán đều huấn luyện theo tầng panel × có/không lịch sử, cùng đặc trưng đầy đủ; **(b) cấu hình tốt nhất** của từng thuật toán (cây: 1 mô hình nhận NaN). Lưu lý do thiếu từng đặc trưng. NOT_EVALUABLE tính vào mức phủ và recall toàn phạm vi. |
| 9 | 5% chưa phải ngân sách báo động thêm. | Quantile 95% riêng từng panel trên val; báo tỷ lệ gắn cờ thực tế ở test và phần tăng thêm trên phiếu rule-AUTO. Tách "lần đầu thật" và "không có lịch sử ≤90 ngày". |
| 10 | `analytical_single` dễ tạo benchmark tự đúng; HCT nằm ngoài `MODEL_TESTS`. | Độ lệch rộng 8–60% (gồm lệch nhỏ), báo recall theo mức lệch. Train/val không tiêm vào ALT, MG, PLT, RDW; test tiêm vào mọi chỉ số → báo recall riêng trên chỉ số chưa thấy. Thêm HCT vào `MODEL_TESTS`. Báo `qc_window` riêng, không gộp vào recall. |
| 11 | Bản xuất cây cho JS thiếu thông tin. | Dùng XGBoost JSON đầy đủ (base_score, objective, nhánh thiếu). Không áp `Math.fround` đồng loạt cho LightGBM. OCSVM xuất cả intercept/offset. KNN benchmark trên đúng tập con sẽ triển khai. Test so khớp gồm biên split, 0, thiếu, sát ngưỡng. |

## 10. Bước 3 — đã triển khai (17/11/2026)
- Gộp `origin/main` (PR #2). Gỡ `chem_wbit_xgb`, `heme_wbit_xgb`, `chem_contam_xgb` và mọi LR cũ; dùng chung, tổng quát hóa bộ chấm điểm cây JSON của PR #2 cho XGBoost (so sánh float32) và LightGBM (missing type), có giải thích Saabas.
- Mô hình triển khai: `chem_ivfluid` (LightGBM), `fv_chem_basic` / `fv_chem_ext` / `fv_cbc` (KNN, chỉ khi không có lịch sử ≤90 ngày). EDTA: rule. Lỗi phân tích đơn chỉ số: không triển khai.
- `ml/train_runtime.py` huấn luyện đúng cấu hình đã benchmark (assert cùng PR-AUC val và cùng ngưỡng) và xuất `tests/fixtures/model-parity.json`; `tests/model.test.js` kiểm điểm JS khớp thư viện.
- Server không gọi Python; thiếu mô hình → chỉ rule, ghi rõ. Báo cáo đánh giá duy nhất: `reports/evaluation-comparison.json` (toàn luồng trên bộ demo độc lập + tóm tắt benchmark), có dấu vân tay để phát hiện báo cáo cũ.
- `firstVisitAbnormalPolicy` trong CHEM-H02: app chỉ chạy `ALWAYS_REVIEW`; giá trị khác vẫn giữ phiếu. `MODEL_FLAG_ONLY` chỉ có trong benchmark (đề xuất chờ khoa).
