# VBook WebDAV Cloud

Server WebDAV chạy trên Cloudflare Workers, lưu file trong R2, tài khoản trong KV và quản lý dung lượng bằng SQLite-backed Durable Objects. Có giao diện file cá nhân và trang quản trị `/admin`.

## Chức năng

- Cách ly dữ liệu theo username; mọi thao tác file đều cần Basic Auth.
- Các phương thức `OPTIONS`, `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL`, `PROPFIND` (Depth 0/1). Đây là tập con WebDAV; chưa hỗ trợ `LOCK`, `UNLOCK`, `MOVE`, `COPY` hay đầy đủ mọi yêu cầu RFC.
- Upload theo stream, giới hạn kích thước file và quota theo user. Mỗi user có một Durable Object tuần tự hóa thao tác ghi; không dùng KV làm bộ đếm dung lượng.
- Liệt kê phân trang R2, hỗ trợ dấu tiếng Việt, khoảng trắng, ký tự `#`, `?`, `%` trong tên file.
- Xóa thư mục theo lô, gồm cả đường dẫn không có `/` cuối. Công việc xóa được lưu bền vững và có alarm để tiếp tục nếu gián đoạn.
- File tải xuống được trả dưới dạng attachment, kèm `nosniff` và CSP sandbox để tránh chạy HTML/JavaScript trên tên miền admin.
- Trang admin hỗ trợ thêm/sửa/khóa/xóa user, có CSRF và cookie phiên `HttpOnly`, `Secure`, `SameSite=Strict`; phiên hết hạn sau 8 giờ. Thiếu `ADMIN_PIN` thì admin trả 503.

## Cài đặt

Cần Node.js 22 trở lên, tài khoản Cloudflare đã bật R2, một bucket R2 và một namespace KV. SQLite-backed Durable Objects có trên Workers Free; hạn mức và khả năng phát sinh phí phụ thuộc gói sử dụng, không bảo đảm mọi tải đều miễn phí.

```sh
git clone https://github.com/duongden/vbook-webdav.git
cd vbook-webdav
npm ci
cp config/wrangler.example.jsonc wrangler.jsonc
```

Điền `USER_KV.id` và `STORAGE_R2.bucket_name` trong `wrangler.jsonc`. Giữ binding `USER_STORAGE` và migration `user-storage-v1` để Cloudflare tạo lớp `UserStorage` với SQLite.

Đặt mã quản trị dài, khó đoán bằng secret (không commit mã vào source):

```sh
npx wrangler secret put ADMIN_PIN
```

Để chạy local, tạo `.dev.vars` chứa `ADMIN_PIN="ma-quan-tri-local"`; file này được Git bỏ qua. `npm run dev` dùng dữ liệu R2/KV/DO local. Cookie admin có `Secure`, vì vậy dùng HTTPS khi kiểm thử giao diện admin trong trình duyệt.

```sh
npm run check
npm run dev
# Khi đã sẵn sàng triển khai:
npm run deploy
```

## Nâng cấp từ phiên bản KV quota cũ

1. Sao lưu source, `wrangler.jsonc`, các secret local và dữ liệu R2/KV riêng trước khi triển khai. Backup source không thay thế backup dữ liệu Cloudflare.
2. Thêm phần dưới đây vào cấu hình hiện tại, giữ nguyên binding R2/KV và secret:

```jsonc
"durable_objects": {
  "bindings": [{ "name": "USER_STORAGE", "class_name": "UserStorage" }]
},
"migrations": [
  { "tag": "user-storage-v1", "new_sqlite_classes": ["UserStorage"] }
]
```

Nếu đã có migration khác, thêm mục mới vào mảng hiện có; không xóa lịch sử migration.

