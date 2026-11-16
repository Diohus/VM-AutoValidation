# Thiết kế dữ liệu đích

Đây là thiết kế để phát triển tiếp, chưa phải schema đã triển khai trong demo frontend.

## Bảng chính

| Bảng | Trường gợi ý |
|---|---|
| subjects | subject_token (mã giả ổn định), dữ liệu tối thiểu được phép dùng |
| test_catalog | test_code, name, discipline, value_type |
| orders | order_id, subject_token, ordered_at, status |
| order_items | order_item_id, order_id, test_code, status |
| specimens | specimen_id, order_id, type, collected_at, received_at |
| results | result_id, order_item_id, specimen_id, version, numeric_value, text_value, comparator, unit, instrument_id, method_id, measured_at, status, supersedes_id |
| instrument_flags | result_id hoặc specimen_id, code, source, observed_at |
| clinical_context | context_id, subject_token, type, code/value, known_at, effective_from, effective_to, source, verification_status |
| evaluations | evaluation_id, input_snapshot, rule_version, evaluated_at, decision, reasons |
| review_actions | evaluation_id, result_version, action, reason_code, note, reviewer, reviewed_at |

Một danh mục có 150 xét nghiệm vẫn chỉ có 15 order_items khi chỉ định 15 mục. Kết quả chưa có không được suy ra là không chỉ định. Một phiếu có thể có nhiều mẫu; ràng buộc ghép mẫu cần thống nhất với LIS.

## Trạng thái

Order item: `ORDERED`, `PENDING`, `RESULTED`, `FAILED`, `CANCELLED`, `NOT_APPLICABLE`. Chỉ có record chỉ định mới được chuyển qua các trạng thái đó; không dùng 0 làm giá trị thiếu.

Rule đích: `PASS`, `REVIEW`, `NOT_APPLICABLE`, `NOT_EVALUABLE`. Rule trong bản demo hiện chỉ trả pass boolean vì chạy trên fixture đóng; cần mở rộng trước khi xử lý input tùy ý.

## CSV và ML

Dữ liệu trao đổi có thể là các CSV theo từng bảng. Dữ liệu vận hành nên dùng dạng dài. Chỉ pivot thành bảng đặc trưng nhiều cột ở bước ML; kèm mask trạng thái thiếu và mốc thời gian. Không dùng chẩn đoán hoặc dữ liệu chỉ biết sau thời điểm quyết định.

## Lịch sử và bảo mật

Nối lịch sử bằng mã giả ổn định. Bảng ánh xạ danh tính giữ trong bệnh viện, không đưa vào demo. Giả danh hóa không đồng nghĩa vô danh hoàn toàn. Mỗi đánh giá cần giữ đúng phiên bản và thông tin được biết tại thời điểm đó.
