# Free Email Automation On Vercel

This path keeps Firebase on the free Spark plan. Firebase still stores users, streaks, notifications, and announcements. Vercel runs the backend mail worker and daily cron job for free on the Hobby plan.

## What Runs Where

- Frontend: Vite app on Vercel.
- Data: Firebase Auth + Firestore Spark.
- Mail worker: `api/mail-worker.js` on Vercel.
- Schedule: Vercel Cron calls `/api/mail-worker` every day at `13:00 UTC` (`20:00 Asia/Bangkok`).
- Sender: `azotatoeic@gmail.com` through a Gmail App Password.
- AI copywriter: Groq by default, Gemini also supported.

## Required Vercel Env Vars

Add these in Vercel Dashboard > Project > Settings > Environment Variables:

```bash
APP_BASE_URL=https://to-ic.vercel.app
AI_PROVIDER=groq
AI_MODEL=llama-3.3-70b-versatile
AI_API_KEY=your-groq-key
GMAIL_APP_PASSWORD=your-gmail-app-password
CRON_SECRET=make-a-random-string-at-least-16-chars
FIREBASE_SERVICE_ACCOUNT_B64=base64-encoded-service-account-json
MAX_EMAILS_PER_RUN=40
EMAIL_SEND_DELAY_MS=900
MAX_ANNOUNCEMENTS_PER_RUN=10
```

Use the Vercel dashboard for secrets. Do not prefix these with `VITE_`, and do not put real values in Git.

## Create Firebase Service Account Base64

1. Open Firebase Console > Project settings > Service accounts.
2. Click Generate new private key.
3. Save the JSON file somewhere outside the repo.
4. Convert it to base64:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\service-account.json"))
```

Put that output into `FIREBASE_SERVICE_ACCOUNT_B64` in Vercel.

## Daily Reminder

Vercel calls:

```text
/api/mail-worker
```

The route sends streak reminders to users who:

- have an email,
- did not complete a lesson today,
- have `emailPreferences.studyReminders !== false`,
- have not already received today's reminder.

## New Lesson Announcement

Create a Firestore document in `announcements`:

```json
{
  "courseTitle": "TOEIC Speaking - Writing Prep",
  "lessonTitle": "Read a Text Aloud - Lesson 03",
  "lessonUrl": "https://to-ic.vercel.app/pages/bai-hoc.html?course=noi-viet&lesson=sw-read-text-aloud-1",
  "summary": "Bài mới giúp luyện nhấn trọng âm, ngắt nhịp và đọc rõ câu ngắn.",
  "sendEmail": true
}
```

The next daily cron run will send it and mark the document as `sent`. To send announcements manually after deploy, open:

```text
https://to-ic.vercel.app/api/mail-worker?mode=announcements&secret=YOUR_CRON_SECRET
```

## Deploy

```bash
npm run build
```

Then redeploy on Vercel. Cron jobs only run on Production deployments.

## Notes

Vercel Hobby cron jobs are free, but they can run within the selected hour instead of at the exact minute. For this project, that means the 20:00 reminder may run sometime between 20:00 and 20:59 Vietnam time.
