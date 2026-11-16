# Nhiệm vụ tiếp theo cho Codex

Có thể giao nguyên nội dung sau cho Codex khi mở repo:

> Đọc AGENTS.md, README.md và docs/DATA_MODEL.md. Phát triển bản demo VM-AutoValidation hiện có thành phiên bản dùng dữ liệu dạng dài và rule cấu hình, giữ nguyên khả năng chạy cục bộ. Chỉ dùng dữ liệu giả lập.
>
> Thực hiện lần lượt:
> 1. Thay fixture kiểu mảng results lồng trong ca bằng các tập test_catalog, orders, order_items, specimens, results và clinical_context. UI chỉ hiện đúng các mục của phiếu. Phân biệt chỉ định đang chờ và chỉ số đã có kết quả.
> 2. Tạo rule cấu hình với id, version, applies_to, requires, check, on_trigger và on_missing. Chỉ hỗ trợ tập toán tử hữu hạn, không eval. Tách rule engine khỏi UI. Mỗi rule trả PASS/REVIEW/NOT_APPLICABLE/NOT_EVALUABLE. Các ngưỡng nếu có chỉ là tham số kỹ thuật giả lập và phải được ghi rõ chưa thẩm định; không tự đề xuất ngưỡng lâm sàng.
> 3. Bổ sung màn hình xem rule nào được áp dụng, dữ liệu nào được dùng và lý do chuyển người duyệt. Không tạo điểm confidence hoặc số liệu AI giả.
> 4. Thêm tình huống kết quả đang chờ, kết quả được sửa và không có lịch sử. Phản hồi cũ phải gắn với phiên bản cũ, không tự dùng cho kết quả mới.
> 5. Giữ các điều kiện chặn bắt buộc. Bệnh nền hoặc rule tùy chọn không được xóa chặn.
> 6. Chỉ ghi phản hồi mô phỏng; chưa tích hợp LIS, ký số, LLM, gửi thông báo hoặc dữ liệu thật.
> 7. Kiểm tra engine, thiếu dữ liệu, phạm vi áp dụng, xung đột rule và phiên bản kết quả. Chạy npm test, npm run check, kiểm tra UI nếu có công cụ trình duyệt và cập nhật README.
>
> Hoàn thành một phiên bản chạy được, báo rõ những gì còn mô phỏng. Không dừng ở bản kế hoạch. Nếu có quyền GitHub, làm trên nhánh feature và mở draft PR; không tự merge.
