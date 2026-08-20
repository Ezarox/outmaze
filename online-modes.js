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
    partyAiControl: document.getElementById("partyAiControl"),
    partyAiCount: document.getElementById("partyAiCount"),
    partyAddAi: document.getElementById("partyAddAi"),
    partyRemoveAi: document.getElementById("partyRemoveAi"),
    partyReady: document.getElementById("partyReady"),
    partyStart: document.getElementById("partyStart"),
    partyEarlyStart: document.getElementById("partyEarlyStart"),
    partyNext: document.getElementById("partyNext"),
    partyCountdown: document.getElementById("partyCountdown"),
    partyProgress: document.getElementById("partyProgress"),
    partyRoundLabel: document.getElementById("partyRoundLabel"),
    partyProgressFill: document.getElementById("partyProgressFill"),
    partyRoster: document.getElementById("partyRoster"),
    partyLeave: document.getElementById("partyLeave"),
    partyGallery: document.getElementById("partyGallery"),
    partyPodium: document.getElementById("partyPodium"),
    partyPodiumPlaces: document.getElementById("partyPodiumPlaces"),
    closePartyPodium: document.getElementById("closePartyPodium"),
    dailyPanel: document.getElementById("dailyPanel"),
    dailyTitle: document.getElementById("dailyTitle"),
    dailyDate: document.getElementById("dailyDate"),
    dailyPrevious: document.getElementById("dailyPrevious"),
    dailyNext: document.getElementById("dailyNext"),
    dailyToday: document.getElementById("dailyToday"),
    dailyAiTime: document.getElementById("dailyAiTime"),
    dailyBest: document.getElementById("dailyBest"),
    dailyAttempts: document.getElementById("dailyAttempts"),
    dailyStatus: document.getElementById("dailyStatus"),
    dailyActions: document.getElementById("dailyActions"),
    dailyCancel: document.getElementById("dailyCancel"),
    dailyModify: document.getElementById("dailyModify"),
    dailyBack: document.getElementById("dailyBack"),
    dailyLeaderboard: document.getElementById("dailyLeaderboard")
  };
  let partyAnimation = null;
  let partyCountdownTimer = null;

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

  function formatPoints(value) {
    const points = Number(value || 0);
    return points.toFixed(points % 1 ? 1 : 0);
  }

  function formatPointLabel(value) {
    const points = Number(value || 0);
    return `${formatPoints(points)} ${points === 1 ? "pt" : "pts"}`;
  }

  function setPartyStatus(text, error = false) {
    if (!elements.partyStatus) return;
    elements.partyStatus.textContent = text;
    elements.partyStatus.classList.toggle("is-error", Boolean(error));
  }

  function clearPartyCountdown() {
    if (partyCountdownTimer) clearInterval(partyCountdownTimer);
    partyCountdownTimer = null;
    elements.partyCountdown?.classList.add("hidden");
  }

  function updatePartyCountdown() {
    const finalRound = state.party.round >= state.party.rounds;
    const visible = state.party.phase === "results" && !finalRound && Boolean(partyAnimation?.complete) && Boolean(state.party.nextRoundAt);
    elements.partyCountdown?.classList.toggle("hidden", !visible);
    if (!visible || !elements.partyCountdown) return;
    const remaining = Math.max(0, Math.ceil((Number(state.party.nextRoundAt) - Date.now()) / 1000));
    elements.partyCountdown.textContent = remaining > 0 ? `Next round in ${remaining}s` : "Starting next round…";
  }

  function startPartyCountdown() {
    clearPartyCountdown();
    updatePartyCountdown();
    partyCountdownTimer = setInterval(updatePartyCountdown, 250);
  }

  function partySelf() {
    return state.party.members.find((member) => member.uid === profileUid()) || null;
  }

  function renderPartyStandings() {
    if (!elements.partyRoster || !partyAnimation) return;
    elements.partyRoster.innerHTML = "";
    elements.partyRoster.classList.remove("is-build-summary");
    elements.partyRoster.classList.add("is-standings");
    elements.partyRoster.setAttribute("aria-label", "Live party standings");

    const heading = document.createElement("div");
    heading.className = "party-standing party-standing--heading";
    heading.innerHTML = "<span>Player</span><span>Time this round</span><span>Placement this round</span><span>Total score</span><span>Overall time</span>";
    elements.partyRoster.appendChild(heading);

    const rows = partyAnimation.items
      .map((item) => {
        const previousTotal = Number(item.entry.totalPoints || 0) - Number(item.entry.points || 0);
        const previousTime = Number(item.entry.totalTime || 0) - Number(item.entry.time || 0);
        return {
          item,
          displayedTotal: item.finished ? Number(item.entry.totalPoints || 0) : previousTotal,
          displayedTime: item.finished ? Number(item.entry.totalTime || 0) : previousTime
        };
      })
      .sort((a, b) =>
        b.displayedTotal - a.displayedTotal ||
        b.displayedTime - a.displayedTime ||
        Number(a.item.entry.slot || 999) - Number(b.item.entry.slot || 999)
      );

    rows.forEach(({ item, displayedTotal, displayedTime }) => {
      const entry = item.entry;
      const row = document.createElement("div");
      row.className = "party-standing";
      row.classList.toggle("is-self", entry.uid === profileUid());
      row.classList.toggle("is-finished", item.finished);
      row.innerHTML = `
        <span class="party-standing__player"><i aria-hidden="true"></i><strong></strong></span>
        <span class="party-standing__time"></span>
        <span class="party-standing__placement"></span>
        <span class="party-standing__total"></span>
        <span class="party-standing__overall"></span>`;
      row.querySelector("i").textContent = entry.profile.emoji;
      row.querySelector("strong").textContent = `${entry.profile.name}${entry.uid === profileUid() ? " · You" : ""}`;
      row.querySelector(".party-standing__time").textContent = item.finished ? formatTime(entry.time) : "Running…";
      row.querySelector(".party-standing__placement").textContent = item.finished
        ? `#${entry.rank} · +${formatPointLabel(entry.points)}`
        : "—";
      row.querySelector(".party-standing__total").textContent = formatPointLabel(displayedTotal);
      row.querySelector(".party-standing__overall").textContent = formatTime(displayedTime);
      elements.partyRoster.appendChild(row);
    });
  }

  function renderPartyRoster() {
    if (!elements.partyRoster) return;
    if (!state.party.room) {
      elements.partyRoster.innerHTML = "";
      elements.partyRoster.classList.remove("is-standings", "is-build-summary");
      elements.partyRoster.setAttribute("aria-label", "Party players");
      return;
    }
    if (state.party.phase === "results" && partyAnimation) {
      renderPartyStandings();
      return;
    }
    if (state.party.phase === "building") {
      elements.partyRoster.innerHTML = "";
      elements.partyRoster.classList.remove("is-standings");
      elements.partyRoster.classList.add("is-build-summary");
      elements.partyRoster.setAttribute("aria-label", "Party build status");
      state.party.members.forEach((member) => {
        const item = document.createElement("div");
        item.className = "party-build-member";
        const status = member.bot
          ? "Ready"
          : state.party.locked || (member.uid === profileUid() && state.party.submitted)
            ? "Locked"
            : member.early ? "Early ready" : "Building";
        item.classList.toggle("is-ready", status !== "Building");
        item.innerHTML = `
          <span class="party-build-member__emoji" aria-hidden="true"></span>
          <strong></strong>
          <small></small>
          <b></b>`;
        item.querySelector(".party-build-member__emoji").textContent = member.emoji;
        item.querySelector("strong").textContent = member.name;
        item.querySelector("small").textContent = status;
        item.querySelector("b").textContent = `${formatPointLabel(member.score)} · ${formatTime(member.totalTime)}`;
        elements.partyRoster.appendChild(item);
      });
      return;
    }
    elements.partyRoster.innerHTML = "";
    elements.partyRoster.classList.remove("is-build-summary");
    elements.partyRoster.classList.add("is-standings");
    elements.partyRoster.setAttribute("aria-label", "Party scoreboard");
    const heading = document.createElement("div");
    heading.className = "party-standing party-standing--heading";
    heading.innerHTML = "<span>Player</span><span>Time this round</span><span>Placement this round</span><span>Total score</span><span>Overall time</span>";
    elements.partyRoster.appendChild(heading);
    state.party.members.forEach((member) => {
      const row = document.createElement("div");
      row.className = "party-standing";
      row.classList.toggle("is-self", member.uid === profileUid());
      row.innerHTML = `
        <span class="party-standing__player"><i aria-hidden="true"></i><strong></strong></span>
        <span class="party-standing__time"></span>
        <span class="party-standing__placement"></span>
        <span class="party-standing__total"></span>
        <span class="party-standing__overall"></span>`;
      row.querySelector("i").textContent = member.emoji;
      row.querySelector("strong").textContent = `${member.name}${member.bot ? " · AI" : ""}${member.host ? " · Host" : ""}${member.uid === profileUid() ? " · You" : ""}`;
      const buildingStatus = member.bot
        ? "Maze ready"
        : state.party.locked || (member.uid === profileUid() && state.party.submitted)
          ? "Maze locked"
          : member.early
            ? "Ready to start"
            : "Building…";
      row.querySelector(".party-standing__time").textContent = state.party.phase === "building" ? buildingStatus : "—";
      row.querySelector(".party-standing__placement").textContent = state.party.phase === "lobby"
        ? member.ready ? "Ready" : "Not ready"
        : "—";
      row.querySelector(".party-standing__total").textContent = formatPointLabel(member.score);
      row.querySelector(".party-standing__overall").textContent = formatTime(member.totalTime);
      elements.partyRoster.appendChild(row);
    });
  }

  function renderParty() {
    const inRoom = Boolean(state.party.room);
    const lobby = inRoom && state.party.phase === "lobby";
    const building = inRoom && state.party.phase === "building";
    const results = inRoom && state.party.phase === "results";
    const self = partySelf();
    const host = Boolean(self?.host);
    const botCount = state.party.members.filter((member) => member.bot).length;
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
      elements.partyReady.disabled = state.party.preparing;
      elements.partyReady.textContent = self?.ready ? "Ready" : "Ready up";
      elements.partyReady.classList.toggle("is-selected", Boolean(self?.ready));
      elements.partyReady.setAttribute("aria-pressed", String(Boolean(self?.ready)));
    }
    elements.partyAiControl?.classList.toggle("hidden", !lobby || !host);
    if (elements.partyAiCount) elements.partyAiCount.textContent = String(botCount);
    if (elements.partyAddAi) {
      elements.partyAddAi.disabled = state.party.preparing || state.party.members.length >= 8;
    }
    if (elements.partyRemoveAi) {
      elements.partyRemoveAi.disabled = state.party.preparing || botCount === 0;
    }
    elements.partyStart?.classList.toggle("hidden", !lobby || !host);
    if (elements.partyStart) elements.partyStart.disabled = !everyoneReady || state.party.preparing;
    elements.partyEarlyStart?.classList.toggle("hidden", !building || state.party.locked);
    if (elements.partyEarlyStart) {
      elements.partyEarlyStart.textContent = self?.early ? "Keep building" : "Ready to start early";
      elements.partyEarlyStart.classList.toggle("is-selected", Boolean(self?.early));
      elements.partyEarlyStart.setAttribute("aria-pressed", String(Boolean(self?.early)));
    }
    const finalRound = state.party.round >= state.party.rounds;
    elements.partyNext?.classList.toggle("hidden", !results || !host || !finalRound);
    if (elements.partyNext) elements.partyNext.disabled = Boolean(results && partyAnimation && !partyAnimation.complete);
    if (elements.partyNext) elements.partyNext.textContent = "Play another match";
    elements.partyProgress?.classList.toggle("hidden", !inRoom || lobby);
    if (elements.partyRoundLabel) elements.partyRoundLabel.textContent = `Round ${Math.max(1, state.party.round)} of ${state.party.rounds}`;
    if (elements.partyProgressFill) {
      elements.partyProgressFill.style.width = `${Math.min(100, (state.party.round / Math.max(1, state.party.rounds)) * 100)}%`;
    }
    if (elements.partyTitle) {
      elements.partyTitle.textContent = !inRoom
        ? "Create or join a party"
        : state.party.preparing
          ? "AI players are building"
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
    state.party.preparing = false;
    state.party.submitted = false;
    state.party.members = [];
    state.party.results = null;
    state.party.liveScores = null;
    state.party.nextRoundAt = null;
    clearPartyCountdown();
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
    state.party.preparing = Boolean(event.preparing);
    state.party.members = Array.isArray(event.members) ? event.members : state.party.members;
    state.party.nextRoundAt = event.nextRoundAt ?? state.party.nextRoundAt;
    renderParty();
  }

  function startPartyBuild(event) {
    stopPartyAnimation();
    clearPartyCountdown();
    hidePartyPodium();
    state.party.active = true;
    state.party.room = event.room;
    state.party.phase = "building";
    state.party.roundId = event.roundId;
    state.party.round = event.round;
    state.party.rounds = event.rounds;
    state.party.buildEndsAt = event.buildEndsAt;
    state.party.locked = false;
    state.party.preparing = false;
    state.party.submitted = false;
    state.party.results = null;
    state.party.liveScores = null;
    state.party.nextRoundAt = null;
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

  function sizeMiniMaze(item) {
    const renderSize = 690;
    if (item.canvas.width !== renderSize || item.canvas.height !== renderSize) {
      item.canvas.width = renderSize;
      item.canvas.height = renderSize;
      item.context = item.canvas.getContext("2d");
    }
    item.previewSized = true;
  }

  function drawMiniMaze(item) {
    if (!item.previewSized) sizeMiniMaze(item);
    window.OutmazeRendering?.renderMazePreview?.(item.context, {
      grid: item.runner.grid,
      special: item.runner.special,
      runner: item.runner,
      neutralSpecials: item.runner.neutralSpecials
    });
  }

  function finishPartyItem(item) {
    if (item.finished) return;
    item.finished = true;
    item.card.classList.remove("is-running");
    item.card.classList.add("is-finished");
    item.result.textContent = formatTime(item.entry.time);
    state.party.liveScores[item.entry.uid] = Number(item.entry.totalPoints || 0);
    updateHud();
    renderPartyRoster();
  }

  function hidePartyPodium() {
    elements.partyPodium?.classList.add("hidden");
  }

  function showPartyPodium() {
    if (!elements.partyPodium || !elements.partyPodiumPlaces || !partyAnimation) return;
    const medals = ["🥇", "🥈", "🥉"];
    const places = partyAnimation.items
      .slice()
      .sort((a, b) =>
        Number(b.entry.totalPoints || 0) - Number(a.entry.totalPoints || 0) ||
        Number(b.entry.totalTime || 0) - Number(a.entry.totalTime || 0) ||
        Number(a.entry.slot || 999) - Number(b.entry.slot || 999)
      )
      .slice(0, 3);
    elements.partyPodiumPlaces.innerHTML = "";
    places.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = `party-podium-place party-podium-place--${index + 1}`;
      row.innerHTML = `
        <span class="party-podium-place__medal" aria-hidden="true"></span>
        <span class="party-podium-place__emoji" aria-hidden="true"></span>
        <strong></strong>
        <b></b>`;
      row.querySelector(".party-podium-place__medal").textContent = medals[index];
      row.querySelector(".party-podium-place__emoji").textContent = item.entry.profile.emoji;
      row.querySelector("strong").textContent = item.entry.profile.name;
      row.querySelector("b").textContent = `${formatPointLabel(item.entry.totalPoints)} · ${formatTime(item.entry.totalTime)}`;
      elements.partyPodiumPlaces.appendChild(row);
    });
    elements.partyPodium.classList.remove("hidden");
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
    partyAnimation.complete = partyAnimation.items.every((item) => item.finished);
    if (partyAnimation.complete || timestamp - partyAnimation.lastDraw >= 1000 / 30) {
      partyAnimation.items.forEach(drawMiniMaze);
      partyAnimation.lastDraw = timestamp;
    }
    if (partyAnimation.complete) {
      setPartyStatus(state.party.round >= state.party.rounds ? "Match complete. Final placement points are locked." : "Round complete. The next seed starts automatically.");
      startPartyCountdown();
      renderParty();
      if (state.party.round >= state.party.rounds) showPartyPodium();
      return;
    }
    partyAnimation.frame = requestAnimationFrame(partyAnimationFrame);
  }

  function stopPartyAnimation() {
    if (partyAnimation?.frame) cancelAnimationFrame(partyAnimation.frame);
    partyAnimation = null;
  }

  function startPartyResults(event) {
    stopPartyAnimation();
    clearPartyCountdown();
    hidePartyPodium();
    state.party.phase = "results";
    state.party.results = event;
    state.party.round = event.round;
    state.party.rounds = event.rounds;
    state.party.nextRoundAt = Number(event.nextRoundAt || 0) || null;
    state.building = false;
    state.race = null;
    document.body.classList.add("party-racing");
    gameBody?.classList.add("hidden");
    elements.partyGallery?.classList.remove("hidden");
    elements.partyGallery.innerHTML = "";
    const orderedEntries = event.entries
      .slice()
      .sort((a, b) => Number(a.slot || 999) - Number(b.slot || 999));
    state.party.liveScores = Object.fromEntries(
      orderedEntries.map((entry) => [
        entry.uid,
        Number(entry.totalPoints || 0) - Number(entry.points || 0)
      ])
    );
    const items = orderedEntries.map((entry) => {
      const card = document.createElement("article");
      card.className = "party-maze-card is-running";
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
      canvas.width = 690;
      canvas.height = 690;
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
    partyAnimation = {
      items,
      last: performance.now(),
      lastDraw: 0,
      accumulator: 0,
      complete: false,
      frame: null
    };
    items.forEach(sizeMiniMaze);
    items.forEach(drawMiniMaze);
    updateHud();
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
    if (event.type === "party-preparing") {
      state.party.preparing = true;
      setPartyStatus(event.bots ? `Generating ${event.bots} distinct AI maze${event.bots === 1 ? "" : "s"}…` : "Preparing the next seed…");
      renderParty();
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
    const isToday = Boolean(challenge.day && challenge.day === challenge.today);
    if (elements.dailyTitle) elements.dailyTitle.textContent = isToday ? "Today’s shared seed" : "Archived shared seed";
    if (elements.dailyDate) {
      elements.dailyDate.value = challenge.day || "";
      elements.dailyDate.min = challenge.archiveStart || "";
      elements.dailyDate.max = challenge.today || "";
      elements.dailyDate.disabled = !challenge.day;
    }
    if (elements.dailyPrevious) elements.dailyPrevious.disabled = !challenge.day || challenge.day <= challenge.archiveStart;
    if (elements.dailyNext) elements.dailyNext.disabled = !challenge.day || challenge.day >= challenge.today;
    if (elements.dailyToday) elements.dailyToday.disabled = !challenge.today || isToday;
    if (elements.dailyAiTime) elements.dailyAiTime.textContent = formatTime(challenge.aiTime);
    if (elements.dailyBest) elements.dailyBest.textContent = formatTime(challenge.personalBest);
    if (elements.dailyAttempts) elements.dailyAttempts.textContent = String(challenge.attempts || 0);
    const canCancel = !state.building && !state.daily.submitting && Boolean(
      state.reveal?.active || (state.race && !state.race.finished)
    );
    elements.dailyActions?.classList.toggle("hidden", !state.daily.attemptComplete && !canCancel);
    elements.dailyCancel?.classList.toggle("hidden", !canCancel);
    elements.dailyModify?.classList.toggle("hidden", !state.daily.attemptComplete);
    renderDailyLeaderboard();
  }

  function shiftDailyDay(day, offset) {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  }

  function applyDailyChallenge(challenge) {
    state.daily.challenge = challenge;
    state.daily.submitting = false;
    state.daily.attemptComplete = false;
    hideResultPopup();
    startGame(challenge.seed);
    state.results.ai = Number(challenge.aiTime);
    elements.dailyPanel?.classList.remove("hidden");
    updateDailyPanel();
    const isToday = challenge.day === challenge.today;
    updatePhaseLabel(
      isToday ? "Build today’s maze" : `Build the ${challenge.day} maze`,
      `The hidden AI benchmark is ${formatTime(challenge.aiTime)}. Unlimited verified attempts are available.`
    );
    if (elements.dailyStatus) {
      elements.dailyStatus.textContent = isToday
        ? "The AI time is public; its maze remains hidden."
        : `Historical challenge ${challenge.day}. Its leaderboard remains open for unlimited attempts.`;
    }
  }

  async function loadDailyDay(day) {
    if (!state.daily.active || !day || state.daily.submitting) return;
    if (day === state.daily.challenge?.day) return;
    showLoadingOverlay("Loading archived challenge…");
    try {
      const challenge = await window.OutmazeAccount.api(`/api/daily?day=${encodeURIComponent(day)}`);
      applyDailyChallenge(challenge);
    } catch (error) {
      if (elements.dailyStatus) elements.dailyStatus.textContent = error.message || "That Daily Challenge could not be loaded.";
      updateDailyPanel();
    } finally {
      hideLoadingOverlay();
    }
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
      document.body.classList.add("daily-mode");
      hideMainMenu();
      elements.dailyPanel?.classList.remove("hidden");
      applyDailyChallenge(challenge);
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
      body: JSON.stringify({ ...payload, day: state.daily.challenge?.day })
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

  function cancelDailyAttempt() {
    const canCancel = state.daily.active && !state.building && !state.daily.submitting && Boolean(
      state.reveal?.active || (state.race && !state.race.finished)
    );
    if (!canCancel) return;
    hideResultPopup();
    editAndRetry();
    state.daily.attemptComplete = false;
    if (elements.dailyStatus) elements.dailyStatus.textContent = "Run cancelled. No time was submitted; your maze is open for editing.";
    updateDailyPanel();
  }

  function deactivateModes({ closeSocket = false } = {}) {
    const wasParty = state.party.active;
    if (wasParty && state.party.room) vsSend({ type: "party-leave", room: state.party.room });
    stopPartyAnimation();
    clearPartyCountdown();
    hidePartyPodium();
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
  elements.partyAddAi?.addEventListener("click", () => {
    vsSend({ type: "party-ai-adjust", room: state.party.room, delta: 1 });
  });
  elements.partyRemoveAi?.addEventListener("click", () => {
    vsSend({ type: "party-ai-adjust", room: state.party.room, delta: -1 });
  });
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
      restart: true
    });
  });
  elements.partyLeave?.addEventListener("click", showMainMenu);
  elements.closePartyPodium?.addEventListener("click", hidePartyPodium);
  elements.partyPodium?.addEventListener("click", (event) => {
    if (event.target === elements.partyPodium) hidePartyPodium();
  });
  elements.dailyCancel?.addEventListener("click", cancelDailyAttempt);
  elements.dailyModify?.addEventListener("click", modifyDailyMaze);
  elements.dailyBack?.addEventListener("click", showMainMenu);
  elements.dailyPrevious?.addEventListener("click", () => {
    if (state.daily.challenge?.day) loadDailyDay(shiftDailyDay(state.daily.challenge.day, -1));
  });
  elements.dailyNext?.addEventListener("click", () => {
    if (state.daily.challenge?.day) loadDailyDay(shiftDailyDay(state.daily.challenge.day, 1));
  });
  elements.dailyToday?.addEventListener("click", () => loadDailyDay(state.daily.challenge?.today));
  elements.dailyDate?.addEventListener("change", () => loadDailyDay(elements.dailyDate.value));
  window.addEventListener("resize", () => {
    partyAnimation?.items.forEach((item) => {
      item.previewSized = false;
      sizeMiniMaze(item);
      drawMiniMaze(item);
    });
  });

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
