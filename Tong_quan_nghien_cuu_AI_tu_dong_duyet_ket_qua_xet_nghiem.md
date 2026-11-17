# Tổng quan nghiên cứu: AI tự động duyệt kết quả xét nghiệm

**Nov 12, 2026 · @Do**

## Kết luận chính

Chưa có nghiên cứu nào công bố một hệ thống ML tự ký cho toàn bộ danh mục xét nghiệm. Các hệ thống tự ký đang chạy thật đều dựa trên luật; ML mới được chứng minh cho từng loại lỗi riêng, và phần lớn mới ở mức hồi cứu.

- **Tự ký bằng luật đã chạy ở quy mô lớn.** Kingmed phát hành hơn 3,5 triệu báo cáo tự động từ 2019 mà không có khiếu nại lâm sàng. Hệ thống Zhongshan chạy trên Cobas 8000, cùng họ máy Roche Cobas với khoa của bạn.

- **Nới luật để tăng tỷ lệ tự ký thì bỏ lọt nhiều hơn.** Ở Zhongshan, tỷ lệ tự ký tăng từ 49,5% lên 73,9%, nhưng tỷ lệ báo cáo chuyên gia từ chối mà hệ thống vẫn cho qua tăng từ 11,2% lên 24,5%. Con số này đi ngược nguyên tắc "không bỏ lọt" của bạn.

- **ML thay luật cho kết quả tốt nhất khi có bằng chứng mù đôi.** Wang 2021 đạt tỷ lệ tự ký 89,6% với tỷ lệ âm tính giả 0,95 phần nghìn. Đây là mốc so sánh gần nhất với mục tiêu của dự án.

- **AUC trên dữ liệu mô phỏng không dự báo được hiệu năng thật.** Mô hình WBIT có độ nhạy và độ đặc hiệu 99% chỉ còn PPV khoảng 3% ở tỷ lệ lỗi thật 0,03%. Farrell 2023 phải chỉnh ngưỡng mới đạt PPV 10,9% khi chạy tiến cứu.

- **Gradient boosting là lựa chọn mặc định hiện nay.** Bốn nghiên cứu từ 2023 đến 2026 (Farrell, Graham, Tortosa-Carreres, Srirujee) đều chọn XGBoost, chủ yếu vì xử lý được giá trị thiếu.

- **Người duyệt lại dự đoán của AI làm kết quả kém đi.** Nhân viên giám sát AI đạt độ chính xác 81,2%, còn AI tự chạy đạt 92,5%. Thêm lời giải thích cũng không làm nhân viên tin AI hơn.

- **Khoảng trống:** chưa có nghiên cứu ML nào cho đông máu hay vi sinh, và chưa có nghiên cứu nào ghép đủ ba lớp (luật, theo dõi máy, hợp lý theo bệnh nhân) thành một hệ thống.

## Cập nhật áp dụng vào prototype

