// E:\OMEGLE\app_public.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, push, onChildAdded, serverTimestamp,
  query, limitToLast, off
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

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
let unsubMessages = null;

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
}

async function joinLobby() {
  if (joined) return;
  joined = true;

  btnFind.disabled = true;
  btnNext.disabled = false;
  inputEl.disabled = false;
  sendBtn.disabled = false;

  clearChat();
  addMessage("You joined the lobby.", { system: true });
  setStatus("Lobby • connected");

  // listen last 200 messages
  const q = query(messagesRef(), limitToLast(200));
  unsubMessages = onChildAdded(q, (snap) => {
    const m = snap.val();
    if (!m || !m.text) return;
    addMessage(m.text, { personal: m.uid === uid });
  });
}

async function leaveLobby() {
  if (!joined) return;
  joined = false;

  try {
    if (unsubMessages) unsubMessages();
    unsubMessages = null;
    off(messagesRef());
  } catch {}

  btnFind.disabled = false;
  btnNext.disabled = true;
  inputEl.disabled = true;
  sendBtn.disabled = true;

  clearChat();
  setStatus("Ready");
}

async function sendMessage() {
  const text = (inputEl.value || "").trim();
  if (!text || !uid) return;

  inputEl.value = "";
  inputEl.focus();

  await push(messagesRef(), {
    uid,
    text,
    at: serverTimestamp()
  });
}

// UI events
btnFind.addEventListener("click", joinLobby);
btnNext.addEventListener("click", leaveLobby);

sendBtn.addEventListener("click", sendMessage);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
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
