# VM-AutoValidation / LabReview

**Tất cả dữ liệu là giả lập. Không kết nối LIS, không ký số, không phát hành kết quả thật. Mọi ngưỡng, rule và mô hình là cấu hình minh họa, chưa được khoa xét nghiệm phê duyệt hay thẩm định. Không dùng cho người bệnh.**

Prototype mô phỏng bước kiểm tra kết quả sau khi máy gửi lên LIS, trước khi ký trả:

```
máy → LIS → [kiểm tra trước trả: dữ liệu → QC → cờ máy → mẫu → giới hạn/tới hạn → lịch sử → nhất quán → mô hình]
          → AUTO_APPROVE_ELIGIBLE (mô phỏng ký, chờ ACK)  |  MANUAL_REVIEW (người phụ trách, có lý do)  |  BLOCKED (nêu điều kiện cần xử lý)
```

## Chạy trên máy

Yêu cầu Node.js ≥ 22. Không cần cài thư viện nào (không có dependency npm).

```bash
npm start          # tự sinh dữ liệu + huấn luyện nếu chưa có, rồi mở http://127.0.0.1:5173
npm test           # 51 test: rule (gồm thiếu dữ liệu, giá trị 0), ngưỡng cá nhân, mô hình, LLM (không gọi mạng), luồng duyệt/ký/phản hồi
npm run setup      # sinh lại dữ liệu (seed cố định) và huấn luyện lại
npm run diagnose   # rule nào đang giữ phiếu "sạch"; 16 kịch bản có ra đúng quyết định không
```

Benchmark mô hình (ngoại tuyến, Python; server không cần Python):

```bash
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt
npm run bench:data   # bộ benchmark riêng: 10.000 người bệnh, seed 20261117 (~3 phút)
npm run bench        # ml/benchmark.py → reports/benchmark.json + bảng tóm tắt (~9 phút)
npm run bench:test   # test hồi quy của benchmark
```

Lần chạy đầu mất khoảng 30 giây để sinh khoảng 19.000 phiếu và huấn luyện. Trạng thái demo (phản hồi, nhật ký, phiên bản sửa) lưu ở `data/runtime/state.json`. Có thể xóa trong tab *Nhật ký*.

## Các chức năng

| Tab | Nội dung |
|---|---|
| **Hàng đợi duyệt** | 109 phiếu của "hôm nay" (16/11/2026), gồm 16 kịch bản dựng sẵn và các phiếu của người bệnh thuộc tập test. Phiếu được sắp theo mức ưu tiên (tới hạn → bị chặn → cần xem xét). Phần chi tiết gồm: kết quả, đơn vị, khoảng tham chiếu, giới hạn tự duyệt, lịch sử có thời điểm, bối cảnh không định danh, HIL, cờ máy và sự kiện QC. Phần **giải thích quyết định** đi theo từng bước, mỗi rule có trạng thái Đạt / Không đạt / Không đánh giá được (thiếu dữ liệu) / Không áp dụng. Kèm điểm mô hình và đặc trưng đóng góp. |
| | Thao tác: *duyệt & ký mô phỏng*, *giữ lại*, *yêu cầu kiểm tra bổ sung*, *ghi nhận đã thông báo tới hạn*, mỗi thao tác cần mã lý do và ghi chú. *Cập nhật kết quả* (chạy lại / sửa đơn vị / lấy mẫu mới) tạo phiên bản mới, làm đánh giá cũ hết hiệu lực và đánh giá lại. |
| | Ký/gửi: gửi tới "hệ thống tiếp nhận" giả lập. Chỉ hiện "đã ký/đã gửi" khi có ACK. Có idempotency key theo phiên bản, chặn gửi trùng, khoảng 10% lần gửi lỗi để thử gửi lại, và ACK của phiên bản cũ không xác nhận phiên bản mới. |
| | Chế độ: *Chạy ngầm* (chỉ đề xuất) hoặc *Tự ký mô phỏng*. Bật/tắt lớp mô hình. Có thể hiện nhãn ground truth giả lập để đào tạo. |
| **Nhập thử kết quả** | Bác sĩ tự nhập giá trị, đơn vị, HIL, cờ máy, trạng thái QC và giá trị lần trước để xem hệ thống quyết định. Ô trống nghĩa là "chưa có kết quả", không bị coi là 0. Phần nhập thử không ghi vào hàng đợi. |
| **Đánh giá mô hình** | So sánh *chỉ rule* với *rule + mô hình* trên cùng tập test, kèm mẫu số và khoảng tin cậy 95% (Wilson). Báo cáo tỷ lệ phát hiện theo loại lỗi, PR-AUC, độ nhạy và độ đặc hiệu tại ngưỡng, và PPV ước tính ở tỷ lệ lỗi giả định 1%, 0,1% và 0,03%. |
| **Phản hồi** | Mỗi thao tác của người phụ trách được lưu thành một bản ghi gồm quyết định hệ thống, phiên bản rule/mô hình, mã băm đầu vào, hành động, lý do và kết quả xác minh. Trạng thái nhãn mặc định là `CHƯA RÀ SOÁT`. Có xuất CSV. **Phản hồi không làm thay đổi rule đang chạy.** |
| **Nhật ký** | Ghi lại đánh giá, thao tác, sửa phiên bản, gửi, ACK, gửi lỗi, gửi trùng và thay đổi cấu hình. |
| **Rule & cấu hình** | Bộ rule JSON có phiên bản (người phê duyệt: *chưa có*) và danh mục chỉ số minh họa. |

