# Cập nhật kiến trúc sau review bảo mật (2026-09-05)

Các quyết định dưới đây thay thế quy tắc quota KV cũ ở phần sau:
- KV giữ tài khoản; Durable Object `UserStorage` theo user giữ quota và tuần tự hóa mutation R2.
- Chỉ quét R2 để khởi tạo/phục hồi counter khi chưa biết dung lượng hoặc mutation bị gián đoạn. UI có thể list để hiển thị file, không ghi đè counter.
- Đường dẫn lấy từ URL gốc và decode đúng một lần; không decode lại `c.req.path`.
- PUT yêu cầu Content-Length và dùng FixedLengthStream để kiểm tra kích thước thực tế.
- Xóa theo lô R2, lưu tiến độ và alarm để phục hồi; không báo thành công khi xóa còn pending.
- `.local-backups/` chứa backup riêng trên máy: không commit, push, deploy hoặc đính kèm vào artifact.
- Các `.agents/skills/` được nhắc bên dưới không có trong snapshot GitHub. Kiểm chứng bằng `npm run check` và smoke test Miniflare; không tuyên bố đã đọc skill vắng mặt.

# AGENTS.md — VBook WebDAV Cloud

Hướng dẫn cho mọi AI coding agent (Antigravity, Claude Code, Cursor, Copilot...) khi làm việc trong repo này.

## Dự án là gì

VBook WebDAV Cloud — server WebDAV serverless chạy trên Cloudflare Workers (HonoJS), dùng R2 làm storage và KV để cache quota, phục vụ đồng bộ dữ liệu cho VBook/Legado. Có kèm Admin Dashboard (PIN-based) và giao diện Fake Cloud Drive cho người dùng cuối.

## Cách dùng Skills

Trước khi code phần liên quan, đọc SKILL.md tương ứng trong `.agents/skills/<tên-skill>/SKILL.md`.

Skill đã cài trong project này:

| Skill | Áp dụng khi |
|---|---|
| `typescript` | Mọi file `.ts` — strict mode, không dùng `any`, generics có constraint |
| `hono` | Route handler, middleware trong HonoJS |
| `authentication` | Logic Basic Auth, PBKDF2-SHA256, verify credential |
| `backend-development` | Logic WebDAV (PROPFIND/MKCOL/PUT/GET/DELETE), quota R2/KV |
| `tech-docs` | Cập nhật README.md, comment public API |
| `interface-design` | Layout Admin Dashboard, Fake Cloud Drive UI |
| `css` / `css-best-practices` | Style cho 2 giao diện trên (HTML/CSS thuần, không framework) |
| `systematic-debugging` | Khi tìm lỗi 503 CPU timeout, lỗi path traversal, lỗi quota lệch |
| `code-refactoring` | Dọn code, tách logic quota/R2/KV khỏi route handler |
| `verification-protocol` | Bắt buộc trước khi báo "xong việc" |
| `code-review` | Trước khi merge thay đổi vào `main` |
| `critical-partner` | Phản biện thiết kế, không chỉ đồng ý theo yêu cầu |

## Quy tắc riêng của dự án (bắt buộc)

1. **Không bao giờ dùng R2 `list()` để tính quota.** Luôn đọc/ghi số liệu quota qua Workers KV (incremental update). Nếu nghi ngờ KV lệch số, dùng cơ chế self-healing (re-seed từ R2) thay vì quét R2 trực tiếp trong request path.
2. **Mọi path từ client phải qua `decodeURIComponent()` trước khi xử lý**, và validate chống Path Traversal (không cho `../` thoát khỏi `/${username}/...`).
3. **Khi sinh XML `<D:href>` trong response PROPFIND, luôn `encodeURIComponent()`** tên file/thư mục con — kể cả khi tên có khoảng trắng hoặc tiếng Việt.
4. **Cách ly dữ liệu theo user tuyệt đối** — mọi thao tác R2/KV phải scope theo `username`, không được để leak chéo giữa các user dùng chung server.
5. **Basic Auth phải luôn hash bằng PBKDF2-SHA256** với số vòng lặp đã tinh chỉnh cho CPU time ~1ms — không tăng vòng lặp tuỳ tiện vì sẽ gây lỗi 503 CPU Time Exceeded trên Free Tier.
6. **Giới hạn file upload là 100MB** (giới hạn cứng của Cloudflare Workers) — không cần tự validate thêm trong code trừ khi muốn báo lỗi sớm/thân thiện hơn cho client.
7. **Xoá thư mục phải quét sạch mọi file con**, kể cả khi client gửi path không có `/` cuối.
8. Route `/admin` chỉ xác thực bằng `ADMIN_PIN`, không phải Basic Auth user — không được gộp chung 2 luồng xác thực này.

## Khi review/refactor

- Ưu tiên giữ code tối ưu CPU time (Free Tier Cloudflare) — tránh thêm loop/scan nặng vào hot path (upload/download).
- Tuân theo `verification-protocol` skill: chạy/verify thực tế trước khi