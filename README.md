# Async Review — internal UAT tool (MVP)

A lightweight self-hosted stand-in for flask.do for internal async user-acceptance
testing. Upload videos, leave **timestamped text and voice comments**, review async.

**Stack (all free, ONE service):**
- **Frontend:** static HTML/CSS/JS, no build step → Vercel.
- **Everything else (videos, voice notes, comments):** Cloudflare R2. No database.
- **Auth:** none — users type a name. Access gated only by the unguessable URL.
- **Sync:** none/realtime-free by design. Data loads on page load; hit **↻ refresh**
  (or reload the page) to pull the latest comments.

**Two routes:** `/uploader` (upload videos) and `/reviewer` (watch + comment). Share
`/reviewer` with stakeholders.

---

## ⚠️ Read first (security + cost)
- **R2 credentials live in `config.js`, served to every visitor.** Anyone with the URL
  can read/write/delete objects **in this one bucket**. Deliberate choice for a tiny,
  short-lived tool. Mitigate: mint a token **scoped to only this bucket** (Step 3), and
  **delete it when done**.
- **Cost:** 5×1 GB videos ≈ 5 GB of R2's free 10 GB; egress is free; reads/writes are far
  under the free op limits. Should be $0 — confirm your own usage.

---

## Step 1 — Push the code (repo already has a first commit)
```bash
cd async-uat
git remote add origin https://github.com/<you>/async-uat.git   # if not set
git branch -M main && git push -u origin main
```
Make the repo **private** (once `config.js` has your keys, they're in the repo).

## Step 2 — Create the Cloudflare R2 bucket
1. https://dash.cloudflare.com → **R2 Object Storage → Enable** (asks for a payment method;
   free under the limits, you won't be charged).
2. **Create bucket** → name `uat-review`, location Automatic.
3. Bucket → **Settings → Public Development URL → Enable** → copy `https://pub-xxxx.r2.dev`.
4. Bucket → **Settings → CORS Policy → Add** → paste (swap in your real Vercel domain):
   ```json
   [
     {
       "AllowedOrigins": ["https://YOUR-PROJECT.vercel.app", "http://localhost:8000"],
       "AllowedMethods": ["GET", "PUT", "HEAD", "DELETE"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   (This same policy covers both the `r2.dev` reads and the S3-API writes/lists/deletes.)

## Step 3 — Create a bucket-scoped API token
1. R2 → **Manage R2 API Tokens → Create API token**.
2. Permissions: **Object Read & Write**.
3. **Specify bucket → only `uat-review`** (never account-wide).
4. Copy the **Access Key ID** + **Secret Access Key**. Get your **Account ID** from the
   R2 overview page.

## Step 4 — Fill `config.js`
Put `accountId`, `accessKeyId`, `secretAccessKey`, `bucket`, and `publicBaseUrl`
(the `pub-xxxx.r2.dev` URL) into `window.R2_CONFIG`. Commit + push.

## Step 5 — Deploy on Vercel
1. https://vercel.com → **Add New → Project → Import** the repo.
2. Framework: **Other**. No build command / output dir (it's static). **Deploy.**
3. Add the resulting `*.vercel.app` domain to the R2 CORS `AllowedOrigins` (Step 2.4) and re-save.

## Step 6 — Use it
- You: `https://your-project.vercel.app/uploader` → drop in `.mp4`s.
- Stakeholders: `https://your-project.vercel.app/reviewer` → name, pick a video, comment.
- Comments don't live-update; click **↻ refresh** to pull the latest.

## Local testing
```bash
cd async-uat && python3 -m http.server 8000
# open http://localhost:8000/reviewer.html  and  /uploader.html
```
Keep `http://localhost:8000` in the R2 CORS list.

## Cleanup (~30 days)
- Delete the R2 API token, then delete the bucket (removes all videos, audio, comments).

## Data model (all in R2)
- `data/videos.json` — array of `{ id, title, url, addedBy, createdAt, size }`
- `data/comments/<videoId>/<id>.json` — `{ id, videoId, author, t, text, audioUrl, createdAt }`
- `videos/<ts>-<name>.mp4`, `audio/<videoId>/<id>.webm`

## Debugging
Console is prefixed `[review]`. If something breaks, open DevTools → Console and run
`copy(__reviewLogs())`, then paste the output to me.

## Known limitations
No auth; creds client-side; no realtime (refresh to update); single-PUT upload (~1 GB
ceiling); voice notes need Chromium/Safari; library delete removes the registry row but
not the R2 file; the videos registry is read-modify-write, so two people uploading at the
exact same second could clobber one entry (fine for single-uploader use).
