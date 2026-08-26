// ============================================================================
//  Async Review — MVP  (role-aware: "reviewer" | "uploader")
//  Static frontend. Cloudflare R2 stores EVERYTHING: videos, voice notes, and
//  comments (as JSON objects). No database. Data loads fresh on page load /
//  refresh — no realtime sync (by design).
// ============================================================================

import { AwsClient } from "https://cdn.jsdelivr.net/npm/aws4fetch@1.0.20/+esm";

const ROLE = window.APP_ROLE || "reviewer";

// ---------- logging ----------
// Filter the browser console by "[review]". If something breaks: DevTools →
// Console → copy the red lines, or run  copy(__reviewLogs())  and paste to me.
const LOG = [];
function log(...a){ const t=new Date().toISOString().slice(11,19); const line=`[review ${t}] `+a.map((x)=>(x&&typeof x==="object")?safeJson(x):String(x)).join(" "); LOG.push(line); console.log("%c"+line,"color:#6c7bff"); }
function logErr(label,e){ const line=`[review ERROR] ${label}: ${(e&&e.message)||e}`; LOG.push(line); console.error(line,e||""); }
function safeJson(x){ try{return JSON.stringify(x);}catch{return "[unserializable]";} }
window.__reviewLogs = () => LOG.join("\n");
window.addEventListener("error",(e)=>logErr("window.onerror",e.error||e.message));
window.addEventListener("unhandledrejection",(e)=>logErr("unhandledrejection",e.reason));
log("boot",{ role: ROLE, ua: navigator.userAgent });

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const fmt = (s) => { s=Math.max(0,Math.floor(s||0)); const m=Math.floor(s/60),r=s%60; return `${m}:${String(r).padStart(2,"0")}`; };
const bytes = (n) => n>1e9?(n/1e9).toFixed(2)+" GB":n>1e6?(n/1e6).toFixed(1)+" MB":(n/1e3).toFixed(0)+" KB";
const escapeHtml = (s) => String(s).replace(/[&<>"']/g,(m)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,8);
function slugId(str){ let h=0; for(let i=0;i<str.length;i++){ h=(h*31+str.charCodeAt(i))|0; } return "s"+(h>>>0).toString(36); }
function banner(msg,kind=""){ const b=$("banner"); if(!b)return; b.textContent=msg; b.className="banner "+kind; clearTimeout(banner._t); banner._t=setTimeout(()=>b.classList.add("hidden"),kind==="err"?8000:3500); b.classList.remove("hidden"); }

// ---------- config ----------
const R2 = window.R2_CONFIG || {};
const r2Ready = R2.accessKeyId && R2.accessKeyId !== "PASTE_ME";
log("config status",{ r2Configured: !!r2Ready, bucket: R2.bucket, publicBaseUrl: R2.publicBaseUrl });
if (!r2Ready) { logErr("config","R2 not configured (config.js still has PASTE_ME)"); banner("R2 isn't configured yet — edit config.js (see README).","err"); }
const aws = r2Ready ? new AwsClient({ accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey, service:"s3", region:"auto" }) : null;
const S3_BASE = r2Ready ? `https://${R2.accountId}.r2.cloudflarestorage.com/${R2.bucket}` : "";
const PUB = (R2.publicBaseUrl||"").replace(/\/$/,"");

// ---------- shared state ----------
let me = localStorage.getItem("review_name") || "";
let videos = [], currentVideo = null, comments = [];
let pinnedTime = 0, followPlayhead = true;

// ===========================================================================
//  R2 DATA LAYER  (S3-compatible via aws4fetch)
// ===========================================================================
const VIDEOS_KEY = "data/videos.json";
const commentsPrefix = (vid) => `data/comments/${vid}/`;

// PUT an object. Uses XHR + presigned-query URL so video uploads get a progress bar.
async function r2Put(key, body, contentType, onProgress) {
  if (!aws) throw new Error("R2 not configured");
  const endpoint = `${S3_BASE}/${key}`;
  const signed = await aws.sign(endpoint, { method:"PUT", headers:{ "Content-Type":contentType }, aws:{ signQuery:true } });
  return new Promise((resolve,reject)=>{
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signed.url, true);
    xhr.setRequestHeader("Content-Type", contentType);
    if (onProgress && xhr.upload) xhr.upload.onprogress=(e)=>{ if(e.lengthComputable) onProgress(Math.round((e.loaded/e.total)*100)); };
    xhr.onload=()=>{ if(xhr.status>=200&&xhr.status<300){ log("R2 PUT ok",{key,status:xhr.status}); resolve(`${PUB}/${key}`); } else { logErr("R2 PUT",`${key} status=${xhr.status} ${String(xhr.responseText||"").slice(0,200)}`); reject(new Error(`R2 PUT ${xhr.status}. Check creds + CORS.`)); } };
    xhr.onerror=()=>{ logErr("R2 PUT",`${key} network/CORS`); reject(new Error("R2 PUT network error — usually bucket CORS.")); };
    xhr.send(body);
  });
}

// GET + parse a JSON object from the public URL (comments/videos aren't secret).
async function r2GetJson(key, dflt=null) {
  try {
    const res = await fetch(`${PUB}/${key}?t=${Date.now()}`, { cache:"no-store" });
    if (res.status===404) return dflt;
    if (!res.ok) { logErr("R2 GET",`${key} status=${res.status}`); return dflt; }
    return await res.json();
  } catch(e){ logErr("R2 GET",e); return dflt; }
}

// LIST object keys under a prefix (signed S3 ListObjectsV2).
async function r2List(prefix) {
  if (!aws) return [];
  const url = `${S3_BASE}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const res = await aws.fetch(url, { method:"GET" });
  if (!res.ok) { logErr("R2 LIST",`${prefix} status=${res.status}`); return []; }
  const xml = await res.text();
  const doc = new DOMParser().parseFromString(xml,"application/xml");
  const keys = [...doc.getElementsByTagName("Key")].map((n)=>n.textContent);
  if (doc.getElementsByTagName("IsTruncated")[0]?.textContent==="true") log("R2 LIST truncated (only first page shown)",{prefix});
  log("R2 LIST",{ prefix, count: keys.length });
  return keys;
}

// DELETE an object (signed).
async function r2Delete(key) {
  if (!aws) return;
  const res = await aws.fetch(`${S3_BASE}/${key}`, { method:"DELETE" });
  if (!(res.ok||res.status===204)) logErr("R2 DELETE",`${key} status=${res.status}`);
  else log("R2 DELETE ok",{key});
}

// ---------- videos registry (single JSON file) ----------
function seedVideos(){ return (window.SEED_VIDEOS||[]).map((v)=>({ id: slugId(v.url), title: v.title, url: v.url, seed:true })); }

async function loadVideos() {
  const stored = r2Ready ? (await r2GetJson(VIDEOS_KEY, [])) : [];
  const storedUrls = new Set(stored.map((v)=>v.url));
  videos = [...seedVideos().filter((v)=>!storedUrls.has(v.url)), ...stored];
  log("videos loaded",{ total: videos.length, stored: stored.length });
  return videos;
}
async function saveVideosRegistry(list){ await r2Put(VIDEOS_KEY, JSON.stringify(list), "application/json"); }

// ---------- comments ----------
async function loadComments(vid) {
  const keys = (await r2List(commentsPrefix(vid))).filter((k)=>k.endsWith(".json"));
  const items = await Promise.all(keys.map(async (k)=>{ const c=await r2GetJson(k); if(c) c._key=k; return c; }));
  comments = items.filter(Boolean).sort((a,b)=>a.t-b.t);
  log("comments loaded",{ vid, count: comments.length });
  return comments;
}

// ===========================================================================
//  NAME GATE
// ===========================================================================
function showApp(){ $("name-gate").classList.add("hidden"); $("app").classList.remove("hidden"); $("who-name").textContent=me; boot(); }
if (me && $("name-input")) $("name-input").value=me;
$("name-form").addEventListener("submit",(e)=>{ e.preventDefault(); const v=$("name-input").value.trim(); if(!v)return; me=v; localStorage.setItem("review_name",me); showApp(); });
$("change-name").addEventListener("click",()=>{ $("app").classList.add("hidden"); $("name-gate").classList.remove("hidden"); $("name-input").focus(); });
if (me) showApp();

async function boot(){
  await loadVideos();
  if(ROLE==="reviewer"){
    renderVideoSelect();
    const wantV = new URLSearchParams(location.search).get("v");
    const target = (wantV && videos.find((x)=>x.id===wantV)) ? wantV : (videos[0] && videos[0].id);
    if(wantV && !videos.find((x)=>x.id===wantV)) banner("That video link wasn't found — showing the latest instead.","err");
    if(!currentVideo && target) selectVideo(target);
  } else { renderLibrary(); }
}

// ===========================================================================
//  REVIEWER
// ===========================================================================
if (ROLE === "reviewer") {
  const video=$("video"), track=$("track"), progress=$("progress");

  window.renderVideoSelect=function(){
    const sel=$("video-select"); sel.innerHTML="";
    if(!videos.length){ $("video-empty").classList.remove("hidden"); $("video-wrap").classList.add("hidden"); const o=document.createElement("option"); o.textContent="— no videos —"; sel.appendChild(o); return; }
    videos.forEach((v)=>{ const o=document.createElement("option"); o.value=v.id; o.textContent=v.title||v.url; if(currentVideo&&v.id===currentVideo.id)o.selected=true; sel.appendChild(o); });
  };
  $("video-select").addEventListener("change",(e)=>{ if(e.target.value) selectVideo(e.target.value); });

  window.selectVideo=async function(id){
    const v=videos.find((x)=>x.id===id); if(!v)return; currentVideo=v;
    log("selectVideo",{ title:v.title, url:v.url });
    $("video-empty").classList.add("hidden"); $("video-wrap").classList.remove("hidden");
    video.src=v.url; video.load(); pinnedTime=0; updateStamp(); renderVideoSelect();
    await refreshComments();
  };

  window.refreshComments=async function(){ if(!currentVideo)return; await loadComments(currentVideo.id); renderComments(); renderMarkers(); };
  $("refresh-btn").addEventListener("click",()=>{ $("refresh-btn").textContent="↻ …"; refreshComments().finally(()=>$("refresh-btn").textContent="↻ refresh"); });

  $("play").addEventListener("click",()=>video.paused?video.play():video.pause());
  video.addEventListener("play",()=>$("play").textContent="⏸");
  video.addEventListener("pause",()=>$("play").textContent="▶");
  $("mute").addEventListener("click",()=>{ video.muted=!video.muted; $("mute").textContent=video.muted?"🔇":"🔊"; });
  video.addEventListener("timeupdate",()=>{ const d=video.duration||0; progress.style.width=d?(video.currentTime/d)*100+"%":"0%"; $("time").textContent=`${fmt(video.currentTime)} / ${fmt(d)}`; if(followPlayhead){ pinnedTime=video.currentTime; updateStamp(); } highlightActiveComment(); });
  video.addEventListener("loadedmetadata",()=>{ $("time").textContent=`0:00 / ${fmt(video.duration)}`; renderMarkers(); });
  video.addEventListener("error",()=>{ if(currentVideo){ logErr("video load",`code=${video.error&&video.error.code} src=${video.currentSrc}`); banner("Video failed to load. Check the R2 URL is public and CORS allows this site.","err"); } });
  track.addEventListener("click",(e)=>{ const r=track.getBoundingClientRect(); const p=(e.clientX-r.left)/r.width; if(video.duration) video.currentTime=p*video.duration; });
  $("follow-toggle").addEventListener("change",(e)=>followPlayhead=e.target.checked);
  $("use-current").addEventListener("click",()=>{ pinnedTime=video.currentTime; updateStamp(); });
  window.updateStamp=()=>$("stamp").textContent=fmt(pinnedTime);

  window.renderMarkers=function(){ const box=$("markers"); box.innerHTML=""; const d=video.duration||0; if(!d)return; comments.forEach((c)=>{ const m=document.createElement("div"); m.className="marker"; m.style.left=(c.t/d)*100+"%"; m.title=`${c.author} @ ${fmt(c.t)}`; m.addEventListener("click",(ev)=>{ev.stopPropagation(); video.currentTime=c.t;}); box.appendChild(m); }); };

  window.renderComments=function(){
    const list=$("comment-list"); list.innerHTML="";
    $("comment-count").textContent=`${comments.length} comment${comments.length===1?"":"s"}`;
    if(!comments.length){ list.innerHTML=`<div class="empty-note">No comments yet.<br>Scrub to a moment and leave the first one.</div>`; return; }
    comments.forEach((c)=>{
      const el=document.createElement("div"); el.className="comment"; el.dataset.t=c.t; el.dataset.id=c.id;
      const when=c.createdAt?new Date(c.createdAt).toLocaleString():"";
      const mine=c.author===me;
      el.innerHTML=`<div class="c-top"><span class="c-author">${escapeHtml(c.author)}</span><span class="c-when">${when}</span><span class="c-stamp" title="Jump to ${fmt(c.t)}">${fmt(c.t)}</span>${mine?'<button class="c-del" title="Delete">✕</button>':""}</div>${c.text?`<div class="c-text">${escapeHtml(c.text)}</div>`:""}${c.audioUrl?`<audio class="c-audio" controls preload="none" src="${c.audioUrl}"></audio>`:""}`;
      el.querySelector(".c-stamp").addEventListener("click",()=>video.currentTime=c.t);
      const del=el.querySelector(".c-del");
      if(del) del.addEventListener("click",async()=>{ try{ await r2Delete(c._key); await refreshComments(); banner("Deleted.","ok"); }catch(e){ banner("Delete failed: "+e.message,"err"); } });
      list.appendChild(el);
    });
  };
  window.highlightActiveComment=function(){ const t=video.currentTime; let active=null; comments.forEach((c)=>{ if(c.t<=t+0.3) active=c.id; }); document.querySelectorAll(".comment").forEach((el)=>el.classList.toggle("active",el.dataset.id===active)); };

  // send comment
  let pendingAudioBlob=null;
  $("send-btn").addEventListener("click",async()=>{
    if(!currentVideo){ banner("Pick a video first.","err"); return; }
    if(!r2Ready){ banner("R2 not configured.","err"); return; }
    const text=$("comment-text").value.trim();
    if(!text && !pendingAudioBlob){ banner("Write something or record a note.","err"); return; }
    const btn=$("send-btn"); btn.disabled=true; btn.textContent="Posting…";
    try{
      const id=rid(); let audioUrl=null;
      if(pendingAudioBlob){ const ak=`audio/${currentVideo.id}/${id}.webm`; log("uploading audio",{bytes:pendingAudioBlob.size}); audioUrl=await r2Put(ak, pendingAudioBlob, pendingAudioBlob.type||"audio/webm"); }
      const c={ id, videoId:currentVideo.id, author:me, t:Math.round(pinnedTime*10)/10, text:text||"", audioUrl, createdAt:new Date().toISOString() };
      await r2Put(`${commentsPrefix(currentVideo.id)}${id}.json`, JSON.stringify(c), "application/json");
      log("comment posted",{ t:c.t, hasAudio:!!audioUrl });
      $("comment-text").value=""; clearAudio(); await refreshComments(); banner("Comment posted.","ok");
    }catch(e){ logErr("post comment",e); banner("Post failed: "+e.message,"err"); }
    finally{ btn.disabled=false; btn.textContent="Comment"; }
  });

  // audio recording
  let mediaRecorder=null, chunks=[], recStream=null, recTimer=null, recStart=0;
  $("record-btn").addEventListener("click",async()=>{
    if(mediaRecorder&&mediaRecorder.state==="recording"){ stopRecording(); return; }
    if(!r2Ready){ banner("R2 not configured — can't store audio.","err"); return; }
    try{ recStream=await navigator.mediaDevices.getUserMedia({audio:true}); }catch(e){ banner("Mic access denied or unavailable.","err"); return; }
    chunks=[];
    const mime=MediaRecorder.isTypeSupported("audio/webm;codecs=opus")?"audio/webm;codecs=opus":(MediaRecorder.isTypeSupported("audio/webm")?"audio/webm":"");
    mediaRecorder=new MediaRecorder(recStream, mime?{mimeType:mime,audioBitsPerSecond:32000}:undefined);
    mediaRecorder.ondataavailable=(e)=>{ if(e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop=()=>{ pendingAudioBlob=new Blob(chunks,{type:mediaRecorder.mimeType||"audio/webm"}); const a=$("audio-preview"); a.src=URL.createObjectURL(pendingAudioBlob); a.classList.remove("hidden"); recStream.getTracks().forEach((t)=>t.stop()); };
    mediaRecorder.start(); recStart=Date.now();
    $("record-btn").textContent="■ Stop"; $("record-btn").classList.add("recording");
    const st=$("record-status"); st.classList.remove("hidden"); st.classList.add("rec-live");
    recTimer=setInterval(()=>{ const s=(Date.now()-recStart)/1000; st.textContent="recording "+fmt(s); if(s>=(window.AUDIO_SAFETY_STOP_SECONDS||900)){ banner("Safety stop reached.",""); stopRecording(); } },250);
  });
  function stopRecording(){ if(mediaRecorder&&mediaRecorder.state==="recording") mediaRecorder.stop(); clearInterval(recTimer); $("record-btn").textContent="● Record"; $("record-btn").classList.remove("recording"); const st=$("record-status"); st.classList.remove("rec-live"); st.classList.add("hidden"); }
  function clearAudio(){ pendingAudioBlob=null; chunks=[]; const a=$("audio-preview"); a.src=""; a.classList.add("hidden"); }
}

// ===========================================================================
//  UPLOADER
// ===========================================================================
if (ROLE === "uploader") {
  window.renderLibrary=function(){
    const lib=$("library"); lib.innerHTML="";
    $("lib-count").textContent=`${videos.length} video${videos.length===1?"":"s"}`;
    if(!videos.length){ lib.innerHTML=`<div class="empty-note">Nothing uploaded yet.</div>`; return; }
    videos.forEach((v)=>{
      const el=document.createElement("div"); el.className="lib-item";
      el.innerHTML=`<div class="li-main"><div class="li-title">${escapeHtml(v.title||v.url)}</div><div class="li-url">${escapeHtml(v.url)}</div></div><button class="li-copy link-btn" title="Copy reviewer link for this video">copy link</button>${v.seed?'<span class="li-tag">from config</span>':'<button class="li-rename link-btn" title="Rename">rename</button><button class="c-del" title="Remove from library">✕</button>'}`;
      const cpy=el.querySelector(".li-copy");
      cpy.addEventListener("click",async()=>{ const link=`${location.origin}/reviewer?v=${encodeURIComponent(v.id)}`; try{ await navigator.clipboard.writeText(link); banner("Reviewer link copied — paste it in Slack.","ok"); }catch{ prompt("Copy this reviewer link:", link); } });
      const ren=el.querySelector(".li-rename");
      if(ren) ren.addEventListener("click",async()=>{ const nt=prompt("New title:", v.title||""); if(nt==null) return; const t=nt.trim(); if(!t) return; try{ const list=await r2GetJson(VIDEOS_KEY,[]); const it=list.find((x)=>x.id===v.id); if(it){ it.title=t; await saveVideosRegistry(list); await loadVideos(); renderLibrary(); banner("Renamed.","ok"); } }catch(e){ banner("Rename failed: "+e.message,"err"); } });
      const del=el.querySelector(".c-del");
      if(del) del.addEventListener("click",async()=>{ try{ const next=(await r2GetJson(VIDEOS_KEY,[])).filter((x)=>x.id!==v.id); await saveVideosRegistry(next); await loadVideos(); renderLibrary(); banner("Removed from library (R2 file not deleted).","ok"); }catch(e){ banner("Remove failed: "+e.message,"err"); } });
      lib.appendChild(el);
    });
  };
  $("lib-refresh").addEventListener("click",()=>{ $("lib-refresh").textContent="↻ …"; loadVideos().then(renderLibrary).finally(()=>$("lib-refresh").textContent="↻ refresh"); });

  const dz=$("dropzone"), input=$("file-input");
  ["dragenter","dragover"].forEach((ev)=>dz.addEventListener(ev,(e)=>{e.preventDefault();dz.classList.add("drag");}));
  ["dragleave","drop"].forEach((ev)=>dz.addEventListener(ev,(e)=>{e.preventDefault();dz.classList.remove("drag");}));
  dz.addEventListener("drop",(e)=>handleFiles(e.dataTransfer.files));
  input.addEventListener("change",(e)=>{ handleFiles(e.target.files); input.value=""; });

  function handleFiles(fileList){ if(!r2Ready){ banner("R2 not configured — edit config.js.","err"); return; } [...fileList].filter((f)=>f.type.startsWith("video/")).forEach(uploadVideo); }

  async function uploadVideo(file){
    const row=document.createElement("div"); row.className="up-row";
    row.innerHTML=`<div class="ur-top"><span class="ur-name">${escapeHtml(file.name)}</span><span class="ur-pct">0%</span></div><div class="ur-bar"><div class="ur-fill"></div></div><div class="ur-sub muted">${bytes(file.size)}</div>`;
    $("upload-queue").prepend(row);
    const fill=row.querySelector(".ur-fill"), pct=row.querySelector(".ur-pct"), sub=row.querySelector(".ur-sub");
    try{
      const key=`videos/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;
      log("upload start",{ name:file.name, size:file.size, key });
      const url=await r2Put(key, file, file.type||"video/mp4", (p)=>{ fill.style.width=p+"%"; pct.textContent=p+"%"; });
      const entry={ id: slugId(url), title:file.name.replace(/\.[^.]+$/,""), url, addedBy:me, createdAt:new Date().toISOString(), size:file.size };
      const next=await r2GetJson(VIDEOS_KEY,[]); next.push(entry); await saveVideosRegistry(next);
      log("upload done + registered",{ url });
      await loadVideos(); renderLibrary();
      pct.textContent="done"; fill.style.width="100%"; row.classList.add("ok"); sub.textContent="Available to reviewers.";
    }catch(e){ logErr("upload video",e); row.classList.add("err"); pct.textContent="failed"; sub.textContent=e.message; }
  }
}
