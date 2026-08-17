# Async Review — internal UAT tool (MVP)

A lightweight, self-hosted stand-in for flask.do for internal async user-acceptance
testing. Upload videos, leave **timestamped text and voice comments**, review async.

**Stack (all free):**
- **Frontend:** static HTML/CSS/JS, no build step → deployed on Vercel.
- **Videos + voice notes:** Cloudflare R2 (free tier: 10 GB storage, egress free).
- **Comments + video registry:** Firebase Firestore (free Spark plan).
- **Auth:** none — users just type a name. Access is gated only by the unguessable URL.

**Two routes:**
- `/uploader` — upload video files (straight to R2) and manage the library.
- `/reviewer` — watch any video, leave timeline comments. Share this with stakeholders.

---

## ⚠️ Read this first (security + cost)

- **R2 credentials live in `config.js`, which ships to every visitor's browser.** Anyone
  who loads the page can read them and read/write/delete objects **in this one bucket**.
  This was a deliberate choice for a tiny, short-lived internal tool. To keep the blast
  radius contained: **create an R2 API token scoped to ONLY this bucket** (Step 4), never
  an account-wide key, and **delete that token when the UAT cycle ends**.
- **Firestore rules below are fully open** (anyone with the URL can read/write comments).
  Fine for a throwaway internal tool; do not reuse this project for anything sensitive.
- **Cost:** 5×1 GB videos = ~5 GB, half of R2's free 10 GB; egress is free. Firestore free
  tier is far more than a few reviewers generate. You should stay at $0, but confirm your
  own usage — I can't guarantee Cloudflare/Google won't change free tiers.

---

## Step 1 — Get the code onto GitHub

```bash
cd async-review          # the folder these files are in
git init
git add .
git commit -m "Async review MVP"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<you>/async-review.git
git push -u origin main
```

## Step 2 — Firebase (Firestore) for comments

1. Go to https://console.firebase.google.com → **Add project** (disable Analytics, you don't need it).
2. **Build → Firestore Database → Create database** → start in **production mode** → pick a region.
3. Firestore **Rules** tab → paste this and **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if true;   // open: gated only by the unguessable URL
       }
     }
   }
   ```

4. Project **Settings (gear) → General → Your apps → Web (`</>`)** → register an app →
   copy the `firebaseConfig` object.
5. Paste those values into **`config.js`** (`window.FIREBASE_CONFIG`).

> No indexes needed for the MVP. If the browser console ever shows a "create index" link
> for a query, just click it once.

## Step 3 — Cloudflare R2 bucket for media

1. https://dash.cloudflare.com → **R2**. (Activating R2 asks for a payment method even on
   the free tier; you won't be charged under the free limits.)
2. **Create bucket** — e.g. `uat-review`. Note the name.
3. Open the bucket → **Settings → Public access → R2.dev subdomain → Allow**. Copy the
   public URL, e.g. `https://pub-xxxxxxxx.r2.dev`. This is `publicBaseUrl` in `config.js`.
4. Find your **Account ID**: R2 overview page (right sidebar) → this is `accountId`.
5. Bucket → **Settings → CORS policy → Add**, paste (replace the origins with your real
   Vercel domain; keep localhost for local testing):

   ```json
   [
     {
       "AllowedOrigins": [
         "https://YOUR-PROJECT.vercel.app",
         "http://localhost:8000"
       ],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

## Step 4 — R2 API token (scoped to ONE bucket)

1. R2 → **Manage R2 API Tokens → Create API token**.
2. **Permissions: Object Read & Write.**
3. **Specify bucket** → choose **only** `uat-review`. (Do NOT leave it account-wide.)
4. Create → copy the **Access Key ID** and **Secret Access Key** (shown once).
5. Put them + `accountId`, `bucket`, `publicBaseUrl` into **`config.js`** (`window.R2_CONFIG`).

Your `config.js` is now fully filled in. Commit it:

```bash
git add config.js && git commit -m "Configure Firebase + R2" && git push
```

## Step 5 — Deploy on Vercel

1. https://vercel.com → **Add New → Project → Import** your GitHub repo.
2. Framework preset: **Other**. No build command, no output dir — it's static.
3. **Deploy.** You'll get `https://your-project.vercel.app`.
4. **Go back to Step 3.5 CORS** and make sure your real Vercel domain is in `AllowedOrigins`.
   Re-save the CORS policy if you had a placeholder.

## Step 6 — Use it

- **You:** open `https://your-project.vercel.app/uploader`, drop in your `.mp4`s.
- **Stakeholders:** send them `https://your-project.vercel.app/reviewer`.
- They enter a name, pick a video, scrub to a moment, and leave a text or voice comment.
  Comments appear live for everyone and are pinned to the timeline.

---

## Local testing (optional)

```bash
cd async-review
python3 -m http.server 8000
# open http://localhost:8000/reviewer.html  and  /uploader.html
```
(Locally the clean `/reviewer` URL isn't rewritten — use the `.html` names. On Vercel the
clean URLs work.) Keep `http://localhost:8000` in the R2 CORS list while testing.

## Cleanup when you're done (~30 days)

- **Kill credentials:** Cloudflare → R2 → Manage API Tokens → **delete** the token.
- **Delete media:** R2 → the bucket → delete objects (or delete the bucket).
- **Delete comments:** Firebase console → Firestore → delete the `comments` and `videos`
  collections, or just delete the whole Firebase project.

## Data model (for reference)

`videos` (Firestore): `{ title, url, createdAt, addedBy, size }`
`comments` (Firestore): `{ videoId, videoUrl, author, t (seconds), text, audioUrl, createdAt }`
Media objects in R2: `videos/<ts>-<name>.mp4`, `audio/<videoKey>/<ts>-<rand>.webm`

## Known MVP limitations

- No auth — anyone with the link can view/comment. By design.
- R2 creds are client-side (see security note). By design, for this short-lived tool.
- Voice notes need a Chromium-based browser or Safari (uses `MediaRecorder`). No transcription.
- Video upload is a single PUT — fine up to ~1 GB; very large files on flaky connections
  may need a retry. Multipart upload was left out to keep the MVP simple.
- Deleting a video from the library removes it from the list but does **not** delete the
  file from R2 (clean R2 up manually at the end).
