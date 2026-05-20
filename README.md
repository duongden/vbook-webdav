# ☁️ VBook WebDAV Cloud

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![HonoJS](https://img.shields.io/badge/Hono-v4-E36002?logo=hono&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178C6?logo=typescript&logoColor=white)

**VBook WebDAV Cloud** là một giải pháp Serverless toàn diện chạy trên hạ tầng **Cloudflare Workers**, cung cấp giao thức **WebDAV** và giao diện quản lý **Web UI (Fake Cloud Drive)** cực kỳ nhẹ và hoàn toàn miễn phí. 

Được thiết kế đặc biệt để phục vụ nhu cầu đồng bộ, sao lưu truyện từ các ứng dụng như **VBook** hoặc **Legado** với khả năng vận hành 24/7 và chi phí **0đ**.

---

## ✨ Tính Năng Nổi Bật (Features)

*   **🔒 Multi-user Isolation:** Hỗ trợ nhiều người dùng chung một Server URL nhưng mọi file được cách ly tự động. File của ai người nấy quản lý, không lo ghi đè (`/${username}/...`).
*   **🛡️ Anti-Abuse Quota System:** Tính năng bảo vệ dung lượng thông minh. Chặn đứng các file tải lên vượt giới hạn kích thước (Max File Size) hoặc khi tổng dung lượng người dùng vượt mức (Quota).
*   **⚡ WebDAV Chuẩn:** Hỗ trợ đầy đủ các phương thức `PROPFIND`, `MKCOL`, `PUT`, `GET`, `DELETE`, `OPTIONS`. Hoạt động trơn tru với tính năng *Kiểm tra* và *Đồng bộ* của VBook.
*   **🌐 Fake Cloud Drive UI:** Tự động nhận diện truy cập từ trình duyệt để hiển thị giao diện Quản lý File tĩnh cực sang trọng với Dark Mode (sử dụng Tailwind CSS).
*   **🔑 Secret Admin Dashboard:** Giao diện quản trị ẩn chỉ truy cập bằng mã PIN, cho phép Thêm/Sửa/Xoá User và set Quota trực tiếp ngay trên điện thoại mà không cần dùng lệnh CLI.
*   **🚀 Zero-cost & High Performance:** Tận dụng tối đa Free Tier của Cloudflare (100k Request/ngày, R2 10GB, KV Storage). Tối ưu hóa stream chống tự động nén (Gzip interference) để tối đa tốc độ tải xuống.

---

## 🚀 Hướng Dẫn Cài Đặt (Quick Start)

Yêu cầu chuẩn bị: Bạn cần có một tài khoản [Cloudflare](https://dash.cloudflare.com) và đã bật tính năng R2 Storage.

### 1. Cấu hình Cloudflare
1. Vào Cloudflare Dashboard, mục **R2** và tạo một Bucket mới (ví dụ: `vbook-backup-bucket`).
2. Vào **Workers & Pages -> KV** và tạo một Namespace mới (ví dụ: `USER_KV`). Lấy ID của Namespace đó.

### 2. Cài đặt dự án
Clone dự án về máy tính của bạn:
```bash
git clone https://github.com/your-username/vbook-webdav.git
cd vbook-webdav
npm install
```

### 3. Cấu hình Biến môi trường
Mở thư mục dự án, đổi tên file `wrangler.example.jsonc` thành `wrangler.jsonc` và cập nhật thông tin của bạn:
```jsonc
{
  "vars": {
    "ADMIN_PIN": "123456" // Đổi mã PIN bí mật của bạn tại đây
  },
  "kv_namespaces": [
    {
      "binding": "USER_KV",
      "id": "<ID_KV_CỦA_BẠN>" // Dán ID KV vào đây
    }
  ],
  "r2_buckets": [
    {
      "binding": "STORAGE_R2",
      "bucket_name": "vbook-backup-bucket" // Tên Bucket R2 của bạn
    }
  ]
}
```

### 4. Deploy lên Cloudflare
Triển khai hệ thống chỉ với 1 lệnh duy nhất:
```bash
npx wrangler deploy
```

---

## 📱 Hướng Dẫn Sử Dụng

### Quản trị User (Dành cho Admin)
Truy cập đường dẫn bí mật: `https://<ten-worker>.workers.dev/admin`
1. Nhập mã PIN (Cấu hình trong `ADMIN_PIN`).
2. Thêm Username mới, thiết lập Mật khẩu, Dung lượng tối đa (Quota MB).

### Cấu hình trên Ứng dụng VBook / Legado
Mở ứng dụng đọc truyện của bạn, vào phần **Đồng bộ & Sao lưu -> WebDAV**:
*   **URL:** `https://<ten-worker>.workers.dev` (Hoặc có thể thêm `/webdav` phía sau đều được hỗ trợ).
*   **Tên (Username):** Username vừa tạo ở trang Admin.
*   **Mật khẩu:** Mật khẩu tương ứng.
*   **Thư mục gốc:** `vbook_backup` (Khuyến nghị giữ nguyên).

Bấm **Kiểm tra** để thấy chữ xanh và lưu lại!

### Quản lý File cá nhân (Fake Cloud Drive)
Bất cứ lúc nào, bạn (hoặc bạn bè) có thể dùng trình duyệt trên điện thoại/máy tính mở `https://<ten-worker>.workers.dev`.
Hệ thống sẽ hỏi mật khẩu (Basic Auth). Đăng nhập bằng tài khoản VBook ở trên để xem danh sách File, tải về hoặc xóa trực tiếp với giao diện trực quan.

---

## 🛠️ Công Nghệ Sử Dụng (Tech Stack)
*   **[HonoJS](https://hono.dev/):** Web Framework siêu nhẹ, nhanh và được tối ưu hóa cho Edge computing.
*   **[Cloudflare Workers](https://workers.cloudflare.com/):** Nền tảng Serverless mạnh mẽ.
*   **[Cloudflare R2](https://developers.cloudflare.com/r2/):** Lưu trữ S3-compatible miễn phí 10GB.
*   **[Cloudflare KV](https://developers.cloudflare.com/kv/):** Cơ sở dữ liệu Key-Value phân tán lưu trữ tài khoản người dùng siêu tốc.
*   **[Tailwind CSS](https://tailwindcss.com/):** Thư viện Utility-first CSS được tích hợp thông qua CDN cho giao diện Cloud Drive.

## 📄 Giấy phép (License)
Dự án được phân phối dưới giấy phép MIT. Xem file `LICENSE` để biết thêm chi tiết.
