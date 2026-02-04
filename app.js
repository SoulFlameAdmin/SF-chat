import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getDatabase, ref, set, get, push, onValue, off,
  serverTimestamp, runTransaction, remove, update, onDisconnect, onChildAdded
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

/**
 * Stranger Chat (minimal)
 * - Realtime Database
 * - Anonymous Auth
 * - Matching by pairs (2 people per room)
 * - If 3rd user arrives → they stay in searching until someone free
 * - Room is deleted when any user presses Next or closes tab (best-effort)
 */

// ---------- UI ----------
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const statusEl = document.getElementById("status");
const btnFind = document.getElementById("btnFind");
const btnNext = document.getElementById("btnNext");

const AVATAR = "https://s3-us-west-2.amazonaws.com/s.cdpn.io/156381/profile/profile-80.jpg";
let lastMinute = null;
let typingBubbleEl = null;
let typingTimer = null;

function scrollToBottom() {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
}
function pad2(n) { return String(n).padStart(2, "0"); }

function maybeAddTimestamp(messageNode) {
  const d = new Date();
  const min = d.getMinutes();
  if (lastMinute !== min) {
    lastMinute = min;
    const stamp = document.createElement("div");
    stamp.className = "timestamp";
    stamp.textContent = `${pad2(d.getHours())}:${pad2(min)}`;
    messageNode.appendChild(stamp);
  }
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

function addMessage(text, { personal = false, loading = false, system = false } = {}) {
  const msg = document.createElement("div");
  msg.className =
    "message new" +
    (personal ? " message-personal" : "") +
    (loading ? " loading" : "") +
    (system ? " message-system" : "");

  if (!personal && !system) msg.appendChild(makeAvatar());

  if (loading) {
    const typing = document.createElement("span");
    typing.className = "typing";
    typing.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    msg.appendChild(typing);
  } else {
    msg.appendChild(document.createTextNode(text));
  }

  messagesEl.appendChild(msg);

  if (!loading && !system) maybeAddTimestamp(msg);

  void msg.offsetWidth; // animate
  scrollToBottom();
  return msg;
}

function clearChat() {
  messagesEl.innerHTML = "";
  lastMinute = null;
  typingBubbleEl = null;
}

function setStatus(s) { statusEl.textContent = s; }

function setInputEnabled(enabled) {
  inputEl.disabled = !enabled;
  sendBtn.disabled = !enabled;
  btnNext.disabled = !enabled;
  if (enabled) inputEl.focus();
}

function setFindEnabled(enabled) {
  btnFind.disabled = !enabled;
}

// ---------- Firebase ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Global state
let uid = null;
let roomId = null;
let peerUid = null;
let isSearching = false;

let joiningRoomId = null; // prevents double-join (duplicate listeners => duplicate messages)

let unsubMatch = null;
let unsubRoomGone = null;
let unsubMsgs = null;
let unsubPeerTyping = null;

function safeOff(unsub) {
  try { if (typeof unsub === "function") unsub(); } catch {}
}

function detachRoomListeners() {
  if (unsubRoomGone) { safeOff(unsubRoomGone); unsubRoomGone = null; }
  if (unsubMsgs) { safeOff(unsubMsgs); unsubMsgs = null; }
  if (unsubPeerTyping) { safeOff(unsubPeerTyping); unsubPeerTyping = null; }
  hideTyping();
}

// Helpers
const rootRef = ref(db);
const waitingRef = ref(db, "waiting");                 // single-slot waiting object: {uid, ts}
const matchRef = () => ref(db, `matches/${uid}`);      // private per user
const roomRef = () => ref(db, `rooms/${roomId}`);
const msgsRef = () => ref(db, `rooms/${roomId}/messages`);
const myTypingRef = () => ref(db, `rooms/${roomId}/typing/${uid}`);
const peerTypingRef = () => ref(db, `rooms/${roomId}/typing/${peerUid}`);
const presenceRef = () => ref(db, `presence/${uid}`);

// ---------- Core: lifecycle ----------
async function boot() {
  setStatus("Signing in…");
  setInputEnabled(false);
  setFindEnabled(false);

  await signInAnonymously(auth);

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    uid = user.uid;

    // Presence (best-effort)
    await set(presenceRef(), { online: true, ts: serverTimestamp() });
    onDisconnect(presenceRef()).remove();

    // Clean own match on disconnect
    onDisconnect(matchRef()).remove();

    setStatus("Ready");
    setFindEnabled(true);

    addMessage("Press FIND to match with a stranger.", { system: true });
  });
}

