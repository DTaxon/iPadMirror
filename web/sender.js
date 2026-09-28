(() => {
  "use strict";

  const C = window.MirrorCommon;
  const sessionInput = document.getElementById("sessionInput");
  const startButton = document.getElementById("startButton");
  const stopButton = document.getElementById("stopButton");
  const localVideo = document.getElementById("localVideo");
  const emptyState = document.getElementById("emptyState");
  const connectionBadge = document.getElementById("connectionBadge");
  const statusText = document.getElementById("statusText");
  const transportText = document.getElementById("transportText");
  const diagnostics = document.getElementById("diagnostics");

  let apiBase = "";
  let sessionCode = "";
  let ws = null;
  let pc = null;
  let stream = null;
  let pendingIceCandidates = [];
  let statsTimer = null;
  let offerSent = false;

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

  sessionInput.addEventListener("input", () => {
    const cursorAtEnd = sessionInput.selectionStart === sessionInput.value.length;
    sessionInput.value = C.formatSessionCode(sessionInput.value);
    if (cursorAtEnd) sessionInput.setSelectionRange(sessionInput.value.length, sessionInput.value.length);
  });

  startButton.addEventListener("click", () => start().catch(showError));
  stopButton.addEventListener("click", stop);

  async function start() {
    apiBase = C.getApiBase();
    sessionCode = C.normalizeSessionCode(sessionInput.value);
    if (sessionCode.length !== 10) {
      throw new Error("Enter the 10-character session code shown on the receiver.");
    }

    startButton.disabled = true;
    sessionInput.disabled = true;
    setStatus("Choose a screen", "warning");

    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
    });

    localVideo.srcObject = stream;
    emptyState.hidden = true;
    stopButton.disabled = false;

    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => stop());
    }

    await createPeerConnection();
    connectSignaling();
  }

  async function createPeerConnection() {
    const iceConfig = await C.getIceServers(apiBase);
    log("Loaded ICE configuration", { mode: iceConfig.mode, servers: iceConfig.iceServers.map(s => s.urls) });

    pc = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      iceCandidatePoolSize: 4,
    });

    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      if (track.kind === "video") {
        try {
          const parameters = sender.getParameters();
          parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
          parameters.encodings[0].maxBitrate = 6_000_000;
          parameters.degradationPreference = "maintain-resolution";
          await sender.setParameters(parameters);
        } catch (_) {}
      }
    }

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) sendSignal({ type: "ice", candidate: event.candidate });
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
          break;
      }
    });
  }

  function connectSignaling() {
    const wsUrl = `${C.websocketBase(apiBase)}/ws/${sessionCode}?role=sender`;
    ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      setStatus("Waiting for receiver", "warning");
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
      if (stream) setStatus("Signaling disconnected", "error");
    });
  }

  function sendSignal(payload) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  async function maybeSendOffer() {
    if (!pc || offerSent || ws?.readyState !== WebSocket.OPEN) return;
    offerSent = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: "offer", sdp: pc.localDescription });
    log("Sent WebRTC offer");
  }

  async function handleSignal(msg) {
    switch (msg.type) {
      case "welcome":
        if (msg.peerConnected) {
          await maybeSendOffer();
        } else {
          setStatus("Waiting for receiver", "warning");
        }
        break;

      case "peer-status":
        if (msg.connected) {
          await maybeSendOffer();
        }
        break;

      case "answer":
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        await flushPendingIce();
        log("Received WebRTC answer");
        break;

      case "ice":
        if (!msg.candidate) break;
        if (!pc?.remoteDescription) {
          pendingIceCandidates.push(msg.candidate);
        } else {
          await pc.addIceCandidate(msg.candidate);
        }
        break;

      case "peer-left":
        setStatus("Receiver disconnected", "warning");
        log("Receiver disconnected");
        break;

      case "error":
        throw new Error(msg.message || "Signaling service error");
    }
  }

  async function flushPendingIce() {
    if (!pc?.remoteDescription) return;
    const queued = pendingIceCandidates;
    pendingIceCandidates = [];
    for (const candidate of queued) await pc.addIceCandidate(candidate);
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
    } catch (_) {}
  }

  function stop() {
    stopStats();
    if (ws) {
      try { ws.close(1000, "Stopped"); } catch (_) {}
      ws = null;
    }
    if (pc) {
      try { pc.close(); } catch (_) {}
      pc = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    localVideo.srcObject = null;
    emptyState.hidden = false;
    offerSent = false;
    pendingIceCandidates = [];
    sessionCode = "";
    sessionInput.disabled = false;
    startButton.disabled = false;
    stopButton.disabled = true;
    transportText.textContent = "—";
    setStatus("Idle", "waiting");
  }

  function showError(error) {
    console.error(error);
    log("Error", error.message);
    setStatus("Error", "error");
    if (!stream) {
      sessionInput.disabled = false;
      startButton.disabled = false;
    }
  }
})();
