# ☁️ VBook WebDAV Cloud

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![HonoJS](https://img.shields.io/badge/Hono-v4-E36002?logo=hono&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178C6?logo=typescript&logoColor=white)

**VBook WebDAV Cloud** là một giải pháp Serverless toàn diện chạy trên hạ tầng **Cloudflare Workers**, cung cấp giao thức **WebDAV** và giao diện quản lý **Web UI (Fake Cloud Drive)** cực kỳ nhẹ, bảo mật và hoàn toàn miễn phí. 

Dự án được tối ưu hóa đặc biệt cho nhu cầu đồng bộ, sao lưu cấu hình, truyện, và dấu trang từ các ứng dụng như **VBook**, **Legado** hoặc các WebDAV client thông dụng khác với khả năng vận hành 24/7 và chi phí **0đ**.

---

## ✨ Tính Năng Nổi Bật (Features)

*   **🔒 Cách ly người dùng (Multi-user Isolation):** Hỗ trợ nhiều tài khoản sử dụng chung một Server URL nhưng dữ liệu được phân vùng và cách ly tuyệt đối (`/${username}/...`).
*   **⚡ WebDAV Chuẩn RFC:** Hỗ trợ đầy đủ các phương thức `PROPFIND`, `MKCOL`, `PUT`, `GET`, `DELETE`, `OPTIONS`. Hoạt động mượt mà với tính năng *Kiểm tra* và *Đồng bộ* của VBook, Legado, Cyberduck...
*   **🚀 Siêu tốc độ & CPU Safe:** Xác thực Basic Auth sử dụng mã hóa **PBKDF2-SHA256** được tinh chỉnh số vòng lặp tối ưu hóa cho môi trường Serverless (~1ms CPU time), loại bỏ hoàn toàn lỗi **503 CPU Time Exceeded** trên Cloudflare Workers Free Tier.
*   **📊 Quản lý Quota Hiệu năng cao (KV-Cached Quotas):** 
    *   Tổng dung lượng lưu trữ của người dùng được lưu vết và tính toán trực tiếp trong **Workers KV** bằng phương thức cộng/trừ tịnh tiến (incremental updates) sau mỗi lần tải file.
    *   Hoàn toàn **không dùng lệnh quét R2 list** nặng nề khi upload hay tải giao diện, tiết kiệm tối đa số lượng Class B R2 operations và giúp hệ thống chạy tức thì.
    *   **Cơ chế tự sửa lỗi (Self-healing):** Tự động quét và nạp lại (re-seed) cache KV từ R2 khi phát hiện dữ liệu trống hoặc sau các thao tác xóa file lớn.
*   **🔤 Hỗ trợ hoàn hảo Ký tự đặc biệt & Khoảng trắng:** 
    *   Đường dẫn được chuẩn hóa, giải mã thông minh (`decodeURIComponent`) ngăn chặn tấn công Path Traversal.
    *   Tự động mã hóa URL (`encodeURIComponent`) các thư mục và file con khi sinh thẻ `<D:href>` XML, giúp mọi hệ điều hành (Windows Explorer, macOS Finder) hiển thị đúng tên file có khoảng trắng và dấu Tiếng Việt.
*   **📂 Xử lý Thư mục Khổng lồ (Enterprise Scale):** Hệ thống tích hợp xử lý phân trang (Pagination) thông minh trên Cloudflare R2, phá vỡ rào cản 1000 files mặc định, giúp đồng bộ an toàn hàng chục nghìn tệp tin. Thao tác xóa thư mục cũng đệ quy làm sạch triệt để mọi file con.
*   **🔑 Secret Admin Dashboard:** Giao diện quản trị ẩn sang trọng chỉ truy cập bằng mã PIN bảo mật, hỗ trợ Thêm/Sửa/Xoá User và thiết lập Quota trực tiếp ngay trên trình duyệt di động.
*   **🌐 Modern Cloud Drive UI:** Tự động nhận diện truy cập từ trình duyệt để hiển thị giao diện Quản lý File tĩnh cực kỳ hiện đại với Card Layout, Toast Notifications mượt mà, hỗ trợ tải xuống và xóa file trực quan.

---

## 🚀 Hướng Dẫn Cài Đặt (Quick Start)

Yêu cầu chuẩn bị: Bạn cần có một tài khoản [Cloudflare](https://dash.cloudflare.com) miễn phí và đã kích hoạt dịch vụ R2 Storage.

### 1. Cấu hình Cloudflare
1. Vào Cloudflare Dashboard, mục **R2** và tạo một Bucket mới (ví dụ: `vbook-backup-bucket`).
2. Vào **Workers & Pages -> KV** và tạo một Namespace mới (ví dụ: `USER_KV`). Copy ID của Namespace đó.

### 2. Cài đặt dự án
Tải dự án về máy tính của bạn:
```bash
git clone https://github.com/kychitoge/vbook-webdav.git
cd vbook-webdav
npm install
#hoặc pnpm install
```

### 3. Cấu hình Biến môi trường
Đổi tên file `wrangler.example.jsonc` thành `wrangler.jsonc` ở thư mục gốc và cập nhật thông tin của bạn:
```jsonc
{
  "name": "vbook-webdav",
  "main": "src/index.ts",
  "compatibility_date": "2024-03-01",
  "vars": {
    "ADMIN_PIN": "123456" // Đổi mã PIN quản trị bí mật của bạn tại đây
  },
  "kv_namespaces": [
    {
      "binding": "USER_KV",
      "id": "<DÁN_ID_KV_CỦA_BẠN_VÀO_ĐÂY>"
    }
  ],
  "r2_buckets": [
    {
      "binding": "STORAGE_R2",
      "bucket_name": "vbook-backup-bucket" // Tên Bucket R2 bạn vừa tạo
    }
  ]
}
```

### 4. Deploy lên Cloudflare
Triển khai hệ thống lên mây chỉ với 1 lệnh duy nhất:
```bash
npx run deploy
# hoặc dùng pnpm run deploy
```

---

## 📱 Hướng Dẫn Sử Dụng

### 1. Quản trị User (Dành cho Admin)
Truy cập đường dẫn bí mật: `https://<ten-worker>.workers.dev/admin`
1. Nhập mã PIN (Cấu hình trong `ADMIN_PIN`).
2. Thêm Username mới, thiết lập Mật khẩu, Dung lượng tối đa (Quota MB), Kích thước file tối đa (Max File MB).
3. Bấm **Edit** để cập nhật thông số người dùng hiện tại (bỏ trống trường password để giữ nguyên mật khẩu cũ) hoặc **Delete** để xóa người dùng cùng toàn bộ file R2 của người dùng đó.

### 2. Cấu hình trên Ứng dụng VBook / Legado
Mở ứng dụng đọc truyện của bạn, vào phần **Đồng bộ & Sao lưu -> WebDAV**:
*   **URL / Địa chỉ:** `https://<ten-worker>.workers.dev` (Hoặc có thể thêm `/webdav` phía sau đều được hỗ trợ).
*   **Tên đăng nhập (Username):** Username vừa tạo ở trang Admin.
*   **Mật khẩu (Password):** Mật khẩu tương ứng.
*   **Thư mục gốc:** `vbook_backup` (Khuyến nghị giữ nguyên để tạo thư mục đồng bộ riêng).

Bấm **Kiểm tra** để xác thực kết nối (thấy chữ xanh báo thành công) và bấm **Lưu lại**!

### 3. Giao diện Web Cá Nhân (Fake Cloud Drive)
Mở trình duyệt truy cập thẳng: `https://<ten-worker>.workers.dev`
*   Hệ thống sẽ hỏi thông tin đăng nhập **Basic Auth**.
*   Nhập tài khoản người dùng WebDAV của bạn (không phải mã PIN Admin).
*   Bạn có thể xem trực quan danh sách file, kiểm tra dung lượng còn trống, tải file về máy hoặc xóa file cực kỳ thuận tiện.

---

## ⚠️ Lưu Ý Về Giới Hạn Vật Lý (Hạ Tầng Cloudflare)

Vì hệ thống vận hành trên kiến trúc Serverless miễn phí của Cloudflare, có một số giới hạn vật lý cần chú ý:
1.  **Giới hạn dung lượng file tải lên tối đa là 100MB:** 
    Cloudflare Workers giới hạn dung lượng request tối đa là **100MB**. Nếu bạn tải lên file đơn lẻ nặng hơn 100MB, Cloudflare Edge sẽ trả về lỗi `413 Request Entity Too Large` trước khi Worker kịp xử lý. Hãy thiết lập WebDAV client chia nhỏ file nếu bạn cần backup khối lượng dữ liệu khổng lồ.
2.  **Đồng bộ KV (Eventual Consistency):** 
    Workers KV có cơ chế đồng bộ phân tán toàn cầu với độ trễ từ 1-5 giây. Vì vậy, dung lượng lưu trữ trên trang Admin hoặc Web UI có thể mất vài giây để cập nhật chính xác số bytes sau khi bạn vừa tải một lượng lớn file lên.
3.  **Bắt buộc sử dụng HTTPS:** 
    Xác thực Basic Auth gửi mật khẩu dưới dạng chuỗi Base64. Luôn đảm bảo sử dụng đường dẫn `https://` (mặc định Cloudflare đã kích hoạt sẵn) để đảm bảo mật khẩu được truyền đi qua kênh mã hóa an toàn.

---

## 🛠️ Công Nghệ Sử Dụng (Tech Stack)

*   **[HonoJS](https://hono.dev/):** Web Framework siêu nhẹ, nhanh và được tối ưu hóa xuất sắc cho Edge computing.
*   **[Cloudflare Workers](https://workers.cloudflare.com/):** Nền tảng Serverless mạnh mẽ của Cloudflare.
*   **[Cloudflare R2](https://developers.cloudflare.com/r2/):** Dịch vụ lưu trữ S3-compatible miễn phí 10GB của Cloudflare.
*   **[Cloudflare KV](https://developers.cloudflare.com/kv/):** Cơ sở dữ liệu Key-Value phân tán lưu trữ phiên làm việc và tài khoản siêu tốc.

---

## 📄 Giấy phép (License)

Dự án được phân phối dưới giấy phép MIT. Xem file `LICENSE` để biết thêm chi tiết.
