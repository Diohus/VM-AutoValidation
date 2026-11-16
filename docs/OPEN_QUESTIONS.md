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
- Mô hình là logistic regression để giải thích được. Chưa so sánh với XGBoost/LightGBM (không có thư viện trong môi trường), chưa hiệu chỉnh xác suất, chưa có conformal prediction.
- Chưa có PBRTQC (theo dõi trôi máy bằng dòng kết quả bệnh nhân), chưa có vi sinh, nước tiểu hay kết quả định tính.
