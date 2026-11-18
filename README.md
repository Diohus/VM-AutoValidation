# VM-AutoValidation / LabReview

**Tất cả dữ liệu là giả lập. Không kết nối LIS, không ký số, không phát hành kết quả thật. Mọi ngưỡng, rule và mô hình là cấu hình minh họa, chưa được khoa xét nghiệm phê duyệt hay thẩm định. Không dùng cho người bệnh.**

Prototype hỗ trợ bác sĩ duyệt kết quả sau khi máy gửi lên LIS. **Hệ thống chỉ đề xuất. Bác sĩ quyết định và ký; hệ thống không tự ký.**

```
máy → LIS → hệ thống đọc phiếu [dữ liệu → QC → cờ máy → mẫu → giới hạn/tới hạn → lịch sử → nhất quán → mô hình]
          → đề xuất: Không thấy bất thường | Có điểm cần chú ý | Chưa nên ký   (tô màu dòng có vấn đề + lý do)
          → bác sĩ đọc, bấm: Ký | Cần xem xét lại | Yêu cầu chạy lại mẫu
          → Ký: phiếu vào hàng đợi ký (FIFO, chạy ngầm), lần lượt gửi sang hệ thống ký của bệnh viện (~10–15 s/phiếu, mô phỏng);
                bác sĩ sang phiếu tiếp theo ngay, không chờ
          → ký lỗi: phiếu quay lại đầu danh sách "Chờ duyệt" + thông báo (chuông, toast, thông báo trình duyệt)
```

## Chạy trên máy

Yêu cầu Node.js ≥ 22 để chạy web app. **Không cần Python và không có dependency npm khi chạy**: các mô hình đã huấn luyện nằm sẵn trong `models/*.json` và được suy luận bằng JS. Nếu thiếu `models/`, app chạy chỉ bằng rule và ghi rõ điều đó; server **không bao giờ** gọi Python hay tự huấn luyện khi khởi động.

```bash
npm start          # tự sinh dữ liệu demo nếu chưa có, rồi mở http://127.0.0.1:5173
npm test           # rule (gồm thiếu dữ liệu, giá trị 0, sai đơn vị), ngưỡng cá nhân, mô hình (khớp điểm với thư viện Python), LLM (không gọi mạng), luồng duyệt/ký/phản hồi
npm run setup      # sinh lại dữ liệu demo (seed cố định) và tính lại báo cáo đánh giá (chỉ Node)
npm run diagnose   # chẩn đoán rule và kịch bản
```

Lần chạy đầu mất khoảng 1 phút để sinh khoảng 19.000 phiếu và tính báo cáo đánh giá. Trạng thái demo (phản hồi, nhật ký, phiên bản sửa) lưu ở `data/runtime/state.json`. Có thể xóa trong tab *Nhật ký*.

### Huấn luyện và benchmark mô hình (ngoại tuyến, Python)

Chỉ cần khi muốn huấn luyện lại hoặc chạy lại benchmark. Phiên bản đã dùng: Python 3.11.9, xem `requirements.txt`.

```bash
python -m venv .venv
.venv/Scripts/python -m pip install --use-feature=truststore -r requirements.txt
npm run bench:data    # bộ benchmark riêng: 10.000 người bệnh, seed 20261117 (~3 phút)
npm run bench         # ml/benchmark.py → reports/benchmark.json + bảng tóm tắt (~9 phút)
npm run bench:test    # test hồi quy của benchmark
npm run train         # ml/train_runtime.py → models/*.json + tests/fixtures/model-parity.json, rồi tính lại báo cáo đánh giá
```

Lưu ý trên Windows của máy phát triển:
- pip lỗi chứng chỉ SSL nếu không có `--use-feature=truststore` (dùng kho chứng chỉ của Windows).
- Windows Application Control chặn DLL của **pandas**, nên `ml/` chỉ dùng numpy/scikit-learn/XGBoost/LightGBM. Không cài pandas.
- Lệnh `npm run bench*`/`train` gọi `.venv\Scripts\python` (đường dẫn Windows). Trên macOS/Linux, chạy trực tiếp `.venv/bin/python ml/benchmark.py`, `ml/train_runtime.py`.

## Các chức năng

