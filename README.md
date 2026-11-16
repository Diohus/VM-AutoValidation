# VM-AutoValidation / LabReview

Demo tương tác cho quy trình xem và duyệt kết quả xét nghiệm. Mục tiêu là cho bác sĩ dùng thử luồng công việc, xác nhận dữ liệu cần thiết và góp ý trước khi xây rule/ML thực tế.

**Tất cả dữ liệu là giả lập. Không có AI thật, không kết nối LIS, không ký số hoặc phát hành kết quả thật. Các quyết định được tạo từ tình huống minh họa, chưa được thẩm định chuyên môn.**

## Chạy trên máy

Yêu cầu Node.js 20 trở lên. Không có dependency bên ngoài và không cần API key.

```sh
git clone https://github.com/Diohus/VM-AutoValidation.git
cd VM-AutoValidation
npm start
```

Mở http://127.0.0.1:5173. Dừng bằng Ctrl+C. Không mở `index.html` trực tiếp qua `file://` vì ứng dụng dùng JavaScript modules.

```sh
npm test
npm run check
```

## Các chức năng

- Bàn duyệt 6 ca thuộc sinh hóa, huyết học và nước tiểu; lọc chuyên khoa.
- Hiển thị 10–15 kết quả tương ứng chỉ định, bối cảnh và lịch sử giả lập.
- Hiển thị dấu vết kiểm tra và đề xuất đủ điều kiện / cần kiểm tra.
- Duyệt mô phỏng, giữ hoặc đề nghị chạy lại; yêu cầu lý do khi giữ hoặc vượt đề xuất giữ.
- Nhật ký phản hồi lưu bằng localStorage trên trình duyệt đang dùng. Không đồng bộ nhiều máy, không huấn luyện model.
- Hai lớp tùy chọn để minh họa ảnh hưởng của lịch sử và bối cảnh; cờ máy và dữ liệu bắt buộc không thể bị tùy chọn này ghi đè.
- Màn hình giải thích cách lưu kết quả dạng dài.

## Cấu trúc

```text
index.html              Giao diện
src/styles.css          Kiểu hiển thị responsive
src/data.js             Fixture giả lập
src/rules.js            Bộ đánh giá tình huống, độc lập giao diện
src/app.js              Tương tác và phản hồi trình duyệt
scripts/serve.mjs       Máy chủ phát triển cục bộ
tests/rules.test.js     Kiểm tra hành vi và điều kiện chặn
AGENTS.md               Hướng dẫn cho Codex
docs/DATA_MODEL.md      Thiết kế dữ liệu đích
docs/DEMO_SCRIPT.md     Kịch bản trình diễn với bác sĩ
docs/CODEX_TASK.md      Nhiệm vụ tiếp theo có thể giao cho Codex
```

## Phạm vi hiện tại

Ứng dụng là frontend tĩnh; dữ liệu đích trong tài liệu chưa phải database được triển khai. `delta`, `flag`, `missing` và `contextMissing` là nhãn tình huống được dựng sẵn, không phải kết quả thuật toán chuyên môn. Không nhập dữ liệu người bệnh thật vào phần ghi chú. Không có tính năng cấp quyền, audit chống sửa hoặc triển khai bệnh viện.

Bước tiếp theo nên là chuẩn hóa input, tách rule cấu hình và xác nhận quy trình với khoa. Xem `docs/CODEX_TASK.md`. Không tự đặt ngưỡng lâm sàng hoặc dùng bệnh nền như điều kiện tự động pass.