boot();

// ---------- Matching ----------
async function startSearch() {
  if (!uid) return;

  await leaveRoom({ keepChat: false }); // ensure clean
  clearChat();

  isSearching = true;
  setFindEnabled(false);
  setInputEnabled(false);
  btnNext.disabled = true;

  addMessage("Searching for a stranger…", { system: true });
  setStatus("Searching…");

  // Listen for match
  listenForMatch();

  // Try to claim waiting slot or match
  await attemptMatch();
}

function listenForMatch() {
  if (unsubMatch) { safeOff(unsubMatch); unsubMatch = null; }

  const r = matchRef();
  const handler = (snap) => {
    const v = snap.val();
    if (!v || !v.roomId) return;

    // Guard: avoid double-join (duplicate listeners => duplicate messages)
    if (roomId === v.roomId || joiningRoomId === v.roomId) return;

    // Matched!
    joinRoom(v.roomId, v.peer);
  };

  onValue(r, handler);
  unsubMatch = () => off(r, "value", handler);
}

async function attemptMatch() {
  let other = null;
  const NOW = () => Date.now();

  try {
    const res = await runTransaction(waitingRef, (cur) => {
      const now = NOW();

      if (cur === null) return { uid, ts: now };
      if (typeof cur === "string") cur = { uid: cur, ts: now - 999999 };

      if (!cur.uid) return { uid, ts: now };

      // Refresh our own slot
      if (cur.uid === uid) return { uid, ts: now };

      // Stale slot? take over
      if (cur.ts && now - cur.ts > 45000) return { uid, ts: now };

      // Otherwise match with the waiting user
      other = cur.uid;
      return null; // clears waiting
    }, { applyLocally: false });

    if (!res.committed) return;

    if (other) {
      await createRoomWith(other);
    } else {
      // We are in waiting slot now — keep heartbeat so others don't see it stale.
      heartbeatWaitingSlot();
    }
  } catch (e) {
    console.error(e);
    setStatus("Error");
    addMessage("Firebase error. Check config / rules.", { system: true });
    setFindEnabled(true);
    isSearching = false;
  }
}

function heartbeatWaitingSlot() {
  // Update waiting.ts periodically while we're searching AND still the waiting uid.
  const interval = setInterval(async () => {
    if (!isSearching || !uid) { clearInterval(interval); return; }

    try {
      await runTransaction(waitingRef, (cur) => {
        const now = Date.now();
        if (!cur) return cur;
        if (typeof cur === "string") cur = { uid: cur, ts: now };
        if (cur.uid !== uid) return cur;          // someone else took it or matched
        return { uid, ts: now };
      }, { applyLocally: false });
    } catch {
      // ignore
    }
  }, 12000);
}

async function createRoomWith(otherUid) {
  const r = push(ref(db, "rooms"));
  const newRoomId = r.key;

  const room = {
    createdAt: serverTimestamp(),
    active: true,
    participants: { [uid]: true, [otherUid]: true }
  };

  await set(r, room);

  const multi = {};
  multi[`matches/${uid}`] = { roomId: newRoomId, peer: otherUid, ts: Date.now() };
  multi[`matches/${otherUid}`] = { roomId: newRoomId, peer: uid, ts: Date.now() };

  try { await update(rootRef, multi); }
  catch {
    // Fallback: at least write ours.
    await set(matchRef(), { roomId: newRoomId, peer: otherUid, ts: Date.now() });
  }

  // Join immediately (safe now: joinRoom has anti-double-join guard)
  await joinRoom(newRoomId, otherUid);
}

async function clearWaitingIfMine() {
  try {
    await runTransaction(waitingRef, (cur) => {
      if (!cur) return cur;
      if (typeof cur === "string") return (cur === uid ? null : cur);
      if (cur.uid === uid) return null;
      return cur;
    }, { applyLocally: false });
  } catch {}
}

