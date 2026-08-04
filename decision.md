# Decision Record: Giới hạn Upload 100MB

## 1. Bối cảnh
Dự án **VBook WebDAV Cloud** sử dụng kiến trúc Serverless 100% trên hạ tầng Cloudflare Workers. Người dùng mong muốn có khả năng upload các file backup (thường từ ứng dụng VBook/Legado qua giao thức WebDAV) lớn hơn 100MB.
Tuy nhiên, Cloudflare Workers Free/Pro áp đặt giới hạn cứng: request body tối đa là 100MB. Bất kỳ request nào lớn hơn 100MB đều bị Cloudflare Edge chặn lại ngay lập tức với lỗi `413 Request Entity Too Large`.

## 2. Ràng buộc dự án
Các giải pháp kỹ thuật đề xuất bị vướng vào hai ràng buộc cốt lõi (Hard Constraints) của dự án:
- **Tiêu chí "0 Đồng":** Không chấp nhận bất kỳ giải pháp nào phát sinh chi phí duy trì hàng tháng (Ví dụ: Nâng cấp gói Cloudflare Business/Enterprise để tăng mức giới hạn lên 200MB - 500MB).
- **Client Cố định:** Không thể hoặc không muốn sửa mã nguồn của client (app VBook/Legado) để hỗ trợ chia nhỏ file (chunked upload) hay WebDAV multipart upload. Server WebDAV phải làm việc được với hành vi PUT file nguyên khối của client hiện hành.

## 3. Các Phương Án Đã Đánh Giá

### 3.1. Phương án A: Nâng cấp gói Cloudflare
- **Mô tả:** Đóng tiền trả phí cho Cloudflare để tăng limit request.
- **Kết quả:** BỊ LOẠI vì vi phạm tiêu chí "0 Đồng".

### 3.2. Phương án B: Presigned URL Redirect (Dùng HTTP 307)
- **Mô tả:** Worker chặn request, kiểm tra `Content-Length`. Nếu file quá lớn, sinh ra S3 Presigned URL và trả về mã `307 Temporary Redirect` để client tự PUT thẳng vào R2.
- **Kết quả:** KHÔNG KHẢ THI.
- **Nguyên nhân:** Cloudflare chặn kích thước file ở tầng **Edge Proxy**, *trước khi* request đi vào script Worker. Với các file > 100MB, mã lỗi `413` được Edge trả về ngay lập tức. Mã nguồn của Worker (`src/index.ts`) hoàn toàn không được kích hoạt (invoke) nên không có cơ hội thực thi logic sinh Presigned URL hay trả mã HTTP 307. Kể cả khi client gửi header `Expect: 100-continue`, gateway của Cloudflare vẫn đánh rớt request đó.

### 3.3. Phương án C: Chunked / Multipart Upload
- **Mô tả:** Client chia nhỏ file thành các phần < 100MB, dùng `Content-Range` để đẩy lên Worker, Worker ghép lại qua R2 Multipart API.
- **Kết quả:** BỊ LOẠI vì vi phạm ràng buộc "Client Cố định" (không được sửa app client).

## 4. Quyết Định Môn Cốt (Decision)

Căn cứ vào kết quả đánh giá kỹ thuật: Bài toán upload file lớn hơn 100MB với các ràng buộc hiện tại là **vô nghiệm (impossible) về mặt kỹ thuật**.

**Quyết định chính thức:**
1. **Đóng Backlog:** Đánh dấu backlog xử lý upload > 100MB thành `CLOSED / WONTFIX`.
2. **Chấp nhận giới hạn:** Xem mức 100MB không phải là lỗi cần fix (bug), mà là một đặc tả phần mềm (specification). Mức 100MB thường đã đủ để backup truyện dạng chữ (text).
3. **Thay đổi thái độ với lỗi:** Khi client đẩy file > 100MB, chúng ta chấp nhận việc proxy Cloudflare tự động trả về lỗi 413, lỗi này đủ phổ quát để WebDAV client hiển thị thông báo lỗi cho người dùng.

Quyết định này đảm bảo giữ gìn tôn chỉ "0 Đồng" và giúp đội ngũ không tốn thêm thời gian nghiên cứu các giải pháp không khả thi.
