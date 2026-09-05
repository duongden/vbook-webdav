# VBook WebDAV Cloud

Lưu và quản lý bản sao lưu từ VBook, Legado hoặc ứng dụng hỗ trợ WebDAV. Bạn có thể tìm, tải về và xóa backup bằng trình duyệt trên máy tính hoặc điện thoại.

## 1. Kết nối ứng dụng

Bạn cần **địa chỉ WebDAV, tên tài khoản và mật khẩu** do người quản trị cung cấp.

Mở phần sao lưu WebDAV trong ứng dụng và điền:

| Ô trong ứng dụng | Cách điền |
| --- | --- |
| Server / URL | Dán nguyên địa chỉ WebDAV được cung cấp |
| Username | Tên tài khoản của bạn |
| Password | Mật khẩu tài khoản |
| Thư mục backup, nếu có | Ví dụ: `vbook_backup` |

Sau đó:

1. Bấm **Kiểm tra kết nối**, nếu ứng dụng có nút này.
2. Chọn **Sao lưu / Backup** và chờ hoàn tất.
3. Mở địa chỉ WebDAV trong trình duyệt, đăng nhập cùng tài khoản để xem file.

Tên menu có thể khác giữa các ứng dụng. Mật khẩu tài khoản dùng để backup khác với mã đăng nhập của người quản trị.

## 2. Xem và tìm backup

Trên máy tính, thanh bên trái chứa bộ lọc và thông tin dung lượng. Khu vực bên phải hiển thị danh sách file. Trên điện thoại, bộ lọc nằm phía trên danh sách.

| Bạn muốn | Thao tác |
| --- | --- |
| Xem toàn bộ file | Chọn **Tất cả** |
| Xem các file đang được ứng dụng sử dụng | Chọn **Bản hiện tại** |
| Xem những phiên bản cũ được giữ lại | Chọn **Lịch sử** |
| Tìm một file | Nhập tên file hoặc thư mục vào ô tìm kiếm; có thể gõ không dấu |
| Xem bản mới nhất trước | Chọn **Mới nhất trước** trong ô sắp xếp |
| Tìm file chiếm nhiều dung lượng | Chọn **Dung lượng lớn nhất** |
| Xem thêm file | Dùng mũi tên chuyển trang ở cuối danh sách; mỗi trang tối đa 20 file |
| Cập nhật danh sách sau khi backup | Bấm **Làm mới** |

Ngày giờ được hiển thị theo giờ Việt Nam.

## 3. Tải về và khôi phục

1. Chọn **Bản hiện tại** hoặc **Lịch sử**.
2. Kiểm tra tên file và ngày giờ của bản muốn lấy.
3. Bấm **Tải về**.
4. Trong ứng dụng, mở chức năng **Khôi phục / Nhập bản sao lưu** và chọn file vừa tải.

Tải file về không tự khôi phục dữ liệu trong ứng dụng. Bạn cần thực hiện bước khôi phục trong chính ứng dụng đó.

## 4. Hiểu về lịch sử backup

Khi ứng dụng gửi bản mới vào cùng tên file và thư mục, hệ thống giữ bản trước trong **Lịch sử**.

| Lần sao lưu | Bản hiện tại | Lịch sử |
| --- | --- | --- |
| Lần đầu | Bản đầu tiên | Chưa có |
| Lần thứ hai, cùng đường dẫn | Bản thứ hai | Giữ bản đầu tiên |
| Lần thứ ba, cùng đường dẫn | Bản thứ ba | Giữ hai bản trước |

- Ngày giờ của bản lịch sử là thời điểm bản đó được chuyển vào lịch sử.
- Nếu ứng dụng tự tạo tên file khác nhau mỗi lần, các file ấy vẫn nằm trong **Bản hiện tại**.
- Lịch sử **không tự xóa**. Bạn chủ động chọn những bản không cần giữ nữa.
- Mỗi bản lưu chiếm dung lượng riêng. Đặt tên theo ngày giờ không làm file nhỏ hơn.

## 5. Xóa backup và quản lý dung lượng

Bấm **Xóa** cạnh file, kiểm tra đúng tên rồi xác nhận. File bị xóa không có thùng rác để khôi phục.

Xóa một bản hiện tại không xóa các phiên bản cũ trong **Lịch sử**. Nếu muốn giải phóng thêm dung lượng, kiểm tra cả hai mục.

