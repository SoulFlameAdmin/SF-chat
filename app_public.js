// E:\OMEGLE\app_public.js (STRANGERS + ROOMS) — NO DUPLICATES (join + listeners + send)
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

const BUILD = "SFCHAT_FIX_JOIN_LISTEN_SEND_v1";

// anti double init (ако файлът се зареди 2 пъти)
if (window.__SF_ROOMS_BOOTED__) {
  console.warn("SF Rooms already booted.", window.__SF_ROOMS_BUILD__);
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

  const AVATAR =
    "https://s3-us-west-2.amazonaws.com/s.cdpn.io/156381/profile/profile-80.jpg";

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

  // hash (FNV-1a 32-bit)
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0);
  }

  // детерминистичен msgId: ако send се викне 2 пъти за едно действие -> 1 key
  const SEND_BUCKET_MS = 350;
  function makeDeterministicMsgId(uid, text, now) {
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

  // listeners
  let unsubMessages = null;
  let messagesQ = null;
  let messagesHandler = null;

  let unsubMatch = null;

  let seenMsgKeys = new Set();
  let recentSig = new Map(); // UI dedupe за стари дубли

  // hard anti double-send (локално)
  let sending = false;
  let lastSendAt = 0;
  let lastSendSig = "";

  // join lock (убива race condition ако joinRoom се извика 2 пъти почти едновременно)
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

  async function setTyping(isTyping) {
    if (!joined || !currentRoomId || !uid) return;
    try {
      await set(typingRef(currentRoomId, uid), !!isTyping);
    } catch {}
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
    if (!uid) return;

    joined = false;

    detachRoomListeners();
    detachMatchListener();

    if (currentRoomId) {
      try { await remove(typingRef(currentRoomId, uid)); } catch {}
    }

    // важно: чистим match-а при leave (и ще го чистим и при join)
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
      // optional
    }
  }

  async function joinRoom(roomId, peer) {
    if (!roomId) return;

    // ✅ guard: ако join се опита 2 пъти за същата стая -> IGNORE
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

    btnFind.disabled = true;
    btnNext.disabled = false;
    inputEl.disabled = false;
    sendBtn.disabled = false;

    clearChat();
    addMessage("Connected.", { system: true });
    setStatus("Room • connected");

    // ✅ КРИТИЧНО: чистим match нода веднага, за да няма повторен trigger при reconnect
    try { await remove(matchRef()); } catch {}

    detachRoomListeners();

    // listen last 200 messages ordered by "at"
    const listenToken = Symbol("roomListenToken");
    window.__SF_ROOM_LISTEN_TOKEN__ = listenToken;

    messagesQ = query(messagesRootRef(roomId), orderByChild("at"), limitToLast(200));
    messagesHandler = (snap) => {
      // ако има стар listener от race condition, го игнорирай
      if (window.__SF_ROOM_LISTEN_TOKEN__ !== listenToken) return;

      const k = snap.key;
      if (k && seenMsgKeys.has(k)) return;
      if (k) seenMsgKeys.add(k);

      const m = snap.val();
      if (!m || !m.text) return;

      // UI dedupe (скрива стари дубли в DB)
      const bucket = Math.floor(((m.clientAt || 0) / 1000)); // 1s bucket за render
      const sig = `${m.uid || ""}::${m.text}::${bucket}`;
      const now = Date.now();
      const last = recentSig.get(sig);
      if (last && (now - last) < 3500) return;
      recentSig.set(sig, now);

      // prune
      if (recentSig.size > 700) {
        for (const [s, t] of recentSig) {
          if (now - t > 6000) recentSig.delete(s);
        }
      }

      addMessage(m.text, { personal: m.uid === uid });
    };

    unsubMessages = onChildAdded(messagesQ, messagesHandler);

    typingOn = false;
    await setTyping(false);

    joinLock = false;
    finding = false;
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

    // waiting side
    setStatus("Searching…");
    unsubMatch = onValue(matchRef(), async (snap) => {
      const v = snap.val();
      if (!v || !v.roomId || !v.peer) return;

      // ✅ гаранция: спри match listener веднага
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
    if (sig === lastSendSig && (now - lastSendAt) < 250) return;

    sending = true;
    lastSendAt = now;
    lastSendSig = sig;

    inputEl.value = "";
    inputEl.focus();
    sendBtn.disabled = true;

    // ✅ детерминистичен ключ = няма дубъл дори при двойно викане
    const clientMsgId = makeDeterministicMsgId(uid, text, now);

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

  // ✅ единен send: form submit
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
