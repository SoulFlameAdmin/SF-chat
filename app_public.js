// E:\OMEGLE\app_public.js — SFCHAT anti-duplicate (join + listeners + send)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, set, update, remove, push,
  onChildAdded, onValue, off, runTransaction,
  query, orderByChild, limitToLast, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

/**
 * ✅ Защо дублираше:
 * - joinRoom/листенери се пускаха 2 пъти (двойно init или двойно match trigger)
 * - sendMessage можеше да се извика 2 пъти от 1 действие (Enter/submit/click комбинации)
 *
 * ✅ Тук го убиваме:
 * - глобален boot guard
 * - join guard (ако вече си в същата стая -> ignore)
 * - ALWAYS detach listeners преди нови
 * - idempotent msgId (на база uid+timebucket+hash(text))
 * - UI dedupe за стари дубли в DB
 */

const BUILD = "SFCHAT_FIX_v5_2026-02-06";
if (window.__SFCHAT_BOOTED__) {
  console.warn("[SFCHAT] already booted:", window.__SFCHAT_BUILD__);
/* stop */  throw new Error("SFCHAT double boot blocked");
}
window.__SFCHAT_BOOTED__ = true;
window.__SFCHAT_BUILD__ = BUILD;
console.log("[SFCHAT] boot", BUILD);

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// UI
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const btnFind = document.getElementById("btnFind");
const btnNext = document.getElementById("btnNext");
const statusEl = document.getElementById("status");
const formEl = document.getElementById("chatForm");

if (!messagesEl || !inputEl || !sendBtn || !btnFind || !btnNext || !statusEl || !formEl) {
  throw new Error("Missing DOM elements.");
}

function setStatus(t) { statusEl.textContent = t; }
function scrollToBottom() {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
}

const AVATAR = "https://s3-us-west-2.amazonaws.com/s.cdpn.io/156381/profile/profile-80.jpg";

function makeAvatar() {
  const fig = document.createElement("figure");
  fig.className = "avatar";
  const img = document.createElement("img");
  img.src = AVATAR;
  img.alt = "avatar";
  fig.appendChild(img);
  return fig;
}

function addMessage(text, { personal = false, system = false } = {}) {
  const msg = document.createElement("div");
  msg.className = "message new" + (personal ? " message-personal" : "");
  if (!personal && !system) msg.appendChild(makeAvatar());
  msg.appendChild(document.createTextNode(text));
  if (system) {
    msg.style.opacity = "0.85";
    msg.style.fontStyle = "italic";
  }
  messagesEl.appendChild(msg);
  void msg.offsetWidth;
  scrollToBottom();
}

function clearChat() {
  messagesEl.innerHTML = "";
}

// ---------- helpers ----------
function hash32(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0);
}

// 300ms bucket: убива двойни event-и от едно натискане,
// но позволява нормално 2 отделни съобщения след малко.
const SEND_BUCKET_MS = 300;

function makeMsgId(uid, text, now) {
  const bucket = Math.floor(now / SEND_BUCKET_MS).toString(36);
  const u = (uid || "").slice(0, 10);
  const h = hash32(text || "").toString(36);
  return `${u}_${bucket}_${h}`;
}

// ---------- state ----------
let uid = null;
let joined = false;
let currentRoomId = null;
let peerUid = null;

let unsubMessages = null;
let messagesQ = null;
let messagesHandler = null;

let unsubMatch = null;

let lastJoinedRoomId = null;
let joinLock = false;

let seenKeys = new Set();

// UI dedupe (ако DB вече има дубли)
let recentSig = new Map(); // sig -> lastMs

// refs
const waitingRef = () => ref(db, "waiting/slot");
const matchRef = () => ref(db, `matches/${uid}`);

const messagesRootRef = (roomId) => ref(db, `rooms/${roomId}/messagesById`);
const msgRef = (roomId, msgId) => ref(db, `rooms/${roomId}/messagesById/${msgId}`);

function detachRoomListeners() {
  try { if (unsubMessages) unsubMessages(); } catch {}
  unsubMessages = null;

  try { if (messagesQ && messagesHandler) off(messagesQ, "child_added", messagesHandler); } catch {}
  messagesQ = null;
  messagesHandler = null;

  seenKeys = new Set();
  recentSig = new Map();
}

function detachMatchListener() {
  try { if (unsubMatch) unsubMatch(); } catch {}
  unsubMatch = null;
}

async function leaveRoomUIOnly() {
  joined = false;
  currentRoomId = null;
  peerUid = null;

  detachRoomListeners();
  detachMatchListener();

  btnFind.disabled = false;
  btnNext.disabled = true;
  inputEl.disabled = true;
  sendBtn.disabled = true;

  clearChat();
  setStatus("Ready");
}

async function leaveRoomHard() {
  if (!uid) return;
  try { await remove(matchRef()); } catch {}
  await leaveRoomUIOnly();
}

