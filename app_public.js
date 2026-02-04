// E:\OMEGLE\app_rooms.js (STRANGERS + ROOMS, NO DOUBLE SEND)
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

  // hard anti double-send
  let sending = false;
  let lastSendAt = 0;
  let lastSendSig = "";

  // typing debounce
  let typingTimer = null;
  let typingOn = false;

  // refs
  const waitingRef = () => ref(db, "waiting/slot");
  const matchRef = () => ref(db, `matches/${uid}`);
  const roomRef = (roomId) => ref(db, `rooms/${roomId}`);
  const participantsRef = (roomId) => ref(db, `rooms/${roomId}/participants`);
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
  }

  function detachRoomListeners() {
    try { if (unsubMessages) unsubMessages(); } catch {}
    unsubMessages = null;

    try { if (messagesQ && messagesHandler) off(messagesQ, "child_added", messagesHandler); } catch {}
    messagesQ = null;
    messagesHandler = null;

    seenMsgKeys = new Set();
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

    // typing off + cleanup match node (optional)
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

    // Ако искаш да чистиш waiting слот, може, но не е задължително.
    // Пазя го "меко", за да не прави допълнителни проблеми.
    if (resetWaiting) {
      // ако ти си бил в waiting/slot, може да го чистиш
      // (но без cloud function няма перфектна гаранция)
    }
  }

  async function findMatch() {
    if (!uid) return;

    setStatus("Searching…");
    btnFind.disabled = true;
    btnNext.disabled = false;

    // ако вече имаш match listener – махни
    detachMatchListener();

    // 1) опит да вземеш slot-а (transaction)
    let otherUid = null;

    await runTransaction(waitingRef(), (cur) => {
      if (cur === null) return uid;                 // ти ставаш чакащия
      if (typeof cur === "string" && cur !== uid) { // намираш друг
        otherUid = cur;
        return null; // изчистваме slot-а
      }
      return cur; // ако е твоето uid или нещо друго — не пипай
    });

    if (otherUid) {
      // 2) Ти си “матчера” -> създаваш room С participants ОЩЕ СЕГА (иначе rules режат)
      const roomId = push(ref(db, "rooms")).key;

      const updates = {};
      updates[`rooms/${roomId}/participants/${uid}`] = true;
      updates[`rooms/${roomId}/participants/${otherUid}`] = true;
      updates[`rooms/${roomId}/createdAt`] = serverTimestamp();

      // matches оставяме отворено (както са ти rules) за да можеш да пишеш и за другия
      updates[`matches/${uid}`] = { roomId, peer: otherUid, at: Date.now() };
      updates[`matches/${otherUid}`] = { roomId, peer: uid, at: Date.now() };

      await update(ref(db), updates);

      await joinRoom(roomId, otherUid);
      return;
    }

    // 3) Ти си чакащия -> чакаш някой да ти запише match
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

    if (sending) return;
    if (sig === lastSendSig && (now - lastSendAt) < 2000) return;

    sending = true;
    lastSendAt = now;
    lastSendSig = sig;

    inputEl.value = "";
    inputEl.focus();
    sendBtn.disabled = true;

    const clientMsgId = crypto.randomUUID(); // idempotent key

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

  // submit-only pipeline (ако е във form)
  const formEl = inputEl.closest("form");
  if (formEl) {
    try { sendBtn.type = "submit"; } catch {}

    formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      sendMessage();
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        if (e.repeat) return;
        e.preventDefault();
        formEl.requestSubmit();
      }
    });
  } else {
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
