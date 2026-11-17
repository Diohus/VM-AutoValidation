# Điểm chưa xác minh và câu hỏi cho khoa

Ghi chú: phần **yêu cầu của chủ dự án** lấy từ `PROJECT CONTEXT.txt`. Phần **đề xuất thiết kế** là lựa chọn của prototype, chưa phải quyết định.

## Cần khoa xác nhận trước khi dùng dữ liệu thật

1. **Phạm vi đầu tiên.** Bắt đầu với nhóm hóa sinh nào (ví dụ thận – điện giải trên cobas c303/ISE)? Prototype đang làm cả hóa sinh và CBC để minh họa hai bộ rule tách riêng.
2. **Ngưỡng.** Toàn bộ khoảng tham chiếu, giới hạn tự duyệt, giá trị tới hạn, RCV/delta và giới hạn HIL trong `config/` là minh họa. Cần ngưỡng theo SOP và hướng dẫn của hãng (giới hạn HIL theo từng test).
3. **Chính sách giá trị tới hạn.** Ai thông báo, trong bao lâu, ghi nhận ở đâu? Có bao giờ cho phép tự ký kết quả tới hạn không?
4. **Đơn vị ký.** Prototype giả định ký cả phiếu. Khoa có trả từng phần không, ví dụ trả trước các chỉ số đạt?
5. **LIS và middleware.** Hệ thống có xuất được những dữ liệu sau qua HL7/ASTM không: cờ máy, H/L/I, số lô hóa chất, lần chạy lại, trạng thái QC theo thời điểm?
6. **QC.** Hệ thống có ghi thời điểm khóa và mở theo từng máy và từng xét nghiệm không, hay chỉ ghi theo ngày?
7. **Bối cảnh người bệnh.** Những trường nào được phép đưa vào thành phần AI: tuổi, giới, bệnh nền, thuốc, nhịn ăn, truyền dịch, truyền máu? Lấy từ đâu, và thời điểm "biết" được ghi thế nào?
8. **Nhật ký chạy lại và từ chối mẫu.** Nhật ký có ghi lý do không? Đây là nguồn nhãn quan trọng, nhưng nhãn này phản ánh *hành động*, không phải *lỗi thật*.
9. **Định danh tại giường.** Khoa có quét mã định danh khi lấy mẫu không? Câu trả lời ảnh hưởng tới tỷ lệ WBIT thật và PPV của mô hình.
10. **Trách nhiệm pháp lý.** Ai chịu trách nhiệm với một kết quả do hệ thống tự ký? Cơ chế ký số thực hiện thế nào?

## Trước khi bật tự ký thật (đề xuất)

- Chạy ngầm dài hạn (chế độ *Chạy ngầm* của demo). Đếm số lần người và máy đồng ý theo từng xét nghiệm, như cơ chế hai giai đoạn của Kingmed. Có thể tham khảo mốc khối lượng của WS/T 616-2018 hoặc CLSI AUTO10/AUTO15.
- Thước đo chính là cặp số: **tỷ lệ tự ký** và **tỷ lệ cho qua nhầm trên số phiếu tự ký**. Chọn ngưỡng theo recall định trước.
- Đánh giá tách theo người bệnh và theo thời gian. Báo cáo PPV ở tỷ lệ lỗi thật.
- Giám sát sau triển khai. Khi đổi lô hóa chất, hiệu chuẩn lại hoặc đổi máy thì phải kiểm tra lại.

## Giới hạn kỹ thuật đã biết của prototype