3. Chạy `npm ci`, `npm run check`, sau đó deploy khi đã sẵn sàng. Không đổi tên/xóa migration đã triển khai.
4. Không cần chuyển file: vẫn giữ R2 key `username/...` và KV key `user:username`. Counter `usage:username` cũ không còn được dùng. Lần đầu cần dung lượng, Durable Object tính lại từ R2; các upload tiếp theo cập nhật counter đã tuần tự hóa.
5. Phiên admin cũ không còn hợp lệ, cần đăng nhập lại. Tài khoản plaintext cũ được nâng cấp sang PBKDF2 khi đăng nhập thành công. Username hợp lệ gồm chữ ASCII, số, `_`, `-`, dài tối đa 128 ký tự; tài khoản cũ có tên khác cần di chuyển riêng.

Không chạy đồng thời phiên bản cũ và mới cùng ghi một bucket. Không ghi/xóa trực tiếp qua R2 ngoài ứng dụng sau khi counter được tạo; thay đổi ngoài luồng cần đối soát dung lượng trước khi tiếp tục áp quota.

## Sử dụng với VBook / Legado

- URL: `https://<worker>.workers.dev` hoặc thêm `/webdav`.
- Username/password: tài khoản do admin tạo, không dùng mã admin.
- Thư mục gốc: ví dụ `vbook_backup`.
- Luôn dùng HTTPS. Basic Auth chỉ mã hóa Base64, không mã hóa bí mật đường truyền.

Mở `/` bằng trình duyệt để xem danh sách và tải/xóa file; mở `/admin` để quản trị.

## Dung lượng và xử lý lỗi

- Quota và giới hạn file trong giao diện được nhập theo MiB (1.048.576 byte). Server cũng giới hạn mỗi upload ở 100.000.000 byte. Giới hạn request ở Cloudflare Edge phụ thuộc gói tài khoản.
- PUT bắt buộc có `Content-Length`; thiếu trả **411**, vượt kích thước file trả **413**, vượt tổng quota trả **507**. Body thực tế không khớp kích thước khai báo bị từ chối. Client chỉ gửi chunked upload không có độ dài cần đổi cấu hình/client.
- Khi xóa còn nhiều trang dữ liệu, server trả **503** kèm `Retry-After: 30`, không báo thành công sớm. Alarm tiếp tục công việc; thử DELETE lại sau. Các lượt ghi cùng user tạm chờ hoặc bị từ chối khi xóa còn pending.
- Xóa user chỉ báo hoàn tất sau khi xóa sạch file. Storage của user bị khóa để các request còn dùng thông tin KV cũ không ghi lại dữ liệu trong lúc xóa.
- KV giữ tài khoản có eventual consistency: đổi mật khẩu/khóa tài khoản có thể chưa xuất hiện ngay ở mọi vùng; không cam kết 1–5 giây.
- UI vẫn list R2 để hiển thị file; chỉ phần tính quota không quét toàn bucket ở mỗi upload. Khi khởi tạo hoặc phục hồi mutation bị gián đoạn, hệ thống cần quét lại R2.
- PBKDF2 giữ 1.000 vòng của phiên bản trước để tương thích ngân sách CPU. Đây là mức thấp đối với tấn công offline; không có cam kết “loại bỏ hoàn toàn CPU timeout”. Nên dùng mật khẩu dài, duy nhất và bảo vệ quyền truy cập KV.

## Kiểm thử và backup local

`npm run check` chạy TypeScript strict và test. Test tích hợp dùng Miniflare/workerd với R2, KV và SQLite-backed DO cục bộ; không gọi tài nguyên Cloudflare production. Có test upload đồng thời, overwrite, quota, phân trang >1.000 file, tên đặc biệt, admin/CSRF và fault injection cho việc xóa/stream bị gián đoạn.

`.local-backups/` chỉ dành cho backup riêng trên máy. Không commit, push, deploy hay đính kèm thư mục này vào artifact. Worker chỉ bundle entrypoint trong `src`; không cấu hình static assets trỏ vào thư mục gốc dự án.

## Tham khảo

- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Giấy phép MIT, xem [LICENSE](LICENSE).
