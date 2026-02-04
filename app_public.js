// E:\OMEGLE\app_public.js (NO-DOUBLE-SEND, IDEMPOTENT)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, set,
  onChildAdded, serverTimestamp,
  query, limitToLast, off, orderByChild
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

// ---------- Anti double-init guard ----------
if (window.__SF_PUBLIC_CHAT_BOOTED__) {
  console.warn("SF Public Chat already booted — skipping duplicate init.");
} else {
  window.__SF_PUBLIC_CHAT_BOOTED__ = true;

  const app = initializeApp(firebaseConfig);
  const db = getDatabase(app);
  const auth = getAuth(app);

  // UI (IDs must exist in HTML)
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("messageInput");
  const sendBtn = document.getElementById("sendBtn");
  const btnFind = document.getElementById("btnFind");
  const btnNext = document.getElementById("btnNext");
  const statusEl = document.getElementById("status");

  if (!messagesEl || !inputEl || !sendBtn || !btnFind || !btnNext || !statusEl) {
    throw new Error("Missing DOM elements: messages, messageInput, sendBtn, btnFind, btnNext, status");
  }

  const AVATAR =
    "https://s3-us-west-2.amazonaws.com/s.cdpn.io/156381/profile/profile-80.jpg";

  let uid = null;
  let joined = false;

  // Listener state
  let unsubMessages = null;
  let messagesQ = null;
  let messagesHandler = null;

  // Dedupe render by key (extra safety)
  let seenMsgKeys = new Set();

  // Anti double-send guard
  let sending = false;
  let lastSendAt = 0;
  let lastSendSig = "";

  // IMPORTANT: deterministic write path
  const messagesRootRef = () => ref(db, "public/messagesById");
  const msgRef = (id) => ref(db, `public/messagesById/${id}`);

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

  function detachMessagesListener() {
    try { if (unsubMessages) unsubMessages(); } catch {}
    unsubMessages = null;

    try { if (messagesQ && messagesHandler) off(messagesQ, "child_added", messagesHandler); } catch {}
    messagesQ = null;
    messagesHandler = null;
  }

  async function joinLobby() {
    if (!uid || joined) return;
    joined = true;

    btnFind.disabled = true;
    btnNext.disabled = false;
    inputEl.disabled = false;
    sendBtn.disabled = false;

    clearChat();
    addMessage("You joined the lobby.", { system: true });
    setStatus("Lobby • connected");

    detachMessagesListener();
    seenMsgKeys = new Set();

    // listen last 200 messages ORDERED BY "at"
    messagesQ = query(messagesRootRef(), orderByChild("at"), limitToLast(200));

    messagesHandler = (snap) => {
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

    const raw = (inputEl.value || "");
    const text = raw.trim();
    if (!text) return;
    if (text.length > 500) return; // client-side mirror of rules

    const now = Date.now();
    const sig = `${text}::${uid}`;

    // HARD anti double-trigger
    if (sending) return;
    if (sig === lastSendSig && (now - lastSendAt) < 2000) return;

    sending = true;
    lastSendAt = now;
    lastSendSig = sig;

    inputEl.value = "";
    inputEl.focus();
    sendBtn.disabled = true;

    // This ID makes the write idempotent (rules allow create only)
    const clientMsgId = crypto.randomUUID();

    try {
      await set(msgRef(clientMsgId), {
        uid,
        text,
        clientMsgId,
        clientAt: now,
        at: serverTimestamp()
      });
    } catch (err) {
      console.error("send failed:", err);
      addMessage("Send failed (rules / network).", { system: true });
    } finally {
      sending = false;
      if (joined) sendBtn.disabled = false;
    }
  }

  // ==========================
  // UI EVENTS — SINGLE PIPELINE
  // ==========================
  btnFind.addEventListener("click", joinLobby, { passive: true });
  btnNext.addEventListener("click", leaveLobby, { passive: true });

  // If input+button are inside a <form>, we send ONLY via submit.
  const formEl = inputEl.closest("form");

  if (formEl) {
    // Make button submit, do NOT call sendMessage() from click
    try { sendBtn.type = "submit"; } catch {}

    formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      sendMessage();
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        if (e.repeat) return;
        e.preventDefault();
        formEl.requestSubmit(); // never call sendMessage directly here
      }
    });
  } else {
    // No form — still safe
    sendBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
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

  window.addEventListener("beforeunload", () => {
    detachMessagesListener();
  });

  // ==========================
  // Boot
  // ==========================
  (async function boot() {
    setStatus("Signing in…");
    btnFind.disabled = true;
    btnNext.disabled = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;

    try {
      await signInAnonymously(auth);
    } catch (err) {
      console.error("auth failed:", err);
      setStatus("Auth error");
      return;
    }

    onAuthStateChanged(auth, (user) => {
      if (!user) return;
      uid = user.uid;
      setStatus("Ready");
      btnFind.disabled = false;
    });
  })();
}
