const form = document.getElementById("configForm");
const stopBtn = document.getElementById("stopBtn");
const scanBtn = document.getElementById("scanBtn");
const connectWalletBtn = document.getElementById("connectWalletBtn");
const walletPanel = document.getElementById("walletPanel");
const privateKeyField = document.getElementById("privateKeyField");
const connectedWallet = document.getElementById("connectedWallet");
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
const PREDICTION_ADDRESS = "0x18b2a687610328590bc8f2e5fedde3b582a49cda";
const ABI = [
  "event BetBull(address indexed sender, uint256 indexed epoch, uint256 amount)",
  "event BetBear(address indexed sender, uint256 indexed epoch, uint256 amount)",
  "event Claim(address indexed sender, uint256 indexed epoch, uint256 amount)",
  "function betBull(uint256 epoch) external payable",
  "function betBear(uint256 epoch) external payable",
  "function currentEpoch() public view returns (uint256)",
  "function claim(uint256[] calldata epochs) external",
  "function claimable(uint256 epoch, address user) public view returns (bool)",
];

const state = {
  mode: "privateKey",
  running: false,
  stopRequested: false,
  provider: null,
  signer: null,
  contract: null,
  walletAddress: "",
  targetAddress: "",
  lastBetEpoch: "-",
  lastCheckedBlock: "-",
  logs: [],
  topWinners: [],
};

function ensureEthers() {
  if (!window.ethers) {
    throw new Error("Ethers browser build belum termuat.");
  }
}

function getMode() {
  return form.elements.mode.value;
}

function readFormValues() {
  return Object.fromEntries(new FormData(form).entries());
}

function getConfigFromForm() {
  const values = readFormValues();

  return {
    mode: getMode(),
    rpcUrl: values.rpcUrl || "",
    privateKey: values.privateKey || "",
    targetAddress: values.targetAddress || "",
    betAmount: values.betAmount || "0.004",
    gasPriceGwei: values.gasPriceGwei || "0.1",
    claimGasPriceGwei: values.claimGasPriceGwei || "3",
    pollingIntervalMs: values.pollingIntervalMs || "3500",
    sleepAfterBetMs: values.sleepAfterBetMs || "210000",
    catchUpBlocks: values.catchUpBlocks || "100",
    autoTarget: form.elements.autoTarget.checked,
    autoClaim: form.elements.autoClaim.checked,
  };
}

function loadStoredConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "{}");

    for (const [name, value] of Object.entries(stored)) {
      const field = form.elements.namedItem(name);
      if (!field) continue;

      if (field.type === "checkbox") {
        field.checked = Boolean(value);
      } else if (field.type === "radio") {
        const radio = form.querySelector(
          `input[name="${name}"][value="${value}"]`,
        );
        if (radio) radio.checked = true;
      } else {
        field.value = value;
      }
    }
  } catch {
    // Ignore malformed local storage.
  }
}

function saveStoredConfig() {
  const values = readFormValues();
  values.autoTarget = form.elements.autoTarget.checked;
  values.autoClaim = form.elements.autoClaim.checked;
  values.mode = getMode();
  localStorage.setItem(storageKey, JSON.stringify(values));
}

function setModeUI() {
  const mode = getMode();
  privateKeyField.classList.toggle("hidden", mode === "walletConnect");
  walletPanel.classList.toggle("hidden", mode !== "walletConnect");
  connectWalletBtn.disabled = mode !== "walletConnect";
  connectWalletBtn.textContent = state.walletAddress
    ? "Reconnect Wallet"
    : "Connect Wallet";
}

function pushLog(level, message, meta = {}) {
  state.logs.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level,
    message,
    meta,
    timestamp: new Date().toISOString(),
  });
  state.logs = state.logs.slice(0, 200);
  renderLogs(state.logs);
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

function syncLocalStatus() {
  updateStatus({
    running: state.running,
    walletAddress: state.walletAddress,
    targetAddress: state.targetAddress,
    lastBetEpoch: state.lastBetEpoch,
    lastCheckedBlock: state.lastCheckedBlock,
    logs: state.logs,
    topWinners: state.topWinners,
  });
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
  if (getMode() === "walletConnect" && state.running) {
    syncLocalStatus();
    return;
  }

  const payload = await requestJSON("/api/status");
  updateStatus(payload);
}

function toNumberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function validateConfig(config) {
  if (config.mode === "privateKey") {
    if (!config.rpcUrl) {
      throw new Error("RPC URL wajib diisi untuk mode private key.");
    }

    if (!config.privateKey) {
      throw new Error("Private key wajib diisi untuk mode private key.");
    }
  }

  if (!config.autoTarget && !config.targetAddress) {
    throw new Error("Target address wajib diisi jika auto target dimatikan.");
  }
}

