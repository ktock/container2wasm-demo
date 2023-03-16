importScripts("https://cdn.jsdelivr.net/npm/xterm-pty@0.9.4/workerTools.js");

onmessage = (msg) => {
  importScripts(location.origin + "/module.js");
  importScripts(location.origin + "/containers/riscv64-node-container.js");

  emscriptenHack(new TtyClient(msg.data));
};