### 16 kịch bản demo (mục 8 của PROJECT CONTEXT)

| Mã | Tình huống | Quyết định |
|---|---|---|
| KB1 | Đầy đủ, ổn định, QC đạt | AUTO_APPROVE_ELIGIBLE |
| KB2 | Glucose 11,7 ngoài tham chiếu nhưng ổn định theo lịch sử (bệnh nền chỉ hiển thị, không tự cho qua) | AUTO_APPROVE_ELIGIBLE |
| KB2b | Tiểu đường, glucose về mục tiêu sau khi bắt đầu insulin (−44%) | MANUAL_REVIEW |
| KB3 / KB3b / KB3c | Creatinine tăng 123% / CBC thay đổi lớn MCV/RDW, chưa rõ nguyên nhân / nghi lẫn NaCl 0,9% | MANUAL_REVIEW |
| KB3d | Thay đổi thật khi nhập viện vì tổn thương thận cấp (ca âm tính khó, mẫu đúng) | MANUAL_REVIEW |
| KB4 / KB4b / KB4c | QC K không đạt đang khóa / cờ PLT_CLUMPS / tan máu H=180 | BLOCKED |
| KB5 / KB5b / KB5d | Sai đơn vị mg/dL / lỗi truyền kết quả Cl / thiếu HIL | BLOCKED |
| KB5c | K bất thường, người bệnh lần đầu, rule yêu cầu lịch sử | MANUAL_REVIEW |
| KB6 | K 6,6, giá trị tới hạn đi luồng ưu tiên, phải ghi nhận đã thông báo | MANUAL_REVIEW (ưu tiên CRITICAL) |
| KB7 | Kiểu hình nghi nhiễm EDTA, dùng để thử ghi phản hồi | MANUAL_REVIEW |

## Cấu trúc