async function connectWallet() {
  ensureEthers();

  if (!window.ethereum) {
    throw new Error("MetaMask atau wallet injected tidak ditemukan.");
  }

  const provider = new window.ethers.BrowserProvider(window.ethereum);
  let accounts;

  try {
    accounts = await provider.send("eth_requestAccounts", []);
  } catch (error) {
    if (error?.code === 4001) {
      throw new Error("Akses wallet ditolak oleh user.");
    }

    throw new Error(error?.message || "Gagal meminta akses wallet.");
  }

  if (!accounts?.length) {
    throw new Error("Wallet tidak mengembalikan akun.");
  }

  state.provider = provider;
  state.signer = await provider.getSigner();
  state.walletAddress = await state.signer.getAddress();
  connectedWallet.textContent = state.walletAddress;

  const network = await provider.getNetwork();
  if (network.chainId !== 56n) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x38" }],
      });
    } catch {
      pushLog(
        "warn",
        "Wallet terhubung, tapi jaringan bukan BSC. Silakan switch ke BSC (chainId 56).",
      );
    }
  }

  if (window.ethereum.on && !window.__pksWalletListenerInstalled) {
    window.ethereum.on("accountsChanged", (accounts) => {
      state.walletAddress = accounts?.[0] || "";
      connectedWallet.textContent = state.walletAddress || "Not connected";
      setModeUI();
      syncLocalStatus();
    });

    window.__pksWalletListenerInstalled = true;
  }

  setModeUI();
  syncLocalStatus();
}

function buildBrowserContract() {
  ensureEthers();

  if (!state.signer) {
    throw new Error("Wallet belum terhubung.");
  }

  return new window.ethers.Contract(PREDICTION_ADDRESS, ABI, state.signer);
}

async function getGasPrice(provider, fallbackGwei) {
  const feeData = await provider.getFeeData();
  if (feeData.gasPrice) {
    return feeData.gasPrice;
  }

  return window.ethers.parseUnits(String(fallbackGwei), "gwei");
}

async function scanWinnersLocal(provider) {
  ensureEthers();
  const contract = new window.ethers.Contract(
    PREDICTION_ADDRESS,
    ABI,
    provider,
  );
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 3000);

  const [bulls, bears, claims] = await Promise.all([
    contract.queryFilter("BetBull", fromBlock),
    contract.queryFilter("BetBear", fromBlock),
    contract.queryFilter("Claim", fromBlock),
  ]);

  const data = {};

  [...bulls, ...bears].forEach((log) => {
    const address = log.args.sender;
    if (!data[address]) data[address] = { played: 0, won: 0 };
    data[address].played++;
  });

  claims.forEach((log) => {
    const address = log.args.sender;
    if (data[address]) data[address].won++;
  });

  return Object.entries(data)
    .map(([address, stats]) => ({
      address,
      played: stats.played,
      won: stats.won,
      winRate: parseFloat(((stats.won / stats.played) * 100).toFixed(2)),
    }))
    .filter((winner) => winner.played >= 5)
    .sort((a, b) => b.winRate - a.winRate);
}

async function loadWinners(config) {
  if (getMode() === "walletConnect") {
    if (!state.provider) {
      throw new Error("Connect wallet dulu sebelum scan di mode browser.");
    }

    state.topWinners = await scanWinnersLocal(state.provider);
  } else {
    const payload = await requestJSON("/api/scan", {
      method: "POST",
      body: JSON.stringify(config),
    });

    state.topWinners = payload.winners || [];
  }

  renderWinners(state.topWinners);
  return state.topWinners;
}

async function resolveTargetAddress(config) {
  if (!config.autoTarget) {
    return config.targetAddress;
  }

  const winners = await loadWinners(config);
  if (!winners.length) {
    throw new Error("Tidak ada target yang lolos scanner.");
  }

  return winners[0].address;
}

async function waitWithStop(ms) {
  const step = 500;

  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    if (state.stopRequested) return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(step, ms - elapsed)),
    );
  }
}

