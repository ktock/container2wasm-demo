importScripts("https://cdn.jsdelivr.net/npm/xterm-pty@0.9.4/workerTools.js");

onmessage = (msg) => {
  importScripts("./module.js");
  importScripts("./containers/riscv64-vim-container.js");

  emscriptenHack(new TtyClient(msg.data));
};
