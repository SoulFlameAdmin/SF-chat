// E:\OMEGLE\app_public.js — STRANGERS + ROOMS (NO DUPLICATES FINAL)
// Fixes:
// 1) The matcher (first person) DOES NOT write matches/<uid> for himself -> avoids double join.
// 2) joinRoom is idempotent + locked.
// 3) msgId is deterministic (bucketed) -> double send becomes 1 write (second gets PERMISSION_DENIED and is ignored).
// 4) UI dedupe prevents old DB duplicates from rendering twice.

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

const BUILD = "SFCHAT_NO_DUPES_FINAL_v2";

// ✅ Anti double-init (ако по някаква причина се зареди 2 пъти)
if (window.__SF_ROOMS_BOOTED__) {
  console.warn("[SFCHAT] already booted:", window.__SF_ROOMS_BUILD__);
} else {
  window.__SF_ROOMS_BOOTED__ = true;
  window.__SF_ROOMS_BUILD__ = BUILD;
  console.log("[SFCHAT] boot:", BUILD);

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
  const chatForm = document.getElementById("chatForm");

  if (!messagesEl || !inputEl || !sendBtn || !btnFind || !btnNext || !statusEl || !chatForm) {
    throw new Error("Missing DOM elements (messages/messageInput/sendBtn/btnFind/btnNext/status/chatForm).");
  }

  const AVATAR = "https://s3-us-west-2.amazonaws.com/s.cdpn.io/156381/profile/profile-80.jpg";

  // ---------- helpers ----------
  function setStatus(t) { statusEl.textContent = t; }

  function scrollToBottom() {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
  }

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
    seenMsgKeys = new Set();
    recentSig = new Map();
  }

  // FNV-1a 32-bit hash
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0);
  }

  // ✅ Детеминистичен msgId: ако send се извика 2 пъти до ~2s, става 1 msgId
  // (rules: !data.exists -> вторият set ще е PERMISSION_DENIED и го игнорираме)
  const SEND_BUCKET_MS = 2000; // по-широк прозорец -> няма да имаш дубъл при “първия”
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

  // waiting state
  let isWaiting = false;

  // listeners
  let unsubMessages = null;
  let messagesQ = null;
  let messagesHandler = null;

  let unsubMatch = null;

  let seenMsgKeys = new Set();

  // UI dedupe (ако има стари дубли в DB)
  let recentSig = new Map();

  // hard anti double-send
  let sending = false;
  let lastSendAt = 0;
  let lastSendSig = "";

  // join lock
  let joinLock = false;
  let lastJoinedRoomId = null;

  // find lock
  let finding = false;

  // typing debounce
  let typingTimer = null;
  let typingOn = false;

  // refs
  const waitingRef = () => ref(db, "waiting/slot");
  const matchRef = () => ref(db, `matches/${uid}`);
  const typingRef = (roomId, who) => ref(db, `rooms/${roomId}/typing/${who}`);
  const messagesRootRef = (roomId) => ref(db, `rooms/${roomId}/messagesById`);
  const msgRef = (roomId, msgId) => ref(db, `rooms/${roomId}/messagesById/${msgId}`);

  function detachRoomListeners() {
    try { if (unsubMessages) unsubMessages(); } catch {}
    unsubMessages = null;

    try { if (messagesQ && messagesHandler) off(messagesQ, "child_added", messagesHandler); } catch {}
    messagesQ = null;
    messagesHandler = null;

    seenMsgKeys = new Set();
    recentSig = new Map();
  }

  function detachMatchListener() {
    try { if (unsubMatch) unsubMatch(); } catch {}
    unsubMatch = null;
  }

  async function safeClearWaitingSlotIfMine() {
    if (!uid) return;
    try {
      await runTransaction(waitingRef(), (cur) => {
        if (cur === uid) return null;
        return cur;
      });
    } catch {}
  }

  async function setTyping(isTyping) {
    if (!joined || !currentRoomId || !uid) return;
    try { await set(typingRef(currentRoomId, uid), !!isTyping); } catch {}
  }

  function scheduleTypingPulse() {
    if (!joined) return;

    if (!typingOn) {
      typingOn = true;
      setTyping(true);
    }

    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingOn = false;
      setTyping(false);
    }, 800);
  }

  async function leaveRoom(resetWaiting = true) {
    joined = false;

    detachRoomListeners();
    detachMatchListener();

    if (currentRoomId && uid) {
      try { await remove(typingRef(currentRoomId, uid)); } catch {}
    }

    // ✅ чистим match нода, за да не re-trigger-ва join при reconnect
    if (uid) {
      try { await remove(matchRef()); } catch {}
    }

    // ✅ ако сме били “чакащи”, чистим waiting/slot ако е наше
    if (resetWaiting && isWaiting) {
      await safeClearWaitingSlotIfMine();
    }

    isWaiting = false;
    finding = false;
    joinLock = false;

    currentRoomId = null;
    peerUid = null;

    btnFind.disabled = false;
    btnNext.disabled = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;

    clearChat();
    setStatus("Ready");
  }

  async function joinRoom(roomId, peer) {
    if (!uid || !roomId) return;

    // ✅ guard: ако join се опита 2 пъти -> ignore
    if (joinLock) return;
    if (joined && currentRoomId === roomId) return;
    if (lastJoinedRoomId === roomId) return;

    joinLock = true;
    lastJoinedRoomId = roomId;

    // reset
    await leaveRoom(false);

    currentRoomId = roomId;
    peerUid = peer;
    joined = true;
    isWaiting = false;
    finding = false;

    btnFind.disabled = true;
    btnNext.disabled = false;
    inputEl.disabled = false;
    sendBtn.disabled = false;

    clearChat();
    addMessage("You're now chatting with a stranger. Say hi!", { system: true });
    setStatus("CONNECTED");

    // ✅ КРИТИЧНО: махаме match нода веднага
    try { await remove(matchRef()); } catch {}

    detachRoomListeners();

    // ✅ Token: стар handler няма право да рендерира
    const token = Symbol("listenToken");
    window.__SF_LISTEN_TOKEN__ = token;

    messagesQ = query(messagesRootRef(roomId), orderByChild("at"), limitToLast(200));
    messagesHandler = (snap) => {
      if (window.__SF_LISTEN_TOKEN__ !== token) return;

      const k = snap.key;
      if (!k) return;
      if (seenMsgKeys.has(k)) return;
      seenMsgKeys.add(k);

      const m = snap.val();
      if (!m || !m.text) return;

      // UI dedupe (скрива стари дубли: различни key-ове, но еднакъв текст/време)
      const t = String(m.text || "").trim();
      const b = typeof m.clientAt === "number" ? Math.floor(m.clientAt / 1000) : 0; // 1s bucket
      const sig = `${m.uid || ""}::${b}::${t}`;
      const now = Date.now();
      const last = recentSig.get(sig);
      if (last && (now - last) < 3500) return;
      recentSig.set(sig, now);

      // prune
      if (recentSig.size > 700) {
        for (const [s, ts] of recentSig) {
          if (now - ts > 6000) recentSig.delete(s);
        }
      }

      addMessage(m.text, { personal: m.uid === uid });
    };

    unsubMessages = onChildAdded(messagesQ, messagesHandler);

    typingOn = false;
    await setTyping(false);

    joinLock = false;
  }

  async function findMatch() {
    if (!uid) return;
    if (finding) return;
    finding = true;

    setStatus("Searching…");
    btnFind.disabled = true;
    btnNext.disabled = false;

    detachMatchListener();

    let otherUid = null;

    await runTransaction(waitingRef(), (cur) => {
      if (cur === null) {
        isWaiting = true;
        return uid; // ставаш чакащ
      }
      if (typeof cur === "string" && cur !== uid) {
        otherUid = cur;   // намери друг
        isWaiting = false;
        return null;      // чистим slot-а
      }
      // ако е твоето uid или нещо друго -> не пипай
      return cur;
    });

    // ✅ ти си matcher (първия), намери друг
    if (otherUid) {
      const roomId = push(ref(db, "rooms")).key;

      const updates = {};
      updates[`rooms/${roomId}/participants/${uid}`] = true;
      updates[`rooms/${roomId}/participants/${otherUid}`] = true;
      updates[`rooms/${roomId}/createdAt`] = serverTimestamp();

      // ✅ КРИТИЧНО: НЕ пишем matches/${uid} за matcher-а (точно това ти прави двойния join)
      updates[`matches/${otherUid}`] = { roomId, peer: uid, at: Date.now() };

      await update(ref(db), updates);

      await joinRoom(roomId, otherUid);
      return;
    }

    // ✅ ти си чакащия -> чакай да ти запишат match
    setStatus("Searching…");
    unsubMatch = onValue(matchRef(), async (snap) => {
      const v = snap.val();
      if (!v || !v.roomId || !v.peer) return;

      // ✅ гаранция: спри listener-а веднага
      detachMatchListener();

      // ✅ чисти match нода веднага (убива повторение при reconnect)
      try { await remove(matchRef()); } catch {}

      await joinRoom(v.roomId, v.peer);
    });
  }

  async function sendMessage() {
    if (!joined || !uid || !currentRoomId) return;

    const text = (inputEl.value || "").trim();
    if (!text) return;
    if (text.length > 500) return;

    const now = Date.now();
    const sig = `${text}::${uid}`;

    // локално anti-double
    if (sending) return;
    if (sig === lastSendSig && (now - lastSendAt) < 300) return;

    sending = true;
    lastSendAt = now;
    lastSendSig = sig;

    inputEl.value = "";
    inputEl.focus();

    const clientMsgId = makeMsgId(uid, text, now);

    try {
      await set(msgRef(currentRoomId, clientMsgId), {
        uid,
        text,
        clientMsgId,
        clientAt: now,
        at: serverTimestamp()
      });
    } catch (e) {
      // rules: ако вече съществува key-а (дедупе) -> PERMISSION_DENIED -> просто игнор
      const s = String(e?.code || e?.message || e || "");
      if (s.includes("PERMISSION_DENIED")) {
        // ignore (means duplicate prevented)
      } else {
        console.error("send failed:", e);
        addMessage("Send failed (network / permission).", { system: true });
      }
    } finally {
      sending = false;
    }
  }

  // UI events
  btnFind.addEventListener("click", findMatch);
  btnNext.addEventListener("click", () => leaveRoom(true));

  // ✅ Единен send pipeline: само submit
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });

  // Enter = send, Shift+Enter = new line
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.repeat) return;
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  // typing pulse
  inputEl.addEventListener("input", () => {
    if (!joined) return;
    scheduleTypingPulse();
  });

  window.addEventListener("beforeunload", () => {
    detachRoomListeners();
    detachMatchListener();
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
}
