const { EventEmitter } = require("events");
const { ethers } = require("ethers");
const { findTopWinners } = require("./scanner");

const PREDICTION_ADDRESS = "0x18b2a687610328590bc8f2e5fedde3b582a49cda";
const ABI = [
  "event BetBull(address indexed sender, uint256 indexed epoch, uint256 amount)",
  "event BetBear(address indexed sender, uint256 indexed epoch, uint256 amount)",
  "function betBull(uint256 epoch) external payable",
  "function betBear(uint256 epoch) external payable",
  "function currentEpoch() public view returns (uint256)",
  "function claim(uint256[] calldata epochs) external",
  "function claimable(uint256 epoch, address user) public view returns (bool)",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(address) {
  if (!address) return null;

  try {
    return ethers.getAddress(address);
  } catch {
    return null;
  }
}

async function retryAsync(
  operation,
  { retries = 3, delayMs = 1000, label = "operation" } = {},
) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        await sleep(delayMs * attempt);
      }
    }
  }

  const message =
    lastError?.reason || lastError?.message || `Failed to complete ${label}`;
  throw new Error(message);
}

class PredictionBot extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      rpcUrl: "",
      privateKey: "",
      targetAddress: "",
      betAmount: "0.004",
      gasPriceGwei: "0.1",
      claimGasPriceGwei: "3",
      autoTarget: false,
      autoClaim: true,
      pollingIntervalMs: 3500,
      sleepAfterBetMs: 210000,
      catchUpBlocks: 100,
      scanBlocks: 3000,
      eventChunkSize: 100,
      gasLimit: 400000,
      ...config,
    };

    this.provider = null;
    this.wallet = null;
    this.contract = null;
    this.walletAddress = null;
    this.targetAddress = null;
    this.running = false;
    this.stopRequested = false;
    this.lastBetEpoch = 0n;
    this.lastCheckedBlock = 0;
    this.logs = [];
    this.topWinners = [];
  }

  log(level, message, meta = {}) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      level,
      message,
      meta,
      timestamp: new Date().toISOString(),
    };

    this.logs.unshift(entry);
    this.logs = this.logs.slice(0, 200);
    this.emit("log", entry);
    return entry;
  }

  updateConfig(nextConfig = {}) {
    this.config = { ...this.config, ...nextConfig };
  }

  validateConfig() {
    const rpcUrl = (this.config.rpcUrl || "").trim();
    const privateKey = (this.config.privateKey || "").trim();

    if (!rpcUrl) {
      throw new Error("RPC URL wajib diisi.");
    }

    if (!privateKey) {
      throw new Error("Private key wajib diisi.");
    }

    if (privateKey.length < 32) {
      throw new Error("Private key tidak valid.");
    }

    if (!this.config.autoTarget) {
      const targetAddress = normalizeAddress(this.config.targetAddress);
      if (!targetAddress) {
        throw new Error("Target address tidak valid.");
      }

      this.config.targetAddress = targetAddress;
    }

    if (!this.config.betAmount || Number(this.config.betAmount) <= 0) {
      throw new Error("Bet amount harus lebih besar dari 0.");
    }
  }

  async initialize() {
    this.validateConfig();

    this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    await retryAsync(() => this.provider.getBlockNumber(), {
      retries: 3,
      delayMs: 1200,
      label: "provider initialization",
    });

    this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);
    this.walletAddress = this.wallet.address;
    this.contract = new ethers.Contract(PREDICTION_ADDRESS, ABI, this.wallet);
    this.log("info", "Koneksi wallet dan kontrak siap.", {
      walletAddress: this.walletAddress,
    });
  }

  async resolveTargetAddress() {
    if (this.config.autoTarget) {
      this.log("info", "Mencari target address terbaik dari scanner.");
      const winners = await retryAsync(() => findTopWinners(this.provider), {
        retries: 2,
        delayMs: 1500,
        label: "winner scan",
      });

      this.topWinners = winners;

      if (!winners.length) {
        throw new Error("Tidak ada target yang lolos filter scanner.");
      }

      this.targetAddress = winners[0].address;
      this.log("success", "Target otomatis dipilih.", {
        targetAddress: this.targetAddress,
        winRate: winners[0].winRate,
      });
      return this.targetAddress;
    }

    this.targetAddress = normalizeAddress(this.config.targetAddress);
    if (!this.targetAddress) {
      throw new Error("Target address tidak valid.");
    }

    this.log("info", "Target manual dipakai.", {
      targetAddress: this.targetAddress,
    });
    return this.targetAddress;
  }

  async getGasPrice(fallbackGwei) {
    const feeData = await retryAsync(() => this.provider.getFeeData(), {
      retries: 2,
      delayMs: 1000,
      label: "gas fee lookup",
    });

    if (feeData.gasPrice) {
      return feeData.gasPrice;
    }

    return ethers.parseUnits(String(fallbackGwei), "gwei");
  }

  async handleBet(position, sender, epoch) {
    const target = this.targetAddress.toLowerCase();
    const currentEpoch = BigInt(epoch);

    if (this.stopRequested) return false;

    if (sender.toLowerCase() !== target || currentEpoch <= this.lastBetEpoch) {
      return false;
    }

    this.log("warn", "Target match detected.", {
      sender,
      position,
      epoch: currentEpoch.toString(),
    });

    const betAmount = ethers.parseUnits(String(this.config.betAmount), "ether");
    const gasPrice = await this.getGasPrice(this.config.gasPriceGwei);

    const tx =
      position === "BULL"
        ? await this.contract.betBull(currentEpoch, {
            value: betAmount,
            gasPrice,
            gasLimit: this.config.gasLimit,
          })
        : await this.contract.betBear(currentEpoch, {
            value: betAmount,
            gasPrice,
            gasLimit: this.config.gasLimit,
          });

    this.log("info", "Transaction dikirim.", { hash: tx.hash });
    await tx.wait();

    this.lastBetEpoch = currentEpoch;
    this.log("success", "Bet berhasil dikonfirmasi.", {
      epoch: currentEpoch.toString(),
      position,
    });
    return true;
  }

  async autoClaim() {
    if (!this.config.autoClaim) return;

    try {
      const currentEpoch = await retryAsync(
        () => this.contract.currentEpoch(),
        {
          retries: 2,
          delayMs: 1000,
          label: "current epoch lookup",
        },
      );

      const claimableEpochs = [];
      const epochValue = BigInt(currentEpoch);
      const scanDepth = Math.min(5, Number(epochValue));

      for (let i = 1; i <= scanDepth; i++) {
        const checkEpoch = epochValue - BigInt(i);
        const isClaimable = await retryAsync(
          () => this.contract.claimable(checkEpoch, this.walletAddress),
          { retries: 2, delayMs: 900, label: "claimable check" },
        );

        if (isClaimable) {
          claimableEpochs.push(checkEpoch);
        }
      }

      if (!claimableEpochs.length) return;

      this.log("warn", "Claimable round ditemukan.", {
        claimableEpochs: claimableEpochs.map((value) => value.toString()),
      });

      const gasPrice = await this.getGasPrice(this.config.claimGasPriceGwei);
      const tx = await this.contract.claim(claimableEpochs, { gasPrice });
      this.log("info", "Claim transaction dikirim.", { hash: tx.hash });
      await tx.wait();
      this.log("success", "Claim berhasil.");
    } catch (error) {
      this.log("error", "Claim gagal.", { error: error.message });
    }
  }

  async catchUp() {
    const currentBlock = await retryAsync(
      () => this.provider.getBlockNumber(),
      {
        retries: 2,
        delayMs: 1000,
        label: "current block lookup",
      },
    );

    const lookbackBlock = Math.max(
      0,
      currentBlock - Number(this.config.catchUpBlocks),
    );
    const currentEpoch = await retryAsync(() => this.contract.currentEpoch(), {
      retries: 2,
      delayMs: 1000,
      label: "catch-up epoch lookup",
    });

    const [bullEvents, bearEvents] = await Promise.all([
      retryAsync(
        () => this.contract.queryFilter("BetBull", lookbackBlock, currentBlock),
        {
          retries: 2,
          delayMs: 1000,
          label: "catch-up bull scan",
        },
      ),
      retryAsync(
        () => this.contract.queryFilter("BetBear", lookbackBlock, currentBlock),
        {
          retries: 2,
          delayMs: 1000,
          label: "catch-up bear scan",
        },
      ),
    ]);

    const target = this.targetAddress.toLowerCase();
    const bullMatch = bullEvents.find(
      (event) =>
        event.args.sender.toLowerCase() === target &&
        event.args.epoch.toString() === currentEpoch.toString(),
    );
    const bearMatch = bearEvents.find(
      (event) =>
        event.args.sender.toLowerCase() === target &&
        event.args.epoch.toString() === currentEpoch.toString(),
    );

    if (bullMatch) {
      return this.handleBet(
        "BULL",
        bullMatch.args.sender,
        bullMatch.args.epoch,
      );
    }

    if (bearMatch) {
      return this.handleBet(
        "BEAR",
        bearMatch.args.sender,
        bearMatch.args.epoch,
      );
    }

    this.log("info", "Tidak ada bet target pada epoch saat ini.");
    return false;
  }

  async scanBlockWindow(startBlock, endBlock) {
    const [bullEvents, bearEvents] = await Promise.all([
      retryAsync(
        () => this.contract.queryFilter("BetBull", startBlock, endBlock),
        {
          retries: 2,
          delayMs: 1000,
          label: "bull scan",
        },
      ),
      retryAsync(
        () => this.contract.queryFilter("BetBear", startBlock, endBlock),
        {
          retries: 2,
          delayMs: 1000,
          label: "bear scan",
        },
      ),
    ]);

    const events = [
      ...bullEvents.map((event) => ({ position: "BULL", event })),
      ...bearEvents.map((event) => ({ position: "BEAR", event })),
    ];

    return events.sort((left, right) => {
      if (left.event.blockNumber !== right.event.blockNumber) {
        return left.event.blockNumber - right.event.blockNumber;
      }

      return left.event.index - right.event.index;
    });
  }

  async monitorLoop() {
    this.lastCheckedBlock = await retryAsync(
      () => this.provider.getBlockNumber(),
      {
        retries: 2,
        delayMs: 1000,
        label: "initial monitoring block",
      },
    );
    this.log("info", "Monitoring dimulai.", { block: this.lastCheckedBlock });

    while (!this.stopRequested) {
      try {
        const currentBlock = await retryAsync(
          () => this.provider.getBlockNumber(),
          {
            retries: 2,
            delayMs: 1000,
            label: "monitoring block lookup",
          },
        );

        if (currentBlock > this.lastCheckedBlock) {
          let startBlock = this.lastCheckedBlock + 1;
          if (
            currentBlock - this.lastCheckedBlock >
            Number(this.config.eventChunkSize)
          ) {
            startBlock = Math.max(
              0,
              currentBlock - Number(this.config.eventChunkSize),
            );
            this.log(
              "warn",
              "Terlalu banyak block tertinggal, melompat ke range terbaru.",
              {
                startBlock,
                currentBlock,
              },
            );
          }

          const events = await this.scanBlockWindow(startBlock, currentBlock);

          for (const item of events) {
            const executed = await this.handleBet(
              item.position,
              item.event.args.sender,
              item.event.args.epoch,
            );

            if (executed) {
              this.log("info", "Menunggu setelah bet berhasil.", {
                sleepAfterBetMs: this.config.sleepAfterBetMs,
              });

              await this.waitWithStop(this.config.sleepAfterBetMs);
              this.lastCheckedBlock = await retryAsync(
                () => this.provider.getBlockNumber(),
                {
                  retries: 2,
                  delayMs: 1000,
                  label: "resume block lookup",
                },
              );

              break;
            }
          }

          this.lastCheckedBlock = currentBlock;

          if (currentBlock % 80 === 0) {
            await this.autoClaim();
          }
        }
      } catch (error) {
        this.log("error", "Polling error.", { error: error.message });
        this.lastCheckedBlock = await retryAsync(
          () => this.provider.getBlockNumber(),
          {
            retries: 2,
            delayMs: 1000,
            label: "error recovery block lookup",
          },
        );
      }

      await this.waitWithStop(this.config.pollingIntervalMs);
    }
  }

  async waitWithStop(durationMs) {
    const step = 500;

    for (let elapsed = 0; elapsed < durationMs; elapsed += step) {
      if (this.stopRequested) return;
      await sleep(Math.min(step, durationMs - elapsed));
    }
  }

  async start(nextConfig = {}) {
    if (this.running) {
      throw new Error("Bot sudah berjalan.");
    }

    this.updateConfig(nextConfig);
    this.stopRequested = false;
    this.topWinners = [];
    this.lastBetEpoch = 0n;

    await this.initialize();
    await this.resolveTargetAddress();

    this.running = true;
    this.log("success", "Bot siap berjalan.", {
      walletAddress: this.walletAddress,
      targetAddress: this.targetAddress,
    });

    try {
      await this.catchUp();
      await this.monitorLoop();
    } finally {
      this.running = false;
      this.stopRequested = false;
      this.log("info", "Bot berhenti.");
    }
  }

  async stop() {
    this.stopRequested = true;
    this.running = false;
    this.log("info", "Stop signal diterima.");
  }

  getStatus() {
    return {
      running: this.running,
      walletAddress: this.walletAddress,
      targetAddress: this.targetAddress,
      lastBetEpoch: this.lastBetEpoch.toString(),
      lastCheckedBlock: this.lastCheckedBlock,
      autoTarget: Boolean(this.config.autoTarget),
      autoClaim: Boolean(this.config.autoClaim),
      logs: this.logs,
      topWinners: this.topWinners,
      config: {
        rpcUrl: this.config.rpcUrl,
        betAmount: this.config.betAmount,
        gasPriceGwei: this.config.gasPriceGwei,
        claimGasPriceGwei: this.config.claimGasPriceGwei,
        pollingIntervalMs: this.config.pollingIntervalMs,
        sleepAfterBetMs: this.config.sleepAfterBetMs,
        catchUpBlocks: this.config.catchUpBlocks,
        scanBlocks: this.config.scanBlocks,
      },
    };
  }

  async scanWinners() {
    if (!this.provider) {
      this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    }

    const winners = await retryAsync(() => findTopWinners(this.provider), {
      retries: 2,
      delayMs: 1500,
      label: "winner scan",
    });

    this.topWinners = winners;
    return winners;
  }
}

module.exports = { PredictionBot, PREDICTION_ADDRESS, normalizeAddress };
