// Locate the installed Pi release for tests and the replay driver.
// One resolver, because the layout moves between releases: deps were nested
// under the pi package before 1.5.x and are hoisted to the release root after.
const path = require("node:path");
const fs = require("node:fs");

function findPiRoot() {
  if (process.env.PI_ROOT) return process.env.PI_ROOT;
  const install = path.join(process.env.HOME, ".pi/agent/install");
  try {
    const version = fs.readFileSync(path.join(install, "current-version"), "utf8").trim();
    const root = path.join(install, "releases", version, "node_modules/@earendil-works/pi-coding-agent");
    if (fs.existsSync(path.join(root, "dist", "modes"))) return root;
  } catch { /* fall through */ }
  // current-version missing or stale: newest release that has the package.
  try {
    const releases = path.join(install, "releases");
    for (const version of fs.readdirSync(releases).sort().reverse()) {
      const root = path.join(releases, version, "node_modules/@earendil-works/pi-coding-agent");
      if (fs.existsSync(path.join(root, "dist", "modes"))) return root;
    }
  } catch { /* fall through */ }
  throw new Error("test-pi: no Pi install found; set PI_ROOT or run bootstrap");
}

const PI = findPiRoot();
const vreq = (id) => require.resolve(id, { paths: [PI] });

// pi-ai publishes no exports entry, so resolve its dist file directly. The
// dependency layout moves with Pi: try both the hoisted release root and the
// pre-1.5 nested layouts.
function findPiAiRoot() {
  const candidates = [
    path.join(PI, "..", "pi-ai"),
    path.join(PI, "node_modules", "@earendil-works", "pi-ai"),
    path.join(PI, "node_modules", "pi-ai"),
    path.join(PI, "..", "..", "pi-ai"),
  ];
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, "dist", "index.js"))) return root;
  }
  throw new Error("test-pi: no pi-ai install found; set PI_ROOT or check the Pi release");
}

module.exports = { PI, vreq, findPiRoot, findPiAiRoot };