| Tab | Nội dung |
|---|---|
| **Duyệt kết quả** | 110 phiếu của ngày mô phỏng 16/11/2026, trong đó có 17 phiếu kịch bản trong hàng đợi và các phiếu tập test. Bộ dữ liệu có tổng cộng 36 phiếu mang split `scenario`; đây không phải số phiếu kịch bản trong hàng đợi hôm nay. Danh sách chia tab *Chờ duyệt* (phiếu ký lỗi luôn ở đầu), *Xem lại*, *Chạy lại*, *Đang ký*, *Đã ký*; trong mỗi tab sắp theo ưu tiên (tới hạn → chưa nên ký → cần chú ý). Phiếu hiển thị như phiếu kết quả thông thường: bảng gọn (không kẻ dọc), cờ H/L, đơn vị, khoảng tham chiếu, lần trước. Dòng hệ thống thấy có vấn đề được **tô màu và có chú thích lý do ngay dưới dòng**; vấn đề chung của phiếu (QC, HIL, mô hình…) nằm trong ô *Hệ thống đề xuất* ngay dưới bảng, trên thanh nút. Cột danh sách phiếu kéo được để đổi độ rộng hoặc thu gọn. Bối cảnh (kể cả mô tả kịch bản demo), mẫu, các bước kiểm tra và mô hình nằm trong phần thu gọn. Phần **chi tiết các bước kiểm tra** đi theo từng bước, mỗi rule có trạng thái Đạt / Không đạt / Không đánh giá được (thiếu dữ liệu) / Không áp dụng. Mỗi điểm mô hình kèm **mức phủ dữ liệu** ("dùng 7/12 chỉ số", nêu chỉ số nào không chỉ định / chưa có kết quả), trạng thái lịch sử và **giải thích theo từng phiếu** (đặc trưng đóng góp nhiều nhất). |
| | Thanh nút cuối phiếu: **Ký**, **Cần xem xét lại** (lý do/ghi chú tùy chọn), **Yêu cầu chạy lại mẫu** (chọn xét nghiệm, mặc định chọn sẵn các chỉ số bị tô màu). Sau mỗi thao tác app tự chuyển sang phiếu tiếp theo. Phiếu có giá trị tới hạn: phải tick "Đã thông báo giá trị tới hạn cho lâm sàng" mới ký được. Phiếu *Chưa nên ký* (thiếu kết quả, sai đơn vị, QC không đạt, cờ chặn…) không ký được, cần chạy lại/xử lý. *Nhận kết quả chạy lại* (mô phỏng máy gửi lên) tạo phiên bản mới; hệ thống đọc lại và phiếu quay về *Chờ duyệt*. |
| | Hàng đợi ký: FIFO, mỗi lần một phiếu, mỗi phiếu 10–15 s (mô phỏng), khoảng 10% lỗi (timeout, HTTP 503, chưa mở khóa chứng thư). Chỉ hiện "Đã ký" khi hệ thống bệnh viện xác nhận. Phiếu còn chờ trong hàng có thể *rút lệnh ký*; phiếu đang gửi thì không. Idempotency key theo phiên bản, chặn ký trùng; có phiên bản mới thì lệnh ký của phiên bản cũ bị bỏ. Phiếu ký lỗi quay lại đầu *Chờ duyệt*, có thông báo (chuông trên thanh trên cùng, toast, và thông báo trình duyệt nếu được cho phép), bấm *Ký lại*. Khởi động lại máy chủ: phiếu đang chờ tiếp tục theo thứ tự; phiếu đang gửi dở được coi là lỗi (chưa xác nhận) để bác sĩ ký lại. |
| | Cài đặt: ngưỡng chung/cá nhân, bật/tắt lớp mô hình, hiện nhãn ground truth giả lập để đào tạo. Không còn chế độ tự ký. |
| **Nhập thử kết quả** | Bác sĩ tự nhập giá trị, đơn vị, HIL, cờ máy, trạng thái QC và giá trị lần trước để xem hệ thống quyết định. Ô trống nghĩa là "chưa có kết quả", không bị coi là 0. Phần nhập thử không ghi vào hàng đợi. |
| **Đánh giá mô hình** | Một nơi duy nhất, đọc `reports/evaluation-comparison.json`: (1) *chỉ rule* so với *rule + mô hình đang dùng* trên tập test của bộ demo (dữ liệu độc lập với bộ huấn luyện), kèm mẫu số, Wilson 95%, phát hiện theo loại lỗi, ngưỡng cá nhân, và số lần mỗi mô hình chấm điểm / không đánh giá được; (2) tóm tắt benchmark ngoại tuyến (`reports/benchmark.json`): LR so với XGBoost so với LightGBM, mô hình bất thường cho người khám lần đầu, chính sách người khám lần đầu. Dữ liệu giả lập đã làm giàu tỷ lệ lỗi; không phải hiệu năng lâm sàng. |
| **Phản hồi** | Mỗi thao tác của người phụ trách được lưu thành một bản ghi gồm quyết định hệ thống, phiên bản rule/mô hình, mã băm đầu vào, hành động, lý do và kết quả xác minh. Trạng thái nhãn mặc định là `CHƯA RÀ SOÁT`. Có xuất CSV. **Phản hồi không làm thay đổi rule đang chạy.** |
| **Nhật ký** | Ghi lại đánh giá, thao tác, sửa phiên bản, gửi, ACK, gửi lỗi, gửi trùng và thay đổi cấu hình. |
| **Rule & cấu hình** | Bộ rule JSON có phiên bản (người phê duyệt: *chưa có*) và danh mục chỉ số minh họa. |

### Kịch bản demo trong hàng đợi (mục 8 của PROJECT CONTEXT, cộng thêm KB8)

