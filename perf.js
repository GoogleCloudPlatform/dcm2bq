const util = require("util");
const { DEBUG_MODE } = require("./utils");

const HOT_SPOT_MIN = 100; // amount in ms to determine if there's a hot spot

function getStackLine(rewind) {
  const stackRewind = rewind || 0;
  const stack = new Error().stack;
  const line0 = stack.split("\n")[stackRewind + 1];
  const sub0 = line0.indexOf("/");
  const sub1 = line0.lastIndexOf(":");
  return line0.substring(sub0, sub1);
}

class PerfCtx {
  constructor(id, name) {
    this.id = id || Math.floor(Math.random() * 10000);
    this.name = name || `perf_${this.id}`;
    this.start = Date.now();
    this.stack = [{ ref: getStackLine(2), ts: 0, name: "create" }];
    this.length = 1;
  }

  addRef(name) {
    const ticks = Date.now() - this.start;
    const entry = { ref: getStackLine(2), ts: ticks };
    if (name) {
      entry.name = name;
    }
    if (ticks - this.stack[this.stack.length - 1].ts > HOT_SPOT_MIN) {
      entry.hot = true;
    }
    this.stack.push(entry);
    this.length = this.stack.length;
  }

  print() {
    if (DEBUG_MODE) {
      // const output = util.inspect(this.get(), { showHidden: false, depth: null, colors: true });
      const output = JSON.stringify(this.get());
      console.log(output);
    }
  }

  get() {
    return { id: this.id, name: this.name, start: this.start, stack: this.stack };
  }
}

module.exports = { PerfCtx };
