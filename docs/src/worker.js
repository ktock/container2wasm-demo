importScripts("https://cdn.jsdelivr.net/npm/xterm-pty@0.9.4/workerTools.js");
importScripts(location.origin + "/src/browser_wasi_shim/index.js");
importScripts(location.origin + "/src/browser_wasi_shim/wasi_defs.js");
importScripts(location.origin + "/src/worker-util.js");
importScripts(location.origin + "/src/wasi-util.js");

onmessage = (msg) => {
    if (serveIfInitMsg(msg)) {
        return;
    }
    var ttyClient = new TtyClient(msg.data);
    var args = [];
    var env = [];
    var fds = [];
    var netParam = getNetParam();
    var listenfd = 3;
    fetchChunks((wasm) => {
        if (!netParam || netParam.mode != 'none') {
            recvCert().then((cert) => {
                var certDir = getCertDir(cert);
                fds = [
                    undefined, // 0: stdin
                    undefined, // 1: stdout
                    undefined, // 2: stderr
                    certDir,   // 3: certificates dir
                    undefined, // 4: socket listenfd
                    undefined, // 5: accepted socket fd (multi-connection is unsupported)
                    // 6...: used by wasi shim
                ];
                args = ['arg0', '--net=socket=listenfd=4', '--mac', genmac()];
                env = [
                    "SSL_CERT_FILE=/.wasmenv/proxy.crt",
                    "https_proxy=http://192.168.127.253:80",
                    "http_proxy=http://192.168.127.253:80",
                    "HTTPS_PROXY=http://192.168.127.253:80",
                    "HTTP_PROXY=http://192.168.127.253:80"
                ];
                listenfd = 4;
                startWasi(wasm, ttyClient, args, env, fds, listenfd, 5);
            });
            return;
        }
        startWasi(wasm, ttyClient, args, env, fds, listenfd, 5);
    });
};

function startWasi(wasm, ttyClient, args, env, fds, listenfd, connfd) {
    var cmd = getArgs();
    if (cmd) {
        var flags = ['-entrypoint', '/bin/sh', '--', '-c', cmd];
        if (args.length > 0) {
            args = args.concat(flags);
        } else {
            args = ['arg0'];
            args = args.concat(flags);
        }
    }
    var wasi = new WASI(args, env, fds);
    wasiHack(wasi, ttyClient, connfd);
    wasiHackSocket(wasi, listenfd, connfd);
    WebAssembly.instantiate(wasm, {
        "wasi_snapshot_preview1": wasi.wasiImport,
    }).then((inst) => {
        wasi.start(inst.instance);
    });
}

function getArgs() {
    var vars = location.search.substring(1).split('&');
    for (var i = 0; i < vars.length; i++) {
        var kv = vars[i].split('=');
        if (decodeURIComponent(kv[0]) == 'args') {
            return decodeURIComponent(kv[1]);
        }
    }
}