| Mã | Tình huống | Đề xuất của hệ thống (mã engine) |
|---|---|---|
| KB1 | Đầy đủ, ổn định, QC đạt | AUTO_APPROVE_ELIGIBLE |
| KB2 | Glucose 11,7 ngoài tham chiếu nhưng ổn định theo lịch sử (bệnh nền chỉ hiển thị, không tự cho qua) | AUTO_APPROVE_ELIGIBLE |
| KB2b | Tiểu đường, glucose về mục tiêu sau khi bắt đầu insulin (−44%) | MANUAL_REVIEW |
| KB3 / KB3b / KB3c | Creatinine tăng 123% / nghi nhầm mẫu (WBIT) trên CBC (delta check và mô hình WBIT cùng giữ) / nghi lẫn NaCl 0,9% (rule Na−Cl và mô hình lẫn dịch truyền cùng giữ) | MANUAL_REVIEW |
| KB3d | Thay đổi thật khi nhập viện vì tổn thương thận cấp (ca âm tính khó, mẫu đúng) | MANUAL_REVIEW |
| KB4 / KB4b / KB4c | QC K không đạt đang khóa / cờ PLT_CLUMPS / tan máu H=180 | BLOCKED |
| KB5 / KB5b / KB5d | Sai đơn vị mg/dL (mô hình không nhận giá trị sai đơn vị → không đánh giá được) / lỗi truyền kết quả Cl / thiếu HIL | BLOCKED |
| KB5c | K bất thường, người bệnh lần đầu, rule yêu cầu lịch sử | MANUAL_REVIEW |
| KB6 | K 6,6, giá trị tới hạn đi luồng ưu tiên, phải ghi nhận đã thông báo | MANUAL_REVIEW (ưu tiên CRITICAL) |
| KB7 | Kiểu hình nghi nhiễm EDTA (rule K–Ca giữ; không dùng mô hình cho EDTA), dùng để thử ghi phản hồi | MANUAL_REVIEW |
| KB8 | Bệnh thận mạn ổn định — ngưỡng chung so với ngưỡng cá nhân | MANUAL_REVIEW ở chế độ ngưỡng chung; có thể đủ điều kiện khi bật chế độ cá nhân hóa |

## Cấu trúc

```
config/analytes.json        danh mục 23 chỉ số (đơn vị SI, tham chiếu, giới hạn tự duyệt, tới hạn, AMR, RCV, CVi/CVg) — minh họa
config/rules.chem.json      bộ rule hóa sinh (cobas c303/ISE mô phỏng) — có mã, bước, hành động, lý do, phiên bản
config/rules.heme.json      bộ rule CBC (DxH 690T mô phỏng) — tách riêng, không dùng chung với hóa sinh
src/core/engine.js          pipeline đánh giá thuần (không I/O), dùng chung cho server, đánh giá và test
src/core/features.js        đặc trưng cho mô hình (chỉ dùng lịch sử TRƯỚC thời điểm đo; không điền giá trị thiếu; 0 là giá trị thật)
src/core/model.js           suy luận JS: cây XGBoost (bộ chấm điểm của PR #2, mở rộng: float32, giải thích Saabas) và KNN người khám lần đầu
src/core/load-models.js     nạp models/*.json (chỉ phía Node)
src/core/history.js         tra lịch sử theo mã giả
scripts/generate-data.mjs   sinh dữ liệu giả lập (xem docs/SYNTHETIC_DATA.md)
scripts/export-features.mjs xuất đặc trưng + quyết định chỉ-rule (từ engine JS) cho Python
scripts/evaluate-comparison.mjs đánh giá toàn luồng chỉ rule vs rule + mô hình, gộp tóm tắt benchmark → reports/evaluation-comparison.json
ml/benchmark.py             benchmark LR / XGBoost / LightGBM / KNN / OCSVM / Gaussian → reports/benchmark.json
ml/train_runtime.py         huấn luyện đúng các mô hình benchmark đã chọn (reports/benchmark.json → deployed), xuất JSON + fixture so điểm
models/                     mô hình đang dùng (JSON, đã commit): chem_wbit, heme_wbit, chem_ivfluid (XGBoost, cấu hình PR #2), fv_chem_basic, fv_chem_ext, fv_cbc (KNN)
server/server.mjs           API + mô phỏng ký/gửi/ACK + lưu trạng thái
public/                     giao diện tiếng Việt (vanilla JS, sáng/tối, dùng được trên điện thoại)
tests/                      node:test (+ tests/fixtures/model-parity.json)
docs/                       thiết kế dữ liệu, mô hình, các điểm chưa xác minh
```

## Benchmark lớp mô hình (17/11/2026, dữ liệu giả lập)

**Mọi con số dưới đây chỉ đúng trên dữ liệu giả lập**: tỷ lệ lỗi được làm giàu khoảng 10–50 lần, và lỗi do chính generator tiêm vào nên dễ phát hiện hơn lỗi thật. Không dùng làm tiêu chí nghiệm thu. Chi tiết đầy đủ ở `reports/benchmark.json`; kế hoạch và quyết định thiết kế ở [docs/MODEL_REDESIGN_PLAN.md](docs/MODEL_REDESIGN_PLAN.md).

