# VBook WebDAV Cloud

Kho backup cá nhân cho VBook, Legado và ứng dụng hỗ trợ WebDAV. File lưu trên Cloudflare R2; bạn quản lý bằng trình duyệt hoặc ứng dụng đang dùng.

**Có sẵn:** tài khoản riêng, giới hạn dung lượng, lịch sử backup theo ngày giờ, tìm kiếm, phân trang và giao diện responsive.

> Các URL, tên tài nguyên và thông tin cấu hình trong tài liệu là **giá trị mẫu**. Không đưa mật khẩu, API token, khóa mã hóa hoặc cấu hình riêng lên GitHub.

## Bắt đầu từ đâu?

| Bạn muốn… | Đọc phần |
| --- | --- |
| Kết nối app và backup | [Sử dụng WebDAV](#sử-dụng-webdav) |
| Tải lại hoặc xóa bản cũ | [Quản lý backup trên web](#quản-lý-backup-trên-web) |
| Tạo tài khoản, chỉnh giới hạn | [Dành cho admin](#dành-cho-admin) |
| Tự triển khai server | [Cài đặt lần đầu](#cài-đặt-lần-đầu) |
| Cập nhật bản mới | [Deploy qua GitHub](#deploy-qua-github) hoặc [Deploy qua terminal](#deploy-qua-terminal) |
| Backup báo lỗi | [Xử lý lỗi thường gặp](#xử-lý-lỗi-thường-gặp) |

## Sử dụng WebDAV

Nhờ admin cung cấp **URL server, username và password**. Trong cài đặt backup WebDAV của app, nhập:

| Ô trong app | Giá trị mẫu |
| --- | --- |
| Server / URL | `https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/` |
| Username | Tài khoản do admin tạo |
| Password | Mật khẩu của tài khoản đó |
| Thư mục backup, nếu app có ô riêng | `vbook_backup` |

1. Dùng **Kiểm tra kết nối** nếu app có hỗ trợ.
2. Chạy backup lần đầu.
3. Mở URL server bằng trình duyệt, đăng nhập cùng tài khoản và kiểm tra file đã xuất hiện.

Server cũng hỗ trợ URL kết thúc bằng `/webdav/`. Không nhập `ADMIN_PIN` vào ô password của app: mã này chỉ dùng cho trang quản trị. Tên và vị trí menu backup phụ thuộc từng app.

## Quản lý backup trên web

Trên máy tính:

```text
┌──────────────────────┬────────────────────────────────────┐
│ SIDEBAR              │ NỘI DUNG CHÍNH                     │
│ Tất cả               │ Tệp của tôi           [Làm mới]    │
│ Bản hiện tại         │ [Tìm tên / thư mục] [Sắp xếp]      │
│ Lịch sử              │                                    │
│                      │ Tên · Dung lượng · Ngày giờ        │
│ Dung lượng đã dùng   │ backup.zip       [Tải về] [Xóa]    │
│ Tổng số tệp          │                                    │
│ Tệp mới nhất         │ 1–20 / 45 tệp          [←] 1/3 [→] │
└──────────────────────┴────────────────────────────────────┘
```

Trên điện thoại, sidebar chuyển thành vùng điều hướng phía trên danh sách.

| Thao tác | Cách dùng |
| --- | --- |
| Chỉ xem file đang dùng | Chọn **Bản hiện tại** |
| Xem các bản server giữ lại | Chọn **Lịch sử** |
| Tìm một backup | Nhập tên file hoặc thư mục; tìm kiếm hỗ trợ bỏ dấu tiếng Việt |
| Đổi thứ tự | Chọn mới nhất, tên hoặc dung lượng |
| Xem thêm | Dùng nút chuyển trang; mỗi trang tối đa 20 tệp |
| Tải về | Bấm **Tải về** cạnh bản cần lấy |
| Xóa bản không cần | Bấm **Xóa**, kiểm tra tên rồi xác nhận |
| App vừa backup xong | Bấm **Làm mới** |

Nếu kết quả xóa chưa rõ, giao diện giữ file và hiện **Kiểm tra lại**. Nút này xác nhận trạng thái, không gửi thêm lệnh xóa.

### Lịch sử ngày giờ hoạt động thế nào?

Khi app ghi đè **cùng đường dẫn**, server giữ bản trước trong `backup-history`, rồi cập nhật file hiện tại. Ví dụ:

```text
vbook_backup/backup.zip                  ← bản hiện tại
backup-history/
  2026-01-02_14-30-00-000_UTC+7_<id>/
    vbook_backup/backup.zip              ← bản trước khi ghi đè
```

- Ngày giờ trong tên lịch sử là **lúc lưu bản cũ**, theo giờ Việt Nam (GMT+7). Mã riêng tránh trùng tên.
- Lần upload đầu chỉ tạo file hiện tại. Nếu app tự tạo tên mới mỗi lần, các file đó vẫn thuộc **Bản hiện tại**, vì server chưa thực hiện lưu phiên bản cũ.
- **Không tự xóa lịch sử.** Bạn chủ động xóa trên web khi không cần nữa.
- Tổng quota tính cả file hiện tại và lịch sử. Mỗi bản là bản đầy đủ, không phải phần chênh lệch và không được nén thêm.
- Không upload trực tiếp vào `backup-history`: thư mục này dành cho server. Bạn vẫn được tải và xóa các bản trong đó.
- Xóa một file hiện tại không xóa lịch sử ở thư mục riêng. Xóa toàn bộ tài khoản hoặc toàn bộ cây thư mục gốc có thể xóa cả lịch sử.

**Khôi phục:** tải bản cần dùng trong **Lịch sử**, rồi chọn chức năng nhập/khôi phục backup của app. Web hiện chưa có nút tự thay bản hiện tại bằng bản lịch sử.

## Dành cho admin

Mở `https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/admin`, đăng nhập bằng `ADMIN_PIN`.

1. Tạo tài khoản bằng username, password, quota và giới hạn file.
2. Gửi thông tin kết nối cho người sử dụng bằng kênh riêng.
3. Trong **Thao tác**, chọn sửa thông tin, tạm khóa/mở khóa hoặc xóa tài khoản.

| Trường | Ý nghĩa |
| --- | --- |
| Quota | Tổng dung lượng cho tài khoản, **bao gồm lịch sử** |
| Max File | Dung lượng tối đa của mỗi lần upload |
| Password khi sửa | Để trống nếu muốn giữ mật khẩu hiện tại |

Các ô đang ghi MB nhưng tính theo **MiB** (1 MiB = 1.048.576 byte). Ví dụ backup khoảng 76,5 MB có thể đặt Max File là `95`; quota cần đủ cho số bản muốn giữ. Server vẫn giới hạn mỗi upload ở **100.000.000 byte**, dù đặt Max File cao hơn.

### Xem lại mật khẩu

Tính năng tùy chọn dành cho admin:

1. Tạo khóa riêng trên máy bằng `openssl rand -hex 32`.
2. Trong Worker → **Settings → Variables and Secrets**, thêm loại **Secret**, tên `PASSWORD_VAULT_KEY`, giá trị là khóa vừa tạo.
3. Lưu khóa riêng an toàn và giữ nguyên qua các lần deploy.
4. Tài khoản cũ cần nhập lại mật khẩu trong **Sửa thông tin** một lần; có thể dùng lại mật khẩu cũ.
5. Bấm **Mật khẩu** để xem hoặc sao chép. Hộp tự đóng sau 30 giây.

Mật khẩu cũ chỉ có hash không thể đọc ngược. Khi cấu hình khóa, server lưu thêm bản mã hóa AES-256-GCM. Đổi hoặc mất khóa khiến bản mã hóa cũ không đọc được; kiểm tra đăng nhập bằng hash vẫn hoạt động. Khi chưa cấu hình khóa, tạo/đổi mật khẩu vẫn hoạt động nhưng chưa xem lại được. Người có quyền admin có thể đọc mật khẩu đã lưu theo cách này.

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
```

Lệnh secret yêu cầu nhập giá trị riêng; không viết giá trị vào lệnh để tránh lưu trong lịch sử terminal. Sau khi đặt `ADMIN_PIN`, mở `/admin` để tạo tài khoản đầu tiên. Nếu muốn xem lại mật khẩu, thêm `PASSWORD_VAULT_KEY` theo hướng dẫn phía trên.

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
| `PASSWORD_VAULT_KEY` | Chỉ khi muốn xem lại mật khẩu |

Hai secret này nằm trong Worker → **Settings → Variables and Secrets**, không phải biến build. Script build chỉ tạo cấu hình tạm từ ba biến `CF_*`; không đưa khóa hoặc mật khẩu vào source.

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

Nếu secret đã đặt trên Dashboard, không khai báo lại `ADMIN_PIN` hoặc `PASSWORD_VAULT_KEY` trong `vars` local. `--keep-vars` giữ biến Dashboard, nhưng giá trị khai báo trong cấu hình vẫn có thể ghi đè biến cùng tên.

Sau deploy, Wrangler in URL và Version ID. Mở web, tải lại trang và kiểm tra các thao tác cần dùng.

## Xử lý lỗi thường gặp

| Hiện tượng | Kiểm tra / xử lý |
| --- | --- |
| Không đăng nhập được, HTTP 401 | Kiểm tra username/password của app; không dùng mã admin |
| HTTP 403 | Kiểm tra tài khoản bị khóa, phiên admin/CSRF hết hạn hoặc upload vào thư mục lịch sử |
| HTTP 413 | File vượt Max File hoặc giới hạn request; tăng Max File nếu file vẫn dưới 100.000.000 byte |
| HTTP 507 | Quota không đủ giữ bản hiện tại, lịch sử và upload mới; xóa bản không cần hoặc tăng quota |
| Không tạo được thư mục | Cập nhật server; tạo lại thư mục đã có được hỗ trợ. Kiểm tra tên thư mục có trùng một file không |
| Xóa trả 503 hoặc đang xử lý | Có thể đang xóa theo lô; chờ rồi kiểm tra lại, không coi đó là thành công ngay |
| Chưa có bản mật khẩu mã hóa | Cấu hình secret runtime rồi nhập lại mật khẩu tài khoản một lần |
| Build báo thiếu `CF_*` | Thêm biến trong phần Builds, lưu rồi chạy lại đúng commit |
| Push xong nhưng giao diện cũ | Kiểm tra repo, nhánh, commit của build và Worker đích; tải lại trình duyệt |
| HTTP 411 | App upload không gửi Content-Length; cần client gửi độ dài đã biết |

Khi chia sẻ log hoặc ảnh để nhờ hỗ trợ, che mật khẩu, token và giá trị secret.

## Nâng cấp từ bản cũ

- Sao lưu riêng source, cấu hình và dữ liệu R2/KV. Backup source không thay thế backup dữ liệu Cloudflare.
- Bản dùng counter quota KV cũ cần thêm binding `USER_STORAGE` và migration SQLite `user-storage-v1` theo file mẫu. Nếu đã có migration khác, thêm mục mới, không xóa lịch sử đã triển khai.
- Không chạy đồng thời bản cũ và mới cùng ghi một bucket. Không cần di chuyển file: cấu trúc vẫn là `username/...`; tài khoản vẫn nằm ở KV `user:username`.
- Quota được khởi tạo lại từ R2 rồi quản lý bởi Durable Object. Phiên admin cũ có thể cần đăng nhập lại.

## Phạm vi và kiểm thử

- Hỗ trợ `OPTIONS`, `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL`, `PROPFIND` Depth 0/1; chưa hỗ trợ `MOVE`, `COPY`, `LOCK`, `UNLOCK` hay đầy đủ mọi yêu cầu WebDAV.
- R2 lưu file; KV lưu tài khoản; mỗi user có một SQLite Durable Object tuần tự hóa ghi/xóa và quản lý quota.
- KV có eventual consistency: đổi mật khẩu/khóa tài khoản có thể mất thời gian để xuất hiện ở mọi vùng.
- Mật khẩu đăng nhập dùng PBKDF2 1.000 vòng theo cơ chế tương thích cũ, còn yếu trước tấn công offline; bảo vệ quyền truy cập KV và dùng mật khẩu dài, duy nhất.
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

`wrangler.jsonc`, `wrangler.toml`, `.env`, `.dev.vars`, `.wrangler/`, `.local-backups/`, API token, khóa mã hóa và bản backup dữ liệu riêng.

Giữ file mẫu công khai `config/wrangler.example.jsonc` với placeholder. Không cấu hình static assets trỏ vào thư mục gốc hoặc thư mục backup. Không đính kèm cấu hình riêng trong artifact, issue hay ảnh README.

## Tài liệu tham khảo

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

Giấy phép MIT — xem [LICENSE](LICENSE).
