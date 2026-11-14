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
module.exports = { PI, vreq, findPiRoot };