Thiết lập: bộ riêng 10.000 người bệnh (seed 20261117), 63.235 phiếu, chia theo người bệnh 60/20/20, có mô phỏng nhầm mẫu (WBIT). Đặc trưng và quyết định "chỉ rule" lấy từ chính engine JS. Siêu tham số chọn bằng GroupKFold theo người bệnh trên train; ngưỡng là ngưỡng lớn nhất đạt recall đích trên val; test chỉ dùng một lần. Không điền giá trị thiếu. Khoảng tin cậy: Wilson; PR-AUC dùng bootstrap theo người bệnh.

### Giữ phần nào của đồng đội (PR #2), thay phần nào, vì sao

Quy tắc (người dùng, 17/11/2026), **chốt trước khi chạy**: lựa chọn của đồng đội là mặc định; phương án khác chỉ thay khi **tốt hơn rõ trên tập validation** — khoảng tin cậy PR-AUC không chồng lên nhau, hoặc số lỗi bắt thêm so với chỉ-rule chênh rõ (Wilson không chồng) mà báo động giả không tệ hơn rõ. Ngang nhau → giữ của đồng đội. Quyết định dựa trên val; test chỉ để báo cáo. Cấu hình đồng đội = XGBoost depth 3, 200 cây, eta 0,05, `scale_pos_weight` = âm/dương, cùng tập đặc trưng như `scripts/train-xgb.mjs` @ a3d90ca.