Prototype thử các phương pháp trong tổng quan trên dữ liệu giả lập: XGBoost cho nhầm mẫu (WBIT) hóa sinh và CBC khi có lịch sử ≤90 ngày (theo hướng Graham 2025 và Tortosa-Carreres; cấu hình do đồng đội chọn trong PR #2), XGBoost có giám sát trên nhiễm dịch truyền mô phỏng (theo hướng Spies 2025, Clinical Chemistry), và phát hiện bất thường đa biến cho người khám lần đầu (KNN, theo Farrell 2024, CCLM). Nhiễm EDTA vẫn bắt bằng luật K–Ca. So sánh logistic regression, XGBoost và LightGBM nằm ở `reports/benchmark.json`; đánh giá toàn luồng ở `reports/evaluation-comparison.json`. Đây là chuyển phương pháp để thử tính áp dụng, không tái tạo mô hình hay dữ liệu nghiên cứu, và không dùng để khẳng định hiệu quả lâm sàng.

## Phạm vi và mức độ đọc

Tôi chỉ đọc được toàn văn ba bài truy cập mở; các bài còn lại nằm sau tường phí nên tôi dựa vào abstract và tài liệu chính thức đi kèm. Mọi con số trong tài liệu lấy từ các nguồn này, không suy đoán.

Hệ quả: với nhóm cuối, bạn nên tải bản gốc trước khi trích dẫn số liệu trong báo cáo chính thức. Phần "hạn chế" của các bài chỉ có abstract là nhận xét của tôi dựa trên thiết kế nghiên cứu, không phải lời tác giả, trừ khi ghi rõ.

Tôi ưu tiên *Clinical Chemistry* (ADLM), *Clinical Chemistry and Laboratory Medicine* (CCLM), *Am J Clin Pathol* và khuyến nghị của IFCC. Phần lớn các bài chính công bố từ 2021 trở lại đây.

| Mức độ đọc | Bài |
|---|---|
| Toàn văn | Zhu 2022, Jin 2021, Srirujee 2026 |
| Abstract đầy đủ, kèm podcast hoặc tài liệu của tác giả | Farrell 2023, Graham 2025, Spies 2024, Badrick 2019, Master 2023 |
| Abstract đầy đủ | Demirci 2016, Mitani 2020, Farrell 2021 và 2022 (ba bài), Farrell 2024, Tortosa-Carreres 2025, Spies 2025, Duan 2021, Luo 2016, Wang Z 2019, Seok 2024 (dấu ấn ung thư), Shang 2024, Jin K 2025 |
| Chỉ một phần abstract hoặc qua bài khác trích lại | Wang 2021 (phương pháp từ nhà xuất bản, kết quả qua nguồn trích lại), Rosenbaum 2018, Seok 2024 (đa trung tâm), Liang 2024 |

---

## Nhóm 1: Autoverification (luật và ML)

Nhóm này trả lời trực tiếp câu hỏi "máy tự ký được bao nhiêu và bỏ lọt bao nhiêu". Luật đã chạy thật ở quy mô lớn; ML mới có một nghiên cứu hóa sinh và một nghiên cứu CBC.

### Wang H. và cộng sự, CCLM 2021;59(5):883-891 (trực tuyến 2020)

- **Vấn đề:** hệ thống luật giữ lại quá nhiều báo cáo hợp lệ, KTV vẫn phải duyệt tay phần lớn.
- **Cách tiếp cận:** dùng ML thay bộ luật để phân biệt báo cáo hợp lệ và không hợp lệ trong phòng hóa sinh.
- **Dữ liệu:** phòng xét nghiệm hóa sinh tại Trung Quốc (tài trợ từ Tế Nam, Sơn Đông). Tôi chưa đọc được quy mô dữ liệu.
- **Mô hình và lý do:** huấn luyện nhiều thuật toán qua hai vòng, chọn ba thuật toán tốt nhất ghép thành ensemble. Ensemble giảm rủi ro một mô hình đơn lẻ sai hệ thống.
- **Kết quả:** thử mù đôi với nhân viên giàu kinh nghiệm cho tỷ lệ tự ký 89,60% và tỷ lệ âm tính giả 0,95 phần nghìn. Số báo cáo không hợp lệ giảm khoảng 80% so với bộ luật.
- **Hạn chế (nhận xét của tôi):** một trung tâm; nhãn là phán đoán của người duyệt, nên mô hình học cách bắt chước KTV chứ không học lỗi thật.
- **Đã có gì mới hơn:** Srirujee 2026 lặp lại hướng này cho CBC với XGBoost và ngưỡng recall định trước.

### Zhu J., Wang H. và cộng sự, J Clin Lab Anal 2022;36(2):e24233

- **Vấn đề:** hệ thống luật năm 2012 của BV Zhongshan (359 luật, 60 xét nghiệm) có ngưỡng do chuyên gia đặt, quá chặt, độ đặc hiệu chỉ khoảng 53%.
- **Cách tiếp cận:** chuyên gia chọn loại luật; ngưỡng lấy từ phân vị dữ liệu lịch sử. Thêm hai loại luật mới: giá trị cực đoan và kiểm tra nhất quán giữa các chỉ số.
- **Dữ liệu:** 113.956 báo cáo (02 đến 05/2017) để đặt ngưỡng. Kiểm định trên 2.246.697 báo cáo từ 20 bệnh viện, trong đó 20.996 báo cáo do hội đồng chuyên gia duyệt tay. Máy Roche Cobas 8000.
- **Công nghệ:** 428 luật. Ngưỡng cực đoan lấy phân vị 0,1 đến 99,9; ngưỡng giới hạn 2,5 đến 97,5; delta check 5 đến 95 trong 3 tháng. Chín luật nhất quán, ví dụ Ca × P (gợi ý nhiễm EDTA-K2), Na/Cl (điện cực lão hóa), TG/chỉ số L.
- **Kết quả:** độ đặc hiệu tăng từ 53,11% lên 78,53%; tỷ lệ tự ký tăng từ 49,5% lên 73,9%; tỷ lệ tự ký tại 20 bệnh viện tăng 19 đến 51%.
- **Gặp vấn đề ở đâu:** độ nhạy giảm từ 88,77% xuống 75,55%. Trong 1.808 báo cáo chuyên gia từ chối, hệ thống mới cho qua 442 báo cáo (hệ thống cũ: 203). Abstract ghi 77,55% nhưng bảng 3 trong bài cho 75,55%. Một bệnh viện phải đặt lại 60 ngưỡng delta theo dữ liệu riêng mới đạt mức tăng 49%.
- **Hướng cải tiến của tác giả:** tối ưu phân vị riêng cho từng xét nghiệm, dùng dữ liệu của chính bệnh viện.

### Jin D. và cộng sự (Kingmed), BMC Med Inform Decis Mak 2021;21:174

- **Vấn đề:** kiểm định autoverification bằng so sánh thủ công người và máy tốn công và dễ sai.
- **Cách tiếp cận:** đưa việc kiểm định vào chính LIS, hai giai đoạn. Giai đoạn một kiểm từng luật chạy đúng ý chưa. Giai đoạn hai đếm số báo cáo người và máy đồng ý; đủ ngưỡng (ví dụ 3.000) mới bật tự phát hành, và bộ đếm về 0 nếu người sửa báo cáo vì luật sai hoặc thiếu.
- **Dữ liệu:** 833 luật cho 30 xét nghiệm (10/2019 đến 01/2020); 926.195 báo cáo. Toàn hệ thống có 25.487 luật, khoảng 80.000 báo cáo tự phát hành mỗi ngày, gồm cả vi sinh.
- **Kết quả:** 782 luật (93,87%) qua kiểm định, 51 luật bị xóa. Thời gian kiểm định bộ viêm gan B giảm từ 452 xuống 275 giờ. Hơn 3,5 triệu báo cáo tự phát hành từ 2019 mà không có khiếu nại lâm sàng.
- **Hạn chế:** tác giả nói khó ghép vào LIS có sẵn. "Không khiếu nại" không phải tỷ lệ lỗi đo được.
- **Điểm đáng lấy:** chuẩn WS/T 616-2018 của Trung Quốc yêu cầu kiểm định ít nhất 3 tháng hoặc 50.000 báo cáo, và kiểm lại hằng năm ít nhất 10 ngày làm việc hoặc 5.000 báo cáo.

### Srirujee S., Chokchaipermpoonphol P., J Clin Lab Anal 2026 (11/08/2026)

- **Vấn đề:** luật cứng cho CBC giữ lại quá nhiều kết quả.
- **Dữ liệu:** 63.201 kết quả CBC từ máy Sysmex XN-10, BV Songklanagarind (Thái Lan), cả năm 2024. 30,9% thuộc nhóm phải duyệt tay.
- **Mô hình và lý do:** Decision Tree, Random Forest, XGBoost; chia 80:20. Đầu vào gồm chỉ số, từng cờ của máy và cả tham số máy không in ra báo cáo. Ngưỡng chọn theo recall định trước 95% và 97,5%, vì yêu cầu an toàn đặt trước, hiệu quả tính sau.
- **Kết quả (tập kiểm tra 12.641 mẫu):** luật hiện tại có độ nhạy 88,95%, độ đặc hiệu 45,54%. XGBoost ở recall 95% đạt độ đặc hiệu 81,46%; ở recall 97,5% đạt 68,95%. Ba đặc trưng quan trọng nhất đều là cờ bạch cầu của máy.
- **Hạn chế (tác giả nêu):** một trung tâm; không có chỉ số HIL; không dùng delta check vì khung ML chưa xử lý được dữ liệu thiếu; không cross-validation; chưa đo ổn định theo thời gian và tác động lâm sàng.
- **Ghi chú:** mã nguồn công khai trên GitHub. Máy của bạn là DxH 690T nên cờ và tham số khác, phải huấn luyện lại.

### Các bài bổ trợ

- **Demirci 2016, Am J Clin Pathol:** mạng nơ-ron (Weka) duyệt kết quả hóa sinh có giá trị nguy hiểm tại ĐH Dokuz Eylül. Độ nhạy 91%, độ đặc hiệu 100%, kappa 0,950; không kết quả nào chuyên gia từ chối mà mô hình cho qua. Công nghệ đã cũ, nhưng là bài đầu tiên đặt tiêu chí "không ký nhầm".
- **Wang Z. 2019, BMC Med Inform Decis Mak:** luật cho đông máu (PT, APTT, TT, fibrinogen). Ngưỡng lấy từ 157.079 kết quả năm 2016. Thử nghiệm 14.295 mẫu: tự ký 78,75%, độ nhạy 100%, độ đặc hiệu 83,99%, không có âm tính giả. Sau 6 tháng chạy thật với 83.699 mẫu, tỷ lệ tự ký 78,86%. Đây là tham chiếu cho máy Stago, và không dùng ML.

---

## Nhóm 2: Phát hiện dán nhầm nhãn (WBIT) bằng ML

Đây là mảng ML trưởng thành nhất trong xét nghiệm, và là mảng duy nhất đã đi hết chặng đường từ mô phỏng đến chạy tiến cứu. Bài học chính: mô hình rất tốt trên giấy vẫn cho rất nhiều báo động giả khi lỗi thật hiếm.

### Rosenbaum M.W., Baron J.M. (MGH), Am J Clin Pathol 2018;150(6):555-566

- **Vấn đề:** delta check một chỉ số vừa bỏ lọt vừa báo động giả nhiều.
- **Cách tiếp cận:** mô phỏng WBIT bằng cách tráo kết quả giữa các bệnh nhân nội trú, rồi huấn luyện năm thuật toán.
- **Dữ liệu:** kết quả hóa sinh nội trú thường quy tại Massachusetts General Hospital; 11 chỉ số (Ca, Mg, BUN, creatinin, glucose, P, anion gap, Cl, K, bicarbonat và một chỉ số nữa). Tôi chưa đọc được số mẫu.
- **Mô hình và lý do:** SVM dùng cả giá trị hiện tại và mức thay đổi tuyệt đối của 11 chỉ số, vì dấu hiệu nhầm mẫu nằm ở tổ hợp thay đổi, không ở một chỉ số.
- **Kết quả:** AUC 0,97; ở độ nhạy 80%, độ đặc hiệu 96%. Chỉ số đơn tốt nhất (BUN, creatinin) chỉ đạt AUC 0,84.
- **Gặp vấn đề ở đâu:** ở độ nhạy 80%, PPV chỉ 52% ngay trên dữ liệu mô phỏng. Theo một bài sau đó, mô hình bị bó trong bộ 11 chỉ số cố định và các cặp mẫu cách nhau dưới 36 giờ.

### Mitani T. và cộng sự (ĐH Tokyo), CCLM 2020;58(3):375-383

- **Cách tiếp cận:** mở rộng delta check thành chuỗi thời gian: cửa sổ trượt 4 lần xét nghiệm liên tiếp, lần cuối bị tráo để tạo ca nhầm mẫu.
- **Dữ liệu:** 15 chỉ số CBC và hóa sinh tại bệnh viện ĐH Tokyo; chỉ lấy lần xét nghiệm có ít nhất 11 trong 15 chỉ số.
- **Mô hình và lý do:** gradient boosting decision tree, vì chính xác và giải thích được qua mức đóng góp của từng đặc trưng.
- **Kết quả:** ROC AUC 0,9983 trên tập kiểm định mô phỏng.
- **Hạn chế (nhận xét của tôi):** tỷ lệ lỗi trong tập kiểm định cao hơn thực tế nhiều lần; cần ít nhất 3 lần xét nghiệm trước, nên không dùng được cho bệnh nhân mới.

### Chuỗi nghiên cứu của Farrell C.J.L. (NSW Health Pathology, Úc)

- **Ann Clin Biochem 2021:** 8 mô hình huấn luyện trên 127.256 bộ kết quả điện giải, urê, creatinin. Mạng nơ-ron đạt 92,1%, cây quyết định đơn giản 86,5%, nhân viên xét nghiệm 77,8%.
- **Int J Lab Hematol 2022:** lặp lại với 101.015 bộ CBC. Nhân viên đạt 85,7% (độ nhạy 80,1%); mạng nơ-ron 99,1%. CBC dễ phát hiện nhầm mẫu hơn hóa sinh.
- **CCLM 2022;60(12):1993-1997:** nhân viên duyệt 510 bộ kết quả kèm dự đoán của AI. Người cộng AI đạt 81,2% (độ nhạy 73,7%, độ đặc hiệu 88,6%); AI tự chạy đạt 92,5% (90,6% và 94,5%). Người làm hỏng dự đoán đúng của máy.
- **Ann Clin Biochem 2022:** thêm lời giải thích cho dự đoán không đổi tỷ lệ nhân viên đồng ý với AI (83,3% so với 81,8%, p = 0,46).

### Farrell C.-J. và cộng sự, Clinical Chemistry 2023;69(9):1031-1037

- **Vấn đề:** các mô hình trước không dùng được thường quy vì không chịu được giá trị thiếu và PPV thấp.
- **Dữ liệu:** huấn luyện trên 135.128 kết quả CBC (hiện tại và trước đó). Chạy tiến cứu 22 tuần tại một phòng xét nghiệm bệnh viện công.
- **Mô hình và lý do:** XGBoost, vì xử lý được giá trị thiếu. Cách tăng PPV là chỉnh ngưỡng xác suất, không đổi mô hình.
- **Kết quả:** trong 38.187 kết quả CBC đã qua kiểm tra thường quy, mô hình gắn cờ 110 mẫu để xét nghiệm thêm và xác nhận 12 ca WBIT. PPV 10,9%. Theo tác giả, tỷ lệ phát hiện cao gấp 6 lần quy trình chuẩn.
- **Gặp vấn đề ở đâu:** tỷ lệ WBIT thật khoảng 0,03%. Tác giả tính rằng mô hình tốt nhất từ giai đoạn mô phỏng (độ nhạy và độ đặc hiệu 99%) chỉ đạt PPV 3% ngoài thực tế.

### Graham B.V., Master S.R. và cộng sự (CHOP), Clinical Chemistry 2025;71(3):418-427

- **Vấn đề:** chưa ai đánh giá mô hình WBIT trong điều kiện tỷ lệ lỗi thấp như thực tế, và chưa ai thử trên bệnh nhi.
- **Cách tiếp cận:** tạo WBIT giả bằng cách tráo kết quả giữa hai bệnh nhân cùng khoa, cùng thời điểm (sát thực tế hơn tráo ngẫu nhiên). Đánh giá trên tập kiểm định đã giảm mẫu về tỷ lệ lỗi thấp, qua nhiều ngưỡng xác suất.
- **Mô hình:** XGBoost với tiền xử lý tối thiểu thắng các cấu hình khác.
- **Kết quả:** độ chính xác 0,9715 (CBC có công thức bạch cầu) và 0,9647 (không có). Ở tỷ lệ lỗi thấp, PPV ước tính dao động từ 0,01 đến 0,67 và từ 0,01 đến 0,75 tùy ngưỡng.
- **Phát hiện phụ:** số WBIT ước tính giảm mạnh sau khi bệnh viện áp dụng định danh bệnh nhân bằng quét mã tại giường (PPID).

### Tortosa-Carreres J. và cộng sự (BV La Fe, València), CCLM 2026;64(3):617-629 (trực tuyến 29/10/2025)

- **Điểm mới:** dùng cả ca WBIT thật, không chỉ mô phỏng, và kết hợp hóa sinh với huyết học.
- **Dữ liệu:** tập nội bộ cân bằng (huấn luyện 324, kiểm định 108; một nửa số lỗi là thật). Hai tập ngoài 800 và 460 mẫu với 5% WBIT.
- **Mô hình:** chọn 16 trong 25 biến bằng Elastic Net, rồi XGBoost. Đặc trưng là biến thiên chuẩn hóa so với kết quả ngay trước đó.
- **Kết quả:** ROC-AUC 0,98 đến 0,99; PR-AUC 0,93 đến 0,99; độ nhạy từ 90% trở lên, độ đặc hiệu 98 đến 99%. Hiệu chỉnh lại xác suất giảm dương tính giả. Thắng khoảng cách Mahalanobis và delta check đơn biến.
- **Hạn chế (nhận xét của tôi):** cỡ mẫu nhỏ; 5% vẫn cao hơn khoảng 170 lần so với mức 0,03% mà Farrell nêu; chưa chạy tiến cứu.

### Các bài bổ trợ

- **Seok H.S. 2024, Clinical Chemistry 70:1256-1267:** nghiên cứu hồi cứu đa trung tâm tại Hàn Quốc. Theo bài trích lại, trên hơn 600.000 ca, mạng nơ-ron sâu và XGBoost vượt delta check và giữ được hiệu năng ở nhiều phòng xét nghiệm. Tôi chưa đọc được số liệu chi tiết.
- **Seok H.S. 2024, CCLM 62:1421-1432:** 5 dấu ấn ung thư trên Cobas c8000; 179.929 bản ghi huấn luyện, 66.332 bản ghi đánh giá. Mạng nơ-ron sâu vượt random forest và ba kiểu delta check.
- **Sürmeli B.G. 2025, J Pers Med:** 799.721 mẫu của 154.998 bệnh nhân tại Đức. Chỉ ba chỉ số MCV, RDW, MCH đã cho F1 trên 90%; thêm quá sáu chỉ số không cải thiện. Mẫu lấy trong 90 ngày sau truyền máu bị loại.

---

## Nhóm 3: Nhiễm dịch truyền, nhiễm EDTA và phát hiện bất thường đa biến

Nhóm này giải quyết vấn đề bạn sẽ gặp đầu tiên: không có nhãn lỗi đáng tin. Cả ba bài đều tạo lỗi nhân tạo, bằng mô phỏng trên máy tính hoặc pha mẫu thật.

### Spies N.C. và cộng sự (Washington University), Clinical Chemistry 2024;70(2):444-452

- **Vấn đề:** phát hiện mẫu lấy ở tay đang truyền dịch dựa vào delta check (cần kết quả trước) hoặc KTV tự nhận ra. Học có giám sát thì cần chuyên gia gán nhãn, rất tốn công.
- **Cách tiếp cận:** học không giám sát. Mẫu nhiễm làm nhiều chỉ số lệch cùng lúc theo hướng đoán được, nên chúng nằm ở vùng rìa khi nén dữ liệu xuống ít chiều.
- **Dữ liệu:** 25.747.291 kết quả bộ chuyển hóa cơ bản của 312.721 bệnh nhân nội trú, khoảng 6 năm, tại Barnes-Jewish.
- **Mô hình và lý do:** UMAP huấn luyện trên dữ liệu thật cộng nhiễm mô phỏng. Một "điểm làm giàu" đo mức gần của mỗi kết quả với vùng nhiễm mô phỏng, cho ra thước đo khách quan để đặt ngưỡng.
- **Kết quả:** ở mức gắn cờ 3 trên 1.000 kết quả, chuyên gia xác nhận PPV 0,78 trên 100 ca liên tiếp. 58 ca trong đó quy trình hiện tại đã bỏ sót; 49 bộ kết quả chứa 56 giá trị nguy hiểm.
- **Gặp vấn đề ở đâu:** không có tiêu chuẩn vàng cho "mẫu bị nhiễm". Bài tiếp theo của chính nhóm thừa nhận phương pháp thiếu độ nhạy với nhiễm nhẹ nhưng vẫn đủ làm sai kết quả.

### Spies N.C. và cộng sự, Clinical Chemistry 2025;71(2):296-306

- **Cải tiến so với bài 2024:** chuyển sang ensemble có giám sát, gồm mô hình chung và mô hình riêng cho từng loại dịch truyền, huấn luyện trên dữ liệu thật và nhiễm mô phỏng.
- **Kiểm định:** nội bộ và ngoại bộ; mốc so sánh lấy từ mô phỏng, thí nghiệm pha mẫu và chuyên gia duyệt.
- **Kết quả:** tỷ lệ gắn cờ cao hơn quy trình hiện tại và bắt được nhiều ca nhiễm vượt giới hạn sai số cho phép. Mô hình hồi quy riêng ước lượng mức độ nhiễm, nên lý do giữ mẫu có định lượng.
- **Tài liệu kèm:** bài hướng dẫn thực hành mô phỏng nhiễm nước muối sinh lý để tạo nhãn cho XGBoost, đi cùng bài tổng quan về kiểm định, triển khai và giám sát ML (Clinical Chemistry 2024;70(11):1334-1343).

### Farrell C.J.L., CCLM 2024;62(12):2444-2450

- **Vấn đề:** luật autoverification xét từng chỉ số riêng, nên bỏ sót tổ hợp kết quả bất thường do mẫu huyết thanh nhiễm chất phụ gia của ống khác.
- **Dữ liệu:** 127.451 bộ kết quả điện giải, urê, creatinin để huấn luyện. Kiểm tra trên mẫu thật pha EDTA, fluoride, natri citrat hoặc ACD (200 mẫu mỗi loại), cộng 127.449 lỗi đơn chỉ số.
- **Mô hình và lý do:** ba mô hình phát hiện bất thường (Gaussian đa biến, khoảng cách KNN, one-class SVM), đều chỉ cần dữ liệu bình thường để huấn luyện. Tất cả đặt cùng mức gắn cờ 5% để so công bằng với luật giới hạn.
- **Kết quả:** KNN và SVM vượt luật giới hạn với cả bốn chất nhiễm. Gaussian đa biến không vượt luật giới hạn với EDTA. Cả ba vượt luật giới hạn với lỗi đơn chỉ số; KNN có độ nhạy tổng thể cao nhất.
- **Hạn chế (nhận xét của tôi):** chỉ ba nhóm chỉ số; mức gắn cờ 5% là cao nếu áp cho mọi mẫu; chưa chạy thực tế.

### Ghi chú về nhiễm EDTA

Dấu hiệu kinh điển là K tăng giả kèm Ca, Mg và ALP giảm. Luật Ca × P của Zhongshan và mô hình đa biến của Farrell là hai cách bắt tổ hợp này. Một tổng quan năm 2025 về nhiễm dịch truyền nêu ba trở ngại chung: quy trình phòng xét nghiệm, tỷ lệ báo động giả cao và thiếu tiêu chuẩn vàng.

---

## Nhóm 4: Theo dõi trôi máy bằng kết quả bệnh nhân (PBRTQC)

Ý tưởng Lớp B của bạn đã có tên chuẩn là PBRTQC và có hẳn bộ khuyến nghị của IFCC. Trung bình trượt thuần là phiên bản cơ bản nhất; từ 2021 đã có các phiên bản tốt hơn rõ rệt.

### Badrick T. và cộng sự (IFCC), Clinical Chemistry 2019;65(8):962-971

- **Vấn đề:** QC nội kiểm chỉ chạy vài lần mỗi ngày, vật liệu QC đắt và có hiệu ứng nền mẫu. Máy có thể trôi giữa hai lần QC mà không ai biết.
- **Cách tiếp cận:** dùng chính dòng kết quả bệnh nhân làm tín hiệu QC. Khi máy lệch, trung bình của một khối kết quả liên tiếp lệch theo, dù từng kết quả vẫn trông hợp lý.
- **Nội dung:** tổng quan các kỹ thuật dùng dữ liệu bệnh nhân để phát hiện lỗi phân tích, kèm khuyến nghị cách thiết lập. Tôi chỉ đọc được abstract và podcast nên không liệt kê chi tiết thuật toán.
- **Ưu điểm tác giả nêu:** mỗi mẫu bệnh nhân bổ sung thông tin QC nên phát hiện sớm hơn; bắt được một phần lỗi trước phân tích; gần như không tốn thêm chi phí.
- **Hạn chế tác giả nêu:** mất công thiết lập tham số và đào tạo lại nhân viên; phải có phần mềm chạy thời gian thực trên middleware hoặc máy.

### Loh T.P. và cộng sự (IFCC), CCLM 2020;58(8):1205-1213

- **Nội dung:** quy trình kiểm định PBRTQC trước khi dùng. Lấy dữ liệu lịch sử sạch (loại các giai đoạn đã biết có lỗi), bơm sai số nhân tạo vào, rồi đo hai thứ: tỷ lệ báo động giả và số mẫu bệnh nhân bị ảnh hưởng trước khi phát hiện.
- **Điểm đáng lấy:** yêu cầu không vượt tỷ lệ dương tính giả mong muốn. Ví dụ minh họa trong bài là trung bình trượt của 1.000 kết quả natri với cỡ khối 20.

### Duan X. và cộng sự (BV Zhongshan), Clinical Chemistry 2021;67(10):1342-1350

- **Vấn đề:** PBRTQC bị nghi ngờ về hiệu năng với một số chỉ số. Diễn giải của tôi về nguyên nhân: kết quả bệnh nhân tự tương quan theo thời gian và phụ thuộc cơ cấu bệnh nhân. Buổi sáng nhiều mẫu ngoại trú, buổi chiều nhiều mẫu hồi sức, trung bình trượt lệch dù máy không trôi.
- **Cách tiếp cận (RARTQC):** thêm một bước hồi quy trước bước kiểm soát. Mô hình hồi quy dự đoán giá trị kỳ vọng của mỗi kết quả; trung bình trượt tính trên phần dư. Phần dư chỉ còn chứa sai số của máy.
- **Dữ liệu:** toàn bộ kết quả bệnh nhân năm 2019 của 4 chỉ số tại BV Zhongshan; bơm ba kiểu sai số: hằng số, tỷ lệ và ngẫu nhiên.
- **Kết quả:** số bệnh nhân bị ảnh hưởng trước khi phát hiện, tại mức sai số toàn phần cho phép, giảm khoảng 50% với sai số hằng số và sai số tỷ lệ.
- **Gặp vấn đề ở đâu:** theo bài bình luận đi kèm, cải thiện rõ với natri và clo (phân bố gần chuẩn); với các chỉ số khác cần nghiên cứu thêm.

### Các phiên bản mới hơn

- **Liang Y. 2024, CCLM 62(4):635-645:** thay hồi quy tuyến tính bằng hồi quy phi tuyến dùng ML, đa trung tâm; so với PBRTQC chuẩn của IFCC và RARTQC tuyến tính.
- **Shang X. 2024, CCLM:** mạng đồ thị phát hiện bất thường cho natri, kali, canxi, dùng 8 biến bệnh nhân. Với canxi ở độ lệch nhỏ 0,02, số mẫu trước khi phát hiện giảm tới khoảng 95%.
- **Duan X. 2024, Ann Lab Med 44(5):** tổng quan của nhóm công tác châu Á - Thái Bình Dương, so sánh trung bình trượt, RARTQC, mạng nơ-ron và phát hiện bất thường.

**Hạn chế chung (nhận xét của tôi):** PBRTQC cần lưu lượng mẫu lớn. Ở một bệnh viện đơn lẻ, các xét nghiệm ít mẫu mỗi ngày sẽ không đủ số liệu để phát hiện trôi kịp thời, nên Lớp B chỉ khả thi cho nhóm chỉ số chạy nhiều.

---

## Nhóm 5: Dự đoán chỉ số, hướng dẫn phương pháp và LLM

Nhóm này không trực tiếp phát hiện lỗi, nhưng cho bạn cơ sở lý thuyết của hướng hồi quy trong Lớp C và các quy tắc đánh giá mà hội đồng chuyên môn sẽ hỏi.

### Luo Y., Szolovits P., Dighe A.S., Baron J.M. (MIT, MGH), Am J Clin Pathol 2016;145:778-788

- **Vấn đề:** kết quả xét nghiệm được báo từng con số riêng lẻ, trong khi các chỉ số của cùng một bệnh nhân liên quan chặt với nhau.
- **Cách tiếp cận:** dự đoán ferritin từ nhân khẩu học và các xét nghiệm khác làm cùng lúc. Nếu dự đoán được, nghĩa là thông tin dư thừa đủ lớn để kiểm tra chéo.
- **Dữ liệu:** kết quả ferritin ngoại trú tại Massachusetts General Hospital.
- **Mô hình:** bốn phương pháp điền giá trị thiếu, năm kỹ thuật hồi quy và phân loại.
- **Kết quả:** phân biệt ferritin bình thường và bất thường với AUC tới 0,97 trên tập giữ riêng. Xem lại hồ sơ cho thấy đôi khi giá trị dự đoán phản ánh tình trạng sắt đúng hơn giá trị đo.
- **Gặp vấn đề ở đâu:** giả định dữ liệu thiếu là ngẫu nhiên. Chính nhóm này sau đó chứng minh ferritin thiếu không ngẫu nhiên: bác sĩ chỉ định xét nghiệm khi nghi ngờ bệnh.
- **Cải tiến:** 3D-MICE (JAMIA 2017) kết hợp tương quan giữa các chỉ số cùng thời điểm với tự tương quan theo thời gian của 13 chỉ số. Đây là đúng hai nguồn thông tin bạn định dùng: các chỉ số cùng mẫu và lịch sử bệnh nhân.

### Master S.R., Badrick T.C., Bietenbeck A., Haymond S. (IFCC), Clinical Chemistry 2023;69(7):690-698

- **Nội dung:** khuyến nghị đồng thuận của nhóm công tác IFCC về thực hành ML trong xét nghiệm, phủ từ đặt bài toán đến triển khai.
- **Điểm quan trọng với dự án:** không chỉ báo cáo AUC ROC. Với dữ liệu mất cân bằng, AUC cao vẫn đi kèm PPV rất thấp. Cần báo cáo thước đo phản ánh tác động của quyết định tự động trong bối cảnh lâm sàng thật.
- **Điểm thứ hai:** có riêng một phần về đạo đức trong ML.

### Spies N.C. và cộng sự, Clinical Chemistry 2024;70(11):1334-1343

- **Vấn đề:** rất nhiều bài chứng minh khái niệm, rất ít mô hình được đưa vào phòng xét nghiệm, vì rào cản nằm ở kiểm định, triển khai và giám sát.
- **Nội dung:** ba bước đó, minh họa bằng bài toán phát hiện mẫu nhiễm nước muối. Sau ngày chạy thật công việc chưa hết: phải theo dõi trôi dữ liệu và có tiêu chí huấn luyện lại.

### LLM trong xét nghiệm

Bằng chứng hiện có ủng hộ giới hạn bạn đã đặt: LLM đọc chữ và viết giải thích, không quyết định ký.

- **Nhóm công tác AI của EFLM, CCLM 2023;61:1158-1166:** ChatGPT đọc 10 phiếu kết quả mô phỏng. Nó nhận ra chỉ số lệch khoảng tham chiếu, nhưng chỉ diễn giải được từng xét nghiệm một, không đánh giá được tổng thể.
- **Jin K. và cộng sự, CCLM 2025:** GPT-4o, o1 và o1 mini tìm 285 lỗi cài vào 86 phiếu xét nghiệm axit nucleic của 7 tác nhân hô hấp. Tỷ lệ phát hiện trung bình khoảng 89 đến 92% với lỗi thiếu sót, lỗi trình tự thời gian và lỗi một người vừa làm vừa duyệt. Với lỗi định dạng kết quả chỉ đạt 51,9%.
- **Ye và cộng sự, J Med Internet Res 2026;28:e87802:** GPT-5, Grok 4 và DeepSeek R1 đọc phiếu CBC bệnh máu. Tác giả ghi nhận ảo giác và lỗi suy luận, kết luận rằng triển khai lâm sàng hiện vẫn cần người giám sát.

### Tổng quan nên đọc

- **Lorde N., Mahapatra S., Kalaria T., Diagnostics 2024;14(16):1808:** ML cho PBRTQC và phát hiện lỗi phân tích, trước phân tích. Truy cập mở.
- **Baniahmad A., Bani-Ahmad S., Molecules 2026;31:3617 (11/10/2026):** tổng quan mới nhất, đi từ hiệu năng thuật toán đến triển khai, có cả LLM và xác minh kết quả. Truy cập mở.

---

## Bảng so sánh các nghiên cứu

Trong các nghiên cứu ML, chỉ Farrell 2023 chạy tiến cứu trong quy trình thật và báo cáo số lỗi được xác nhận. Wang 2021 thử mù đôi với KTV; Graham 2025 và Spies 2025 có phần kiểm định tiến cứu. Phần còn lại là hồi cứu trên lỗi mô phỏng. Bảng xếp theo lớp trong thiết kế của bạn, trong mỗi lớp xếp bài mới trước.

| Nghiên cứu | Lớp | Bài toán | Dữ liệu | Mô hình | Kết quả chính | Mức bằng chứng |
|---|---|---|---|---|---|---|
| Srirujee 2026 | A + C | Tự ký CBC | 63.201 CBC, 1 BV Thái Lan | XGBoost | Độ nhạy 97,5%, độ đặc hiệu 69% (luật: 89% và 46%) | Hồi cứu, 1 trung tâm |
| Zhu 2022 | A | Tự ký hóa sinh | 2,25 triệu báo cáo, 20 BV | 428 luật, ngưỡng theo phân vị | Tự ký 73,9%; bỏ lọt 24,5% so với chuyên gia | Hồi cứu đa trung tâm |
| Jin 2021 | A | Kiểm định hệ thống tự ký | 926.195 báo cáo, 833 luật | Luật, kiểm định trong LIS | Hơn 3,5 triệu báo cáo, không khiếu nại | Chạy thật nhiều năm |
| Wang H. 2021 | C | Tự ký hóa sinh | Chưa rõ quy mô | Ensemble 3 thuật toán | Tự ký 89,6%; âm tính giả 0,95 phần nghìn | Thử mù đôi với KTV |
| Wang Z. 2019 | A | Tự ký đông máu | 83.699 mẫu sau triển khai | Luật | Tự ký 78,9%; độ nhạy 100% khi thử | Chạy thật 6 tháng |
| Demirci 2016 | C | Duyệt hóa sinh có giá trị nguy hiểm | Chưa rõ quy mô | Mạng nơ-ron | Độ nhạy 91%, độ đặc hiệu 100% | Thử nghiệm mô hình |
| Tortosa-Carreres 2025 | C | WBIT, hóa sinh và huyết học | 432 nội bộ, 1.260 ngoài; có WBIT thật | Elastic Net + XGBoost | ROC-AUC 0,98 đến 0,99; PR-AUC 0,93 đến 0,99 | Hồi cứu, kiểm định ngoài |
| Graham 2025 | C | WBIT, CBC nhi | 1 BV nhi (Mỹ) | XGBoost | Độ chính xác 0,97; PPV 0,01 đến 0,75 tùy ngưỡng | Hồi cứu, có so sánh tiến cứu |
| Farrell 2023 | C | WBIT, CBC | 135.128 huấn luyện; 38.187 tiến cứu | XGBoost | 12 WBIT trong 110 cờ; PPV 10,9% | Tiến cứu 22 tuần |
| Farrell 2022 | C | Người giám sát AI hay AI tự chạy | 510 bộ kết quả | Mạng nơ-ron | AI tự chạy 92,5%; người cộng AI 81,2% | Thử nghiệm với tình nguyện viên |
| Mitani 2020 | C | Nhầm mẫu, 15 chỉ số | 1 BV đại học (Nhật) | GBDT trên chuỗi 4 lần | ROC AUC 0,9983 | Hồi cứu, mô phỏng |
| Rosenbaum 2018 | C | WBIT, 11 chỉ số hóa sinh | Nội trú, MGH | SVM | AUC 0,97; PPV 52% ở độ nhạy 80% | Hồi cứu, mô phỏng |
| Spies 2025 | C | Nhiễm dịch truyền | Thật và mô phỏng, nhiều viện | Ensemble + hồi quy mức nhiễm | Gắn cờ nhiều hơn quy trình hiện tại | Kiểm định ngoài, tiến cứu |
| Spies 2024 | C | Nhiễm dịch truyền | 25,7 triệu kết quả, 312.721 BN | UMAP không giám sát | PPV 0,78 ở mức 3 cờ trên 1.000 | Hồi cứu, chuyên gia duyệt 100 ca |
| Farrell 2024 | A + C | Nhiễm phụ gia ống, lỗi đơn chỉ số | 127.451 bộ; 800 mẫu pha | KNN, one-class SVM, Gaussian | KNN và SVM vượt luật giới hạn ở mọi chất nhiễm | Thí nghiệm pha mẫu |
| Duan 2021 | B | Trôi máy | 4 chỉ số, cả năm 2019 | Hồi quy + trung bình trượt | Phát hiện nhanh hơn khoảng 50% | Hồi cứu, bơm sai số |
| Luo 2016 | C | Dự đoán ferritin | Ngoại trú, MGH | 5 kỹ thuật hồi quy, phân loại | AUC 0,97 | Hồi cứu |

### Ba xu hướng thấy rõ từ bảng

1. Dữ liệu càng lớn và càng thật thì con số hiệu năng càng khiêm tốn. AUC 0,998 thuộc về nghiên cứu mô phỏng; PPV 10,9% thuộc về nghiên cứu tiến cứu.
2. Các hệ thống có số liệu chạy thật dài nhất đều là luật.
3. Không dòng nào thuộc Lớp B kết hợp với Lớp A hoặc C trong cùng một hệ thống.

---

## Các mô hình và công nghệ đã có gì mới hơn

Phần lớn cải tiến từ 2018 đến nay nằm ở cách tạo dữ liệu và cách đánh giá, không nằm ở thuật toán. Về thuật toán, mọi nhóm đã hội tụ về gradient boosting.

| Cách làm cũ | Cách làm mới hơn | Tình trạng bằng chứng |
|---|---|---|
| Mạng nơ-ron nông trong Weka (Demirci 2016), SVM (Rosenbaum 2018) | XGBoost: Farrell 2023, Graham 2025, Tortosa-Carreres 2025, Srirujee 2026. Mạng nơ-ron sâu: Seok 2024 | Đã chạy tiến cứu với XGBoost |
| Delta check một chỉ số | Delta check đa chỉ số bằng ML; chuỗi nhiều lần xét nghiệm (Mitani 2020) | Vượt delta check ở các nghiên cứu đã đọc |
| Tráo mẫu ngẫu nhiên để mô phỏng WBIT | Tráo giữa hai bệnh nhân cùng khoa, cùng thời điểm (Graham 2025); thêm WBIT thật (Tortosa-Carreres 2025) | Hồi cứu |
| Đánh giá trên tập cân bằng, báo cáo AUC | Tập kiểm định tỷ lệ lỗi thấp, PPV theo nhiều ngưỡng (Graham 2025); PR-AUC và hiệu chỉnh xác suất (Tortosa-Carreres 2025); recall định trước (Srirujee 2026) | Phù hợp khuyến nghị IFCC 2023 |
| Luật giới hạn từng chỉ số | Phát hiện bất thường đa biến (Farrell 2024) | Thí nghiệm pha mẫu |
| UMAP không giám sát (Spies 2024) | Ensemble có giám sát, mô hình riêng từng loại dịch, hồi quy mức nhiễm (Spies 2025) | Kiểm định ngoài |
| Ngưỡng luật do chuyên gia đặt | Ngưỡng theo phân vị dữ liệu của chính bệnh viện (Zhu 2022) | Đa trung tâm |
| Trung bình trượt thuần | RARTQC (Duan 2021); hồi quy phi tuyến bằng ML (Liang 2024); mạng đồ thị (Shang 2024) | Hồi cứu, bơm sai số |
| ChatGPT đời đầu đọc phiếu kết quả (EFLM 2023) | Mô hình suy luận 2025 đến 2026 (Jin K. 2025, Ye 2026) | Vẫn có ảo giác; chưa nghiên cứu nào cho LLM quyết định ký |

### Công nghệ mới chưa được thử trong lĩnh vực này

Ba hướng dưới đây tôi không tìm thấy trong tài liệu về autoverification, nên đây là đề xuất thử nghiệm, chưa có bằng chứng trong xét nghiệm.

- **Mô hình nền cho dữ liệu bảng.** TabPFN (Nature, 01/2025) vượt gradient boosting đã tinh chỉnh trên các bộ dữ liệu tới 10.000 mẫu và 500 đặc trưng, không cần huấn luyện riêng. Bản 2.5 (11/2025) nâng lên 50.000 mẫu và 2.000 đặc trưng. Hướng này hợp với các tổ hợp bệnh và chỉ số hiếm, nơi bạn chỉ có vài nghìn mẫu.
- **Dự đoán có bảo đảm độ phủ (conformal prediction).** Thay vì một khoảng kỳ vọng do mô hình tự ước lượng, phương pháp này hiệu chỉnh khoảng trên dữ liệu giữ riêng để đạt độ phủ định trước, ví dụ 99%. Nó cho bạn một cơ chế "không chắc thì chuyển người" có cơ sở thống kê.
- **Hồi quy phân vị bằng gradient boosting.** LightGBM và XGBoost hỗ trợ sẵn, cho thẳng cận dưới và cận trên của khoảng kỳ vọng mà không cần giả định phân bố chuẩn.

---

## Đề xuất cho dự án tại Vinmec Ocean Park 2

**Đề xuất chính:** xây Lớp A bằng luật trước và cho chạy ngầm ngay, rồi xây Lớp C thành các bộ phát hiện từng loại lỗi, thay vì một bộ phân loại "đúng hay sai" duy nhất. Lý do: mọi hệ thống tự ký đã chạy thật đều là luật, còn ML chỉ có bằng chứng tốt khi nhắm vào một loại lỗi cụ thể có thể mô phỏng.

### 1. Đặt lại thước đo mục tiêu

- Thước đo chính nên là cặp số: tỷ lệ tự ký, và tỷ lệ âm tính giả tính trên số kết quả đã tự ký. Mốc tham chiếu là Wang 2021: 89,6% và 0,95 phần nghìn.
- Chọn ngưỡng theo recall định trước rồi mới xem tự ký được bao nhiêu, như Srirujee 2026. Cách này khớp nguyên tắc "không bỏ lọt" của bạn.
- Báo cáo PPV ở tỷ lệ lỗi thật và PR-AUC, không chỉ AUC ROC. Dùng tập kiểm định tỷ lệ lỗi thấp theo cách của Graham 2025.
- Lường trước cỡ mẫu. Theo công thức trong Srirujee 2026, cần khoảng 1.825 ca lỗi để ước lượng recall 95% với sai số 1 điểm phần trăm, và 936 ca cho recall 97,5%. Farrell 2023 chỉ xác nhận được 12 WBIT thật trong 22 tuần. Lỗi thật sẽ không đủ để kiểm định, nên phải kết hợp lỗi mô phỏng với một giai đoạn chạy ngầm dài.

### 2. Lớp A: luật cứng

- Lấy khung Zhongshan làm điểm xuất phát vì cùng dòng máy Cobas. Khung có bốn bước: đủ kết quả, luật của máy (cờ, dải đo), luật của phòng xét nghiệm (HIL, giá trị nguy hiểm, logic, nhất quán), so với lịch sử (delta check).
- Thêm các luật nhất quán giữa chỉ số ngay từ Lớp A. Chúng rẻ, giải thích được và bắt đúng các lỗi bạn liệt kê: Ca × P cho nhiễm EDTA, Na/Cl cho điện cực lão hóa, TG so với chỉ số đục.
- Tính ngưỡng từ dữ liệu của chính Vinmec. Một bệnh viện trong nghiên cứu Zhongshan phải đặt lại ngưỡng delta mới dùng được.
- Không sao chép cách chọn phân vị. Nới theo phân vị cố định làm tỷ lệ bỏ lọt tăng hơn gấp đôi ở Zhongshan. Nên đặt ngưỡng cho từng chỉ số sao cho đạt tỷ lệ bỏ lọt mục tiêu trước.
- Đông máu trên Stago: dùng luật theo Wang Z. 2019. Chưa có nghiên cứu ML nào để dựa vào.

### 3. Lớp B: tình trạng máy

- Dùng RARTQC thay cho trung bình trượt thuần: hồi quy bỏ phần biến thiên do bệnh nhân, rồi mới tính trung bình trượt trên phần dư.
- Kiểm định theo quy trình IFCC (Loh 2020): bơm độ lệch nhân tạo vào dữ liệu lịch sử, đo tỷ lệ báo động giả và số bệnh nhân bị ảnh hưởng trước khi phát hiện.
- Bắt đầu với natri và clo, hai chỉ số đã có bằng chứng. Xét nghiệm ít mẫu mỗi ngày thì vẫn dựa vào QC nội kiểm.

### 4. Lớp C: hợp lý với bệnh nhân

**Thứ tự xây dựng, theo độ chắc của bằng chứng:**

1. **WBIT trên CBC.** Bằng chứng mạnh nhất, đã chạy tiến cứu. MCV, RDW và MCH mang phần lớn tín hiệu, và máy DxH 690T có đủ ba chỉ số này. Loại mẫu lấy sau truyền máu khỏi đặc trưng delta.
2. **Nhiễm dịch truyền trên bộ điện giải, glucose.** Mô phỏng được bằng cách pha loãng số học kết quả thật theo thành phần dịch. Bài hướng dẫn của Spies có sẵn quy trình tạo nhãn cho XGBoost.
3. **Nhiễm EDTA.** Bắt đầu bằng luật (K cao kèm Ca thấp), sau đó thêm mô hình khoảng cách KNN hoặc one-class SVM như Farrell 2024.
4. **Mô hình hợp lý tổng quát cho 10 đến 20 chỉ số nhiều mẫu nhất,** tức hướng hồi quy khoảng kỳ vọng của bạn. Làm sau cùng vì đây là phần chưa có tiền lệ.

**Lựa chọn kỹ thuật:**

- **Mô hình cơ sở:** XGBoost hoặc LightGBM. Lý do các nhóm đều chọn là xử lý được giá trị thiếu, điều chắc chắn xảy ra khi mỗi bệnh nhân được chỉ định một tổ hợp xét nghiệm khác nhau.
- **Khoảng kỳ vọng:** hồi quy phân vị, hiệu chỉnh bằng conformal prediction. Kết quả rơi ngoài khoảng 99% thì giữ lại.
- **Tổ hợp hiếm, ít dữ liệu:** thử TabPFN và so với XGBoost trên cùng tập kiểm định.
- **Bệnh nhân lần đầu, chưa có lịch sử:** mô hình delta không dùng được. Dùng mô hình không cần kết quả trước (phát hiện bất thường đa biến) hoặc chuyển người.
- **Mô phỏng nhầm mẫu:** tráo giữa hai bệnh nhân cùng khoa, cùng khung giờ như Graham 2025. Tráo ngẫu nhiên tạo ra ca quá dễ.

**Một lưu ý về nhãn:** nhật ký chạy lại và từ chối mẫu ghi lại việc KTV đã làm, không ghi lỗi thật. Mô hình học từ nhãn này sẽ học bắt chước KTV, kể cả chỗ KTV bỏ sót. Nên dùng nhãn này để huấn luyện, nhưng kiểm định bằng lỗi mô phỏng và lỗi đã xác nhận.

### 5. Phân vai giữa người và AI

- Không thiết kế theo kiểu AI gợi ý, KTV quyết định cuối. Farrell 2022 cho thấy cách này kém hơn AI tự chạy (81,2% so với 92,5%).
- Phân vai một chiều. Kết quả AI ký thì KTV không duyệt lại. Kết quả AI giữ thì KTV phải làm một hành động cụ thể (chạy lại, kiểm tra ống, gọi khoa) rồi mới phát hành, không chỉ bấm đồng ý.
- Bước bác sĩ xét nghiệm ký số vẫn giữ nguyên. Số kết quả AI đã ký mà bác sĩ trả lại là thước đo âm tính giả liên tục, không tốn thêm công.
- Vẫn cần lý do giữ mẫu (mã luật vi phạm, chỉ số lệch nhiều nhất), nhưng đừng kỳ vọng lời giải thích làm KTV tin AI hơn.
- LLM: giữ đúng giới hạn bạn đã đặt.

### 6. Kiểm định và triển khai

- Dùng cơ chế hai giai đoạn của Kingmed. Kiểm từng luật chạy đúng ý. Sau đó đếm số lần người và máy đồng ý cho từng xét nghiệm; đủ ngưỡng mới bật tự ký; bộ đếm về 0 khi phát hiện luật sai hoặc thiếu.
- Mốc tham khảo về khối lượng kiểm định: ít nhất 3 tháng hoặc 50.000 báo cáo trước khi bật, và kiểm lại hằng năm (WS/T 616-2018). Hướng dẫn nền là CLSI AUTO10 và AUTO15.
- Giám sát sau triển khai: theo dõi phân bố đầu vào và tỷ lệ giữ mẫu theo tuần. Đổi lô hóa chất, hiệu chuẩn lại hoặc đổi máy là các mốc phải kiểm tra lại mô hình.

### 7. Câu hỏi cần hỏi khoa trước khi bắt đầu

- Khoa lâm sàng có quét mã định danh bệnh nhân tại giường khi lấy máu không? Nếu có, WBIT thật sẽ hiếm hơn và PPV của mô hình sẽ thấp hơn.
- F9, F4 hoặc LIS có xuất được cờ của máy, chỉ số HIL và số lô hóa chất qua HL7 hoặc ASTM không?
- Nhật ký chạy lại và từ chối mẫu có ghi lý do không, hay chỉ ghi sự kiện?
- Mỗi chỉ số chạy bao nhiêu mẫu mỗi ngày trên từng máy? Con số này quyết định Lớp B làm được cho chỉ số nào.
- Theo quy định của bệnh viện, ai chịu trách nhiệm với một kết quả do AI ký? Tôi không có căn cứ để trả lời câu này.

---

## Danh mục nguồn

Các trang dưới đây là nơi tôi lấy số liệu. Bài có ghi "toàn văn" là bài tôi đọc được trọn vẹn.

### Autoverification

- Zhu 2022, J Clin Lab Anal (toàn văn)
- Jin 2021, BMC Med Inform Decis Mak (toàn văn)
- Srirujee 2026, J Clin Lab Anal (toàn văn)
- Wang H. 2021, CCLM
- Demirci 2016, Am J Clin Pathol
- Wang Z. 2019, BMC Med Inform Decis Mak

### Dán nhầm nhãn (WBIT)

- Rosenbaum và Baron 2018, tóm tắt và bài tường thuật số liệu
- Mitani 2020, CCLM
- Farrell 2021, Ann Clin Biochem
- Farrell 2022, Int J Lab Hematol
- Farrell 2022, CCLM
- Farrell 2022, Ann Clin Biochem (giải thích)
- Farrell 2023, Clinical Chemistry và podcast của tác giả
- Graham 2025, Clinical Chemistry (abstract) và podcast
- Tortosa-Carreres 2025, CCLM
- Seok 2024, CCLM
- Sürmeli 2025, J Pers Med

### Nhiễm mẫu và phát hiện bất thường

- Spies 2024, Clinical Chemistry và podcast
- Spies 2025, Clinical Chemistry
- Spies, hướng dẫn thực hành
- Farrell 2024, CCLM
- Tổng quan nhiễm dịch truyền 2025, J Lab Precis Med

### PBRTQC

- Badrick 2019, podcast Clinical Chemistry
- Loh 2020, CCLM
- Duan 2021, Clinical Chemistry và bài bình luận
- Shang 2024, CCLM
- Duan 2024, Ann Lab Med

### Phương pháp luận, LLM và công nghệ mới

- Luo 2016, Am J Clin Pathol và 3D-MICE
- Master 2023, IFCC và podcast
- Spies 2024, kiểm định và giám sát ML
- EFLM 2023, ChatGPT
- Jin K. 2025, CCLM
- Ye 2026, J Med Internet Res
- Lorde 2024, Diagnostics
- Baniahmad 2026, Molecules
- TabPFN, Nature 2025 và TabPFN-2.5
