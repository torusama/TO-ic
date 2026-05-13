# 🛡️ Firebase Security Guide (Safe as possible)

Để bảo mật tối đa cho dự án TOEIC của mày, hãy copy và dán các bộ luật dưới đây vào Console của Firebase.

## 1. Cloud Firestore Rules
Vào **Firebase Console > Firestore Database > Rules** và dán đoạn này vào:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 1. Chỉ cho phép người dùng đã đăng nhập đọc/ghi dữ liệu của chính họ
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      
      // 2. Bảo mật các sub-collections (hoạt động, bài học đã xong, thông báo)
      match /{allSubcollections=**} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

## 2. Authorized Domains
Đây là lớp chặn "ăn cắp" API Key. Dù ai có lấy được mã của mày, họ cũng không thể chạy nó trên website khác.

1. Vào **Firebase Console > Authentication > Settings > Authorized Domains**.
2. Đảm bảo chỉ có các tên miền sau được phép:
   - `localhost` (để mày code máy cá nhân)
   - `127.0.0.1`
   - `to-ic.vercel.app` (tên miền thật của mày trên Vercel)

## 3. GitHub & Deployment (Vercel)
Vì tao đã cho `firebase-config.js` vào `.gitignore`, khi mày push lên GitHub nó sẽ **không** hiện lên đó.

**Cách chạy trên Vercel:**
1. Khi mày import project vào Vercel, web sẽ bị lỗi (vì thiếu file config).
2. Mày nên dùng một công cụ build (như Vite) để dùng Environment Variables. 
3. **Mẹo đơn giản cho hiện tại:** Nếu mày dùng GitHub Private (Kho riêng tư), mày có thể bỏ `assets/js/firebase-config.js` ra khỏi `.gitignore` để Vercel tự nhận diện. Nếu mày để GitHub Public (Công khai), mày **bắt buộc** phải giữ trong `.gitignore` và tìm cách inject file này lúc deploy.

---
### ⚠️ Lời khuyên cuối cùng:
Nếu mày để repo này ở chế độ **Private (Riêng tư)** trên GitHub, mày cứ để file `firebase-config.js` bình thường để deploy cho dễ. Lớp bảo mật quan trọng nhất vẫn là **Firestore Rules** và **Authorized Domains** tao ghi ở trên.
