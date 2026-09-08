const chokidar = require("chokidar");
const { exec } = require("child_process");
const path = require("path");

const ROOT = process.cwd();

let timer = null;
let deploying = false;

const watcher = chokidar.watch(
  [
    path.join(ROOT, "client"),
    path.join(ROOT, "server", "src")
  ],
  {
    ignored: [
      /node_modules/,
      /dist/,
      /\.git/,
      /\.backup/
    ],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 200
    }
  }
);

console.log("");
console.log("==========================================");
console.log(" HRMS AUTOMATIC CODE DEPLOYMENT");
console.log(" LOCAL = MASTER");
console.log("==========================================");
console.log("");
console.log("Watching client/ and server/src/");
console.log("Waiting for changes...");
console.log("");

function run(command) {
  return new Promise((resolve, reject) => {
    console.log("");
    console.log(">> " + command);

    exec(
      command,
      {
        cwd: ROOT,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 10
      },
      (error, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }
    );
  });
}

async function deployCode() {
  if (deploying) {
    console.log("Deployment already running. Waiting for it to finish.");
    return;
  }

  deploying = true;

  try {
    console.log("");
    console.log("==========================================");
    console.log(" CODE CHANGE DETECTED");
    console.log(" Preparing automatic GitHub deployment");
    console.log("==========================================");

    await run("git status --short");

    await run("git add client server/src");

    await run(
      'git diff --cached --quiet'
    ).catch(async () => {
      await run(
        'git commit -m "Automatic HRMS code update"'
      );
    });

    await run("git push origin main");

    console.log("");
    console.log("==========================================");
    console.log(" AUTOMATIC CODE DEPLOYMENT COMPLETE");
    console.log("==========================================");
    console.log("");
    console.log("GitHub push completed.");
    console.log("The VPS webhook will deploy the new commit.");
    console.log("");
  } catch (error) {
    console.error("");
    console.error("==========================================");
    console.error(" AUTOMATIC DEPLOYMENT FAILED");
    console.error("==========================================");
    console.error(error.message);
    console.error("");
  } finally {
    deploying = false;
  }
}

watcher
  .on("ready", () => {
    console.log(
      `[${new Date().toLocaleTimeString()}] WATCHER READY`
    );
  })
  .on("all", (event, filePath) => {
    console.log(
      `[${new Date().toLocaleTimeString()}] ${event.toUpperCase()}: ${path.relative(ROOT, filePath)}`
    );

    clearTimeout(timer);

    timer = setTimeout(() => {
      deployCode();
    }, 5000);
  })
  .on("error", (error) => {
    console.error("WATCHER ERROR:", error);
  });
