const fs = require("fs");
const L = fs.readFileSync("app/(main)/task/[id]/page.tsx", "utf8").split(/\n/);
L.forEach((x, i) => {
  if (x.includes("ws-title") || x.includes("ws-progress") || x.includes("tprog")) {
    console.log((i + 1) + "|" + x.trim().slice(0, 110));
  }
});