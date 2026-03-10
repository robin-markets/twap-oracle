import "dotenv/config";
import express from "express";
import { loadConfig } from "./config.js";
import { createTwapRouter } from "./routes/twap.js";

const config = loadConfig();

const app = express();
app.use(express.json());

app.use("/twap", createTwapRouter(config));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(config.port, () => {
  console.log(`Robin TWAP Oracle listening on port ${config.port}`);
  console.log(`  Vault:  ${config.vaultAddress}`);
  console.log(`  Chain:  ${config.chainId}`);
});
