// ============================================================================
//  CONFIG  —  fill this in once. This is the ONLY file you edit.
//  Everything (videos, voice notes, AND comments) is stored in Cloudflare R2.
//  No Firebase / database needed.
// ============================================================================

// Cloudflare R2 — stores videos, voice notes, and comment JSON.
//
// ⚠️ SECURITY: these credentials ship to every visitor's browser. Mint a token
// scoped to THIS ONE BUCKET only (never account-wide), and DELETE it when the
// UAT cycle is done. See README.md.
window.R2_CONFIG = {
  accountId:       "ef2aa4555cb03bb3865c5e8cbb3ea393",
  accessKeyId:     "f0b16bba504ff85f38b8307bbeb13128",
  secretAccessKey: "a6526c244064fd54650d783b32db4d3866af8c32ed4bb96656c14817b9b34c70",
  bucket:          "mohit-async-uat-tool",
  publicBaseUrl:   "https://pub-6b5e642e03734b178a639cab64ac31a2.r2.dev",
};

// (Optional) Pre-load videos so the app isn't empty. You can also add them in the
// uploader UI. Each URL is a public R2 object URL.
window.SEED_VIDEOS = [
  // { title: "April Campaign v2", url: "https://pub-xxxx.r2.dev/videos/clip.mp4" },
];

// Safety backstop for voice notes, in seconds (not a feature limit — just stops a
// forgotten recording from running forever). Default 15 min.
window.AUDIO_SAFETY_STOP_SECONDS = 15 * 60;
