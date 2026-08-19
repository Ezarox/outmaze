(function () {
  "use strict";

  const elements = {
    menuParty: document.getElementById("menuParty"),
    menuDaily: document.getElementById("menuDaily"),
    partyPanel: document.getElementById("partyPanel"),
    partyTitle: document.getElementById("partyTitle"),
    partyStatus: document.getElementById("partyStatus"),
    partyCopyRoom: document.getElementById("partyCopyRoom"),
    partyRoomCode: document.getElementById("partyRoomCode"),
    partyLobbyActions: document.getElementById("partyLobbyActions"),
    partyRoundsField: document.getElementById("partyRoundsField"),
    partyRounds: document.getElementById("partyRounds"),
    partyCreate: document.getElementById("partyCreate"),
    partyRoomInput: document.getElementById("partyRoomInput"),
    partyJoin: document.getElementById("partyJoin"),
    partyMatchActions: document.getElementById("partyMatchActions"),
    partyReady: document.getElementById("partyReady"),
    partyStart: document.getElementById("partyStart"),
    partyEarlyStart: document.getElementById("partyEarlyStart"),
    partyNext: document.getElementById("partyNext"),
    partySkip: document.getElementById("partySkip"),
    partyProgress: document.getElementById("partyProgress"),
    partyRoundLabel: document.getElementById("partyRoundLabel"),
    partyProgressFill: document.getElementById("partyProgressFill"),
    partyRoster: document.getElementById("partyRoster"),
    partyLeave: document.getElementById("partyLeave"),
    partyGallery: document.getElementById("partyGallery"),
    dailyPanel: document.getElementById("dailyPanel"),
    dailyTitle: document.getElementById("dailyTitle"),
    dailyDate: document.getElementById("dailyDate"),
    dailyAiTime: document.getElementById("dailyAiTime"),
    dailyBest: document.getElementById("dailyBest"),
    dailyAttempts: document.getElementById("dailyAttempts"),
    dailyStatus: document.getElementById("dailyStatus"),
    dailyActions: document.getElementById("dailyActions"),
    dailyModify: document.getElementById("dailyModify"),
    dailyBack: document.getElementById("dailyBack"),
    dailyLeaderboard: document.getElementById("dailyLeaderboard")
  };
  let partyAnimation = null;

  for (let rounds = 1; rounds <= 10; rounds++) {
    const option = document.createElement("option");
    option.value = String(rounds);
    option.textContent = `${rounds} round${rounds === 1 ? "" : "s"}`;
    option.selected = rounds === 3;
    elements.partyRounds?.appendChild(option);
  }

  function profileUid() {
    return window.OutmazeAccount?.profile?.uid || null;
  }

  function formatTime(value) {
    return value != null && value !== "" && Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}s` : "--";
  }

  function setPartyStatus(text, error = false) {
    if (!elements.partyStatus) return;
    elements.partyStatus.textContent = text;
    elements.partyStatus.classList.toggle("is-error", Boolean(error));
  }

  function partySelf() {
    return state.party.members.find((member) => member.uid === profileUid()) || null;
  }

  function renderPartyRoster() {
    if (!elements.partyRoster) return;
    elements.partyRoster.innerHTML = "";
    state.party.members.forEach((member) => {
      const card = document.createElement("div");
      card.className = "party-member";
      card.classList.toggle("is-ready", Boolean(member.ready));
      card.classList.toggle("is-early", Boolean(member.early));
      const status = state.party.phase === "lobby"
        ? member.ready ? "Ready" : "Not ready"
        : state.party.phase === "building"
          ? member.early ? "Ready to start" : "Building"
          : member.host ? "Host" : "Party player";
      card.innerHTML = `
        <span class="party-member__emoji" aria-hidden="true"></span>
        <span class="party-member__copy"><strong></strong><small></small></span>
        <span class="party-member__score"></span>`;
      card.querySelector(".party-member__emoji").textContent = member.emoji;
      card.querySelector("strong").textContent = `${member.name}${member.host ? " · Host" : ""}${member.uid === profileUid() ? " · You" : ""}`;
      card.querySelector("small").textContent = status;
      card.querySelector(".party-member__score").textContent = `${Number(member.score || 0).toFixed(Number(member.score || 0) % 1 ? 1 : 0)} pts`;
      elements.partyRoster.appendChild(card);
    });
  }

  function renderParty() {
    const inRoom = Boolean(state.party.room);
    const lobby = inRoom && state.party.phase === "lobby";
    const building = inRoom && state.party.phase === "building";
    const results = inRoom && state.party.phase === "results";
    const self = partySelf();
    const host = Boolean(self?.host);
    const everyoneReady = state.party.members.length >= 2 && state.party.members.every((member) => member.ready);

    elements.partyPanel?.classList.toggle("hidden", !state.party.active);
    elements.partyCopyRoom?.classList.toggle("hidden", !inRoom);
    elements.partyLeave?.classList.toggle("hidden", !inRoom);
    elements.partyLobbyActions?.classList.toggle("hidden", inRoom);
    elements.partyMatchActions?.classList.toggle("hidden", !inRoom);
    elements.partyRoundsField?.classList.toggle("hidden", inRoom && !host);
    if (elements.partyRoomCode) elements.partyRoomCode.textContent = state.party.room || "-----";
    if (elements.partyRounds) {
      elements.partyRounds.value = String(state.party.rounds || 3);
      elements.partyRounds.disabled = inRoom && (!host || !lobby);
    }
    elements.partyReady?.classList.toggle("hidden", !lobby);
    if (elements.partyReady) {
      elements.partyReady.textContent = self?.ready ? "Ready" : "Ready up";
      elements.partyReady.classList.toggle("is-selected", Boolean(self?.ready));
      elements.partyReady.setAttribute("aria-pressed", String(Boolean(self?.ready)));
    }
    elements.partyStart?.classList.toggle("hidden", !lobby || !host);
    if (elements.partyStart) elements.partyStart.disabled = !everyoneReady;
    elements.partyEarlyStart?.classList.toggle("hidden", !building || state.party.locked);
    if (elements.partyEarlyStart) {
      elements.partyEarlyStart.textContent = self?.early ? "Keep building" : "Ready to start early";
      elements.partyEarlyStart.classList.toggle("is-selected", Boolean(self?.early));
      elements.partyEarlyStart.setAttribute("aria-pressed", String(Boolean(self?.early)));
    }
    elements.partyNext?.classList.toggle("hidden", !results || !host);
    elements.partySkip?.classList.toggle("hidden", !results || !partyAnimation || partyAnimation.complete);
    const finalRound = state.party.round >= state.party.rounds;
    if (elements.partyNext) elements.partyNext.textContent = finalRound ? "Play another match" : "Next round";
    elements.partyProgress?.classList.toggle("hidden", !inRoom || lobby);
    if (elements.partyRoundLabel) elements.partyRoundLabel.textContent = `Round ${Math.max(1, state.party.round)} of ${state.party.rounds}`;
    if (elements.partyProgressFill) {
      elements.partyProgressFill.style.width = `${Math.min(100, (state.party.round / Math.max(1, state.party.rounds)) * 100)}%`;
    }
    if (elements.partyTitle) {
      elements.partyTitle.textContent = !inRoom
        ? "Create or join a party"
        : lobby
          ? state.party.members.length < 2 ? "Waiting for more players" : "Party lobby"
          : building
            ? "Build in private"
            : finalRound ? "Final standings" : "Round standings";
    }
    renderPartyRoster();
  }

  function copyRoomCode() {
    if (!state.party.room) return;
    navigator.clipboard?.writeText(state.party.room).then(
      () => setPartyStatus(`Party ${state.party.room} copied.`),
      () => setPartyStatus(`Party code: ${state.party.room}`)
    );
  }

  function resetPartyState() {
    state.party.room = null;
    state.party.phase = "connecting";
    state.party.roundId = null;
    state.party.round = 0;
    state.party.rounds = Number(elements.partyRounds?.value || 3);
    state.party.buildEndsAt = null;
    state.party.locked = false;
    state.party.submitted = false;
    state.party.members = [];
    state.party.results = null;
  }

  async function startPartyFromMenu() {
    const profile = await window.OutmazeAccount?.requireProfile?.();
    if (!profile) return;
    showLoadingOverlay("Opening Party Mode…");
    deactivateModes({ closeSocket: true });
    clearCurrentGameState();
    state.vs.active = false;
    state.party.active = true;
    resetPartyState();
    document.body.classList.add("party-mode");
    hideMainMenu();
    gameBody?.classList.add("hidden");
    resourceToolbar?.classList.add("hidden");
    canvas.classList.add("vs-waiting");
    updatePhaseLabel("Party lobby", "Create a room or join a party code.");
    setVsWaitingTimer();
    elements.partyPanel?.classList.remove("hidden");
    renderParty();
    versusClient.onEvent = handleVsEvent;
    vsConnect(handleVsEvent);
    hideLoadingOverlay();
  }

  function createParty() {
    setPartyStatus("Creating a party…");
    vsSend({ type: "party-create", rounds: Number(elements.partyRounds?.value || 3) });
  }

  function joinParty() {
    const room = String(elements.partyRoomInput?.value || "").trim().toUpperCase();
    if (room.length !== 5) {
      setPartyStatus("Enter the five-character party code.", true);
      return;
    }
    setPartyStatus(`Joining party ${room}…`);
    vsSend({ type: "party-join", room });
  }

  function applyPartyState(event) {
    state.party.room = event.room || state.party.room;
    state.party.phase = event.phase || state.party.phase;
    state.party.roundId = event.roundId ?? state.party.roundId;
    state.party.round = Number(event.round || 0);
    state.party.rounds = Number(event.rounds || state.party.rounds || 3);
    state.party.locked = Boolean(event.locked);
    state.party.members = Array.isArray(event.members) ? event.members : state.party.members;
    renderParty();
  }

  function startPartyBuild(event) {
    stopPartyAnimation();
    state.party.active = true;
    state.party.room = event.room;
    state.party.phase = "building";
    state.party.roundId = event.roundId;
    state.party.round = event.round;
    state.party.rounds = event.rounds;
    state.party.buildEndsAt = event.buildEndsAt;
    state.party.locked = false;
    state.party.submitted = false;
    state.party.results = null;
    state.vs.active = false;
    document.body.classList.add("party-mode");
    document.body.classList.remove("party-racing");
    elements.partyGallery?.classList.add("hidden");
    if (elements.partyGallery) elements.partyGallery.innerHTML = "";
    startGame(event.seed);
    state.party.buildEndsAt = event.buildEndsAt;
    gameBody?.classList.remove("hidden");
    elements.partyPanel?.classList.remove("hidden");
    updatePhaseLabel(`Party round ${event.round}`, "Your design stays private until every maze is submitted.");
    setPartyStatus("Build in private. Everyone has the same seed and deadline.");
    renderParty();
  }

  function submitPartyMaze() {
    if (state.party.submitted) return;
    state.party.submitted = true;
    state.building = false;
    state.buildTimeLeft = 0;
    vsSend({
      type: "party-maze",
      room: state.party.room,
      roundId: state.party.roundId,
      payload: { grid: cloneGrid(state.playerGrid), special: cloneSpecial(state.playerSpecial) }
    });
    updatePhaseLabel("Maze locked", "Waiting for the remaining party mazes.");
    setPartyStatus("Maze verified and queued for the party reveal.");
    renderParty();
  }

  function miniCellColor(cell) {
    const cells = AICore.cells;
    if (cell === cells.STATIC) return "#263a33";
    if (cell === cells.PLAYER) return "#3fe49a";
    if (cell === cells.SINGLE) return "#85b5a4";
    if (cell === cells.SPECIAL) return "#cf9cff";
    if (cell === cells.STATIC_SPECIAL) return "#7c658c";
    if (cell === cells.SPEED || cell === cells.SPEED_USED) return "#cf5d66";
    if (cell === cells.SLOW || cell === cells.SLOW_USED) return "#5d82cf";
    if (cell === cells.DETOUR || cell === cells.DETOUR_USED) return "#d5804b";
    if (cell === cells.STONE || cell === cells.STONE_USED) return "#caa755";
    if (cell === cells.REWIND || cell === cells.REWIND_USED) return "#d85c91";
    return "transparent";
  }

  function drawMiniMaze(item) {
    const canvas = item.canvas;
    const context = item.context;
    const size = 12;
    const pad = 16;
    const board = size * 21;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#050807";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate(pad, pad);
    context.fillStyle = "#080d0b";
    context.fillRect(0, 0, board, board);
    if (item.special?.placed && item.special.cell) {
      const cx = (item.special.cell.x + 0.5) * size;
      const cy = (item.special.cell.y + 0.5) * size;
      context.fillStyle = "rgba(207,156,255,.09)";
      if (item.special.type === "row") context.fillRect(0, cy - size * 0.3, board, size * 0.6);
      else if (item.special.type === "column") context.fillRect(cx - size * 0.3, 0, size * 0.6, board);
      else {
        context.beginPath();
        context.arc(cx, cy, size * (item.special.type === "gravity" ? 5 : 3.5), 0, Math.PI * 2);
        context.fill();
      }
    }
    for (let y = 0; y < 21; y++) {
      for (let x = 0; x < 21; x++) {
        const cell = item.runner.grid[y][x];
        if (cell === AICore.cells.EMPTY) continue;
        context.fillStyle = miniCellColor(cell);
        context.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
      }
    }
    context.strokeStyle = "rgba(255,255,255,.055)";
    context.lineWidth = 1;
    for (let line = 0; line <= 21; line++) {
      context.beginPath();
      context.moveTo(0, line * size);
      context.lineTo(board, line * size);
      context.stroke();
      context.beginPath();
      context.moveTo(line * size, 0);
      context.lineTo(line * size, board);
      context.stroke();
    }
    if (item.runner.worldPos) {
      context.fillStyle = "#ffd35a";
      context.shadowColor = "rgba(255,211,90,.7)";
      context.shadowBlur = 8;
      context.beginPath();
      context.arc(item.runner.worldPos.x * size, item.runner.worldPos.y * size, 3.8, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  function finishPartyItem(item) {
    item.finished = true;
    item.card.classList.add("is-finished");
    item.result.textContent = `#${item.entry.rank} · ${formatTime(item.entry.time)} · +${item.entry.points} pts`;
  }

  function partyAnimationFrame(timestamp) {
    if (!partyAnimation || partyAnimation.complete) return;
    const delta = Math.min(0.05, Math.max(0, (timestamp - partyAnimation.last) / 1000));
    partyAnimation.last = timestamp;
    partyAnimation.accumulator += delta;
    while (partyAnimation.accumulator >= AICore.constants.FIXED_TIMESTEP) {
      partyAnimation.items.forEach((item) => {
        if (!item.runner.finished) AICore.advanceRunnerSimulation(item.runner, AICore.constants.FIXED_TIMESTEP);
        if (item.runner.finished && !item.finished) finishPartyItem(item);
      });
      partyAnimation.accumulator -= AICore.constants.FIXED_TIMESTEP;
    }
    partyAnimation.items.forEach(drawMiniMaze);
    partyAnimation.complete = partyAnimation.items.every((item) => item.finished);
    if (partyAnimation.complete) {
      setPartyStatus(state.party.round >= state.party.rounds ? "Match complete. Final placement points are locked." : "Round complete. The host can begin the next seed.");
      renderParty();
      return;
    }
    partyAnimation.frame = requestAnimationFrame(partyAnimationFrame);
  }

  function stopPartyAnimation() {
    if (partyAnimation?.frame) cancelAnimationFrame(partyAnimation.frame);
    partyAnimation = null;
  }

  function skipPartyRace() {
    if (!partyAnimation) return;
    partyAnimation.items.forEach((item) => {
      if (!item.finished) finishPartyItem(item);
      drawMiniMaze(item);
    });
    partyAnimation.complete = true;
    setPartyStatus(state.party.round >= state.party.rounds ? "Match complete. Final placement points are locked." : "Round complete. The host can begin the next seed.");
    renderParty();
  }

  function startPartyResults(event) {
    stopPartyAnimation();
    state.party.phase = "results";
    state.party.results = event;
    state.party.round = event.round;
    state.party.rounds = event.rounds;
    state.building = false;
    state.race = null;
    document.body.classList.add("party-racing");
    gameBody?.classList.add("hidden");
    elements.partyGallery?.classList.remove("hidden");
    elements.partyGallery.innerHTML = "";
    const items = event.entries.map((entry) => {
      const card = document.createElement("article");
      card.className = "party-maze-card";
      const header = document.createElement("div");
      header.className = "party-maze-card__header";
      const emoji = document.createElement("span");
      emoji.textContent = entry.profile.emoji;
      const name = document.createElement("strong");
      name.textContent = entry.profile.name;
      const result = document.createElement("span");
      result.className = "party-maze-card__result";
      result.textContent = "Running…";
      const canvas = document.createElement("canvas");
      canvas.width = 284;
      canvas.height = 284;
      header.append(emoji, name, result);
      card.append(header, canvas);
      elements.partyGallery.appendChild(card);
      const special = entry.maze.special?.placed ? AICore.cloneSpecial(entry.maze.special) : null;
      return {
        entry,
        card,
        result,
        canvas,
        context: canvas.getContext("2d"),
        special,
        runner: AICore.createRunner(entry.profile.name, AICore.cloneGrid(entry.maze.grid), special, state.baseNeutralSpecials),
        finished: false
      };
    });
    partyAnimation = { items, last: performance.now(), accumulator: 0, complete: false, frame: null };
    items.forEach(drawMiniMaze);
    updatePhaseLabel(`Party round ${event.round} results`, "All mazes are public now. Placement points decide the match.");
    setPartyStatus("Runners released across every submitted maze.");
    renderParty();
    partyAnimation.frame = requestAnimationFrame(partyAnimationFrame);
  }

  function handleServerEvent(event) {
    if (!state.party.active) return;
    if (event.type === "connected") {
      state.party.phase = state.party.room ? state.party.phase : "connected";
      setPartyStatus("Connected. Create a party or enter a room code.");
      renderParty();
      return;
    }
    if (event.type === "disconnected") {
      setPartyStatus(
        event.reason === "idle-timeout"
          ? "This party closed after 10 minutes without activity. Return to the menu to create or join another."
          : event.reason === "authentication-timeout"
            ? "The connection closed because sign-in did not finish in time. Return to the menu and try again."
            : "Disconnected from the party server. Return to the menu and reopen Party Mode.",
        true
      );
      return;
    }
    if (event.type === "profile-required") {
      setPartyStatus("Finish your profile before joining a party.", true);
      window.OutmazeAccount?.open?.();
      return;
    }
    if (event.type === "error") {
      setPartyStatus(event.error || "The party server rejected that request.", true);
      return;
    }
    if (event.type === "party-created" || event.type === "party-joined") {
      state.party.room = event.room;
      state.party.phase = "lobby";
      if (elements.partyRoomInput) elements.partyRoomInput.value = event.room;
      setPartyStatus(event.type === "party-created" ? `Party ${event.room} created. Share the code.` : `Joined party ${event.room}.`);
      renderParty();
      return;
    }
    if (event.type === "party-state") {
      applyPartyState(event);
      return;
    }
    if (event.type === "party-player-joined") {
      setPartyStatus(`${event.profile?.emoji || "👤"} ${event.profile?.name || "A player"} joined the party.`);
      return;
    }
    if (event.type === "party-player-left") {
      setPartyStatus("A player left the party. Scores and readiness were updated.");
      return;
    }
    if (event.type === "party-start") {
      startPartyBuild(event);
      return;
    }
    if (event.type === "party-lock") {
      state.party.locked = true;
      submitPartyMaze();
      return;
    }
    if (event.type === "party-maze-accepted") {
      setPartyStatus(`Maze accepted · ${event.submitted} of ${event.required} submitted.`);
      return;
    }
    if (event.type === "party-results") startPartyResults(event);
  }

  function renderDailyLeaderboard() {
    if (!elements.dailyLeaderboard) return;
    elements.dailyLeaderboard.innerHTML = "";
    const rows = state.daily.challenge?.leaderboard || [];
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "daily-score-row";
      empty.textContent = "No verified scores yet. Set the first one.";
      elements.dailyLeaderboard.appendChild(empty);
      return;
    }
    rows.forEach((row) => {
      const item = document.createElement("li");
      item.className = "daily-score-row";
      item.classList.toggle("is-self", row.uid === profileUid());
      item.innerHTML = `
        <span class="daily-score-row__rank"></span>
        <span class="daily-score-row__emoji"></span>
        <span class="daily-score-row__name"></span>
        <span class="daily-score-row__time"></span>`;
      item.querySelector(".daily-score-row__rank").textContent = `#${row.rank}`;
      item.querySelector(".daily-score-row__emoji").textContent = row.emoji;
      item.querySelector(".daily-score-row__name").textContent = row.name;
      item.querySelector(".daily-score-row__time").textContent = formatTime(row.time);
      elements.dailyLeaderboard.appendChild(item);
    });
  }

  function updateDailyPanel() {
    if (!state.daily.active) return;
    const challenge = state.daily.challenge || {};
    if (elements.dailyDate) elements.dailyDate.textContent = challenge.day || "----";
    if (elements.dailyAiTime) elements.dailyAiTime.textContent = formatTime(challenge.aiTime);
    if (elements.dailyBest) elements.dailyBest.textContent = formatTime(challenge.personalBest);
    if (elements.dailyAttempts) elements.dailyAttempts.textContent = String(challenge.attempts || 0);
    elements.dailyActions?.classList.toggle("hidden", !state.daily.attemptComplete);
    renderDailyLeaderboard();
  }

  async function startDailyFromMenu() {
    const profile = await window.OutmazeAccount?.requireProfile?.();
    if (!profile) return;
    showLoadingOverlay("Loading today’s challenge…");
    try {
      const challenge = await window.OutmazeAccount.api("/api/daily");
      deactivateModes({ closeSocket: true });
      clearCurrentGameState();
      state.vs.active = false;
      state.party.active = false;
      state.daily.active = true;
      state.daily.challenge = challenge;
      state.daily.submitting = false;
      state.daily.attemptComplete = false;
      document.body.classList.add("daily-mode");
      hideMainMenu();
      elements.dailyPanel?.classList.remove("hidden");
      startGame(challenge.seed);
      state.results.ai = Number(challenge.aiTime);
      elements.dailyPanel?.classList.remove("hidden");
      updateDailyPanel();
      updatePhaseLabel("Build today’s maze", `The hidden AI benchmark is ${formatTime(challenge.aiTime)}. Unlimited verified attempts are available.`);
      if (elements.dailyStatus) elements.dailyStatus.textContent = "The AI time is public; its maze remains hidden.";
    } catch (error) {
      window.alert(error.message || "The Daily challenge could not be loaded.");
      showMainMenu();
    } finally {
      hideLoadingOverlay();
    }
  }

  async function completeDailyAttempt(payload) {
    if (!state.daily.active) return null;
    if (elements.dailyStatus) elements.dailyStatus.textContent = "Verifying your maze and runner time…";
    const result = await window.OutmazeAccount.api("/api/daily/submit", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.daily.challenge = {
      ...state.daily.challenge,
      ...result
    };
    state.daily.attemptComplete = true;
    updateDailyPanel();
    if (elements.dailyStatus) {
      const comparison = result.submittedTime > state.daily.challenge.aiTime ? "beat" : "did not beat";
      elements.dailyStatus.textContent = `Verified ${formatTime(result.submittedTime)} · ${comparison} the AI · global rank #${result.rank || "–"}.`;
    }
    return result;
  }

  function showDailyError(error) {
    if (elements.dailyStatus) elements.dailyStatus.textContent = error.message || "This attempt was not saved.";
  }

  function modifyDailyMaze() {
    if (!state.daily.active) return;
    hideResultPopup();
    editAndRetry();
    state.daily.attemptComplete = false;
    elements.dailyActions?.classList.add("hidden");
    if (elements.dailyStatus) elements.dailyStatus.textContent = "Maze reopened. Your saved best remains on the leaderboard.";
    updateDailyPanel();
  }

  function deactivateModes({ closeSocket = false } = {}) {
    const wasParty = state.party.active;
    if (wasParty && state.party.room) vsSend({ type: "party-leave", room: state.party.room });
    stopPartyAnimation();
    state.party.active = false;
    state.daily.active = false;
    document.body.classList.remove("party-mode", "party-racing", "daily-mode");
    elements.partyPanel?.classList.add("hidden");
    elements.dailyPanel?.classList.add("hidden");
    elements.partyGallery?.classList.add("hidden");
    if (elements.partyGallery) elements.partyGallery.innerHTML = "";
    if (closeSocket && wasParty && versusClient.ws) {
      const socket = versusClient.ws;
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      }, 50);
      versusClient.onEvent = null;
      versusClient.pending.length = 0;
    }
  }

  elements.menuParty?.addEventListener("click", startPartyFromMenu);
  elements.menuDaily?.addEventListener("click", startDailyFromMenu);
  elements.partyCreate?.addEventListener("click", createParty);
  elements.partyJoin?.addEventListener("click", joinParty);
  elements.partyCopyRoom?.addEventListener("click", copyRoomCode);
  elements.partyRounds?.addEventListener("change", () => {
    state.party.rounds = Number(elements.partyRounds.value);
    if (state.party.room && partySelf()?.host && state.party.phase === "lobby") {
      vsSend({ type: "party-settings", room: state.party.room, rounds: state.party.rounds });
    }
  });
  elements.partyReady?.addEventListener("click", () => {
    const self = partySelf();
    vsSend({ type: "party-ready", room: state.party.room, ready: !self?.ready });
  });
  elements.partyStart?.addEventListener("click", () => vsSend({ type: "party-start", room: state.party.room }));
  elements.partyEarlyStart?.addEventListener("click", () => {
    const self = partySelf();
    vsSend({
      type: "party-early-start",
      room: state.party.room,
      roundId: state.party.roundId,
      vote: !self?.early
    });
  });
  elements.partyNext?.addEventListener("click", () => {
    vsSend({
      type: "party-next",
      room: state.party.room,
      restart: state.party.round >= state.party.rounds
    });
  });
  elements.partySkip?.addEventListener("click", skipPartyRace);
  elements.partyLeave?.addEventListener("click", showMainMenu);
  elements.dailyModify?.addEventListener("click", modifyDailyMaze);
  elements.dailyBack?.addEventListener("click", showMainMenu);

  window.OutmazeOnline = Object.freeze({
    completeDailyAttempt,
    deactivateModes,
    handleServerEvent,
    showDailyError,
    startDailyFromMenu,
    startPartyFromMenu,
    updateDailyPanel
  });
})();