```
config/analytes.json        danh mục 23 chỉ số (đơn vị SI, tham chiếu, giới hạn tự duyệt, tới hạn, AMR, RCV, CVi/CVg) — minh họa
config/rules.chem.json      bộ rule hóa sinh (cobas c303/ISE mô phỏng) — có mã, bước, hành động, lý do, phiên bản
config/rules.heme.json      bộ rule CBC (DxH 690T mô phỏng) — tách riêng, không dùng chung với hóa sinh
src/core/engine.js          pipeline đánh giá thuần (không I/O), dùng chung cho server, huấn luyện và test
src/core/features.js        đặc trưng cho mô hình (chỉ dùng lịch sử TRƯỚC thời điểm đo)
src/core/model.js           logistic regression L2 (train + suy luận + đóng góp đặc trưng)
src/core/history.js         tra lịch sử theo mã giả
scripts/generate-data.mjs   sinh dữ liệu giả lập (xem docs/SYNTHETIC_DATA.md)
scripts/train.mjs           huấn luyện các bộ phát hiện + đánh giá → models/*.json, reports/evaluation.json
scripts/export-features.mjs xuất đặc trưng + quyết định chỉ-rule (từ engine JS) cho benchmark Python
ml/benchmark.py             benchmark LR / XGBoost / LightGBM / KNN / OCSVM / Gaussian → reports/benchmark.json
server/server.mjs           API + mô phỏng ký/gửi/ACK + lưu trạng thái
public/                     giao diện tiếng Việt (vanilla JS, sáng/tối, dùng được trên điện thoại)
tests/                      node:test
docs/                       thiết kế dữ liệu, mô hình, các điểm chưa xác minh
```

## Benchmark lớp mô hình (17/11/2026, dữ liệu giả lập)

**Mọi con số dưới đây chỉ đúng trên dữ liệu giả lập**: tỷ lệ lỗi được làm giàu khoảng 10–50 lần, và lỗi do chính generator tiêm vào nên dễ phát hiện hơn lỗi thật. Không dùng làm tiêu chí nghiệm thu. Chi tiết đầy đủ ở `reports/benchmark.json`; kế hoạch và quyết định thiết kế ở [docs/MODEL_REDESIGN_PLAN.md](docs/MODEL_REDESIGN_PLAN.md).

Thiết lập: bộ riêng gồm 10.000 người bệnh (seed 20261117), 63.273 phiếu, chia theo người bệnh 60/20/20. Đặc trưng và quyết định "chỉ rule" lấy từ chính engine JS. Siêu tham số chọn bằng GroupKFold theo người bệnh trên train; ngưỡng là ngưỡng lớn nhất đạt recall đích trên val; test chỉ dùng một lần. Không điền giá trị thiếu: cây nhận NaN trực tiếp, LR tách theo panel × có/không lịch sử. Khoảng tin cậy: Wilson; PR-AUC và báo động giả dùng thêm bootstrap theo người bệnh.

**Tiêu chí chính: bắt thêm so với chỉ rule, và giá phải trả.** Bảng dưới là thuật toán chọn trước theo CV trên train.

| Bộ phát hiện | Thuật toán | PR-AUC test | Rule đã bắt | Mô hình bắt thêm (trong số rule bỏ sót) | Báo động giả thêm (phiếu sạch rule cho qua) |
|---|---|---|---|---|---|
| Nhiễm EDTA | LR | 1,00 | 72/72 (100%) | 0/0 | 0/5.252 (0%) |
| Lẫn dịch truyền (NaCl 0,9%, glucose 5%) | LightGBM | 0,99 | 106/112 (94,6%) | 3/6 | 0/5.252 (0%) |
| Lỗi phân tích đơn chỉ số — hóa sinh | XGBoost | 0,33 | 41/56 (73,2%) | 10/15 | 2.481/5.252 (**47%**) |
| Lỗi phân tích đơn chỉ số — CBC | XGBoost | 0,49 | 52/82 (63,4%) | 10/30 | 632/5.212 (**12%**) |
| Bất thường, người khám lần đầu (KNN, gắn cờ 5%) | KNN | 0,47–0,60 | — | 6/24 (cả 3 panel) | 0,8–3,6% |

So sánh thuật toán (PR-AUC test, cấu hình tốt nhất của từng thuật toán):

| Bộ phát hiện | LR | XGBoost | LightGBM |
|---|---|---|---|
| Nhiễm EDTA | 1,00 | 1,00 | 1,00 |
| Lẫn dịch truyền | 0,82 | 0,985 | 0,99 |
| Lỗi phân tích — hóa sinh | 0,03 | 0,33 | 0,27 |
| Lỗi phân tích — CBC | 0,46 | 0,49 | 0,50 |

