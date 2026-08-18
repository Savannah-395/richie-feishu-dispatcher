import { config } from "./config.js";
import { runSyncOnce } from "./skill-sync.js";

runSyncOnce(config.sync, "manual").catch((error) => {
  console.error("[richie-sync] manual run failed", error);
  process.exitCode = 1;
});