| Bộ phát hiện | Của đồng đội (PR #2) | Của nhánh này | Được chọn | Số liệu (test) và lý do |
|---|---|---|---|---|
| Nhầm mẫu (WBIT) — hóa sinh, có lịch sử ≤90 ngày | XGBoost tham số PR #2 (biến thể trên bộ đặc trưng hiện tại, xem ghi chú dưới bảng): PR-AUC 0,42 [0,36–0,49], bắt thêm 9/92 ca rule bỏ sót, báo động giả thêm 0,62% | LightGBM (CV): 0,55 [0,48–0,63], bắt thêm 7/92, báo động giả 0,42%; LR 0,09 | **Của đồng đội** | Val: PR-AUC 0,48 [0,41–0,58] so với 0,54 [0,47–0,61] (XGBoost CV), CI chồng; số bắt thêm không chênh rõ. *Ghi chú:* trên val LightGBM có báo động giả thấp hơn rõ (0,2% so với 1,0%), nhưng tiêu chí chốt trước không tính riêng báo động giả nên không đổi. |
| Nhầm mẫu (WBIT) — CBC, có lịch sử ≤90 ngày | XGBoost cấu hình PR #2: PR-AUC 0,50 [0,45–0,59], bắt thêm 21/118, báo động giả 0,64% | LightGBM (CV): 0,52 [0,45–0,61], bắt thêm 19/118, 0,62%; LR 0,30 | **Của đồng đội** | Ngang nhau (CI chồng ở val và test). |
| Lẫn dịch truyền (NaCl 0,9% / glucose 5%) | XGBoost cấu hình PR #2 trên cùng mục tiêu: PR-AUC 0,977 [0,957–0,990], bắt thêm 3/6, báo động giả 1/4.974 | LightGBM (CV): 0,983 [0,968–0,994], bắt thêm 3/6, 0/4.974; LR 0,80 | **Của đồng đội** (đổi từ LightGBM sang XGBoost) | Ngang nhau (val 0,980 so với 0,983, CI chồng). |
| Nhiễm mẫu: gộp (PR #2) hay tách | Một mô hình gộp EDTA + NaCl + glucose 5% (`chem_contam_xgb`): bắt thêm 2/6 ca rule bỏ sót, báo động giả 0/4.974 | Tách: EDTA bằng rule K–Ca + mô hình lẫn dịch truyền: bắt thêm 3/6, báo động giả 1/4.974 | **Tách** | Gộp không tốt hơn rõ trên val (so trên cùng phiếu: cùng 3/5 bắt thêm, 0 báo động giả). Rule đã bắt mọi ca EDTA (72/72 phiếu không lỗi dữ liệu; 74/74 tính cả phiếu lỗi dữ liệu). *Lưu ý:* hướng dẫn cho mục này là "gộp tốt hơn rõ thì dùng gộp, không thì giữ tách"; Codex vòng 4 nêu rằng nguyên tắc chung "ngang nhau ưu tiên đồng đội" sẽ chọn gộp — cần người dùng xác nhận. |
| Bộ chấm điểm cây JS | `scoreXgboostFeatures`, không có giải thích theo từng phiếu, chưa có test so điểm | — | **Của đồng đội**, mở rộng | Giữ, thêm so sánh float32, giải thích Saabas (khớp `approx_contribs` của XGBoost), test so điểm với thư viện. |
| Lỗi phân tích đơn chỉ số | — | XGBoost (CV) | Không triển khai | Báo động giả thêm quá cao ở ngưỡng recall 80% (hóa sinh ~34%, CBC ~9% trên val). |
| Người khám lần đầu | — | KNN (Farrell 2024) | **Của nhánh này** | Đồng đội không có mô hình tương ứng. |

*Ghi chú về "cấu hình PR #2":* tham số (depth 3, 200 cây, eta 0,05, `scale_pos_weight` = âm/dương), bộ lọc đặc trưng, phạm vi có lịch sử và cách chọn ngưỡng giống PR #2; nhưng đặc trưng được tính bằng extractor hiện tại (0 là giá trị thật, không điền giá trị thiếu, thêm HCT và cờ "có đo"), thứ tự cột khác. Không tái hiện extractor cũ vì nó chứa đúng các lỗi mà quyết định 2–3 yêu cầu sửa.

Kết quả gộp các mô hình đang dùng so với chỉ rule (bộ benchmark, test, mục tiêu = nhầm mẫu + nhiễm mẫu + lỗi phân tích):
- **Hóa sinh:** rule bắt 345/458 lỗi. Mô hình có giám sát (WBIT + lẫn dịch truyền) bắt thêm 13/113 ca rule bỏ sót, báo động giả thêm 0,6% phiếu sạch. Cộng KNN người khám lần đầu: 18/113, báo động giả 1,1%.
- **CBC:** rule bắt 127/275 lỗi (WBIT là lỗ hổng chính: rule chỉ bắt 39%). WBIT: thêm 22/148, báo động giả 0,6%. Cộng KNN: 33/148, báo động giả 2,4%.
- **WBIT ở người không có lịch sử ≤90 ngày:** mô hình WBIT không áp dụng (0/83 hóa sinh, 0/87 CBC trên test). KNN người khám lần đầu tình cờ gắn cờ một phần: 2/83 hóa sinh, 11/87 CBC (8 ca rule bỏ sót) — vì máu người khác lệch khỏi phân bố thường quy, không phải vì nhận ra nhầm mẫu. Phần còn lại không phát hiện được; đây là lý do câu hỏi định danh tại giường quan trọng ([docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md)).

So sánh thuật toán (PR-AUC test, cấu hình tốt nhất của từng thuật toán; cột cuối là cấu hình PR #2):

| Bộ phát hiện | LR | XGBoost (CV) | LightGBM (CV) | XGBoost PR #2 |
|---|---|---|---|---|
| WBIT — hóa sinh | 0,09 | 0,54 | 0,55 | 0,42 |
| WBIT — CBC | 0,30 | 0,49 | 0,52 | 0,50 |
| Nhiễm mẫu gộp | 0,81 | 0,975 | 0,98 | 0,97 |
| Lẫn dịch truyền | 0,80 | 0,98 | 0,98 | 0,98 |
| Nhiễm EDTA | 1,00 | 1,00 | 1,00 | — |
| Lỗi phân tích — hóa sinh | 0,03 | 0,33 | 0,27 | — |
| Lỗi phân tích — CBC | 0,46 | 0,49 | 0,50 | — |

Đọc thêm:
- **Người khám lần đầu (KNN/OCSVM/Gaussian, gắn cờ 5%):** độ nhạy KNN ở hóa sinh 76–84%; CBC ba mô hình tương đương. Gắn cờ ở người bệnh nhập viện thật (mẫu đúng) 0–5%.
- **Chính sách người khám lần đầu (hóa sinh, 2.838 phiếu test):** `MODEL_FLAG_ONLY` tăng tự duyệt 79,4% → 84,2% (thả 137 phiếu) nhưng lỗi bị cho qua tăng 81/362 → 90/362 (thêm 9 ca, gồm WBIT, lỗi phân tích, NaCl). App chỉ chạy `ALWAYS_REVIEW`; `MODEL_FLAG_ONLY` chỉ có trong benchmark, là đề xuất chờ khoa.
- **PPV ở tỷ lệ lỗi thật** (1%, 0,1%, 0,03%): xem `ppvAtAssumedPrevalence` trong `reports/benchmark.json`. Với độ đặc hiệu 94–97% (WBIT), PPV ở 0,03% chỉ 0,4–0,8% (lẫn dịch truyền: 32%).

**Kiểm tra toàn luồng trên dữ liệu độc lập** (bộ demo seed 20261116, test 3.852 phiếu; mô hình huấn luyện trên bộ benchmark): hóa sinh — tự duyệt 71,8% → 70,6%, lỗi bị cho qua 9,2% → 7,6%, báo động giả 13,8% → 15,4%; CBC — tự duyệt 83,5% → 81,4%, lỗi bị cho qua 32,0% → 18,4%, báo động giả 5,5% → 7,4%. Xem tab *Đánh giá mô hình*.

## "AI" trong prototype gồm những gì

| Thành phần | Là gì | Cần API key? |
|---|---|---|
| **Mô hình phát hiện lỗi** (bật/tắt ở sidebar) | Chạy cục bộ bằng JS từ `models/*.json` (huấn luyện ngoại tuyến bằng Python trên dữ liệu giả lập): **nhầm mẫu (WBIT)** hóa sinh và CBC (chỉ khi có lịch sử ≤90 ngày) và **lẫn dịch truyền** hóa sinh — XGBoost cấu hình của đồng đội (PR #2); **bất thường đa chỉ số ở người khám lần đầu** (KNN theo panel, theo Farrell 2024). EDTA do rule. Chỉ được giữ thêm phiếu; thiếu dữ liệu then chốt → không đánh giá được, phiếu chuyển người duyệt; điểm chưa hiệu chỉnh xác suất. Mỗi điểm có giải thích theo từng phiếu và mức phủ dữ liệu. | Không (Python chỉ khi huấn luyện lại) |
| **Ngưỡng cá nhân** (chọn ở sidebar) | Khoảng thường gặp của từng người bệnh tính từ kết quả trước của chính họ. Xem [docs/PERSONALIZED_THRESHOLDS.md](docs/PERSONALIZED_THRESHOLDS.md). | Không |
| **Diễn giải bằng LLM** (nút trong phiếu) | Gọi OpenAI `gpt-6-luna` để diễn giải lý do bằng lời. **Không** tham gia quyết định. | Có — điền `OPENAI_API_KEY` trong `.env` |

## Giao diện

Nền trắng, sidebar trái (thu gọn được, nhớ trạng thái), màu chủ đạo xanh nước biển nhạt (`#A9D6EF`, bản đậm `#075985` cho chữ và nút) và điểm nhấn vàng bạch kim/champagne (`#D8C7A3`). Màu trạng thái tách riêng: đạt (xanh lá), cần xem (cam đất), chặn (đỏ), tới hạn (tím). Mọi trạng thái luôn có icon kèm chữ, mọi cặp chữ/nền đạt WCAG AA. Nguyên tắc hiển thị:
- Mặc định chỉ hiện lý do, kết quả và thao tác.
- Kết quả bình thường được thu gọn.
- Bối cảnh, toàn bộ các bước kiểm tra, mô hình và nhật ký nằm trong các mục mở rộng.
- Trang Rule ghi rõ **chặn/chuyển xem khi nào**, **việc cần làm** và **khi thiếu dữ liệu**, với ngưỡng trình bày dạng bảng thay vì JSON.

Hướng thiết kế do Codex tìm trên web (NHS Design System — Colour/Details, AHRQ PSNet — Alert fatigue, CAP — rule harmonization, Data Innovations Instrument Manager, các mẫu dashboard xét nghiệm trên Dribbble). Có thể mở thẳng một phiếu bằng đường dẫn `/#r=<mã phiếu>`.

## Làm việc cùng Codex

- **Vòng 1 (thiết kế):** ban đầu dùng logistic regression làm baseline; mỗi loại lỗi một bộ phát hiện; chia tập theo người bệnh trước khi tiêm lỗi; tách 4 loại nhãn; khóa QC theo máy–xét nghiệm–thời điểm; ký cả phiếu; thêm 2 ca tiểu đường đối chứng; mô phỏng 3 tầng. Sau đó (PR #2) đồng đội thử chuyển ba detector sang XGBoost; lúc đầu gộp, hai detector WBIT bị gỡ và nhiễm mẫu được thay bằng `chem_ivfluid` (LightGBM); sau đó người dùng đổi quyết định (17/11/2026): giữ phần của đồng đội nếu không bị phương án khác vượt rõ. Kết quả: WBIT hóa sinh/CBC và lẫn dịch truyền dùng XGBoost cấu hình PR #2; bộ chấm điểm cây JS của PR #2 được giữ và mở rộng (xem mục Benchmark).
- **Vòng 2 (review mã):** Codex tìm ra 11 lỗi, đã sửa hết và mỗi lỗi có test hồi quy. Các lỗi gồm: gửi lại vượt qua quyết định giữ; kết quả thiếu máy hoặc thời điểm đo lọt qua QC; trạng thái lạ hoặc "không áp dụng" lọt qua kiểm tra đủ kết quả; kết quả ngoài chỉ định bị bỏ qua; lấy mẫu mới vẫn mang kết quả của ống cũ; thời gian không hợp lệ hoặc đo trước khi lấy mẫu vẫn đạt; look-ahead khi phiếu có nhiều thời điểm đo; HIL là NaN vẫn đạt; chuỗi "4.2ERROR" được đọc thành 4,2; phiếu kẹt ở SENDING sau khi khởi động lại; chỉ số "giữ không cần thiết" bị trộn với phần giữ theo chính sách.
- **Làm lại lớp mô hình (17/11/2026), vòng 1 (kế hoạch):** Codex góp ý 11 điểm, đã áp dụng hết (bảng ở mục 9 của [docs/MODEL_REDESIGN_PLAN.md](docs/MODEL_REDESIGN_PLAN.md)). Hai lỗi của kế hoạch: ngưỡng recall diễn đạt ngược ("nhỏ nhất" phải là "lớn nhất"), và công thức z thiếu `/100`. Các điểm còn lại: `--out` của generator bị bỏ qua; giờ khám ngoại trú gán sau khi sắp xếp; `MODEL_FLAG_ONLY` phải quay về giữ phiếu khi mô hình không đánh giá được; so LR với cây phải cùng đầu vào; `analytical_single` dễ thành benchmark "tự đúng" (thêm chỉ số chỉ tiêm ở test); HCT nằm ngoài danh sách chỉ số của mô hình; báo mẫu số rõ cho "bắt thêm"; ablation khoa điều trị; nhãn đa lỗi.
- **Làm lại lớp mô hình, vòng 2 (review mã):** Codex tìm ra 6 lỗi, đã sửa hết và mỗi lỗi có test hồi quy hoặc chốt chặn:
  1. Mã người bệnh giả lập bị trùng (4 cặp trong bộ 10.000), làm gộp lịch sử của hai người. Đã sửa generator, thêm kiểm tra ở generator và bước xuất, rồi sinh lại dữ liệu.
  2. Ngưỡng 5% của mô hình bất thường được hiệu chỉnh trên cả người tái khám quá 90 ngày. Nay hiệu chỉnh trên người khám lần đầu thật và báo riêng hai nhóm.
  3. Chọn thuật toán bằng val. Nay chọn bằng CV trên train; val chỉ đặt ngưỡng.
  4. Chưa có allow-list đặc trưng cố định. Nay khai báo danh sách tên chính xác, từ chối cột lạ, và chỉ loại cột thiếu toàn bộ dựa trên train.
  5. Chỉ số "gắn cờ ở bệnh thật" loại mất chính các ca bệnh cần đo.
  6. Test "về 0" chưa kiểm chiều từ giá trị dương về 0.
- **Gộp PR #2 (XGBoost của đồng đội) và triển khai mô hình mới, vòng 3 (review diff sau merge):** Codex xác nhận điểm JS khớp thư viện (LightGBM 299 phiếu, KNN 100 phiếu mỗi panel), test an toàn mới thật sự chạy nhánh mô hình, server không gọi Python và không gửi cây ra trình duyệt. Codex tìm ra 5 lỗi, đã sửa hết và mỗi lỗi có test hồi quy:
  1. Mô hình "không đánh giá được" (thiếu đầu vào then chốt) vẫn để phiếu tự duyệt vì rule đặt `onNotEvaluable: IGNORE`. Nay là `REVIEW`; test kiểm **quyết định cuối**.
  2. Giá trị node dùng cho giải thích Saabas lấy `internal_value` của LightGBM, vốn không phải kỳ vọng tại node, nên giải thích có thể sai dù điểm đúng. Test cũ "tổng đóng góp = margin" luôn đúng nên không phát hiện được. Nay tính kỳ vọng theo số mẫu (LightGBM) hoặc cover (XGBoost) từ dưới lên; test kiểm từng node và so **từng đóng góp** với `approx_contribs` của XGBoost.
  3. Giải thích KNN dùng khoảng cách tới tâm các láng giềng, nên hai láng giềng đối xứng triệt tiêu nhau (điểm 10, giải thích 0). Nay phân rã theo từng láng giềng, tổng đóng góp bằng điểm.
  4. Chỉ hiện đóng góp dương, nên có phiếu không có giải thích (11/299 phiếu trong fixture). Nay chọn theo trị tuyệt đối và ghi hướng ↑/↓.
  5. Báo cáo đánh giá có thể mô tả sai mô hình đang chạy (ví dụ khi thiếu file mô hình). Nay báo cáo lưu dấu vân tay của mô hình, rule và danh mục; giao diện cảnh báo khi không khớp và liệt kê mô hình thực nạp.
- **Khi gộp PR #2 (tự kiểm, ngoài Codex):** test an toàn của PR #2 nạp mô hình bằng khóa `chem_contam` trong khi rule đã trỏ sang `chem_contam_xgb`, nên test không còn chạy nhánh mô hình. Nay khóa được lấy từ chính bộ rule. Giá trị gửi sai đơn vị (glucose 104 mg/dL) từng lọt vào mô hình như thể là mmol/L; nay bị coi là "chưa có kết quả hợp lệ".
- **Giữ phần của đồng đội, đưa WBIT trở lại, vòng 4 (review diff):** Codex xác nhận tham số `xgb_teammate`, `scale_pos_weight`, phạm vi có lịch sử và công thức ngưỡng khớp PR #2; `val_evidence` không lệch hàng; `injectWbit` không rò chéo tập. Các điểm và cách xử lý:
  1. Gộp/tách khi ngang nhau mặc định chọn tách, trong khi nguyên tắc chung là ưu tiên đồng đội → **giữ như hướng dẫn riêng cho mục này** ("gộp tốt hơn rõ thì dùng gộp"), thêm test hòa, và nêu để người dùng quyết.
  2. Nếu benchmark chọn mô hình gộp, rule CHEM-M02 vẫn trỏ `chem_ivfluid` → `train_runtime.py` dừng khi rule và mô hình xuất không khớp; test JS kiểm hai chiều.
  3. `xgb_teammate` là biến thể (extractor mới, thứ tự cột khác) → ghi rõ trong README và mã; không tái hiện extractor cũ vì nó chứa các lỗi đã được yêu cầu sửa.
  4. `clearly_better` crash khi khoảng tin cậy rỗng; tập val rỗng → sửa, thiếu bằng chứng thì giữ mặc định; có test.
  5. So tách/gộp chưa chắc trên cùng phiếu → nay cùng phiếu; phiếu mô hình không đánh giá được tính là "giữ" như runtime (đồng thời sửa cách tính ở test và báo cáo gộp cho nhất quán).
  6. README/metadata sai (WBIT không có lịch sử, số ca EDTA, ghi chú "không có WBIT", lý do rule ghi LightGBM) → đã sửa theo báo cáo hiện hành.

## Giả định đang dùng

1. **Đơn vị ký là cả phiếu.** Chỉ cần một chỉ số bị chặn hoặc cần xem thì cả phiếu bị giữ, không ký từng phần. Hóa sinh và CBC là hai phiếu riêng.
2. **Hệ thống không tự ký.** Mọi phiếu do bác sĩ ký. Mã AUTO_APPROVE_ELIGIBLE trong engine và báo cáo đánh giá chỉ có nghĩa "không thấy bất thường"; mã này dùng để đo hiệu năng, không dùng để ký.
3. **Giá trị tới hạn:** đứng đầu danh sách; khi ký, bác sĩ phải xác nhận "đã thông báo lâm sàng". Đây là chính sách giả lập.
4. **Phiếu "Chưa nên ký"** (lỗi dữ liệu/QC/mẫu) không ký được trên giao diện; cần chạy lại hoặc xử lý để có phiên bản mới. Đây là lựa chọn an toàn của prototype, khoa có thể đổi.
5. **QC:** dùng lần QC gần nhất *trước thời điểm đo* của đúng cặp máy–xét nghiệm, trong vòng 24 giờ. QC đạt buổi sáng không che được lần QC hỏng sau đó.
6. **Mô hình chỉ được nâng một phiếu lên MANUAL_REVIEW.** Mô hình không thể vượt qua điều kiện chặn hay tự duyệt. Điểm mô hình là điểm phát hiện, không phải xác suất an toàn.
7. **Học từ phản hồi:** chỉ ngoại tuyến. Phản hồi được rà soát nhãn, sau đó huấn luyện lại, đánh giá độc lập, rồi mới phê duyệt phiên bản mới.

## Chưa xác minh trước khi tích hợp thật

Xem [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md). Các điểm chính:
- Schema và giao thức LIS (HL7/ASTM). Khả năng xuất cờ máy, HIL, số lô.
- Ngưỡng do khoa phê duyệt.
- API ký số của hệ thống bệnh viện: thời gian ký, mã lỗi, có truy vấn trạng thái/idempotency không; cách mở khóa chứng thư của bác sĩ.
- Nơi xử lý dữ liệu.
- Hiệu năng trên dữ liệu thật (cần chạy ngầm dài hạn theo CLSI AUTO10/AUTO15).

## LLM (tùy chọn)

Dùng Node.js 24. Điền `OPENAI_API_KEY` trong `.env` (hoặc sao chép `.env.example`), rồi chạy lại `npm start`. `.env` đã được bỏ qua bởi Git; không chia sẻ khóa. Có thể đổi `OPENAI_MODEL`, `OPENAI_BASE_URL`, `LLM_TIMEOUT_MS`; đặt `LLM_ENABLED=false` để tắt. `GET /api/meta` trả trạng thái `llm` không chứa khóa.

`POST /api/reports/:id/explain` với `Content-Type: application/json`, body `{}`, trả `{ text, model, latencyMs, disclaimer }`; lỗi trả `{ error }`. Chỉ áp dụng cho phiếu trong hàng đợi. Cache trong bộ nhớ theo phiếu, phiên bản và mã băm đầu vào; audit chỉ ghi metadata, không ghi payload hay nội dung diễn giải.

Dữ liệu gửi ra ngoài chỉ gồm nhóm tuổi, giới, panel, kết quả/đơn vị/tham chiếu/trạng thái, check có action (mã, tên, thông báo), quyết định hệ thống, điểm mô hình và nhãn bệnh nền/thuốc/sự kiện kèm số ngày tương đối so với thời điểm đo (hoặc lấy mẫu nếu thiếu thời điểm đo). Không gửi mã phiếu, mã người bệnh thay thế, lượt khám, chỉ định, mẫu hay ngày tuyệt đối; không gửi ghi chú người duyệt, lịch sử thô hoặc ground truth. Nhãn và thông báo rule phải tiếp tục được kiểm soát khi tích hợp nguồn dữ liệu mới.

LLM chỉ diễn giải và gợi ý kiểm tra theo SOP; không tham gia đánh giá, thay đổi quyết định hay ký/gửi. Điểm logistic regression/XGBoost là điểm phát hiện trên dữ liệu giả lập, không phải xác suất an toàn. Hiện dùng [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) qua [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create), `reasoning.effort: none`, `max_output_tokens: 700`, văn bản, `store: false`. Model hỗ trợ effort `none/low/medium/high/xhigh/max` và Structured Outputs qua `text.format: { type: "json_schema", name, schema, strict: true }`; luồng này chỉ cần văn bản gạch đầu dòng khoảng 150 từ. Chưa gọi API thật khi chưa điền khóa.