Khi ép cả ba thuật toán dùng cùng đầu vào (cùng tầng panel × lịch sử), XGBoost và LightGBM giảm nhẹ: dịch truyền còn 0,96; lỗi phân tích hóa sinh còn 0,22. Phần lợi thế của cây đến từ việc nhận trực tiếp giá trị thiếu và cờ "có đo".

Đọc kết quả:
- **Nhiễm EDTA:** rule K–Ca và các rule khác đã bắt 100%, nên mô hình không bắt thêm được ca nào. Với panel cơ bản (không có Ca), mô hình trả NOT_EVALUABLE: độ nhạy trên toàn phạm vi chỉ còn 51–58%, nhưng các ca này vẫn bị rule giữ.
- **Lẫn dịch truyền:** cây vượt LR rõ (PR-AUC 0,99 so với 0,82), bắt thêm 3/6 ca rule bỏ sót mà không thêm báo động giả nào. LR bắt thêm 4/6 nhưng thêm 2,1% báo động giả. Đây là chỗ duy nhất mô hình có lợi rõ ràng.
- **Lỗi phân tích đơn chỉ số:** khó. Với hóa sinh, ở ngưỡng recall 80% định trước, mô hình giữ thêm gần một nửa số phiếu sạch, **không dùng được**. Với CBC, XGBoost bắt thêm 10/30 ca nhưng thêm 12% báo động giả. Recall trên chỉ số "chưa thấy khi train" thấp hơn rõ rệt (CBC: 43% so với 70%), tức mô hình học một phần cơ chế tiêm lỗi. Cách chọn ngưỡng theo recall cần đổi sang ngân sách báo động (ví dụ 1%) cho bộ này. Việc đổi phải chốt trước rồi mới chạy lại, không chỉnh theo kết quả test.
- **Người khám lần đầu (KNN/OCSVM/Gaussian):** KNN có độ nhạy cao nhất ở hóa sinh (76–84%); với CBC thì ba mô hình tương đương nhau (PR-AUC khoảng 0,5). Phần bắt thêm so với rule nhỏ (6/24 ca rule bỏ sót), báo động giả thêm 0,8–3,6%. Tỷ lệ gắn cờ ở người bệnh nhập viện thật (mẫu đúng) là 0–5%.
- **Chính sách người khám lần đầu (hóa sinh, 2.838 phiếu test):** `MODEL_FLAG_ONLY` tăng tỷ lệ tự duyệt từ 79,5% lên 84,4% (thả 139 phiếu), nhưng lỗi bị cho qua tăng từ 8/280 lên 12/280 (thêm 2 ca lỗi phân tích, 2 ca lẫn NaCl). Mặc định giữ `ALWAYS_REVIEW`; câu hỏi đã ghi ở [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md).
- **Ablation bỏ đặc trưng nội trú/cấp cứu:** PR-AUC gần như không đổi, nên mô hình không dựa vào dấu vết tỷ lệ tiêm lỗi theo khoa.
- **PPV ở tỷ lệ lỗi thật** (1%, 0,1%, 0,03%): xem `ppvAtAssumedPrevalence` trong `reports/benchmark.json`. Với các bộ có độ đặc hiệu < 99%, PPV ở 0,03% gần 0.

Mô hình đang chạy trong server **chưa được thay** (vẫn là LR `chem_contam`). Bước thay mô hình chờ người dùng xác nhận.

## "AI" trong prototype gồm những gì

| Thành phần | Là gì | Cần API key? |
|---|---|---|
| **Mô hình phát hiện lỗi** (bật/tắt ở sidebar) | Hiện chạy 1 mô hình logistic regression **cục bộ** (`models/chem_contam.json`, nhiễm EDTA/dịch truyền hóa sinh). Mô hình nhầm mẫu (WBIT) đã gỡ. Bộ mô hình mới (XGBoost/LightGBM, phát hiện bất thường cho người khám lần đầu) mới ở mức benchmark, **chưa thay mô hình đang chạy**. Chỉ được giữ thêm phiếu. | Không |
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