Nếu giao diện hiện **Kiểm tra lại**, bấm nút đó để xác nhận kết quả. Nếu đang xử lý, chờ một lúc rồi kiểm tra lại.

| Thông tin dung lượng | Ý nghĩa |
| --- | --- |
| Dung lượng đã dùng | Tổng dung lượng file hiện tại và lịch sử |
| Dung lượng còn trống | Chỗ còn lại để lưu backup tiếp theo |
| Giới hạn mỗi file | Kích thước tối đa của một bản upload, do admin thiết lập |

Dung lượng dùng đơn vị **MB và GB**, với **1 GB = 1.000 MB**. Mỗi file upload tối đa **100 MB**, hoặc thấp hơn nếu tài khoản được đặt giới hạn nhỏ hơn.

Ví dụ: một bản backup 75 MB và hai bản lịch sử cùng kích thước sẽ dùng khoảng **225 MB**. Khi hết chỗ, hãy xóa bản không cần hoặc nhờ admin tăng dung lượng.

## 6. Quản lý tài khoản dành cho admin

Mở địa chỉ trang quản trị được cung cấp và đăng nhập bằng mã quản trị.

### Tạo hoặc sửa tài khoản

| Trường | Điền gì? |
| --- | --- |
| Username | Tên tài khoản để đăng nhập trong app và trên web |
| Password | Mật khẩu tài khoản; khi sửa, để trống nếu muốn giữ mật khẩu cũ |
| Quota (MB) | Tổng dung lượng được dùng, bao gồm lịch sử |
| Max File (MB) | Dung lượng tối đa cho một file upload |

Bấm **Save User** để tạo tài khoản. Để sửa, mở **Thao tác → Sửa thông tin**, thay đổi các ô cần thiết rồi bấm **Update User**.

Ví dụ: với file backup 76,5 MB, có thể đặt **Max File = 95 MB** và chọn quota đủ cho số bản muốn giữ.

### Các thao tác khác

| Thao tác | Kết quả |
| --- | --- |
| **Mật khẩu** | Xem hoặc sao chép mật khẩu nếu tính năng đã được bật; cửa sổ tự đóng sau 30 giây |
| **Thao tác → Tạm khóa** | Ngăn tài khoản tiếp tục sử dụng WebDAV |
| **Thao tác → Mở khóa** | Cho phép tài khoản sử dụng lại |
| **Thao tác → Xóa tài khoản** | Xóa tài khoản cùng toàn bộ file và lịch sử |

Nếu chưa xem được mật khẩu, nhờ người thiết lập hệ thống bật tính năng này. Sau khi được bật, nhập lại mật khẩu trong **Sửa thông tin** một lần; có thể dùng lại mật khẩu hiện tại.

## 7. Khi gặp lỗi

| Thông báo / hiện tượng | Bạn nên làm gì? |
| --- | --- |
| Không đăng nhập được / lỗi 401 | Kiểm tra địa chỉ, tên tài khoản và mật khẩu; không dùng mã admin để backup |
| Không có quyền / lỗi 403 | Nhờ admin kiểm tra tài khoản có bị khóa không; nếu ở trang admin, thử đăng nhập lại |
| File quá lớn / lỗi 413 | Kiểm tra dung lượng file và giới hạn mỗi file của tài khoản; file trên 100 MB cần giảm dung lượng từ ứng dụng |
| Hết dung lượng / lỗi 507 | Xóa bớt lịch sử hoặc nhờ admin tăng quota |
| Không thể tạo thư mục backup | Kiểm tra có file trùng tên thư mục không; nếu vẫn lỗi, gửi thông báo cho admin |
| Đang xử lý / lỗi 503 khi xóa | Chờ một lúc, sau đó dùng **Kiểm tra lại** hoặc **Làm mới** |
| Backup xong nhưng chưa thấy file | Bấm **Làm mới**, chọn **Tất cả** và xóa nội dung ô tìm kiếm |
| Giao diện vẫn giống bản cũ | Tải lại trang hoặc đóng rồi mở lại trình duyệt |

Khi nhờ hỗ trợ, gửi tên ứng dụng và nội dung lỗi. Không gửi mật khẩu; che mật khẩu nếu xuất hiện trong ảnh.

---

Bạn muốn tự cài đặt hoặc cập nhật server? Xem [hướng dẫn dành cho người triển khai](docs/DEPLOYMENT.md).

Giấy phép MIT — xem [LICENSE](LICENSE).
