# Ngưỡng cá nhân hóa (personalized reference intervals)

## Câu hỏi

Hiện mọi người bệnh dùng chung một bộ ngưỡng: khoảng tham chiếu, giới hạn tự duyệt và giá trị tới hạn. Có nên đặt cho mỗi người bệnh một ngưỡng riêng cho từng chỉ số, tùy bệnh lý, tiền sử và lâm sàng của họ?

## Trả lời ngắn

**Có, nhưng ngưỡng nên tính từ chính kết quả đo trước đó của người bệnh, không tính từ chẩn đoán.** Bệnh lý, tiền sử và điều trị đều đã thể hiện trong các lần đo trước. Ngưỡng tính từ dữ liệu đo vì vậy phản ánh đúng tình trạng thực của người bệnh, chứ không phải tình trạng "được ghi" trong hồ sơ. Cách này cũng giữ đúng ràng buộc trong PROJECT CONTEXT: *không chuyển ví dụ tiểu đường thành quy tắc "có tiểu đường + glucose cao = pass"*.

Trong các tài liệu về biến thiên sinh học, cách này được gọi là *personalized reference interval* (prRI). Đây là hướng đã được bàn luận (các tác giả Coskun, Fraser, Carobene; nhóm EFLM về biến thiên sinh học), nhưng **chưa phải thực hành chuẩn cho autoverification**. Cần thẩm định tại khoa trước khi dùng thật.

## Cách prototype tính

Với mỗi chỉ số, lấy *n* kết quả trước của người bệnh trong 365 ngày (n ≥ 3), tính trên thang log:

```
điểm đặt cá nhân  = trung bình của n kết quả trước
khoảng cá nhân    = điểm đặt × exp( ± z · √((n+1)/n) · √(CVi² + CVa²) ),   z = 2,58 (≈99%)
```

Khoảng cá nhân **không được dùng** khi:
- có ít hơn 3 kết quả trước;
- lịch sử dao động mạnh hơn 2,5 lần mức biến thiên kỳ vọng (người bệnh chưa ở trạng thái ổn định);
- người bệnh nhập viện hoặc truyền máu trong 14 ngày gần nhất.

Khi đó hệ thống quay về ngưỡng chung và hiển thị rõ "chưa đủ cơ sở".

## Ba chế độ (chọn ở sidebar, mặc định là ngưỡng chung)

| Chế độ | Hành vi |
|---|---|
| **Ngưỡng chung** | Giống trước đây. |
| **Cá nhân: chỉ siết** | Thêm rule `P01`: kết quả nằm ngoài khoảng thường gặp *của chính người bệnh* thì chuyển người xem, kể cả khi vẫn bình thường so với quần thể. Ví dụ: glucose 5,6 ở người thường có 12. Chế độ này chỉ có thể giữ thêm phiếu. |
| **Cá nhân: siết + nới có điều kiện** | Như "chỉ siết". Ngoài ra, với một số chỉ số được phép (GLU, URE, CRE, ALB, ALP, AST, ALT; HGB, MCV, MCH, RDW), kết quả vượt giới hạn tự duyệt chung **nhưng nằm trong khoảng cá nhân ổn định** thì không bị giữ *chỉ vì* giới hạn chung. |

Các giới hạn cứng không bao giờ được nới:
- Ngưỡng **tới hạn**.
- Các điều kiện chặn: QC, HIL, cờ máy, dữ liệu, dải đo (AMR).
- **K, Na, Ca** và WBC/PLT thấp: không nằm trong danh sách được phép nới.

## Kết quả trên dữ liệu giả lập (tập test)

| Hóa sinh | Tự duyệt | Lỗi mẫu bị cho qua | Báo động giả |
|---|---|---|---|
| Ngưỡng chung | 74,7% | 13,8% | 13,9% |
| Cá nhân: siết | 72,4% | 11,6% | 16,2% |
| Cá nhân: siết + nới | 72,4% | 11,6% | 16,2% |

| Huyết học (CBC) | Tự duyệt | Lỗi mẫu bị cho qua | Báo động giả |
|---|---|---|---|
| Ngưỡng chung | 84,1% | 34,3% | 5,1% |
| Cá nhân: siết | 82,6% | 29,5% | 6,6% |
| Cá nhân: siết + nới | 82,6% | 29,5% | 6,6% |

Cách đọc:
- **Siết** bắt thêm lỗi (số liệu đo ở phiên bản đầu của dữ liệu giả lập; xem tab Đánh giá mô hình cho số hiện tại): phần lớn là nhầm mẫu (WBIT) mà delta check 90 ngày không thấy, vì ngưỡng cá nhân nhìn lại tới 365 ngày. Cái giá phải trả là báo động giả tăng thêm khoảng 1,5–2,3 điểm.
- **Nới** gần như không có tác dụng trên dữ liệu giả lập, vì rất ít người bệnh giả có từ 3 kết quả ổn định trở lên nằm ngoài giới hạn chung. Lợi ích của nới chỉ đánh giá được trên dữ liệu thật của nhóm bệnh mạn tính tái khám định kỳ (ví dụ lọc máu, bệnh thận mạn, thalassemia). Kịch bản **KB8** minh họa đúng trường hợp này.

## Rủi ro cần cân nhắc trước khi dùng thật

1. **Hợp thức hóa sai số kéo dài.** Nếu các kết quả trước đã sai (máy lệch, nhầm mẫu cũ), khoảng cá nhân sẽ "học" theo cái sai. Vì vậy chế độ nới cần nhiều điều kiện, và chỉ nên bật cho nhóm chỉ số và nhóm người bệnh được khoa duyệt.
2. **Bệnh tiến triển.** Khoảng cá nhân luôn đi sau diễn biến bệnh, nên cần cửa sổ thời gian và điều kiện "ổn định".
3. **Đổi máy, đổi phương pháp hoặc lô hóa chất** làm lịch sử không còn so sánh được. Khi triển khai thật cần lọc lịch sử theo phương pháp.
4. **Kiểm định.** Mỗi chỉ số và mỗi chế độ cần được đánh giá riêng: tỷ lệ cho qua nhầm, báo động giả, và ảnh hưởng tới nhóm người bệnh mới (không có lịch sử).
5. **Ngưỡng theo bệnh lý do khoa định nghĩa** (ví dụ "bệnh thận mạn giai đoạn 5: giới hạn tự duyệt creatinine tới 900") là một hướng khác. Hướng này dễ hiểu nhưng phụ thuộc vào chẩn đoán được ghi chính xác và cập nhật, và dễ vi phạm nguyên tắc "không dùng riêng chẩn đoán để ký". Prototype chưa làm hướng này. Nếu khoa muốn, nên giới hạn ở dạng "chỉ siết" hoặc bắt buộc đi kèm điều kiện lịch sử ổn định.
