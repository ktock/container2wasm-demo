importScripts("https://cdn.jsdelivr.net/npm/xterm-pty@0.9.4/workerTools.js");

onmessage = (msg) => {
  importScripts(location.origin + "/container2wasm-demo/module.js");
  importScripts(location.origin + "/container2wasm-demo/containers/riscv64-debian-container.js");

  emscriptenHack(new TtyClient(msg.data));
};
