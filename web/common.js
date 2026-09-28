(() => {
  "use strict";

  const cfg = window.MIRROR_CONFIG || {};

  function getApiBase() {
    const raw = String(cfg.API_BASE || "").trim().replace(/\/$/, "");
    if (!raw || raw.includes("YOUR-WORKER")) {
      throw new Error("Set MIRROR_CONFIG.API_BASE in web/config.js to your deployed Cloudflare Worker URL.");
    }
    return raw;
  }

  function websocketBase(apiBase) {
    const u = new URL(apiBase);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString().replace(/\/$/, "");
  }

  function normalizeSessionCode(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, "")
      .slice(0, 10);
  }

  function formatSessionCode(value) {
    const clean = normalizeSessionCode(value);
    return clean.length > 5 ? `${clean.slice(0, 5)}-${clean.slice(5)}` : clean;
  }

  async function getIceServers(apiBase) {
    const response = await fetch(`${apiBase}/api/ice`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`ICE server request failed (${response.status}).`);
    }
    const data = await response.json();
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      throw new Error("ICE server response did not contain any ICE servers.");
    }
    return data;
  }

  async function detectSelectedCandidatePair(pc) {
    if (!pc) return null;
    const stats = await pc.getStats();
    let selectedPair = null;
    let localCandidate = null;
    let remoteCandidate = null;

    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        selectedPair = stats.get(report.selectedCandidatePairId) || selectedPair;
      }
      if (report.type === "candidate-pair" && report.selected) {
        selectedPair = report;
      }
    });

    if (!selectedPair) return null;
    localCandidate = stats.get(selectedPair.localCandidateId);
    remoteCandidate = stats.get(selectedPair.remoteCandidateId);

    return {
      state: selectedPair.state || "unknown",
      localType: localCandidate?.candidateType || "unknown",
      remoteType: remoteCandidate?.candidateType || "unknown",
      protocol: localCandidate?.protocol || remoteCandidate?.protocol || "unknown",
      localAddress: localCandidate?.address || "",
      remoteAddress: remoteCandidate?.address || "",
    };
  }

  function candidatePairLabel(pair) {
    if (!pair) return "—";
    const relayed = pair.localType === "relay" || pair.remoteType === "relay";
    const path = relayed ? "TURN relay" : "Direct P2P";
    return `${path} (${pair.protocol.toUpperCase()})`;
  }

  window.MirrorCommon = Object.freeze({
    getApiBase,
    websocketBase,
    normalizeSessionCode,
    formatSessionCode,
    getIceServers,
    detectSelectedCandidatePair,
    candidatePairLabel,
  });
})();
