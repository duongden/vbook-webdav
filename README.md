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

## Deploy qua Cloudflare Workers Builds

Không commit `wrangler.jsonc`. Script tạo file bị Git bỏ qua ngay trong môi trường build, từ mẫu công khai và biến riêng trên Cloudflare. Script không ghi đè cấu hình local đã tồn tại và không sao chép secret vào file sinh ra.

Trong Worker → Settings → Builds, kết nối repo và chọn production branch `main`:

| Ô cấu hình | Giá trị |
| --- | --- |
| Build command | `npm run build:cloudflare` |
| Deploy command | `npx wrangler deploy --keep-vars --minify` |
| Version command | `npx wrangler versions upload` |
| Root directory | `/` |

Thêm vào **Build Variables and Secrets**:

| Biến | Giá trị |
| --- | --- |
| `CF_WORKER_NAME` | Tên Worker hiện tại, đúng với Worker đã kết nối repo |
| `CF_KV_NAMESPACE_ID` | ID namespace KV đang gắn với `USER_KV` |
| `CF_R2_BUCKET_NAME` | Tên bucket R2 đang gắn với `STORAGE_R2` |

Dùng lại KV và R2 hiện có để giữ tài khoản và file. `ADMIN_PIN` giữ tại **Settings → Variables and Secrets** của Worker (runtime), không đưa vào Git hoặc biến build. Cấu hình sinh ra giữ runtime vars trên Dashboard và thêm binding/migration `USER_STORAGE` từ mẫu.

Lưu cấu hình rồi retry build chứa script này; các push tiếp theo vào `main` sẽ tự build/deploy. Nếu build cũ thuộc commit chưa có script, cần build commit mới nhất. Chỉ bật build production khi dùng các binding production này.

