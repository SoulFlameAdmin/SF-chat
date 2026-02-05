// E:\OMEGLE\app_public.js (STRANGERS + ROOMS, NO DOUBLE SEND)
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

// anti double init
if (window.__SF_ROOMS_BOOTED__) {
  console.warn("SF Rooms already booted.");
} else {
  window.__SF_ROOMS_BOOTED__ = true;

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

  if (!messagesEl || !inputEl || !sendBtn || !btnFind || !btnNext || !statusEl) {
    throw new Error("Missing DOM elements (messages/messageInput/sendBtn/btnFind/btnNext/status).");
  }

  const AVATAR =
    "https://s3-us-west-2.amazonaws.com/s.cdpn.io/156381/profile/profile-80.jpg";

  // --- constants / helpers ---
  const SEND_BUCKET_MS = 1500; // 1.5s bucket за детерминистичен msgId (убива двойно send)

  function hash32(str) {
    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0);
  }

  // правим msgId детерминистичен, за да няма 2 записа при 1 действие
  function makeDeterministicMsgId({ uid, text, now }) {
    const bucket = Math.floor(now / SEND_BUCKET_MS);
    const uid8 = (uid || "").slice(0, 8);
    const h = hash32(text || "");
    // безопасни символи за RTDB keys: [a-zA-Z0-9_]
    return `${uid8}_${bucket.toString(36)}_${h.toString(36)}`;
  }

  let uid = null;

  // current session state
  let joined = false;
  let currentRoomId = null;
  let peerUid = null;

  // listeners
  let unsubMessages = null;
  let messagesQ = null;
  let messagesHandler = null;
  let unsubMatch = null;

  let seenMsgKeys = new Set();

  // UI dedupe (ако има вече стари дубли в DB)
  let recentRender = new Map(); // sig -> lastSeenMs

  // hard anti double-send (локална защита)
  let sending = false;
  let lastSendAt = 0;
  let lastSendSig = "";

  // typing debounce
  let typingTimer = null;
  let typingOn = false;

  // refs
  const waitingRef = () => ref(db, "waiting/slot");
  const matchRef = () => ref(db, `matches/${uid}`);
  const typingRef = (roomId, who) => ref(db, `rooms/${roomId}/typing/${who}`);
  const messagesRootRef = (roomId) => ref(db, `rooms/${roomId}/messagesById`);
  const msgRef = (roomId, msgId) => ref(db, `rooms/${roomId}/messagesById/${msgId}`);

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
    recentRender = new Map();
  }

  function detachRoomListeners() {
    try { if (unsubMessages) unsubMessages(); } catch {}
    unsubMessages = null;

    try { if (messagesQ && messagesHandler) off(messagesQ, "child_added", messagesHandler); } catch {}
    messagesQ = null;
    messagesHandler = null;

    seenMsgKeys = new Set();
    recentRender = new Map();
  }

  function detachMatchListener() {
    try { if (unsubMatch) unsubMatch(); } catch {}
    unsubMatch = null;
  }

  async function setTyping(isTyping) {
    if (!joined || !currentRoomId || !uid) return;
    try {
      await set(typingRef(currentRoomId, uid), !!isTyping);
    } catch (e) {
      console.warn("typing set failed:", e?.message || e);
    }
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

  async function joinRoom(roomId, peer) {
    // reset
    await leaveRoom(false);

    currentRoomId = roomId;
    peerUid = peer;
    joined = true;

    btnFind.disabled = true;
    btnNext.disabled = false;
    inputEl.disabled = false;
    sendBtn.disabled = false;

    clearChat();
    addMessage("Connected.", { system: true });
    setStatus("Room • connected");

    detachRoomListeners();

    // listen last 200 messages ordered by "at"
    messagesQ = query(messagesRootRef(roomId), orderByChild("at"), limitToLast(200));
    messagesHandler = (snap) => {
      const k = snap.key;
      if (k && seenMsgKeys.has(k)) return;
      if (k) seenMsgKeys.add(k);

      const m = snap.val();
      if (!m || !m.text) return;

      // UI-dedupe: ако има 2 записа със същия текст (по-стари дубли)
      const bucket = Math.floor(((m.clientAt || 0) || 0) / SEND_BUCKET_MS);
      const sig = `${m.uid || ""}::${m.text}::${bucket}`;
      const now = Date.now();
      const last = recentRender.get(sig);
      if (last && (now - last) < 3500) return; // скрий близък дубъл
      recentRender.set(sig, now);

      // prune
      if (recentRender.size > 600) {
        for (const [s, t] of recentRender) {
          if (now - t > 6000) recentRender.delete(s);
        }
      }

      addMessage(m.text, { personal: m.uid === uid });
    };

    unsubMessages = onChildAdded(messagesQ, messagesHandler);

    // ensure typing off initially
    typingOn = false;
    await setTyping(false);
  }

  async function leaveRoom(resetWaiting = true) {
    if (!uid) return;

    joined = false;

    detachRoomListeners();
    detachMatchListener();

    // typing off + cleanup match node
    if (currentRoomId) {
      try { await remove(typingRef(currentRoomId, uid)); } catch {}
    }
    try { await remove(matchRef()); } catch {}

    currentRoomId = null;
    peerUid = null;

    btnFind.disabled = false;
    btnNext.disabled = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;

    clearChat();
    setStatus("Ready");

    if (resetWaiting) {
      // optional (оставено меко)
    }
  }

  async function findMatch() {
    if (!uid) return;

    setStatus("Searching…");
    btnFind.disabled = true;
    btnNext.disabled = false;

    detachMatchListener();

    // 1) try take slot
    let otherUid = null;

    await runTransaction(waitingRef(), (cur) => {
      if (cur === null) return uid;
      if (typeof cur === "string" && cur !== uid) {
        otherUid = cur;
        return null;
      }
      return cur;
    });

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

    // waiting
    setStatus("Searching…");
    unsubMatch = onValue(matchRef(), async (snap) => {
      const v = snap.val();
      if (!v || !v.roomId || !v.peer) return;

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
    const sig = `${text}::${uid}`;

    // локален анти-спам/анти-double
    if (sending) return;
    if (sig === lastSendSig && (now - lastSendAt) < 200) return;

    sending = true;
    lastSendAt = now;
    lastSendSig = sig;

    inputEl.value = "";
    inputEl.focus();
    sendBtn.disabled = true;

    // ✅ ключовата част: детерминистичен msgId
    const clientMsgId = makeDeterministicMsgId({ uid, text, now });

    try {
      await set(msgRef(currentRoomId, clientMsgId), {
        uid,
        text,
        clientMsgId,
        clientAt: now,
        at: serverTimestamp()
      });
    } catch (e) {
      console.error("send failed:", e);
      addMessage("Send failed (permission / network).", { system: true });
    } finally {
      sending = false;
      if (joined) sendBtn.disabled = false;
    }
  }

  // UI events
  btnFind.addEventListener("click", findMatch);
  btnNext.addEventListener("click", () => leaveRoom(true));

  // ✅ Единен pipeline (form)
  const formEl = inputEl.closest("form");

  if (formEl) {
    try { sendBtn.type = "submit"; } catch {}

    formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      sendMessage();
    });

    // Enter = send, Shift+Enter = new line
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        if (e.repeat) return;
        e.preventDefault();
        sendMessage();
      }
    });
  } else {
    // fallback ако някой махне form-а
    sendBtn.addEventListener("click", (e) => {
      e.preventDefault();
      sendMessage();
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        if (e.repeat) return;
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // typing pulse on input
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
