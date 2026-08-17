// ============================================================================
//  CONFIG  —  fill this in once, then never touch it again.
//  This is the ONLY file you need to edit to get the app running.
// ============================================================================

// 1) Firebase web-app config (for the comment database, Firestore).
//    Firebase console -> Project settings -> "Your apps" -> Web app -> Config.
//    (See README.md, "Step 2".)
window.FIREBASE_CONFIG = {
  apiKey: "PASTE_ME",
  authDomain: "PASTE_ME.firebaseapp.com",
  projectId: "PASTE_ME",
  storageBucket: "PASTE_ME.appspot.com",
  messagingSenderId: "PASTE_ME",
  appId: "PASTE_ME",
};

// 2) Cloudflare R2 — used to store VOICE NOTES (audio) uploaded from the browser.
//    (Videos are uploaded to R2 by you manually; audio is uploaded by the app.)
//
//    ⚠️ SECURITY: these credentials ship to every visitor's browser. Mint a token
//    scoped to THIS ONE BUCKET only (never an account-wide key), and DELETE the
//    token when the UAT cycle is done. See README.md, "Step 3" + "Step 4".
window.R2_CONFIG = {
  accountId:       "PASTE_ME",          // Cloudflare account ID
  accessKeyId:     "PASTE_ME",          // R2 API token — Access Key ID
  secretAccessKey: "PASTE_ME",          // R2 API token — Secret Access Key
  bucket:          "uat-review",        // the bucket name you created
  // Public base URL for playback (bucket's r2.dev URL or your custom domain),
  // NO trailing slash. e.g. https://pub-xxxxxxxx.r2.dev
  publicBaseUrl:   "https://pub-PASTE_ME.r2.dev",
};

// 3) (Optional) Pre-load videos so the app isn't empty on first launch.
//    You can also add videos from inside the app — they save to Firestore and
//    are shared with everyone. Each URL is a PUBLIC R2 object URL.
window.SEED_VIDEOS = [
  // { title: "April Campaign — Brand Animation v2", url: "https://pub-xxxxxxxx.r2.dev/brand-animation-v2.mp4" },
];

// 4) Safety stop for voice notes, in seconds. NOT a hard feature limit — just a
//    backstop so a forgotten recording can't run forever and eat storage.
//    Set high (default 15 min). Real notes will be ~3 min or less.
window.AUDIO_SAFETY_STOP_SECONDS = 15 * 60;