- Không có xác thực người dùng. Vai trò "Người phụ trách (demo)" là cố định.
- Trạng thái lưu trong một file JSON cục bộ, không có cơ chế đồng thời nhiều người dùng.
- Mô hình đang chạy (`models/*.json`, huấn luyện ngoại tuyến bằng Python, suy luận bằng JS không dependency): **lẫn dịch truyền** (LightGBM, `chem_ivfluid`) và **bất thường ở người khám lần đầu** (KNN theo panel, `fv_*`). Logistic regression, XGBoost và LightGBM được so trong `ml/benchmark.py`. Mỗi điểm có giải thích theo từng phiếu (Saabas cho cây; độ lệch từng chỉ số so với các phiếu lân cận cho KNN) và mức phủ dữ liệu. Điểm JS được test khớp với thư viện (`tests/model.test.js`).
- Điểm mô hình chưa hiệu chỉnh xác suất, chưa có conformal prediction. Ngưỡng chọn theo recall định trước (cây) hoặc tỷ lệ gắn cờ 5% (KNN) trên tập validation giả lập.
- Server không gọi Python khi khởi động: thiếu `models/*.json` thì chạy chỉ rule và ghi rõ trên giao diện.
- Chưa có PBRTQC (theo dõi trôi máy bằng dòng kết quả bệnh nhân), chưa có vi sinh, nước tiểu hay kết quả định tính.

## Câu hỏi mới về lớp mô hình (17/11/2026)

1. **Người khám lần đầu có kết quả ngoài khoảng tham chiếu: chính sách nào?** Khoa chưa chốt. Prototype có tùy chọn `firstVisitAbnormalPolicy`:
   - `ALWAYS_REVIEW` (**mặc định**, an toàn hơn): giữ rule CHEM-H02 (K/Na/Ca bất thường mà không có lịch sử → chuyển người duyệt). Mô hình bất thường chỉ thêm cờ.
   - `MODEL_FLAG_ONLY` (đề xuất mặc định, **chờ khoa và người dùng xác nhận**: chỉ dùng trong benchmark, chưa đưa lên giao diện): tắt CHEM-H02; chỉ chuyển người duyệt khi mô hình phát hiện bất thường (KNN/one-class SVM/Gaussian, ngưỡng gắn cờ 5%) gắn cờ. Nếu mô hình không đánh giá được thì quay về `ALWAYS_REVIEW`.
   - Lưu ý: `MODEL_FLAG_ONLY` cho phép mô hình **bỏ** một lượt giữ của rule, ngược với nguyên tắc "mô hình chỉ được nâng lên MANUAL_REVIEW". Nếu khoa chọn cách này, nguyên tắc đó cần được sửa một cách tường minh. Số phiếu được thả thêm và số lỗi trong đó: xem `reports/benchmark.json` → `firstVisitPolicy`.
   - Hiện chỉ hóa sinh (CHEM-H02, K/Na/Ca) có rule "cần lịch sử khi bất thường"; CBC chưa có rule tương đương.
2. **Thời điểm "có sẵn" của kết quả cũ.** Lịch sử đang được lọc theo thời điểm đo. Trong LIS thật cần lọc theo thời điểm kết quả được xác nhận/phát hành, theo đúng phiên bản (kết quả đo trước nhưng được sửa sau không được dùng như bản cuối). Dữ liệu giả lập chưa có trường này.
3. **Nhầm mẫu (WBIT) được coi là ngoài phạm vi** vì mẫu có SID định danh. Delta check vẫn giữ để bắt thay đổi thật và lỗi phân tích. Nếu sau này có số liệu WBIT thật (ví dụ từ nhật ký lấy lại mẫu), cần xem lại quyết định này.
4. **Lỗi phân tích không có cờ máy** (bọt khí, kim hút tắc một phần…): khoa có ghi nhận các ca này không (nhật ký chạy lại có lý do)? Đây là nguồn nhãn để kiểm chứng mô hình lỗi phân tích (hiện không triển khai vì quá nhiều báo động giả trên dữ liệu giả lập).
5. **Trích dẫn cần đồng đội xác minh** (phần thêm trong PR #2, đã gỡ khỏi tài liệu cho tới khi đối chiếu):
   - "Farrell et al. 2026, Ann Clin Biochem" (doi:10.1177/00045632261488751) — **không có trong tổng quan nghiên cứu**.
   - Năm của Tortosa-Carreres: tổng quan ghi cả "CCLM 2026;64(3) (trực tuyến 29/10/2025)" (tiêu đề mục) lẫn "2025" (bảng, danh mục). Cần thống nhất.
   - Các DOI (Graham 2025: 10.1093/clinchem/hvae210; Tortosa-Carreres: 10.1515/cclm-2025-0564; Spies 2025: 10.1093/clinchem/hvae168) không có trong tổng quan nên chưa đối chiếu được.