- **Vòng 1 (thiết kế):** Codex đọc PROJECT CONTEXT và tổng quan nghiên cứu, rồi góp ý. Các góp ý đã áp dụng: dùng logistic regression thay cho GBDT tự viết; mỗi loại lỗi một bộ phát hiện; chia tập theo người bệnh trước khi tiêm lỗi; tách 4 loại nhãn; khóa QC theo máy–xét nghiệm–thời điểm; ký cả phiếu; thêm 2 ca tiểu đường đối chứng; mô phỏng 3 tầng; dùng tham số CVi/CVg do Codex đề xuất.
- **Vòng 2 (review mã):** Codex tìm ra 11 lỗi, đã sửa hết và mỗi lỗi có test hồi quy. Các lỗi gồm: gửi lại vượt qua quyết định giữ; kết quả thiếu máy hoặc thời điểm đo lọt qua QC; trạng thái lạ hoặc "không áp dụng" lọt qua kiểm tra đủ kết quả; kết quả ngoài chỉ định bị bỏ qua; lấy mẫu mới vẫn mang kết quả của ống cũ; thời gian không hợp lệ hoặc đo trước khi lấy mẫu vẫn đạt; look-ahead khi phiếu có nhiều thời điểm đo; HIL là NaN vẫn đạt; chuỗi "4.2ERROR" được đọc thành 4,2; phiếu kẹt ở SENDING sau khi khởi động lại; chỉ số "giữ không cần thiết" bị trộn với phần giữ theo chính sách.
- **Làm lại lớp mô hình (17/11/2026), vòng 1 (kế hoạch):** Codex góp ý 11 điểm, đã áp dụng hết (bảng ở mục 9 của [docs/MODEL_REDESIGN_PLAN.md](docs/MODEL_REDESIGN_PLAN.md)). Hai lỗi của kế hoạch: ngưỡng recall diễn đạt ngược ("nhỏ nhất" phải là "lớn nhất"), và công thức z thiếu `/100`. Các điểm còn lại: `--out` của generator bị bỏ qua; giờ khám ngoại trú gán sau khi sắp xếp; `MODEL_FLAG_ONLY` phải quay về giữ phiếu khi mô hình không đánh giá được; so LR với cây phải cùng đầu vào; `analytical_single` dễ thành benchmark "tự đúng" (thêm chỉ số chỉ tiêm ở test); HCT nằm ngoài danh sách chỉ số của mô hình; báo mẫu số rõ cho "bắt thêm"; ablation khoa điều trị; nhãn đa lỗi.
- **Làm lại lớp mô hình, vòng 2 (review mã):** Codex tìm ra 6 lỗi, đã sửa hết và mỗi lỗi có test hồi quy hoặc chốt chặn:
  1. Mã người bệnh giả lập bị trùng (4 cặp trong bộ 10.000), làm gộp lịch sử của hai người. Đã sửa generator, thêm kiểm tra ở generator và bước xuất, rồi sinh lại dữ liệu.
  2. Ngưỡng 5% của mô hình bất thường được hiệu chỉnh trên cả người tái khám quá 90 ngày. Nay hiệu chỉnh trên người khám lần đầu thật và báo riêng hai nhóm.
  3. Chọn thuật toán bằng val. Nay chọn bằng CV trên train; val chỉ đặt ngưỡng.
  4. Chưa có allow-list đặc trưng cố định. Nay khai báo danh sách tên chính xác, từ chối cột lạ, và chỉ loại cột thiếu toàn bộ dựa trên train.
  5. Chỉ số "gắn cờ ở bệnh thật" loại mất chính các ca bệnh cần đo.
  6. Test "về 0" chưa kiểm chiều từ giá trị dương về 0.

## Giả định đang dùng

