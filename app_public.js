// E:\OMEGLE\app_public.js (FIXED)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, push, onChildAdded, serverTimestamp,
  query, limitToLast, off
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

// ---------- Anti double-init guard (ако случайно се зареди 2 пъти) ----------
if (window.__SF_PUBLIC_CHAT_BOOTED__) {
  console.warn("SF Public Chat already booted — skipping duplicate init.");
} else {
  window.__SF_PUBLIC_CHAT_BOOTED__ = true;

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

  const AVATAR = "https://s3-us-west-2.amazonaws.com/s.cdpn.io/156381/profile/profile-80.jpg";

  let uid = null;
  let joined = false;

  // Listener state
  let unsubMessages = null;
  let messagesQ = null;
  let messagesHandler = null;

  // Dedupe по key (за да няма двойно рендериране)
  let seenMsgKeys = new Set();

  // Anti double-send
  let sending = false;
  let lastSendAt = 0;
  let lastSendSig = "";

  const messagesRef = () => ref(db, "public/messages");

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
      msg.style.opacity = "0.8";
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

  function detachMessagesListener() {
    try {
      if (unsubMessages) unsubMessages();
    } catch {}
    unsubMessages = null;

    // extra safety (ако някой listener е останал)
    try {
      if (messagesQ && messagesHandler) off(messagesQ, "child_added", messagesHandler);
    } catch {}
    messagesQ = null;
    messagesHandler = null;
  }

  async function joinLobby() {
    if (!uid) return;
    if (joined) return;

    joined = true;

    btnFind.disabled = true;
    btnNext.disabled = false;
    inputEl.disabled = false;
    sendBtn.disabled = false;

    clearChat();
    addMessage("You joined the lobby.", { system: true });
    setStatus("Lobby • connected");

    // ВАЖНО: махаме стар слушател (ако някога е останал)
    detachMessagesListener();

    // reset dedupe за нова сесия
    seenMsgKeys = new Set();

    // listen last 200 messages
    messagesQ = query(messagesRef(), limitToLast(200));
    messagesHandler = (snap) => {
      // DEDUPE by key
      const k = snap.key;
      if (k && seenMsgKeys.has(k)) return;
      if (k) seenMsgKeys.add(k);

      const m = snap.val();
      if (!m || !m.text) return;
      addMessage(m.text, { personal: m.uid === uid });
    };

    unsubMessages = onChildAdded(messagesQ, messagesHandler);
  }

  async function leaveLobby() {
    if (!joined) return;
    joined = false;

    detachMessagesListener();

    btnFind.disabled = false;
    btnNext.disabled = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;

    clearChat();
    setStatus("Ready");
  }

  async function sendMessage() {
    if (!joined || !uid) return;

    const text = (inputEl.value || "").trim();
    if (!text) return;

    // Anti double-send (Enter repeat / click spam / double trigger)
    const now = Date.now();
    const sig = `${text}::${uid}`;

    if (sending) return;
    if (now - lastSendAt < 350 && sig === lastSendSig) return;

    sending = true;
    lastSendAt = now;
    lastSendSig = sig;

    inputEl.value = "";
    inputEl.focus();

    try {
      // Disable send briefly so UI can't double-trigger
      sendBtn.disabled = true;

      await push(messagesRef(), {
        uid,
        text,
        at: serverTimestamp()
      });
    } finally {
      // re-enable
      setTimeout(() => {
        sending = false;
        if (joined) sendBtn.disabled = false;
      }, 120);
    }
  }

  // UI events (single attach because of global guard)
  btnFind.addEventListener("click", joinLobby);
  btnNext.addEventListener("click", leaveLobby);

  sendBtn.addEventListener("click", sendMessage);

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      // prevents key repeat spam
      if (e.repeat) return;
      e.preventDefault();
      sendMessage();
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
    });
  })();
}
