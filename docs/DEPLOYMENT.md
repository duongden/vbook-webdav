# Hướng dẫn triển khai và vận hành

Tài liệu dành cho người cài đặt, cập nhật và bảo trì server. Hướng dẫn sử dụng nằm trong [README](../README.md).

## Cài đặt lần đầu

Chuẩn bị Node.js 22 trở lên, tài khoản Cloudflare, một bucket R2 và một namespace KV. Hạn mức và chi phí phụ thuộc tài khoản Cloudflare; không cam kết mọi mức sử dụng đều miễn phí.

```sh
git clone https://github.com/duongden/vbook-webdav.git
cd vbook-webdav
npm ci
cp config/wrangler.example.jsonc wrangler.jsonc
```

Chỉnh **file local `wrangler.jsonc`** theo tài khoản của bạn:

| Cấu hình | Điền gì? |
| --- | --- |
| `name` | Tên Worker muốn triển khai |
| `USER_KV` → `id` | ID namespace KV của bạn |
| `STORAGE_R2` → `bucket_name` | Tên bucket R2 của bạn |
| `USER_STORAGE` và `migrations` | Giữ như mẫu khi cài mới |

File này đã được Git bỏ qua. **Không dùng `git add -f` để đưa nó lên repo.**

```sh
npx wrangler login
npm run check
npx wrangler deploy --keep-vars --minify
npx wrangler secret put ADMIN_PIN
npx wrangler secret put ADMIN_SESSION_SECRET
```

Lệnh secret yêu cầu nhập giá trị riêng; không viết giá trị vào lệnh để tránh lưu trong lịch sử terminal. `ADMIN_SESSION_SECRET` cần chuỗi ngẫu nhiên ít nhất 32 byte, có thể tạo bằng `openssl rand -hex 32`. Secret này cũng bảo vệ kho key Drive nếu chưa đặt `DRIVE_VAULT_KEY` riêng. Giữ nguyên secret qua các lần deploy để giải mã được key đã lưu. Sau đó mở `/admin` để tạo tài khoản đầu tiên.

## Deploy qua GitHub

Fork repo vào tài khoản của bạn, rồi kết nối với Worker trong Cloudflare → **Settings → Builds**.

### 1. Điền cấu hình build

| Ô | Giá trị |
| --- | --- |
| Production branch | `main` |
| Build command | `npm run build:cloudflare` |
| Deploy command | `npx wrangler deploy --keep-vars --minify` |
| Version command | `npx wrangler versions upload` |
| Root directory | `/` |

Tắt build nhánh không phải production nếu cấu hình đang dùng tài nguyên production.

### 2. Thêm biến cho build

Trong chính phần **Builds**, tìm **Variables and secrets** bên dưới phần cấu hình/nhánh. Đây là biến dành cho quá trình build.

| Loại | Name | Value |
| --- | --- | --- |
| Variable | `CF_WORKER_NAME` | Tên Worker đã kết nối repo |
| Secret | `CF_KV_NAMESPACE_ID` | ID namespace đang gắn với `USER_KV` |
| Secret | `CF_R2_BUCKET_NAME` | Tên bucket đang gắn với `STORAGE_R2` |

Xem **Bindings** của Worker để xác định đúng KV và R2. Khi cập nhật server hiện có, dùng lại tài nguyên cũ để giữ tài khoản và file.

### 3. Giữ secret chạy ứng dụng ở runtime

| Secret runtime | Bắt buộc? |
| --- | --- |
| `ADMIN_PIN` | Có, để sử dụng admin |
| `ADMIN_SESSION_SECRET` | Khuyến nghị mạnh, dùng để ký phiên admin độc lập với PIN |
| `DRIVE_VAULT_KEY` | Tùy chọn: secret ngẫu nhiên ít nhất 32 ký tự để mã hóa key Drive riêng biệt; mặc định dùng `ADMIN_SESSION_SECRET` |

Các secret này nằm trong Worker → **Settings → Variables and Secrets**, không phải biến build. Script build chỉ tạo cấu hình tạm từ ba biến `CF_*`; không đưa khóa hoặc mật khẩu vào source.

