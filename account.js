(function () {
  "use strict";

  const FIREBASE_VERSION = "12.16.0";
  const PROFILE_CACHE_PREFIX = "outmaze.profile.v1.";
  const PROFILE_RECOVERY_KEY = "outmaze.profile.recovery.v1";
  const EMOJIS = [
    "😀", "😎", "🤓", "🥳", "🤠", "👻", "🤖", "👽",
    "🐸", "🐱", "🐶", "🦊", "🐼", "🐙", "🦄", "🐲",
    "⚡", "🔥", "🌙", "⭐", "🍀", "🍕", "🎯", "🧩"
  ];
  const config = window.OUTMAZE_CONFIG || {};
  const isLocal = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  const apiBase = isLocal ? location.origin : String(config.apiBase || "").replace(/\/$/, "");
  const elements = {
    overlay: document.getElementById("profileOverlay"),
    close: document.getElementById("closeProfile"),
    signedOut: document.getElementById("profileSignedOut"),
    anonymous: document.getElementById("profileAnonymousSignIn"),
    lead: document.getElementById("profileLead"),
    authStatus: document.getElementById("profileAuthStatus"),
    form: document.getElementById("profileForm"),
    account: document.getElementById("profileAccount"),
    name: document.getElementById("profileNameInput"),
    pin: document.getElementById("profilePinInput"),
    pinHint: document.getElementById("profilePinHint"),
    recover: document.getElementById("profileRecover"),
    emojis: document.getElementById("profileEmojiGrid"),
    saveStatus: document.getElementById("profileSaveStatus"),
    menu: document.getElementById("menuProfile"),
    menuEmoji: document.getElementById("menuProfileEmoji"),
    menuName: document.getElementById("menuProfileName")
  };
  const state = {
    auth: null,
    authApi: null,
    user: null,
    profile: null,
    selectedEmoji: EMOJIS[0],
    initialized: false,
    pendingProfileRequests: []
  };

  function setStatus(element, text, error = false) {
    if (!element) return;
    element.textContent = text || "";
    element.classList.toggle("is-error", Boolean(error));
  }

  function firebaseConfigured() {
    const firebase = config.firebase || {};
    return Boolean(firebase.apiKey && firebase.authDomain && firebase.projectId && firebase.appId);
  }

  function localPlayerId() {
    const requested = new URLSearchParams(location.search).get("devPlayer");
    if (requested) return `local-${requested.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "player"}`;
    let id = localStorage.getItem("outmaze.dev.uid");
    if (!id) {
      id = `local-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
      localStorage.setItem("outmaze.dev.uid", id);
    }
    return id;
  }

  function localUser() {
    const uid = localPlayerId();
    return { uid, email: `${uid}@local.outmaze` };
  }

  function cachedProfile() {
    if (!state.user) return null;
    try {
      const profile = JSON.parse(localStorage.getItem(`${PROFILE_CACHE_PREFIX}${state.user.uid}`) || "null");
      if (!profile?.name || !EMOJIS.includes(profile.emoji)) return null;
      return { uid: state.user.uid, name: String(profile.name), emoji: profile.emoji };
    } catch (_) {
      return null;
    }
  }

  function cachedRecovery() {
    try {
      const recovery = JSON.parse(localStorage.getItem(PROFILE_RECOVERY_KEY) || "null");
      if (!recovery?.name || !EMOJIS.includes(recovery.emoji) || !/^\d{6}$/.test(String(recovery.pin || ""))) return null;
      return { name: String(recovery.name), emoji: recovery.emoji, pin: String(recovery.pin) };
    } catch (_) {
      return null;
    }
  }

  function rememberProfile(profile, recoveryPin = "") {
    if (!state.user || !profile) return;
    try {
      localStorage.setItem(
        `${PROFILE_CACHE_PREFIX}${state.user.uid}`,
        JSON.stringify({ name: profile.name, emoji: profile.emoji })
      );
      const previousRecovery = cachedRecovery();
      const sameRecoveredProfile = previousRecovery?.name.toLocaleLowerCase("en-US") === profile.name.toLocaleLowerCase("en-US");
      const pin = String(recoveryPin || (sameRecoveredProfile ? previousRecovery.pin : "") || "");
      if (/^\d{6}$/.test(pin)) {
        localStorage.setItem(PROFILE_RECOVERY_KEY, JSON.stringify({ name: profile.name, emoji: profile.emoji, pin }));
      }
    } catch (_) {
      // The server remains the source of truth when browser storage is unavailable.
    }
  }

  function renderEmojiGrid() {
    if (!elements.emojis) return;
    elements.emojis.innerHTML = "";
    EMOJIS.forEach((emoji) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "profile-emoji-option";
      button.textContent = emoji;
      button.setAttribute("aria-label", `Choose ${emoji}`);
      button.setAttribute("aria-pressed", String(state.selectedEmoji === emoji));
      button.addEventListener("click", () => {
        state.selectedEmoji = emoji;
        renderEmojiSelection();
      });
      elements.emojis.appendChild(button);
    });
  }

  function renderEmojiSelection() {
    elements.emojis?.querySelectorAll(".profile-emoji-option").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.textContent === state.selectedEmoji));
    });
  }

  function render() {
    const signedIn = Boolean(state.user);
    elements.signedOut?.classList.toggle("hidden", signedIn);
    elements.form?.classList.toggle("hidden", !signedIn);
    elements.anonymous?.classList.toggle("hidden", isLocal || signedIn || !state.initialized);
    if (elements.lead) {
      elements.lead.textContent = "This browser remembers one name and emoji for friend rooms, parties, and Daily leaderboards.";
    }
    if (signedIn) {
      if (elements.account) {
        elements.account.textContent = state.profile?.recoveryReady
          ? "Saved in this browser · your PIN can recover it on another device"
          : "Add a recovery PIN to protect this profile before the browser forgets it";
      }
      const displayedProfile = state.profile || cachedProfile();
      if (elements.name && document.activeElement !== elements.name) elements.name.value = displayedProfile?.name || "";
      state.selectedEmoji = displayedProfile?.emoji || state.selectedEmoji || EMOJIS[0];
      renderEmojiSelection();
      if (elements.pin) elements.pin.required = !state.profile;
      if (elements.pinHint) {
        elements.pinHint.textContent = state.profile
          ? "Leave blank to keep your current PIN, or enter six digits to replace it."
          : "Choose six digits for a new profile, or enter the existing PIN to recover one.";
      }
      elements.recover?.classList.toggle("hidden", Boolean(state.profile));
    }
    if (elements.menuEmoji) elements.menuEmoji.textContent = state.profile?.emoji || "👤";
    if (elements.menuName) elements.menuName.textContent = state.profile?.name || (signedIn ? "Finish profile" : "Create profile");
    elements.menu?.classList.toggle("has-profile", Boolean(state.profile));
  }

  async function token(forceRefresh = false) {
    if (!state.user) return null;
    if (isLocal) return `dev:${state.user.uid}`;
    return state.user.getIdToken(forceRefresh);
  }

  async function api(path, options = {}, authRequired = true) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (authRequired) {
      const idToken = await token();
      if (!idToken) throw Object.assign(new Error("Sign in to continue"), { code: "sign-in-required" });
      headers.set("Authorization", `Bearer ${idToken}`);
    }
    const response = await fetch(`${apiBase}${path}`, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(body.error || "Outmaze could not complete that request"), {
        code: body.code || "request-failed",
        status: response.status
      });
    }
    return body;
  }

  async function loadProfile() {
    if (!state.user) {
      state.profile = null;
      render();
      return null;
    }
    try {
      const result = await api("/api/profile");
      state.profile = result.profile || null;
      if (!state.profile) {
        const recovery = cachedRecovery();
        if (recovery) {
          const restored = await api("/api/profile/recover", {
            method: "POST",
            body: JSON.stringify({ name: recovery.name, emoji: recovery.emoji, recoveryPin: recovery.pin })
          });
          state.profile = restored.profile || null;
        }
      }
      rememberProfile(state.profile);
    } catch (error) {
      if (error.code === "invalid-recovery-pin" || error.code === "profile-not-found") {
        try {
          localStorage.removeItem(PROFILE_RECOVERY_KEY);
        } catch (_) {
          // The recovery form remains available when storage cannot be changed.
        }
      }
      if (error.code !== "profile-required" && error.status !== 404) {
        setStatus(elements.saveStatus, error.message, true);
      }
      state.profile = null;
    }
    render();
    window.dispatchEvent(new CustomEvent("outmaze-profile-changed", { detail: state.profile }));
    return state.profile;
  }

  function resolvePending(profile) {
    const pending = state.pendingProfileRequests.splice(0);
    pending.forEach((resolve) => resolve(profile || null));
  }

  function open() {
    elements.overlay?.classList.remove("hidden");
    render();
    setStatus(elements.saveStatus, "");
    if (state.user && !state.profile) setTimeout(() => elements.name?.focus(), 0);
  }

  function close({ cancelPending = true } = {}) {
    elements.overlay?.classList.add("hidden");
    if (cancelPending) resolvePending(null);
  }

  async function requireProfile() {
    await ready;
    if (state.profile) return state.profile;
    open();
    return new Promise((resolve) => state.pendingProfileRequests.push(resolve));
  }

  async function saveProfile(event) {
    event.preventDefault();
    setStatus(elements.saveStatus, "Saving profile…");
    try {
      const recoveryPin = String(elements.pin?.value || "").trim();
      if (!state.profile && !/^\d{6}$/.test(recoveryPin)) {
        throw new Error("Choose a 6-digit recovery PIN");
      }
      const result = await api("/api/profile", {
        method: "POST",
        body: JSON.stringify({
          name: elements.name?.value || "",
          emoji: state.selectedEmoji,
          ...(recoveryPin ? { recoveryPin } : {})
        })
      });
      state.profile = result.profile;
      rememberProfile(state.profile, recoveryPin);
      if (elements.pin) elements.pin.value = "";
      render();
      setStatus(elements.saveStatus, "Profile saved.");
      window.dispatchEvent(new CustomEvent("outmaze-profile-changed", { detail: state.profile }));
      close({ cancelPending: false });
      resolvePending(state.profile);
    } catch (error) {
      setStatus(elements.saveStatus, error.message, true);
    }
  }

  async function recoverProfile() {
    const recoveryPin = String(elements.pin?.value || "").trim();
    if (!/^\d{6}$/.test(recoveryPin)) {
      setStatus(elements.saveStatus, "Enter your 6-digit recovery PIN", true);
      elements.pin?.focus();
      return;
    }
    setStatus(elements.saveStatus, "Recovering profile…");
    try {
      const result = await api("/api/profile/recover", {
        method: "POST",
        body: JSON.stringify({
          name: elements.name?.value || "",
          emoji: state.selectedEmoji,
          recoveryPin
        })
      });
      state.profile = result.profile;
      rememberProfile(state.profile, recoveryPin);
      if (elements.pin) elements.pin.value = "";
      render();
      setStatus(elements.saveStatus, "Profile recovered.");
      window.dispatchEvent(new CustomEvent("outmaze-profile-changed", { detail: state.profile }));
      close({ cancelPending: false });
      resolvePending(state.profile);
    } catch (error) {
      setStatus(elements.saveStatus, error.message, true);
    }
  }

  async function initialize() {
    renderEmojiGrid();
    if (isLocal) {
      state.user = localUser();
      setStatus(elements.authStatus, "Preparing your browser profile…");
      await loadProfile();
      state.initialized = true;
      setStatus(elements.authStatus, "");
      render();
      return;
    }
    if (!firebaseConfigured()) {
      state.initialized = true;
      setStatus(elements.authStatus, "Browser profiles need their one-time Firebase setup.", true);
      render();
      return;
    }
    const [{ initializeApp }, authApi] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`)
    ]);
    state.authApi = authApi;
    state.auth = authApi.initializeAuth(initializeApp(config.firebase), {
      persistence: [authApi.indexedDBLocalPersistence, authApi.browserLocalPersistence]
    });
    setStatus(elements.authStatus, "Preparing your browser profile…");
    await new Promise((resolve, reject) => {
      let initial = true;
      authApi.onAuthStateChanged(state.auth, async (user) => {
        if (!user) {
          state.user = null;
          state.profile = null;
          render();
          try {
            await authApi.signInAnonymously(state.auth);
          } catch (error) {
            if (initial) reject(error);
            else setStatus(elements.authStatus, error.message, true);
          }
          return;
        }
        state.user = user;
        await loadProfile();
        setStatus(elements.authStatus, "");
        if (initial) {
          initial = false;
          resolve();
        }
      });
    });
    state.initialized = true;
  }

  elements.menu?.addEventListener("click", open);
  elements.close?.addEventListener("click", () => close());
  elements.anonymous?.addEventListener("click", () => location.reload());
  elements.form?.addEventListener("submit", saveProfile);
  elements.recover?.addEventListener("click", recoverProfile);
  elements.overlay?.addEventListener("mousedown", (event) => {
    if (event.target === elements.overlay) close();
  });

  const ready = initialize().catch((error) => {
    state.initialized = true;
    setStatus(elements.authStatus, error.message, true);
    render();
  });

  window.OutmazeAccount = Object.freeze({
    api,
    close,
    getIdToken: token,
    get profile() {
      return state.profile;
    },
    get user() {
      return state.user;
    },
    open,
    ready,
    requireProfile
  });
})();
