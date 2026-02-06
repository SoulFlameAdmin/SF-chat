// E:\OMEGLE\app_public.js — STRANGERS + ROOMS (NO DUPLICATES v5)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, set, update, remove, push,
  onChildAdded, onValue, off, runTransaction,
  query, orderByChild, limitToLast, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

const BUILD = "SFCHAT_NODEDUPES_V5";

// ✅ anti double init
if (window.__SFCHAT_BOOTED__) {
  console.warn("[SFCHAT] already booted:", window.__SFCHAT_BUILD__);
} else {
  window.__SFCHAT_BOOTED__ = true;
  window.__SFCHAT_BUILD__ = BUILD;

  console.log("[SFCHAT] boot:", BUILD);

  // ✅ ВИДИМ BADGE (няма как да не го видиш)
  const badge = document.createElement("div");
  badge.id = "sfchat-build-badge";
  badge.style.cssText = `
    position:fixed; left:10px; bottom:10px; z-index:999999;
    background:rgba(0,0,0,.65); color:#fff; font:12px/1.2 system-ui,Segoe UI,Arial;
    padding:8px 10px; border-radius:10px; backdrop-filter: blur(8px);
    border:1px solid rgba(255,255,255,.18);
    max-width: 70vw; pointer-events:none;
  `;
  badge.textContent = `BUILD: ${BUILD} (booting…)`;
  document.body.appendChild(badge);

  // ✅ global dedupe store (оцелява дори при двойно зареждане)
  const D = (window.__SFCHAT_DEDUPE__ ||= { keys: new Map(), sigs: new Map() });

  function dedupeHit(map, key, ttlMs, max = 6000) {
    const now = Date.now();
    const t = map.get(key);
    if (t && (now - t) < ttlMs) return true;
    map.set(key, now);

    if (map.size > max) {
      for (const [k, v] of map) {
        if (now - v > ttlMs * 2) map.delete(k);
        if (map.size <= max) break;
      }
    }
    return false;
  }

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

  if (!messagesEl || !inputEl || !sendBtn || !btnFind || !btnNext || !statusEl) {
    throw new Error("Missing DOM elements (messages/messageInput/sendBtn/btnFind/btnNext/status).");
  }

  const AVATAR = "https://s3-us-west-2.amazonaws.com/s.cdpn.io/156381/profile/profile-80.jpg";

  function setStatus(t) {
    statusEl.textContent = `${t}`;
    badge.textContent = `BUILD: ${BUILD} • ${t}`;
  }

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

  function clearChat() { messagesEl.innerHTML = ""; }

  // ---- deterministic msgId ----
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0);
  }

  const SEND_BUCKET_MS = 2000; // 2s bucket -> двойно send става 1 запис
  function makeMsgId(uid, text, now) {
    const bucket = Math.floor(now / SEND_BUCKET_MS).toString(36);
    const u = (uid || "").slice(0, 10);
    const h = hash32((text || "").trim()).toString(36);
    return `${u}_${bucket}_${h}`;
  }

  // ---- state ----
  let uid = null;

  let joined = false;
  let currentRoomId = null;
  let peerUid = null;

  let finding = false;
  let isWaiting = false;

  // listeners
  let unsubMessages = null;
  let messagesQ = null;
  let messagesHandler = null;

  let unsubMatch = null;

  // send lock
  let sending = false;
  let lastSendAt = 0;
  let lastSendSig = "";

  // join lock
  let joinLock = false;
  let lastJoinedRoomId = null;

  // typing
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
  }

  function detachMatchListener() {
    try { if (unsubMatch) unsubMatch(); } catch {}
    unsubMatch = null;
  }

  async function safeClearWaitingSlotIfMine() {
    if (!uid) return;
    try {
      await runTransaction(waitingRef(), (cur) => (cur === uid ? null : cur));
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

    if (uid) {
      try { await remove(matchRef()); } catch {}
    }

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

    // ✅ idempotent join
    if (joinLock) return;
    if (joined && currentRoomId === roomId) return;
    if (lastJoinedRoomId === roomId) return;

    joinLock = true;
    lastJoinedRoomId = roomId;

    try {
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

      // ✅ remove match immediately (kills reconnect duplicate join)
      try { await remove(matchRef()); } catch {}

      detachRoomListeners();

      // ✅ token against old listeners
      const token = Symbol("listenToken");
      window.__SFCHAT_LISTEN_TOKEN__ = token;

      messagesQ = query(messagesRootRef(roomId), orderByChild("at"), limitToLast(200));

      messagesHandler = (snap) => {
        if (window.__SFCHAT_LISTEN_TOKEN__ !== token) return;

        const key = snap.key;
        if (!key) return;

        // ✅ global key dedupe
        if (dedupeHit(D.keys, `${roomId}|${key}`, 10 * 60 * 1000)) return;

        const m = snap.val();
        if (!m || !m.text) return;

        const t = String(m.text || "").trim();
        const ca = typeof m.clientAt === "number" ? m.clientAt : 0;

        // ✅ global signature dedupe
        const b = Math.floor(ca / SEND_BUCKET_MS);
        const sig = `${roomId}|${m.uid || ""}|${b}|${t}`;
        if (dedupeHit(D.sigs, sig, 8000)) return;

        addMessage(m.text, { personal: m.uid === uid });
      };

      unsubMessages = onChildAdded(messagesQ, messagesHandler);

      typingOn = false;
      await setTyping(false);
    } finally {
      joinLock = false;
    }
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
    let becameWaiting = false;

    await runTransaction(waitingRef(), (cur) => {
      if (cur === null) {
        becameWaiting = true;
        return uid;
      }
      if (typeof cur === "string" && cur !== uid) {
        otherUid = cur;
        becameWaiting = false;
        return null;
      }
      return cur;
    });

    isWaiting = becameWaiting;

    // ✅ matcher side
    if (otherUid) {
      const roomId = push(ref(db, "rooms")).key;

      const updates = {};
      updates[`rooms/${roomId}/participants/${uid}`] = true;
      updates[`rooms/${roomId}/participants/${otherUid}`] = true;
      updates[`rooms/${roomId}/createdAt`] = serverTimestamp();

      // ✅ CRITICAL FIX: match ONLY for the other user (NOT for yourself)
      updates[`matches/${otherUid}`] = { roomId, peer: uid, at: Date.now() };

      await update(ref(db), updates);

      // safety: clear any stale match on our side
      try { await remove(matchRef()); } catch {}

      await joinRoom(roomId, otherUid);
      return;
    }

    // ✅ waiting side
    setStatus("Searching…");
    unsubMatch = onValue(matchRef(), async (snap) => {
      const v = snap.val();
      if (!v || !v.roomId || !v.peer) return;

      detachMatchListener();
      try { await remove(matchRef()); } catch {}
      await safeClearWaitingSlotIfMine();

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

    if (sending) return;
    if (sig === lastSendSig && (now - lastSendAt) < 300) return;

    sending = true;
    lastSendAt = now;
    lastSendSig = sig;

    inputEl.value = "";
    inputEl.focus();

    const id = makeMsgId(uid, text, now);

    try {
      await set(msgRef(currentRoomId, id), {
        uid,
        text,
        clientMsgId: id,
        clientAt: now,
        at: serverTimestamp()
      });
    } finally {
      sending = false;
    }
  }

  // UI events
  btnFind.addEventListener("click", findMatch);
  btnNext.addEventListener("click", () => leaveRoom(true));

  // ✅ single send pipeline
  if (chatForm) {
    chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      sendMessage();
    });
  } else {
    sendBtn.addEventListener("click", (e) => {
      e.preventDefault();
      sendMessage();
    });
  }

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.repeat) return;
      e.preventDefault();
      if (chatForm) chatForm.requestSubmit();
      else sendMessage();
    }
  });

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