// wasiHack patches wasi object for integrating it to xterm-pty.
function wasiHack(wasi, ttyClient, connfd) {
    // definition from wasi-libc https://github.com/WebAssembly/wasi-libc/blob/wasi-sdk-19/expected/wasm32-wasi/predefined-macros.txt
    const ERRNO_INVAL = 28;
    const ERRNO_AGAIN= 6;
    var _fd_read = wasi.wasiImport.fd_read;
    wasi.wasiImport.fd_read = (fd, iovs_ptr, iovs_len, nread_ptr) => {
        if (fd == 0) {
            var buffer = new DataView(wasi.inst.exports.memory.buffer);
            var buffer8 = new Uint8Array(wasi.inst.exports.memory.buffer);
            var iovecs = Iovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
            var nread = 0;
            for (i = 0; i < iovecs.length; i++) {
                var iovec = iovecs[i];
                if (iovec.buf_len == 0) {
                    continue;
                }
                var data = ttyClient.onRead(iovec.buf_len);
                buffer8.set(data, iovec.buf);
                nread += data.length;
            }
            buffer.setUint32(nread_ptr, nread, true);
            return 0;
        } else {
            console.log("fd_read: unknown fd " + fd);
            return _fd_read.apply(wasi.wasiImport, [fd, iovs_ptr, iovs_len, nread_ptr]);
        }
        return ERRNO_INVAL;
    }
    var _fd_write = wasi.wasiImport.fd_write;
    wasi.wasiImport.fd_write = (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
        if ((fd == 1) || (fd == 2)) {
            var buffer = new DataView(wasi.inst.exports.memory.buffer);
            var buffer8 = new Uint8Array(wasi.inst.exports.memory.buffer);
            var iovecs = Ciovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
            var wtotal = 0
            for (i = 0; i < iovecs.length; i++) {
                var iovec = iovecs[i];
                var buf = buffer8.slice(iovec.buf, iovec.buf + iovec.buf_len);
                if (buf.length == 0) {
                    continue;
                }
                ttyClient.onWrite(Array.from(buf));
                wtotal += buf.length;
            }
            buffer.setUint32(nwritten_ptr, wtotal, true);
            return 0;
        } else {
            console.log("fd_write: unknown fd " + fd);
            return _fd_write.apply(wasi.wasiImport, [fd, iovs_ptr, iovs_len, nwritten_ptr]);
        }
        return ERRNO_INVAL;
    }
    wasi.wasiImport.poll_oneoff = (in_ptr, out_ptr, nsubscriptions, nevents_ptr) => {
        if (nsubscriptions == 0) {
            return ERRNO_INVAL;
        }
        let buffer = new DataView(wasi.inst.exports.memory.buffer);
        let in_ = Subscription.read_bytes_array(buffer, in_ptr, nsubscriptions);
        let isReadPollStdin = false;
        let isReadPollConn = false;
        let isClockPoll = false;
        let pollSubStdin;
        let pollSubConn;
        let clockSub;
        let timeout = Number.MAX_VALUE;
        for (let sub of in_) {
            if (sub.u.tag.variant == "fd_read") {
                if ((sub.u.data.fd != 0) && (sub.u.data.fd != connfd)) {
                    console.log("poll_oneoff: unknown fd " + sub.u.data.fd);
                    return ERRNO_INVAL; // only fd=0 and connfd is supported as of now (FIXME)
                }
                if (sub.u.data.fd == 0) {
                    isReadPollStdin = true;
                    pollSubStdin = sub;
                } else {
                    isReadPollConn = true;
                    pollSubConn = sub;
                }
            } else if (sub.u.tag.variant == "clock") {
                if (sub.u.data.timeout < timeout) {
                    timeout = sub.u.data.timeout
                    isClockPoll = true;
                    clockSub = sub;
                }
            } else {
                console.log("poll_oneoff: unknown variant " + sub.u.tag.variant);
                return ERRNO_INVAL; // FIXME
            }
        }
        let events = [];
        if (isReadPollStdin || isReadPollConn || isClockPoll) {
            var readable = false;
            if (isReadPollStdin || (isClockPoll && timeout > 0)) {
                readable = ttyClient.onWaitForReadable(timeout / 1000000000);
            }
            if (readable && isReadPollStdin) {
                let event = new Event();
                event.userdata = pollSubStdin.userdata;
                event.error = 0;
                event.type = new EventType("fd_read");
                events.push(event);
            }
            if (isReadPollConn) {
                var sockreadable = sockWaitForReadable();
                if (sockreadable == errStatus) {
                    return ERRNO_INVAL;
                } else if (sockreadable == true) {
                    let event = new Event();
                    event.userdata = pollSubConn.userdata;
                    event.error = 0;
                    event.type = new EventType("fd_read");
                    events.push(event);
                }
            }
            if (isClockPoll) {
                let event = new Event();
                event.userdata = clockSub.userdata;
                event.error = 0;
                event.type = new EventType("clock");
                events.push(event);
            }
        }
        var len = events.length;
        Event.write_bytes_array(buffer, out_ptr, events);
        buffer.setUint32(nevents_ptr, len, true);
        return 0;
    }
}

function getNetParam() {
    var vars = location.search.substring(1).split('&');
    for (var i = 0; i < vars.length; i++) {
        var kv = vars[i].split('=');
        if (decodeURIComponent(kv[0]) == 'net') {
            return {
                mode: kv[1],
                param: kv[2],
            };
        }
    }
    return null;
}

function genmac(){
    return "02:XX:XX:XX:XX:XX".replace(/X/g, function() {
        return "0123456789ABCDEF".charAt(Math.floor(Math.random() * 16))
    });
}
