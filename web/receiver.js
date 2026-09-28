(() => {
  "use strict";

  const C = window.MirrorCommon;
  const appName = document.getElementById("appName");
  const sessionCodeEl = document.getElementById("sessionCode");
  const copyCodeButton = document.getElementById("copyCodeButton");
  const newSessionButton = document.getElementById("newSessionButton");
  const remoteVideo = document.getElementById("remoteVideo");
  const emptyState = document.getElementById("emptyState");
  const fullscreenButton = document.getElementById("fullscreenButton");
  const audioButton = document.getElementById("audioButton");
  const connectionBadge = document.getElementById("connectionBadge");
  const statusText = document.getElementById("statusText");
  const transportText = document.getElementById("transportText");
  const resolutionText = document.getElementById("resolutionText");
  const diagnostics = document.getElementById("diagnostics");

  let apiBase = "";
  let sessionCode = "";
  let ws = null;
  let pc = null;
  let pendingIceCandidates = [];
  let statsTimer = null;
  let reconnectTimer = null;
  let intentionallyClosing = false;

  if (window.MIRROR_CONFIG?.APP_NAME) {
    appName.textContent = window.MIRROR_CONFIG.APP_NAME;
    document.title = window.MIRROR_CONFIG.APP_NAME;
  }

  function setStatus(message, kind = "waiting") {
    statusText.textContent = message;
    connectionBadge.textContent = message;
    connectionBadge.className = `badge badge-${kind}`;
  }

  function log(message, details) {
    const time = new Date().toLocaleTimeString();
    const suffix = details ? `\n${typeof details === "string" ? details : JSON.stringify(details, null, 2)}` : "";
    diagnostics.textContent = `[${time}] ${message}${suffix}\n\n${diagnostics.textContent}`.slice(0, 12000);
  }

  async function createSession() {
    intentionallyClosing = true;
    cleanupConnection();
    intentionallyClosing = false;

    setStatus("Creating session", "waiting");
    sessionCodeEl.textContent = "———";
    copyCodeButton.disabled = true;

    const response = await fetch(`${apiBase}/api/session`, {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Session request failed (${response.status}).`);

    const data = await response.json();
    sessionCode = C.normalizeSessionCode(data.code);
    if (sessionCode.length !== 10) throw new Error("The signaling service returned an invalid session code.");

    sessionCodeEl.textContent = C.formatSessionCode(sessionCode);
    copyCodeButton.disabled = false;
    log("Created session", { code: C.formatSessionCode(sessionCode) });
    connectSignaling();
  }

  function connectSignaling() {
    if (!sessionCode) return;
    clearTimeout(reconnectTimer);

    const wsUrl = `${C.websocketBase(apiBase)}/ws/${sessionCode}?role=viewer`;
    ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      setStatus("Waiting for iPad", "waiting");
      log("Signaling socket connected");
      sendSignal({ type: "ready" });
    });

    ws.addEventListener("message", async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await handleSignal(msg);
      } catch (error) {
        log("Could not process signaling message", error.message);
      }
    });

    ws.addEventListener("close", (event) => {
      log("Signaling socket closed", { code: event.code, reason: event.reason });
      if (!intentionallyClosing && sessionCode) {
        setStatus("Reconnecting", "warning");
        reconnectTimer = setTimeout(connectSignaling, 1500);
      }
    });

    ws.addEventListener("error", () => {
      log("Signaling socket error");
    });
  }

  function sendSignal(payload) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  async function ensurePeerConnection() {
    if (pc && pc.signalingState !== "closed") return pc;

    const iceConfig = await C.getIceServers(apiBase);
    log("Loaded ICE configuration", { mode: iceConfig.mode, servers: iceConfig.iceServers.map(s => s.urls) });

    pc = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      iceCandidatePoolSize: 4,
    });

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        sendSignal({ type: "ice", candidate: event.candidate });
      }
    });

    pc.addEventListener("track", (event) => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      if (remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream;
      emptyState.hidden = true;
      fullscreenButton.disabled = false;
      audioButton.disabled = false;
      remoteVideo.play().catch(() => {});
      updateResolution();
    });

    pc.addEventListener("connectionstatechange", () => {
      log("Peer connection state", pc.connectionState);
      switch (pc.connectionState) {
        case "connected":
          setStatus("Connected", "connected");
          startStats();
          break;
        case "connecting":
          setStatus("Connecting", "warning");
          break;
        case "disconnected":
          setStatus("Connection interrupted", "warning");
          break;
        case "failed":
          setStatus("Connection failed", "error");
          stopStats();
          break;
        case "closed":
          setStatus("Waiting for iPad", "waiting");
          stopStats();
          break;
      }
    });

    return pc;
  }

  async function handleSignal(msg) {
    switch (msg.type) {
      case "peer-status":
        if (msg.connected) {
          setStatus("iPad found", "warning");
        } else if (!remoteVideo.srcObject) {
          setStatus("Waiting for iPad", "waiting");
        }
        break;

      case "offer": {
        const connection = await ensurePeerConnection();
        await connection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        await flushPendingIce();
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        sendSignal({ type: "answer", sdp: connection.localDescription });
        log("Answered WebRTC offer");
        break;
      }

      case "ice":
        if (!msg.candidate) break;
        if (!pc || !pc.remoteDescription) {
          pendingIceCandidates.push(msg.candidate);
        } else {
          await pc.addIceCandidate(msg.candidate);
        }
        break;

      case "peer-left":
        log("Sender disconnected");
        resetPeerConnection();
        setStatus("Waiting for iPad", "waiting");
        break;

      case "error":
        log("Signaling service error", msg.message || "Unknown signaling error");
        setStatus("Signaling error", "error");
        break;
    }
  }

  async function flushPendingIce() {
    if (!pc?.remoteDescription) return;
    const queued = pendingIceCandidates;
    pendingIceCandidates = [];
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate);
    }
  }

  function resetPeerConnection() {
    stopStats();
    pendingIceCandidates = [];
    if (pc) {
      try { pc.close(); } catch (_) {}
      pc = null;
    }
    remoteVideo.srcObject = null;
    emptyState.hidden = false;
    fullscreenButton.disabled = true;
    audioButton.disabled = true;
    transportText.textContent = "—";
    resolutionText.textContent = "—";
  }

  function cleanupConnection() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (ws) {
      try { ws.close(1000, "New session"); } catch (_) {}
      ws = null;
    }
    resetPeerConnection();
    sessionCode = "";
  }

  function startStats() {
    stopStats();
    updateStats();
    statsTimer = setInterval(updateStats, 2000);
  }

  function stopStats() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
  }

  async function updateStats() {
    try {
      const pair = await C.detectSelectedCandidatePair(pc);
      transportText.textContent = C.candidatePairLabel(pair);
      updateResolution();
    } catch (_) {}
  }

  function updateResolution() {
    if (remoteVideo.videoWidth && remoteVideo.videoHeight) {
      resolutionText.textContent = `${remoteVideo.videoWidth}×${remoteVideo.videoHeight}`;
    }
  }

  copyCodeButton.addEventListener("click", async () => {
    if (!sessionCode) return;
    await navigator.clipboard.writeText(C.formatSessionCode(sessionCode));
    const original = copyCodeButton.textContent;
    copyCodeButton.textContent = "Copied";
    setTimeout(() => { copyCodeButton.textContent = original; }, 1000);
  });

  newSessionButton.addEventListener("click", () => {
    createSession().catch(showFatalError);
  });

  fullscreenButton.addEventListener("click", async () => {
    const target = document.getElementById("videoStage");
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await target.requestFullscreen();
    }
  });

  audioButton.addEventListener("click", () => {
    remoteVideo.muted = !remoteVideo.muted;
    audioButton.textContent = remoteVideo.muted ? "Enable audio" : "Mute audio";
    remoteVideo.play().catch(() => {});
  });

  window.addEventListener("beforeunload", () => {
    intentionallyClosing = true;
    cleanupConnection();
  });

  function showFatalError(error) {
    console.error(error);
    setStatus("Setup error", "error");
    sessionCodeEl.textContent = "ERROR";
    log("Setup error", error.message);
    document.getElementById("sessionHelp").textContent = error.message;
  }

  try {
    apiBase = C.getApiBase();
    createSession().catch(showFatalError);
  } catch (error) {
    showFatalError(error);
  }
})();