### 4. Lưu và chạy build

Bấm **Save**, push commit mới lên `main`, rồi theo dõi build đến khi **Success**. Retry áp dụng cấu hình mới nhưng vẫn build commit được chọn; hãy chọn đúng commit chứa thay đổi cần triển khai.

Nếu cần kích hoạt một build mới khi code không đổi:

```sh
git pull --ff-only
git commit --allow-empty -m "Trigger deployment"
git push origin main
```

Tham khảo [Cloudflare Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## Deploy qua terminal

Dùng khi đã có cấu hình local đúng và muốn triển khai trực tiếp:

```sh
git pull --ff-only
npm ci
npm run check
npx wrangler login
npx wrangler deploy --keep-vars --minify
```

Trước khi deploy, kiểm tra `name` trong cấu hình trùng Worker của URL đang dùng. Giữ nguyên R2/KV, binding Durable Object và lịch sử migration.

Nếu secret đã đặt trên Dashboard, không khai báo lại `ADMIN_PIN`, `ADMIN_SESSION_SECRET`, `DRIVE_VAULT_KEY` trong `vars` local. `--keep-vars` giữ biến Dashboard, nhưng giá trị khai báo trong cấu hình vẫn có thể ghi đè biến cùng tên. Khi chạy local, đặt các giá trị này trong `.dev.vars`, không đặt trong `wrangler.jsonc`.

### Google Drive qua WebDAV

Mỗi user tự lấy và nhập API key trong hộp **Drive** theo [hướng dẫn lấy API key](../README.md#cách-lấy-google-drive-api-key). Worker không dùng `GOOGLE_API_KEY` chung nữa.

Key được mã hóa AES-GCM, gắn với username và lưu trong Durable Object của user cùng Folder ID. API trạng thái chỉ trả cờ đã liên kết, không trả key hoặc bản mã. Trang admin chỉ quản lý tài khoản, quota và trạng thái; chức năng xem lại mật khẩu đã bị gỡ. Đặt lại mật khẩu sẽ gỡ kết nối Drive để user tự nhập key lại. Xóa tài khoản cũng xóa cấu hình Drive.

Người vận hành phải giữ `ADMIN_SESSION_SECRET` ổn định hoặc đặt `DRIVE_VAULT_KEY` riêng trước khi user lưu key. Đổi secret mã hóa khiến key cũ không giải mã được; user cần nhập lại key. Khi nâng cấp từ bản key chung, user cần liên kết lại Drive bằng key cá nhân. Folder ID cũ trong KV không còn được dùng.

Endpoint `/drive-webdav/` dùng Basic Auth của user, hỗ trợ `OPTIONS`, `GET`, `HEAD`, `PROPFIND`; dữ liệu tải trực tiếp từ Drive. Admin session không được dùng thay Basic Auth ở endpoint này hoặc API user.

Phạm vi bảo vệ là quyền trên ứng dụng: người kiểm soát mã Worker và hạ tầng vẫn có khả năng truy cập dữ liệu máy chủ. Đây không phải mã hóa đầu cuối. Quản trị tài khoản vẫn cho phép đặt lại mật khẩu và xóa tài khoản; xóa tài khoản sẽ xóa dữ liệu R2 của tài khoản đó.

## Nâng cấp từ bản cũ

- Sao lưu riêng source, cấu hình và dữ liệu R2/KV. Backup source không thay thế backup dữ liệu Cloudflare.
- Bản dùng counter quota KV cũ cần thêm binding `USER_STORAGE` và migration SQLite `user-storage-v1` theo file mẫu. Nếu đã có migration khác, thêm mục mới, không xóa lịch sử đã triển khai.
- Không chạy đồng thời bản cũ và mới cùng ghi một bucket. Không cần di chuyển file: cấu trúc vẫn là `username/...`; tài khoản vẫn nằm ở KV `user:username`.
- Quota được khởi tạo lại từ R2 rồi quản lý bởi Durable Object. Phiên admin cũ có thể cần đăng nhập lại.

## Phạm vi và kiểm thử

- Hỗ trợ `OPTIONS`, `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL`, `PROPFIND` Depth 0/1; chưa hỗ trợ `MOVE`, `COPY`, `LOCK`, `UNLOCK` hay đầy đủ mọi yêu cầu WebDAV.
- Endpoint `/shared/<owner>/<shareId>/` dùng Basic Auth riêng và chỉ cho phép `OPTIONS`, `GET`, `HEAD`, `PROPFIND`. Share record nằm trong Durable Object hiện có nên không cần binding hoặc migration mới.
- Endpoint `/drive-webdav/` dùng Basic Auth tài khoản, đọc cây thư mục qua Google Drive API và tải trực tiếp từ Drive. Kết nối này không dùng quota R2 và không có quyền ghi.
- Upload từ trình duyệt đi qua cùng luồng PUT và quota Durable Object như WebDAV client; file được đặt dưới `library/`.
- Metadata chỉnh sửa của tệp `library/` nằm trong Durable Object của owner, không sửa object R2. Xóa file/thư mục sẽ dọn metadata liên quan. URL bìa HTTPS được tải trực tiếp bởi trình duyệt nên máy chủ ảnh nhìn thấy kết nối của người dùng.
- R2 lưu file; KV lưu tài khoản; mỗi user có một SQLite Durable Object tuần tự hóa ghi/xóa và quản lý quota.
- KV có eventual consistency: đổi mật khẩu/khóa tài khoản có thể mất thời gian để xuất hiện ở mọi vùng.
- Mật khẩu đăng nhập dùng PBKDF2 1.000 vòng theo cơ chế tương thích cũ, còn yếu trước tấn công offline; bảo vệ quyền truy cập KV và dùng mật khẩu dài, duy nhất.
- Basic Auth chỉ an toàn khi đi qua HTTPS. Đăng nhập user bị giới hạn theo cặp IP/tài khoản; KV có eventual consistency nên nên kết hợp Cloudflare WAF/rate limiting cho hệ thống public.
- Trang admin không cung cấp thao tác xem mật khẩu, key Drive hay duyệt nội dung user.
- Lịch sử được sao chép trước khi thay file hiện tại. Upload lỗi giữ bản cũ; một lần ngắt tiến trình đột ngột có thể để lại bản lịch sử thừa, được tính lại vào quota.
- Phân trang UI chạy trên danh sách đã tải về, chưa giảm tổng metadata đọc từ R2. Không chỉnh/xóa trực tiếp R2 ngoài ứng dụng khi quota đã được khởi tạo nếu chưa có bước đối soát.
- CSS nội bộ dùng theme chung tại `src/webui/theme.ts`; không tải Tailwind CDN.

```sh
npm run check     # TypeScript và test backend cục bộ
npm run test:ui   # Chrome/Chromium: responsive, tìm kiếm, lọc, phân trang, xóa
npm run dev      # Chạy local; dùng .dev.vars cho secret local
```

Test UI dùng Chrome có sẵn trên macOS; môi trường khác có thể chạy `npx playwright install chromium` hoặc đặt `VBOOK_TEST_CHROME`. Test sử dụng dữ liệu giả và tài nguyên local. Cookie admin có Secure nên kiểm thử admin local cần HTTPS hoặc môi trường test thích hợp.

## Những gì không được đưa lên repo public

`wrangler.jsonc`, `wrangler.toml`, `.env`, `.dev.vars`, `.wrangler/`, `.local-backups/`, API token, Google API key, khóa mã hóa và bản backup dữ liệu riêng.

Giữ file mẫu công khai `config/wrangler.example.jsonc` với placeholder. Không cấu hình static assets trỏ vào thư mục gốc hoặc thư mục backup. Không đính kèm cấu hình riêng trong artifact, issue hay ảnh README.

## Tài liệu tham khảo

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

Giấy phép MIT — xem [LICENSE](LICENSE).