Tham khảo [Cloudflare Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

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

### Giao diện quản lý file

Giao diện tiếng Việt hỗ trợ điện thoại, tìm tên tệp/thư mục (không bắt buộc gõ dấu), sắp xếp theo tên, ngày hoặc dung lượng. Làm mới danh sách và xóa file không tải lại toàn trang. CSS/JavaScript của giao diện file được bundle trực tiếp, không phụ thuộc Tailwind CDN.

Khi xóa, nút được khóa trong lúc xử lý và có hộp xác nhận trước thao tác. Nếu DELETE lỗi hoặc mất kết nối, giao diện dùng HEAD để xác nhận lại: chỉ báo thành công khi DELETE trả 200/204 hoặc HEAD xác nhận 404. Nếu chưa biết kết quả, tệp vẫn được giữ trên giao diện cùng nút **Kiểm tra lại**; nút này không gửi thêm DELETE. Lỗi 401/403 được báo riêng.

`GET /` với `Accept: application/json` trả danh sách file và dung lượng cho UI, vẫn bắt buộc Basic Auth và dùng `Cache-Control: private, no-store`. Các response có header `X-VBook-Version` để đối chiếu bản đang triển khai. Push GitHub không tự cập nhật Worker nếu chưa cấu hình tự động deploy; cần triển khai đúng tên Worker của URL đang dùng.

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

`npm run test:ui` chạy thêm kiểm thử Chrome/Chromium headless cho giao diện, gồm lỗi 500 sau khi xóa thành công, mất kết nối, pending, quyền truy cập, tìm kiếm và bố cục điện thoại. Trên macOS có Chrome, test dùng Chrome đã cài; ở môi trường khác chạy `npx playwright install chromium` trước, hoặc đặt `VBOOK_TEST_CHROME` tới executable Chromium. Tất cả dữ liệu và tài khoản trong test là giả.

`.local-backups/` chỉ dành cho backup riêng trên máy. Không commit, push, deploy hay đính kèm thư mục này vào artifact. Worker chỉ bundle entrypoint trong `src`; không cấu hình static assets trỏ vào thư mục gốc dự án.

## Tham khảo

- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Giấy phép MIT, xem [LICENSE](LICENSE).


## Xem mật khẩu trong admin

Tạo khóa ngẫu nhiên bằng `openssl rand -hex 32`, lưu riêng an toàn, rồi thêm **Secret runtime** tên `PASSWORD_VAULT_KEY` trong Worker → Settings → Variables and Secrets. Không đưa khóa vào Git, biến build hoặc log. Dùng cùng khóa qua các lần deploy; thay/mất khóa khiến bản mã hóa cũ không đọc được (đăng nhập bằng hash vẫn hoạt động).

Sau khi cấu hình khóa, mật khẩu khi tạo/sửa tài khoản được lưu thêm bằng AES-256-GCM với nonce ngẫu nhiên và ràng buộc username. Admin chọn **Xem mật khẩu**; hộp tự đóng sau 30 giây. API yêu cầu phiên admin và CSRF, không cache; HTML danh sách không chứa mật khẩu hoặc bản mã hóa.

Tài khoản cũ chỉ có hash cần đặt lại mật khẩu một lần; không thể khôi phục mật khẩu từ hash. Nếu chưa cấu hình khóa, việc tạo/đổi mật khẩu vẫn dùng hash như cũ và chưa hỗ trợ xem lại. Sửa quota mà để trống mật khẩu giữ bản mã hóa hiện có. Quyền admin cho phép đọc mật khẩu nên chỉ cấp cho người được phép biết các mật khẩu này.


## Lịch sử backup theo ngày giờ

App tiếp tục dùng URL và tên file cũ. Mỗi lần PUT ghi đè thành công, bản trước được giữ trong `backup-history/YYYY-MM-DD_HH-mm-ss-SSS_UTC+7_<id>/<đường dẫn gốc>`. Thời gian là lúc lưu vào lịch sử, theo giờ Việt Nam; ID tránh trùng khi backup liên tiếp. Upload lần đầu chỉ tạo bản hiện tại.

Các bản lịch sử xuất hiện trong danh sách web, tải về hoặc xóa bằng nút hiện có. Không tự xóa theo tuổi hay số lượng. Không cho PUT/MKCOL vào thư mục `backup-history` dành riêng cho server; GET/HEAD/DELETE vẫn được phép. Xóa file hiện tại không xóa lịch sử ở thư mục riêng; xóa toàn bộ tài khoản/toàn bộ thư mục gốc có thể xóa cả lịch sử.

Quota bao gồm cả lịch sử. Khi không đủ chỗ giữ bản cũ và bản mới, upload trả 507 và giữ nguyên dữ liệu; xóa thủ công bản không cần rồi thử lại. Bản sao cũ hoàn tất trước khi thay file hiện tại. Upload lỗi giữ nguyên file cũ và dọn bản sao thừa của lần thử đó; nếu Worker bị ngắt đột ngột có thể còn thêm một bản lịch sử, được tính lại vào quota. Không tự chia nhỏ hay nén thêm nội dung backup.

### Tạo lại thư mục từ VBook

Để tương thích client tạo thư mục trước mỗi lần backup, MKCOL trả 201 cả khi collection đã tồn tại (gồm thư mục ngầm có file con); không sửa/xóa dữ liệu hiện có. Nếu đường dẫn trùng một file, vẫn trả 405. HEAD nhận diện thư mục có hoặc không có dấu `/` cuối, cả tại root và mount `/webdav`.

### Danh sách backup gọn hơn

Giao diện hỗ trợ lọc tất cả/bản hiện tại/lịch sử, tìm kiếm và phân trang 20 tệp. Tìm kiếm và đổi bộ lọc về trang đầu; xóa bản cuối trang tự điều chỉnh trang hiện tại. Phân trang thực hiện trên trình duyệt sau khi tải danh sách, chưa giảm lượng metadata đọc từ R2. Ngày giờ hiển thị theo Việt Nam; tên lịch sử rút gọn trên giao diện, đường dẫn tải/xóa giữ nguyên.
