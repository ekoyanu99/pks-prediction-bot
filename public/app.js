const form = document.getElementById("configForm");
const stopBtn = document.getElementById("stopBtn");
const scanBtn = document.getElementById("scanBtn");
const logStream = document.getElementById("logStream");
const winnerList = document.getElementById("winnerList");

const runState = document.getElementById("runState");
const statusMeta = document.getElementById("statusMeta");
const walletValue = document.getElementById("walletValue");
const targetValue = document.getElementById("targetValue");
const epochValue = document.getElementById("epochValue");
const blockValue = document.getElementById("blockValue");
const winnerCount = document.getElementById("winnerCount");

const storageKey = "pks-prediction-bot-config";

function readFormValues() {
  const formData = new FormData(form);
  return Object.fromEntries(formData.entries());
}

function applyStoredValues() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "{}");

    for (const [name, value] of Object.entries(stored)) {
      const field = form.elements.namedItem(name);
      if (!field) continue;

      if (field.type === "checkbox") {
        field.checked = Boolean(value);
      } else {
        field.value = value;
      }
    }
  } catch {
    // Ignore malformed local storage.
  }
}

function persistValues() {
  const values = readFormValues();
  values.autoTarget = form.elements.autoTarget.checked;
  values.autoClaim = form.elements.autoClaim.checked;
  localStorage.setItem(storageKey, JSON.stringify(values));
}

function renderLogs(logs = []) {
  logStream.innerHTML = logs
    .map(
      (entry) => `
        <article class="log ${entry.level}">
          <span>${new Date(entry.timestamp).toLocaleTimeString()}</span>
          <p>${entry.message}</p>
          <small>${entry.level}</small>
        </article>
      `,
    )
    .join("");
}

function renderWinners(winners = []) {
  winnerCount.textContent = `${winners.length} results`;
  winnerList.innerHTML = winners.length
    ? winners
        .slice(0, 8)
        .map(
          (winner, index) => `
            <div class="winner">
              <div>
                <strong>#${index + 1} ${winner.address.slice(0, 8)}...${winner.address.slice(-6)}</strong>
                <p>${winner.played} plays, ${winner.won} wins</p>
              </div>
              <span>${winner.winRate}%</span>
            </div>
          `,
        )
        .join("")
    : '<div class="empty">No winners loaded yet.</div>';
}

function updateStatus(status) {
  runState.textContent = status.running ? "Running" : "Idle";
  statusMeta.textContent = status.running
    ? `Watching ${status.targetAddress || "-"}`
    : status.lastError || "Waiting for configuration";

  walletValue.textContent = status.walletAddress || "-";
  targetValue.textContent = status.targetAddress || "-";
  epochValue.textContent = status.lastBetEpoch || "-";
  blockValue.textContent = status.lastCheckedBlock ?? "-";

  renderLogs(status.logs || []);
  renderWinners(status.topWinners || []);
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }

  return payload;
}

async function refreshStatus() {
  const payload = await requestJSON("/api/status");
  updateStatus(payload);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  persistValues();

  const data = readFormValues();
  data.autoTarget = form.elements.autoTarget.checked;
  data.autoClaim = form.elements.autoClaim.checked;

  if (!data.betAmount) data.betAmount = "0.004";
  if (!data.gasPriceGwei) data.gasPriceGwei = "0.1";
  if (!data.claimGasPriceGwei) data.claimGasPriceGwei = "3";
  if (!data.pollingIntervalMs) data.pollingIntervalMs = "3500";
  if (!data.sleepAfterBetMs) data.sleepAfterBetMs = "210000";
  if (!data.catchUpBlocks) data.catchUpBlocks = "100";

  await requestJSON("/api/start", {
    method: "POST",
    body: JSON.stringify(data),
  });

  await refreshStatus();
});

stopBtn.addEventListener("click", async () => {
  await requestJSON("/api/stop", { method: "POST", body: JSON.stringify({}) });
  await refreshStatus();
});

scanBtn.addEventListener("click", async () => {
  persistValues();
  const data = readFormValues();
  data.autoTarget = form.elements.autoTarget.checked;

  const payload = await requestJSON("/api/scan", {
    method: "POST",
    body: JSON.stringify(data),
  });

  renderWinners(payload.winners || []);
});

setInterval(() => {
  refreshStatus().catch(() => {
    // Keep the dashboard quiet on brief network hiccups.
  });
}, 4000);

applyStoredValues();
refreshStatus().catch(() => {
  updateStatus({
    running: false,
    lastError: "Server belum siap.",
    logs: [],
    topWinners: [],
  });
});
