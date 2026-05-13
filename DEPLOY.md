# Deploy Vercel

Project nay dung Vite multi-page, giu nguyen HTML/CSS/JS hien tai.

## Vercel settings

- Root Directory: `TO-ic` neu ban import tu thu muc cha.
- Build Command: `npm run build`
- Output Directory: `dist`
- Install Command: `npm install`

## Firebase environment variables

Them cac bien nay trong Vercel Project Settings > Environment Variables:

- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_MEASUREMENT_ID`

Script `build-config.js` cung chap nhan ten bien co tien to `VITE_`, vi du `VITE_FIREBASE_API_KEY`.
