// ============================================================================
//  Async Review — MVP  (role-aware: "reviewer" | "uploader")
//  Static frontend. Firestore = comment/video-registry DB. R2 = media storage.
//  No build step: ES modules from CDNs.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, addDoc, deleteDoc, doc,
  onSnapshot, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { AwsClient } from "https://cdn.jsdelivr.net/npm/aws4fetch@1.0.20/+esm";

const ROLE = window.APP_ROLE || "reviewer";

// ---------- logging ----------
// Everything important is logged with the "[review]" prefix so you can filter
// the browser console. If something breaks, open DevTools → Console, and either
// copy the red/orange lines OR run  copy(__reviewLogs())  to copy the full trace,
// then paste it back to me.
const LOG = [];
function log(...a) {
  const t = new Date().toISOString().slice(11, 19);
  const line = `[review ${t}] ` + a.map((x) => (x && typeof x === "object") ? safeJson(x) : String(x)).join(" ");
  LOG.push(line); console.log("%c" + line, "color:#6c7bff");
}
function logErr(label, e) {
  const line = `[review ERROR] ${label}: ${(e && e.message) || e}`;
  LOG.push(line); console.error(line, e || "");
}
function safeJson(x){ try { return JSON.stringify(x); } catch { return "[unserializable]"; } }
window.__reviewLogs = () => LOG.join("\n");
window.addEventListener("error", (e) => logErr("window.onerror", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => logErr("unhandledrejection", e.reason));
log("boot", { role: ROLE, ua: navigator.userAgent });

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s/60), r = s%60; return `${m}:${String(r).padStart(2,"0")}`; };
const bytes = (n) => n > 1e9 ? (n/1e9).toFixed(2)+" GB" : n > 1e6 ? (n/1e6).toFixed(1)+" MB" : (n/1e3).toFixed(0)+" KB";
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (m)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
function banner(msg, kind="") {
  const b = $("banner"); if (!b) return;
  b.textContent = msg; b.className = "banner " + kind;
  clearTimeout(banner._t);
  banner._t = setTimeout(()=>b.classList.add("hidden"), kind==="err"?8000:3500);
  b.classList.remove("hidden");
}

// ---------- config ----------
const FB = window.FIREBASE_CONFIG || {};
const R2 = window.R2_CONFIG || {};
const configured = FB.apiKey && FB.apiKey !== "PASTE_ME";
const r2Ready = R2.accessKeyId && R2.accessKeyId !== "PASTE_ME";

log("config status", { firebaseConfigured: !!configured, r2Configured: !!r2Ready, projectId: FB.projectId, bucket: R2.bucket, publicBaseUrl: R2.publicBaseUrl });
let db = null;
if (!configured) {
  logErr("config", "Firebase not configured (config.js still has PASTE_ME)");
  banner("Firebase isn't configured yet — edit config.js (see README). UI loads but nothing saves.", "err");
} else {
  try { db = getFirestore(initializeApp(FB)); log("firebase initialized"); }
  catch (e) { logErr("firebase init", e); banner("Firebase init failed: " + e.message, "err"); }
}
if (!r2Ready) logErr("config", "R2 not configured (config.js still has PASTE_ME) — uploads/audio will not work");
const aws = r2Ready
  ? new AwsClient({ accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey, service: "s3", region: "auto" })
  : null;

// ---------- shared state ----------
let me = localStorage.getItem("review_name") || "";
let videos = [], currentVideo = null;
let comments = [], unsubComments = null;
let pinnedTime = 0, followPlayhead = true;

// ===========================================================================
//  NAME GATE  (shared)
// ===========================================================================
function showApp() {
  $("name-gate").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("who-name").textContent = me;
  initVideos();
}
if (me && $("name-input")) $("name-input").value = me;
$("name-form").addEventListener("submit", (e)=>{
  e.preventDefault();
  const v = $("name-input").value.trim(); if (!v) return;
  me = v; localStorage.setItem("review_name", me); showApp();
});
$("change-name").addEventListener("click", ()=>{
  $("app").classList.add("hidden"); $("name-gate").classList.remove("hidden"); $("name-input").focus();
});
if (me) showApp();