async function joinRoom(roomId, peer) {
  // ✅ join guard: ако някой ти trigger-не join 2 пъти -> игнор
  if (!roomId) return;
  if (joinLock) return;
  if (joined && currentRoomId === roomId) return;
  if (lastJoinedRoomId === roomId) return;

  joinLock = true;

  // reset UI/listeners
  await leaveRoomUIOnly();

  joined = true;
  currentRoomId = roomId;
  peerUid = peer || null;
  lastJoinedRoomId = roomId;

  btnFind.disabled = true;
  btnNext.disabled = false;
  inputEl.disabled = false;
  sendBtn.disabled = false;

  clearChat();

  // ✅ това е точно редът, който при теб излизаше 2 пъти — вече няма как
  addMessage("You're now chatting with a stranger. Say hi!", { system: true });
  setStatus("CONNECTED");

  // супер важно: махаме match listener + match node, за да не re-trigger-ва
  detachMatchListener();
  try { await remove(matchRef()); } catch {}

  detachRoomListeners();

  // Listen messages
  messagesQ = query(messagesRootRef(roomId), orderByChild("at"), limitToLast(200));
  messagesHandler = (snap) => {
    const k = snap.key;
    if (!k) return;

    // ✅ първо ниво dedupe: key
    if (seenKeys.has(k)) return;
    seenKeys.add(k);

    const m = snap.val();
    if (!m || !m.text) return;

    // ✅ второ ниво dedupe: uid+text+clientAt bucket (скрива стари дубли)
    const b = Math.floor(((m.clientAt || 0) / 1000)) ; // 1s bucket за render
    const sig = `${m.uid || ""}::${m.text}::${b}`;

    const now = Date.now();
    const last = recentSig.get(sig);
    if (last && (now - last) < 3500) return; // hide duplicate
    recentSig.set(sig, now);

    // prune
    if (recentSig.size > 600) {
      for (const [s, t] of recentSig) {
        if (now - t > 6000) recentSig.delete(s);
      }
    }

    addMessage(m.text, { personal: m.uid === uid });
  };

  unsubMessages = onChildAdded(messagesQ, messagesHandler);

  joinLock = false;
}

async function findMatch() {
  if (!uid) return;

  setStatus("Searching…");
  btnFind.disabled = true;
  btnNext.disabled = false;

  detachMatchListener();

  // 1) Try take slot
  let otherUid = null;

  await runTransaction(waitingRef(), (cur) => {
    if (cur === null) return uid;
    if (typeof cur === "string" && cur !== uid) {
      otherUid = cur;
      return null;
    }
    return cur;
  });

  // 2) If matched immediately
  if (otherUid) {
    const roomId = push(ref(db, "rooms")).key;

    const updates = {};
    updates[`rooms/${roomId}/participants/${uid}`] = true;
    updates[`rooms/${roomId}/participants/${otherUid}`] = true;
    updates[`rooms/${roomId}/createdAt`] = serverTimestamp();

    updates[`matches/${uid}`] = { roomId, peer: otherUid, at: Date.now() };
    updates[`matches/${otherUid}`] = { roomId, peer: uid, at: Date.now() };

    await update(ref(db), updates);

    await joinRoom(roomId, otherUid);
    return;
  }

  // 3) Wait for match
  setStatus("Searching for a stranger…");
  unsubMatch = onValue(matchRef(), async (snap) => {
    const v = snap.val();
    if (!v || !v.roomId || !v.peer) return;

    // ✅ гаранция: stop още преди join
    detachMatchListener();

    await joinRoom(v.roomId, v.peer);
  });
}

async function sendMessage() {
  if (!joined || !uid || !currentRoomId) return;

  const text = (inputEl.value || "").trim();
  if (!text) return;
  if (text.length > 500) return;

  const now = Date.now();
  const msgId = makeMsgId(uid, text, now);

  // clear input immediately (UX)
  inputEl.value = "";
  inputEl.focus();

  // ✅ идемпотентен write: ако send се викне 2 пъти в 300ms,
  // msgId е същият => 1 node => няма дубъл
  try {
    await set(msgRef(currentRoomId, msgId), {
      uid,
      text,
      clientMsgId: msgId,
      clientAt: now,
      at: serverTimestamp()
    });
  } catch (e) {
    console.error("send failed:", e);
    addMessage("Send failed (permission / network).", { system: true });
  }
}

// UI events
btnFind.addEventListener("click", findMatch);
btnNext.addEventListener("click", leaveRoomHard);

// ✅ ЕДИНСТВЕН pipeline: submit
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});

// Enter = send, Shift+Enter = new line
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    if (e.repeat) return;
    e.preventDefault();
    formEl.requestSubmit();
  }
});

// Boot
(async function boot() {
  setStatus("Signing in…");
  btnFind.disabled = true;
  btnNext.disabled = true;
  inputEl.disabled = true;
  sendBtn.disabled = true;

  await signInAnonymously(auth);

  onAuthStateChanged(auth, (user) => {
    if (!user) return;
    uid = user.uid;

    setStatus("Ready");
    btnFind.disabled = false;
    btnNext.disabled = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;
  });
})();