1. **Đơn vị ký là cả phiếu.** Chỉ cần một chỉ số bị chặn hoặc cần xem thì cả phiếu bị giữ, không ký từng phần. Hóa sinh và CBC là hai phiếu riêng.
2. **Giá trị tới hạn:** không tự ký. Phiếu chuyển người phụ trách với mức ưu tiên cao nhất, và phải ghi nhận "đã thông báo lâm sàng" trước khi duyệt. Đây là chính sách giả lập.
3. **QC:** dùng lần QC gần nhất *trước thời điểm đo* của đúng cặp máy–xét nghiệm, trong vòng 24 giờ. QC đạt buổi sáng không che được lần QC hỏng sau đó.
4. **Mô hình chỉ được nâng một phiếu lên MANUAL_REVIEW.** Mô hình không thể vượt qua điều kiện chặn hay tự duyệt. Điểm mô hình là điểm phát hiện, không phải xác suất an toàn.
5. **Học từ phản hồi:** chỉ ngoại tuyến. Phản hồi được rà soát nhãn, sau đó huấn luyện lại, đánh giá độc lập, rồi mới phê duyệt phiên bản mới.

## Chưa xác minh trước khi tích hợp thật

Xem [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md). Các điểm chính:
- Schema và giao thức LIS (HL7/ASTM). Khả năng xuất cờ máy, HIL, số lô.
- Ngưỡng do khoa phê duyệt.
- Phương thức ký và trách nhiệm pháp lý với kết quả tự ký.
- Nơi xử lý dữ liệu.
- Hiệu năng trên dữ liệu thật (cần chạy ngầm dài hạn theo CLSI AUTO10/AUTO15).

## LLM (tùy chọn)

Dùng Node.js 24. Điền `OPENAI_API_KEY` trong `.env` (hoặc sao chép `.env.example`), rồi chạy lại `npm start`. `.env` đã được bỏ qua bởi Git; không chia sẻ khóa. Có thể đổi `OPENAI_MODEL`, `OPENAI_BASE_URL`, `LLM_TIMEOUT_MS`; đặt `LLM_ENABLED=false` để tắt. `GET /api/meta` trả trạng thái `llm` không chứa khóa.

`POST /api/reports/:id/explain` với `Content-Type: application/json`, body `{}`, trả `{ text, model, latencyMs, disclaimer }`; lỗi trả `{ error }`. Chỉ áp dụng cho phiếu trong hàng đợi. Cache trong bộ nhớ theo phiếu, phiên bản và mã băm đầu vào; audit chỉ ghi metadata, không ghi payload hay nội dung diễn giải.

Dữ liệu gửi ra ngoài chỉ gồm nhóm tuổi, giới, panel, kết quả/đơn vị/tham chiếu/trạng thái, check có action (mã, tên, thông báo), quyết định hệ thống, điểm mô hình và nhãn bệnh nền/thuốc/sự kiện kèm số ngày tương đối so với thời điểm đo (hoặc lấy mẫu nếu thiếu thời điểm đo). Không gửi mã phiếu, mã người bệnh thay thế, lượt khám, chỉ định, mẫu hay ngày tuyệt đối; không gửi ghi chú người duyệt, lịch sử thô hoặc ground truth. Nhãn và thông báo rule phải tiếp tục được kiểm soát khi tích hợp nguồn dữ liệu mới.

LLM chỉ diễn giải và gợi ý kiểm tra theo SOP; không tham gia đánh giá, thay đổi quyết định hay ký/gửi. Điểm logistic regression vẫn là điểm phát hiện giả lập. Hiện dùng [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) qua [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create), `reasoning.effort: none`, `max_output_tokens: 700`, văn bản, `store: false`. Model hỗ trợ effort `none/low/medium/high/xhigh/max` và Structured Outputs qua `text.format: { type: "json_schema", name, schema, strict: true }`; luồng này chỉ cần văn bản gạch đầu dòng khoảng 150 từ. Chưa gọi API thật khi chưa điền khóa.
