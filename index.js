require("dotenv").config();
const { createServer } = require("./server");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

const defaultConfig = {
  rpcUrl: process.env.RPC_URL || "",
  privateKey: process.env.PRIVATE_KEY || "",
  targetAddress: process.env.TARGET_ADDRESS || "",
  betAmount: process.env.BET_AMOUNT || "0.004",
  autoTarget: process.env.AUTO_TARGET === "true",
  autoClaim: process.env.AUTO_CLAIM !== "false",
};

const { server } = createServer(defaultConfig);

server.listen(PORT, HOST, () => {
  console.log(`PKS Prediction Bot dashboard running at http://${HOST}:${PORT}`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
