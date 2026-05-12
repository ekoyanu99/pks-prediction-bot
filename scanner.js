const { ethers } = require("ethers");

const PREDICTION_ADDRESS = "0x18b2a687610328590bc8f2e5fedde3b582a49cda";
const ABI = [
  "event BetBull(address indexed sender, uint256 indexed epoch, uint256 amount)",
  "event BetBear(address indexed sender, uint256 indexed epoch, uint256 amount)",
  "event Claim(address indexed sender, uint256 indexed epoch, uint256 amount)",
];

async function findTopWinners(provider) {
  const contract = new ethers.Contract(PREDICTION_ADDRESS, ABI, provider);
  const currentBlock = await provider.getBlockNumber();

  // Scan sekitar 3000 block (~2.5 jam di BSC, bukan 5 jam karena blocktime BSC 3 detik)
  const fromBlock = Math.max(0, currentBlock - 3000);

  console.log(
    `[SCANNER] Scanning dari block ${fromBlock} ke ${currentBlock}...`,
  );

  try {
    const [bulls, bears, claims] = await Promise.all([
      contract.queryFilter("BetBull", fromBlock),
      contract.queryFilter("BetBear", fromBlock),
      contract.queryFilter("Claim", fromBlock),
    ]);

    let data = {};

    [...bulls, ...bears].forEach((log) => {
      const addr = log.args.sender;
      if (!data[addr]) data[addr] = { played: 0, won: 0 };
      data[addr].played++;
    });

    claims.forEach((log) => {
      const addr = log.args.sender;
      if (data[addr]) data[addr].won++;
    });

    return Object.entries(data)
      .map(([address, stats]) => {
        const wr = (stats.won / stats.played) * 100;
        return {
          address,
          played: stats.played,
          won: stats.won,
          winRate: parseFloat(wr.toFixed(2)), // Simpan sebagai Number
        };
      })
      .filter((u) => u.played >= 5) // FILTER: Min 5x main & Min 50% Win Rate
      .sort((a, b) => b.winRate - a.winRate);
  } catch (error) {
    console.error("[SCANNER ERROR] Gagal menarik data logs:", error.message);
    return [];
  }
}

module.exports = { findTopWinners };
