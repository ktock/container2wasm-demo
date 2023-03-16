# container2wasm demo

Page: https://ktock.github.io/container2wasm-demo/

Demo page of running Linux-based containers on browser using [container2wasm](https://github.com/ktock/container2wasm).

## Building images

Run `./create-images.sh`

container2wasm needs to be available on the host.

## License

Apache License Version 2.0.

Additionally, this repository relies on third-pirty softwares:

- Bootstrap ([MIT License](https://github.com/twbs/bootstrap/blob/main/LICENSE)): https://github.com/twbs/bootstrap
- xterm-pty ([MIT License](https://github.com/mame/xterm-pty/blob/main/LICENSE.txt)): https://github.com/mame/xterm-pty
- xterm.js ([MIT License](https://github.com/xtermjs/xterm.js/blob/master/LICENSE)): https://github.com/xtermjs/xterm.js
- coi-serviceworker.js([MIT License](https://github.com/gzuidhof/coi-serviceworker/blob/master/LICENSE)): https://github.com/gzuidhof/coi-serviceworker
- container2wasm-genearted images:
  - Containers
    - `riscv64/alpine`-based containers: https://pkgs.alpinelinux.org/packages
    - `riscv64/debian`-based containers: see `/usr/share/doc/*/copyright`
  - Other dependencies(emulator, etc): https://github.com/ktock/container2wasm#acknowledgement
