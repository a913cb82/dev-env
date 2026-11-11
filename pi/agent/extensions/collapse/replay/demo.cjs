// Live demo: watch a streaming turn render, frame by frame, through the
// real components + the real extension. Run: node /tmp/live-demo.cjs
const driver = require("./driver.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const PI = await driver.loadPi();
  const world = driver.createWorld(PI, { width: 100 });
  await driver.restore(world, []);
  const show = (tag) => {
    console.log(`\n===== ${tag} =====`);
    console.log(driver.dump(world).text);
  };
  await driver.runLive(world, [{ op: "user", text: "check disk usage" }]);
  show("user speaks");
  await driver.runLive(world, [
    { op: "start", id: "m1" },
    { op: "thinking", id: "m1", text: "Looking at disk usage" },
  ]);
  show("thinking streams (delta 1)");
  await driver.runLive(world, [{ op: "thinking", id: "m1", text: "Looking at disk usage and large directories" }]);
  show("thinking streams (delta 2)");
  await driver.runLive(world, [
    { op: "tool", id: "m1", toolId: "k1", name: "bash", args: { command: "du -sh /var/log" }, partial: true },
  ]);
  show("tool starts (partial, wheel + streaming args)");
  await sleep(1200);
  show("1.2s later (wheel turns, elapsed grows)");
  await driver.runLive(world, [
    { op: "end", id: "m1", stop: "toolUse" },
    { op: "result", toolId: "k1", text: "4.2G\t/var/log" },
    { op: "turn" },
    { op: "tick" },
  ]);
  show("tool completes, turn ends (collapsed header)");
  driver.openRun(world, "k1");
  show("header clicked open (rows + previews + footer)");
  await driver.runLive(world, [{ op: "toggle" }]);
  show("thinking:visible (stock sections restored)");
})().catch((e) => { console.error("FATAL", e); process.exitCode = 1; });
