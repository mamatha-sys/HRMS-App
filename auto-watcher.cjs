const chokidar = require("chokidar");
const path = require("path");

const ROOT = process.cwd();

const watcher = chokidar.watch(
  [
    path.join(ROOT, "client"),
    path.join(ROOT, "server", "src"),
    path.join(ROOT, "server", "data", "hrms.db"),
    path.join(ROOT, "server", "data", "hrms.db-wal"),
    path.join(ROOT, "server", "data", "hrms.db-shm")
  ],
  {
    ignored: [
      /node_modules/,
      /dist/,
      /\.git/,
      /hrms-sync-temp\.db/,
      /\.backup/
    ],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100
    }
  }
);

console.log("");
console.log("==========================================");
console.log(" HRMS AUTOMATIC CHANGE WATCHER");
console.log(" WATCHING LOCAL HRMS");
console.log("==========================================");
console.log("");
console.log("Project:");
console.log(ROOT);
console.log("");
console.log("Waiting for changes...");
console.log("");

watcher
  .on("ready", () => {
    console.log(`[${new Date().toLocaleTimeString()}] WATCHER READY`);
    console.log("");
  })
  .on("all", (event, filePath) => {
    console.log(
      `[${new Date().toLocaleTimeString()}] ${event.toUpperCase()}: ${path.relative(ROOT, filePath)}`
    );
  })
  .on("error", (error) => {
    console.error("WATCHER ERROR:", error);
  });