async function runBrowserSession(config) {
  ensureEthers();

  if (!state.signer) {
    await connectWallet();
  }

  state.running = true;
  state.stopRequested = false;
  state.logs = [];
  state.lastBetEpoch = "-";
  state.lastCheckedBlock = "-";
  pushLog("info", "Session browser dimulai.");

  const provider = state.provider;
  const signer = state.signer;
  const contract = buildBrowserContract();
  const walletAddress = await signer.getAddress();

  state.walletAddress = walletAddress;
  connectedWallet.textContent = walletAddress;

  try {
    const targetAddress = await resolveTargetAddress(config);
    state.targetAddress = targetAddress;
    pushLog("success", "Target siap dipantau.", { targetAddress });

    let lastBetEpoch = 0n;
    let lastCheckedBlock = await provider.getBlockNumber();
    state.lastCheckedBlock = lastCheckedBlock;

    while (!state.stopRequested) {
      let currentBlock = lastCheckedBlock;

      try {
        currentBlock = await provider.getBlockNumber();

        if (currentBlock > lastCheckedBlock) {
          const startBlock = Math.max(lastCheckedBlock + 1, currentBlock - 100);
          const [bullEvents, bearEvents] = await Promise.all([
            contract.queryFilter("BetBull", startBlock, currentBlock),
            contract.queryFilter("BetBear", startBlock, currentBlock),
          ]);

          const events = [
            ...bullEvents.map((event) => ({ position: "BULL", event })),
            ...bearEvents.map((event) => ({ position: "BEAR", event })),
          ].sort(
            (left, right) => left.event.blockNumber - right.event.blockNumber,
          );

          for (const item of events) {
            if (state.stopRequested) break;

            if (
              item.event.args.sender.toLowerCase() !==
                targetAddress.toLowerCase() ||
              BigInt(item.event.args.epoch) <= lastBetEpoch
            ) {
              continue;
            }

            pushLog("warn", "Target match detected.", {
              position: item.position,
              sender: item.event.args.sender,
              epoch: item.event.args.epoch.toString(),
            });

            const betAmount = window.ethers.parseUnits(
              String(config.betAmount),
              "ether",
            );
            const gasPrice = await getGasPrice(provider, config.gasPriceGwei);
            const tx =
              item.position === "BULL"
                ? await contract.betBull(item.event.args.epoch, {
                    value: betAmount,
                    gasPrice,
                    gasLimit: 400000,
                  })
                : await contract.betBear(item.event.args.epoch, {
                    value: betAmount,
                    gasPrice,
                    gasLimit: 400000,
                  });

            pushLog("info", "Transaction dikirim.", { hash: tx.hash });
            await tx.wait();

            lastBetEpoch = BigInt(item.event.args.epoch);
            state.lastBetEpoch = lastBetEpoch.toString();
            pushLog("success", "Bet berhasil dikonfirmasi.", {
              epoch: state.lastBetEpoch,
            });

            await waitWithStop(toNumberValue(config.sleepAfterBetMs, 210000));
          }

          lastCheckedBlock = currentBlock;
          state.lastCheckedBlock = currentBlock;
        }

        if (config.autoClaim && currentBlock % 80 === 0) {
          const claimableEpochs = [];
          const currentEpoch = await contract.currentEpoch();
          const epochValue = BigInt(currentEpoch);
          const scanDepth = Math.min(5, Number(epochValue));

          for (let i = 1; i <= scanDepth; i++) {
            const checkEpoch = epochValue - BigInt(i);
            const isClaimable = await contract.claimable(
              checkEpoch,
              walletAddress,
            );

            if (isClaimable) {
              claimableEpochs.push(checkEpoch);
            }
          }

          if (claimableEpochs.length) {
            pushLog("warn", "Claimable round ditemukan.", {
              claimableEpochs: claimableEpochs.map((value) => value.toString()),
            });

            const gasPrice = await getGasPrice(
              provider,
              config.claimGasPriceGwei,
            );
            const tx = await contract.claim(claimableEpochs, { gasPrice });
            pushLog("info", "Claim transaction dikirim.", { hash: tx.hash });
            await tx.wait();
            pushLog("success", "Claim berhasil.");
          }
        }
      } catch (error) {
        pushLog("error", "Polling error.", { error: error.message });
      }

      syncLocalStatus();
      await waitWithStop(toNumberValue(config.pollingIntervalMs, 3500));
    }
  } finally {
    state.running = false;
    pushLog("info", "Session browser dihentikan.");
    syncLocalStatus();
  }
}

async function startPrivateKeyBot(config) {
  await requestJSON("/api/start", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveStoredConfig();

  try {
    const config = getConfigFromForm();
    validateConfig(config);

    if (config.mode === "walletConnect") {
      await runBrowserSession(config);
    } else {
      await startPrivateKeyBot(config);
    }

    await refreshStatus();
  } catch (error) {
    pushLog("error", "Bot gagal dijalankan.", { error: error.message });
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    if (getMode() === "walletConnect") {
      state.stopRequested = true;
      pushLog("info", "Stop signal dikirim ke browser session.");
    } else {
      await requestJSON("/api/stop", {
        method: "POST",
        body: JSON.stringify({}),
      });
    }

    await refreshStatus();
  } catch (error) {
    pushLog("error", "Bot gagal dihentikan.", { error: error.message });
  }
});

scanBtn.addEventListener("click", async () => {
  try {
    saveStoredConfig();
    const config = getConfigFromForm();

    if (getMode() === "privateKey") {
      if (!config.rpcUrl) {
        throw new Error("RPC URL wajib diisi untuk scan mode private key.");
      }
    } else if (!state.provider) {
      throw new Error("Connect wallet dulu sebelum scan di mode browser.");
    }

    await loadWinners(config);
    await refreshStatus();
  } catch (error) {
    pushLog("error", "Scan winners gagal.", { error: error.message });
  }
});

connectWalletBtn.addEventListener("click", async () => {
  try {
    await connectWallet();
  } catch (error) {
    pushLog("error", "Wallet connect gagal.", { error: error.message });
  }
});

form.elements.mode.forEach((radio) => {
  radio.addEventListener("change", () => {
    state.mode = getMode();
    setModeUI();
    refreshStatus().catch(() => {});
  });
});

setInterval(() => {
  refreshStatus().catch(() => {});
}, 4000);

loadStoredConfig();
state.mode = getMode();
setModeUI();
refreshStatus().catch(() => {
  updateStatus({
    running: false,
    lastError: "Server belum siap.",
    logs: [],
    topWinners: [],
  });
});