// ===========================================================================
//  VIDEO REGISTRY  (shared — lives in Firestore, seedable from config)
// ===========================================================================
function seedVideos() {
  return (window.SEED_VIDEOS || []).map((v,i)=>({ id:"seed-"+i, title:v.title, url:v.url, seed:true }));
}
function initVideos() {
  videos = seedVideos();
  renderVideoUI();
  if (!db) return;
  const qv = query(collection(db, "videos"), orderBy("createdAt", "asc"));
  log("subscribing to videos collection…");
  onSnapshot(qv, (snap)=>{
    const fromDb = snap.docs.map((d)=>({ id:d.id, ...d.data() }));
    const dbUrls = new Set(fromDb.map((v)=>v.url));
    videos = [...seedVideos().filter((v)=>!dbUrls.has(v.url)), ...fromDb];
    log("videos snapshot", { total: videos.length, fromDb: fromDb.length });
    renderVideoUI();
    if (ROLE === "reviewer" && !currentVideo && videos.length) selectVideo(videos[0].id);
  }, (err)=>{ logErr("videos snapshot", err); banner("Couldn't load videos: "+err.message, "err"); });
}
function renderVideoUI() {
  if (ROLE === "reviewer") renderVideoSelect();
  else renderLibrary();
}

// ===========================================================================
//  REVIEWER  — player + timeline + comments
// ===========================================================================
if (ROLE === "reviewer") {
  const video = $("video"), track = $("track"), progress = $("progress");

  window.renderVideoSelect = function () {
    const sel = $("video-select"); sel.innerHTML = "";
    if (!videos.length) {
      $("video-empty").classList.remove("hidden"); $("video-wrap").classList.add("hidden");
      const o=document.createElement("option"); o.textContent="— no videos —"; sel.appendChild(o); return;
    }
    videos.forEach((v)=>{
      const o=document.createElement("option"); o.value=v.id; o.textContent=v.title||v.url;
      if (currentVideo && v.id===currentVideo.id) o.selected=true; sel.appendChild(o);
    });
  };
  $("video-select").addEventListener("change",(e)=>{ if(e.target.value) selectVideo(e.target.value); });

  window.selectVideo = function (id) {
    const v = videos.find((x)=>x.id===id); if(!v) return;
    currentVideo = v;
    log("selectVideo", { title: v.title, url: v.url });
    $("video-empty").classList.add("hidden"); $("video-wrap").classList.remove("hidden");
    video.src = v.url; video.load();
    pinnedTime = 0; updateStamp(); subscribeComments(v); renderVideoSelect();
  };

  // player controls
  $("play").addEventListener("click",()=> video.paused?video.play():video.pause());
  video.addEventListener("play",()=>$("play").textContent="⏸");
  video.addEventListener("pause",()=>$("play").textContent="▶");
  $("mute").addEventListener("click",()=>{ video.muted=!video.muted; $("mute").textContent=video.muted?"🔇":"🔊"; });
  video.addEventListener("timeupdate",()=>{
    const d=video.duration||0;
    progress.style.width = d ? (video.currentTime/d)*100+"%" : "0%";
    $("time").textContent = `${fmt(video.currentTime)} / ${fmt(d)}`;
    if (followPlayhead){ pinnedTime=video.currentTime; updateStamp(); }
    highlightActiveComment();
  });
  video.addEventListener("loadedmetadata",()=>{ $("time").textContent=`0:00 / ${fmt(video.duration)}`; renderMarkers(); });
  video.addEventListener("error",()=>{ if(currentVideo){ logErr("video load", `code=${video.error&&video.error.code} src=${video.currentSrc}`); banner("Video failed to load. Check the R2 URL is public and CORS allows this site.","err"); } });
  track.addEventListener("click",(e)=>{ const r=track.getBoundingClientRect(); const p=(e.clientX-r.left)/r.width; if(video.duration) video.currentTime=p*video.duration; });
  $("follow-toggle").addEventListener("change",(e)=>followPlayhead=e.target.checked);
  $("use-current").addEventListener("click",()=>{ pinnedTime=video.currentTime; updateStamp(); });

  window.updateStamp = ()=> $("stamp").textContent = fmt(pinnedTime);
  window.renderMarkers = function () {
    const box=$("markers"); box.innerHTML=""; const d=video.duration||0; if(!d) return;
    comments.forEach((c)=>{ const m=document.createElement("div"); m.className="marker"; m.style.left=(c.t/d)*100+"%";
      m.title=`${c.author} @ ${fmt(c.t)}`; m.addEventListener("click",(ev)=>{ev.stopPropagation(); video.currentTime=c.t;}); box.appendChild(m); });
  };

  // comments
  window.subscribeComments = function (v) {
    if (unsubComments){ unsubComments(); unsubComments=null; }
    comments=[]; renderComments();
    if (!db) return;
    const key = v.seed ? ("url:"+v.url) : v.id;
    const qc = query(collection(db,"comments"), where("videoId","==",key), orderBy("t","asc"));
    log("subscribing to comments", { videoKey: key });
    unsubComments = onSnapshot(qc,(snap)=>{ comments=snap.docs.map((d)=>({id:d.id,...d.data()})); log("comments snapshot", { count: comments.length }); renderComments(); renderMarkers(); },
      (err)=>{ logErr("comments snapshot", err); banner("Couldn't load comments: "+err.message,"err"); });
  };
  const videoKey = ()=> currentVideo.seed ? ("url:"+currentVideo.url) : currentVideo.id;

  window.renderComments = function () {
    const list=$("comment-list"); list.innerHTML="";
    $("comment-count").textContent = `${comments.length} comment${comments.length===1?"":"s"}`;
    if (!comments.length){ list.innerHTML=`<div class="empty-note">No comments yet.<br>Scrub to a moment and leave the first one.</div>`; return; }
    comments.forEach((c)=>{
      const el=document.createElement("div"); el.className="comment"; el.dataset.t=c.t; el.dataset.id=c.id;
      const when=c.createdAt?.toDate ? c.createdAt.toDate().toLocaleString() : "";
      const mine=c.author===me;
      el.innerHTML=`
        <div class="c-top">
          <span class="c-author">${escapeHtml(c.author)}</span>
          <span class="c-when">${when}</span>
          <span class="c-stamp" title="Jump to ${fmt(c.t)}">${fmt(c.t)}</span>
          ${mine?'<button class="c-del" title="Delete">✕</button>':""}
        </div>
        ${c.text?`<div class="c-text">${escapeHtml(c.text)}</div>`:""}
        ${c.audioUrl?`<audio class="c-audio" controls preload="none" src="${c.audioUrl}"></audio>`:""}`;
      el.querySelector(".c-stamp").addEventListener("click",()=>video.currentTime=c.t);
      const del=el.querySelector(".c-del");
      if(del) del.addEventListener("click",async()=>{ try{ await deleteDoc(doc(db,"comments",c.id)); }catch(e){ banner("Delete failed: "+e.message,"err"); }});
      list.appendChild(el);
    });
  };
  window.highlightActiveComment = function () {
    const t=video.currentTime; let active=null;
    comments.forEach((c)=>{ if(c.t<=t+0.3) active=c.id; });
    document.querySelectorAll(".comment").forEach((el)=>el.classList.toggle("active", el.dataset.id===active));
  };

  // send comment (text and/or audio)
  let pendingAudioBlob=null;
  $("send-btn").addEventListener("click",async()=>{
    if(!currentVideo){ banner("Pick a video first.","err"); return; }
    if(!db){ banner("Firebase not configured — can't save.","err"); return; }
    const text=$("comment-text").value.trim();
    if(!text && !pendingAudioBlob){ banner("Write something or record a note.","err"); return; }
    const btn=$("send-btn"); btn.disabled=true; btn.textContent="Posting…";
    try{
      let audioUrl=null;
      if(pendingAudioBlob){ log("posting comment with audio", { bytes: pendingAudioBlob.size }); audioUrl=await uploadToR2(pendingAudioBlob, audioKey(videoKey()), pendingAudioBlob.type||"audio/webm"); }
      await addDoc(collection(db,"comments"),{
        videoId:videoKey(), videoUrl:currentVideo.url, author:me,
        t:Math.round(pinnedTime*10)/10, text:text||"", audioUrl, createdAt:serverTimestamp(),
      });
      log("comment posted", { t: Math.round(pinnedTime*10)/10, hasAudio: !!audioUrl });
      $("comment-text").value=""; clearAudio(); banner("Comment posted.","ok");
    }catch(e){ logErr("post comment", e); banner("Post failed: "+e.message,"err"); }
    finally{ btn.disabled=false; btn.textContent="Comment"; }
  });

  // audio recording
  let mediaRecorder=null, chunks=[], recStream=null, recTimer=null, recStart=0;
  $("record-btn").addEventListener("click",async()=>{
    if(mediaRecorder && mediaRecorder.state==="recording"){ stopRecording(); return; }
    if(!r2Ready){ banner("R2 isn't configured — can't store audio (see README).","err"); return; }
    try{ recStream=await navigator.mediaDevices.getUserMedia({audio:true}); }
    catch(e){ banner("Mic access denied or unavailable.","err"); return; }
    chunks=[];
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
               : (MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "");
    mediaRecorder = new MediaRecorder(recStream, mime?{mimeType:mime,audioBitsPerSecond:32000}:undefined);
    mediaRecorder.ondataavailable=(e)=>{ if(e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop=()=>{
      pendingAudioBlob=new Blob(chunks,{type:mediaRecorder.mimeType||"audio/webm"});
      const a=$("audio-preview"); a.src=URL.createObjectURL(pendingAudioBlob); a.classList.remove("hidden");
      recStream.getTracks().forEach((t)=>t.stop());
    };
    mediaRecorder.start(); recStart=Date.now();
    $("record-btn").textContent="■ Stop"; $("record-btn").classList.add("recording");
    const st=$("record-status"); st.classList.remove("hidden"); st.classList.add("rec-live");
    recTimer=setInterval(()=>{ const s=(Date.now()-recStart)/1000; st.textContent="recording "+fmt(s);
      if(s>=(window.AUDIO_SAFETY_STOP_SECONDS||900)){ banner("Safety stop reached.",""); stopRecording(); } },250);
  });
  function stopRecording(){
    if(mediaRecorder && mediaRecorder.state==="recording") mediaRecorder.stop();
    clearInterval(recTimer);
    $("record-btn").textContent="● Record"; $("record-btn").classList.remove("recording");
    const st=$("record-status"); st.classList.remove("rec-live"); st.classList.add("hidden");
  }
  function clearAudio(){ pendingAudioBlob=null; chunks=[]; const a=$("audio-preview"); a.src=""; a.classList.add("hidden"); }
}

// ===========================================================================
//  UPLOADER  — upload video files to R2, register + list
// ===========================================================================
if (ROLE === "uploader") {
  window.renderLibrary = function () {
    const lib=$("library"); lib.innerHTML="";
    const real = videos.filter((v)=>!v.seed);
    $("lib-count").textContent = `${videos.length} video${videos.length===1?"":"s"}`;
    if(!videos.length){ lib.innerHTML=`<div class="empty-note">Nothing uploaded yet.</div>`; return; }
    videos.forEach((v)=>{
      const el=document.createElement("div"); el.className="lib-item";
      el.innerHTML=`
        <div class="li-main">
          <div class="li-title">${escapeHtml(v.title||v.url)}</div>
          <div class="li-url">${escapeHtml(v.url)}</div>
        </div>
        ${v.seed?'<span class="li-tag">from config</span>':'<button class="c-del" title="Remove from library">✕</button>'}`;
      const del=el.querySelector(".c-del");
      if(del) del.addEventListener("click",async()=>{
        try{ await deleteDoc(doc(db,"videos",v.id)); banner("Removed from library (R2 file itself is not deleted).","ok"); }
        catch(e){ banner("Remove failed: "+e.message,"err"); }
      });
      lib.appendChild(el);
    });
  };

  const dz=$("dropzone"), input=$("file-input");
  ["dragenter","dragover"].forEach((ev)=>dz.addEventListener(ev,(e)=>{e.preventDefault();dz.classList.add("drag");}));
  ["dragleave","drop"].forEach((ev)=>dz.addEventListener(ev,(e)=>{e.preventDefault();dz.classList.remove("drag");}));
  dz.addEventListener("drop",(e)=>handleFiles(e.dataTransfer.files));
  input.addEventListener("change",(e)=>{ handleFiles(e.target.files); input.value=""; });

  function handleFiles(fileList) {
    if(!r2Ready){ banner("R2 isn't configured — edit config.js (see README).","err"); return; }
    if(!db){ banner("Firebase not configured — edit config.js.","err"); return; }
    [...fileList].filter((f)=>f.type.startsWith("video/")).forEach(uploadVideo);
  }

  async function uploadVideo(file) {
    const row=document.createElement("div"); row.className="up-row";
    row.innerHTML=`<div class="ur-top"><span class="ur-name">${escapeHtml(file.name)}</span><span class="ur-pct">0%</span></div>
      <div class="ur-bar"><div class="ur-fill"></div></div><div class="ur-sub muted">${bytes(file.size)}</div>`;
    $("upload-queue").prepend(row);
    const fill=row.querySelector(".ur-fill"), pct=row.querySelector(".ur-pct"), sub=row.querySelector(".ur-sub");
    try{
      const key=`videos/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;
      log("upload start", { name: file.name, size: file.size, type: file.type, key });
      const url=await uploadToR2(file, key, file.type||"video/mp4", (p)=>{ fill.style.width=p+"%"; pct.textContent=p+"%"; });
      await addDoc(collection(db,"videos"),{ title:file.name.replace(/\.[^.]+$/,""), url, createdAt:serverTimestamp(), addedBy:me, size:file.size });
      log("upload done + registered", { url });
      pct.textContent="done"; fill.style.width="100%"; row.classList.add("ok"); sub.textContent="Available to reviewers.";
    }catch(e){ logErr("upload video", e); row.classList.add("err"); pct.textContent="failed"; sub.textContent=e.message; }
  }
}

// ===========================================================================
//  R2 UPLOAD  (shared)  — signed-query URL + XHR so we get progress events
// ===========================================================================
function audioKey(vk){ return `audio/${vk.replace(/[^a-zA-Z0-9._-]/g,"_")}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.webm`; }

async function uploadToR2(blob, key, contentType, onProgress) {
  if (!aws) throw new Error("R2 not configured");
  const endpoint = `https://${R2.accountId}.r2.cloudflarestorage.com/${R2.bucket}/${key}`;
  // Sign as a presigned URL (signature in query string) so a plain XHR PUT works
  // and we can attach an upload progress listener.
  let signedUrl;
  try {
    const signed = await aws.sign(endpoint, { method: "PUT", headers: { "Content-Type": contentType }, aws: { signQuery: true } });
    signedUrl = signed.url;
    log("R2 presigned PUT ready", { host: new URL(endpoint).host, key });
  } catch (e) { logErr("R2 sign", e); throw e; }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl, true);
    xhr.setRequestHeader("Content-Type", contentType);
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded/e.total)*100)); };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const publicUrl = `${R2.publicBaseUrl.replace(/\/$/,"")}/${key}`;
        log("R2 PUT ok", { status: xhr.status, publicUrl });
        resolve(publicUrl);
      } else {
        logErr("R2 PUT", `status=${xhr.status} body=${String(xhr.responseText||"").slice(0,200)}`);
        reject(new Error(`R2 upload ${xhr.status}. Check R2 creds + bucket CORS. ${String(xhr.responseText||"").slice(0,120)}`));
      }
    };
    xhr.onerror = () => { logErr("R2 PUT", "network/CORS error"); reject(new Error("R2 upload network error — usually a CORS/config issue on the bucket.")); };
    xhr.send(blob);
  });
}