// ---------- Room / chat ----------
async function joinRoom(id, peer) {
  if (!id) return;

  // Prevent double join (this is the #1 reason for duplicated messages)
  if (roomId === id || joiningRoomId === id) return;
  joiningRoomId = id;

  try {
    // Stop listening for match ASAP, иначе може да влезем втори път
    if (unsubMatch) { safeOff(unsubMatch); unsubMatch = null; }

    // Ако вече има закачени room listeners (от предишен/двоен join) — махни ги
    detachRoomListeners();

    roomId = id;
    peerUid = peer;
    isSearching = false;

    // UI
    setStatus("Connected");
    setInputEnabled(true);
    setFindEnabled(false);
    btnNext.disabled = false;

    addMessage("You’re now chatting with a stranger. Say hi!", { system: true });

    // Watch room active / existence
    const activePath = ref(db, `rooms/${roomId}/active`);
    const roomGoneHandler = (snap) => {
      if (!snap.exists()) endRoomFromRemote();
      else if (snap.val() === false) endRoomFromRemote();
    };
    onValue(activePath, roomGoneHandler);
    unsubRoomGone = () => off(activePath, "value", roomGoneHandler);

    // Messages stream
    const mref = msgsRef();
    const msgHandler = (snap) => {
      const v = snap.val();
      if (!v || !v.text) return;
      addMessage(v.text, { personal: v.uid === uid });
    };
    onChildAdded(mref, msgHandler);
    unsubMsgs = () => off(mref, "child_added", msgHandler);

    // Typing: ours
    await set(myTypingRef(), false);
    onDisconnect(myTypingRef()).remove();

    // Typing: peer
    const pref = peerTypingRef();
    const peerTypingHandler = (snap) => {
      const isTyping = !!snap.val();
      if (isTyping) showTyping();
      else hideTyping();
    };
    onValue(pref, peerTypingHandler);
    unsubPeerTyping = () => off(pref, "value", peerTypingHandler);

    // Ensure our match exists (self)
    try {
      await set(matchRef(), { roomId, peer: peerUid, ts: Date.now() });
    } catch {}
  } finally {
    joiningRoomId = null;
  }
}

function showTyping() {
  if (typingBubbleEl) return;
  typingBubbleEl = addMessage("", { loading: true });
}
function hideTyping() {
  if (!typingBubbleEl) return;
  typingBubbleEl.remove();
  typingBubbleEl = null;
}

async function sendMessage() {
  const raw = inputEl.value;
  const text = raw.trim();
  if (!text || !roomId) return;

  inputEl.value = "";
  inputEl.focus();

  await push(msgsRef(), {
    uid,
    text,
    ts: serverTimestamp()
  });

  // stop typing immediately after send
  try { await set(myTypingRef(), false); } catch {}
}

async function leaveRoom({ keepChat = true } = {}) {
  // Stop searching & clear waiting slot if we were waiting
  if (isSearching) {
    isSearching = false;
    await clearWaitingIfMine();
  }

  // Detach listeners
  if (unsubMatch) { safeOff(unsubMatch); unsubMatch = null; }
  detachRoomListeners();

  // Best-effort: delete room (makes chat disappear)
  if (roomId) {
    try { await remove(myTypingRef()); } catch {}
    try { await set(matchRef(), null); } catch {}

    try {
      // Mark inactive first (so peer sees it), then delete node
      await update(roomRef(), { active: false, endedAt: serverTimestamp() });
    } catch {}

    try { await remove(roomRef()); } catch {}
  }

  roomId = null;
  peerUid = null;

  setStatus("Ready");
  setInputEnabled(false);
  setFindEnabled(true);
  btnNext.disabled = true;

  if (!keepChat) clearChat();
  hideTyping();
}

async function endRoomFromRemote() {
  // Room removed by peer
  try { await set(matchRef(), null); } catch {}

  roomId = null;
  peerUid = null;

  detachRoomListeners();

  setStatus("Stranger left");
  setInputEnabled(false);
  setFindEnabled(true);
  btnNext.disabled = true;

  hideTyping();
  addMessage("Stranger disconnected. Press FIND for a new chat.", { system: true });
}

// ---------- Typing handler ----------
function scheduleTypingOff() {
  if (!roomId) return;
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(async () => {
    try { await set(myTypingRef(), false); } catch {}
  }, 900);
}

async function setTypingOn() {
  if (!roomId) return;
  try { await set(myTypingRef(), true); } catch {}
  scheduleTypingOff();
}

// ---------- Events ----------
btnFind.addEventListener("click", startSearch);

btnNext.addEventListener("click", async () => {
  // startSearch() already calls leaveRoom() internally
  await startSearch();
});

sendBtn.addEventListener("click", sendMessage);

inputEl.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    await sendMessage();
    return;
  }
  if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
    await setTypingOn();
  }
});

window.addEventListener("beforeunload", () => {
  // best-effort cleanup (sync not guaranteed)
  try { clearWaitingIfMine(); } catch {}
  try { if (roomId) remove(roomRef()); } catch {}
});
