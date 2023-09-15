var streamCtrl;
var streamStatus;
var streamLen;
var streamData;
function registerSocketBuffer(shared){
    streamCtrl = new Int32Array(shared, 0, 1);
    streamStatus = new Int32Array(shared, 4, 1);
    streamLen = new Int32Array(shared, 8, 1);
    streamData = new Uint8Array(shared, 12);
}

var imagename;
var numchunks;
function serveIfInitMsg(msg) {
    const req_ = msg.data;
    if (typeof req_ == "object"){
        if (req_.type == "init") {
            if (req_.buf) {
                var shared = req_.buf;
                registerSocketBuffer(shared);
            }
            if (req_.imagename)
                imagename = req_.imagename;
            numchunks = req_.chunks;
            return true;
        }
    }

    return false;
}

function getImagename() {
    return imagename;
}

// fetchChunks fetches specified number of consecutive chunks and
// passes the concatinated array buffer to the callback.
function fetchChunks(f) {
    var prefix = imagename;
    var chunks = numchunks;
    var format = s => prefix + s + '.wasm';
    var files = [];
    for (i = 0; i < chunks; i++) {
        var s = i.toString();
        while (s.length < 2) s = "0" + s;
        files[i] = s;
    }
    files = files.map(format);
    var list = [];
    files.forEach(file => list.push(fetch(file)));
    var results = [];
    var blob;
    Promise.all(list).then(resps => {
        resps.forEach(r => results.push(r['arrayBuffer']()));
        Promise.all(results).then(ab => {
            blob = new Blob(ab);
            blob.arrayBuffer().then(f);
        })
    });
}

const errStatus = {
    val: 0,
};

function sockAccept(){
    streamCtrl[0] = 0;
    postMessage({type: "accept"});
    Atomics.wait(streamCtrl, 0, 0);
    return streamData[0] == 1;
}
function sockSend(data){
    streamCtrl[0] = 0;
    postMessage({type: "send", buf: data});
    Atomics.wait(streamCtrl, 0, 0);
    if (streamStatus[0] < 0) {
        errStatus.val = streamStatus[0]
        return errStatus;
    }
}
function sockRecv(len){
    streamCtrl[0] = 0;
    postMessage({type: "recv", len: len});
    Atomics.wait(streamCtrl, 0, 0);
    if (streamStatus[0] < 0) {
        errStatus.val = streamStatus[0]
        return errStatus;
    }
    let ddlen = streamLen[0];
    var res = streamData.slice(0, ddlen);
    return res;
}

function sockWaitForReadable(timeout){
    streamCtrl[0] = 0;
    postMessage({type: "recv-is-readable", timeout: timeout});
    Atomics.wait(streamCtrl, 0, 0);
    if (streamStatus[0] < 0) {
        errStatus.val = streamStatus[0]
        return errStatus;
    }
    return streamData[0] == 1;
}

function sendCert(data){
    streamCtrl[0] = 0;
    postMessage({type: "send_cert", buf: data});
    Atomics.wait(streamCtrl, 0, 0);
    if (streamStatus[0] < 0) {
        errStatus.val = streamStatus[0]
        return errStatus;
    }
}

function recvCert(){
    var buf = new Uint8Array(0);
    return new Promise((resolve, reject) => {
        function getCert(){
            streamCtrl[0] = 0;
            postMessage({type: "recv_cert"});
            Atomics.wait(streamCtrl, 0, 0);
            if (streamStatus[0] < 0) {
                setTimeout(getCert, 100);
                return;
            }
            var ddlen = streamLen[0];
            buf = appendData(buf, streamData.slice(0, ddlen));
            if (streamStatus[0] == 0) {
                resolve(buf); // EOF
            } else {
                setTimeout(getCert, 0);
                return;
            }
        }
        getCert();
    });
}

function appendData(data1, data2) {
    buf2 = new Uint8Array(data1.byteLength + data2.byteLength);
    buf2.set(new Uint8Array(data1), 0);
    buf2.set(new Uint8Array(data2), data1.byteLength);
    return buf2;
}

function getCertDir(cert) {
    var certDir = new PreopenDirectory("/.wasmenv", {
        "proxy.crt": new File(cert)
    });
    var _path_open = certDir.path_open;
    certDir.path_open = (e, r, s, n, a, d) => {
        var ret = _path_open.apply(certDir, [e, r, s, n, a, d]);
        if (ret.fd_obj != null) {
            var o = ret.fd_obj;
            ret.fd_obj.fd_pread = (view8, iovs, offset) => {
                var old_offset = o.file_pos;
                var r = o.fd_seek(offset, WHENCE_SET);
                if (r.ret != 0) {
                    return { ret: -1, nread: 0 };
                }
                var read_ret = o.fd_read(view8, iovs);
                r = o.fd_seek(old_offset, WHENCE_SET);
                if (r.ret != 0) {
                    return { ret: -1, nread: 0 };
                }
                return read_ret;
            }
        }
        return ret;
    }
    certDir.dir.contents["."] = certDir.dir;
    return certDir;
}

function wasiHackSocket(wasi, listenfd, connfd) {
    // definition from wasi-libc https://github.com/WebAssembly/wasi-libc/blob/wasi-sdk-19/expected/wasm32-wasi/predefined-macros.txt
    const ERRNO_INVAL = 28;
    const ERRNO_AGAIN= 6;
    var connfdUsed = false;
    var connbuf = new Uint8Array(0);
    var _fd_close = wasi.wasiImport.fd_close;
    wasi.wasiImport.fd_close = (fd) => {
        if (fd == connfd) {
            connfdUsed = false;
            return 0;
        }
        return _fd_close.apply(wasi.wasiImport, [fd]);
    }
    var _fd_read = wasi.wasiImport.fd_read;
    wasi.wasiImport.fd_read = (fd, iovs_ptr, iovs_len, nread_ptr) => {
        if (fd == connfd) {
            return wasi.wasiImport.sock_recv(fd, iovs_ptr, iovs_len, 0, nread_ptr, 0);
        }
        return _fd_read.apply(wasi.wasiImport, [fd, iovs_ptr, iovs_len, nread_ptr]);
    }
    var _fd_write = wasi.wasiImport.fd_write;
    wasi.wasiImport.fd_write = (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
        if (fd == connfd) {
            return wasi.wasiImport.sock_send(fd, iovs_ptr, iovs_len, 0, nwritten_ptr);
        }
        return _fd_write.apply(wasi.wasiImport, [fd, iovs_ptr, iovs_len, nwritten_ptr]);
    }
    var _fd_fdstat_get = wasi.wasiImport.fd_fdstat_get;
    wasi.wasiImport.fd_fdstat_get = (fd, fdstat_ptr) => {
        if ((fd == listenfd) || (fd == connfd) && connfdUsed){
            let buffer = new DataView(wasi.inst.exports.memory.buffer);
            // https://github.com/WebAssembly/WASI/blob/snapshot-01/phases/snapshot/docs.md#-fdstat-struct
            buffer.setUint8(fdstat_ptr, 6); // filetype = 6 (socket_stream)
            buffer.setUint8(fdstat_ptr + 1, 2); // fdflags = 2 (nonblock)
            return 0;
        }
        return _fd_fdstat_get.apply(wasi.wasiImport, [fd, fdstat_ptr]);
    }
    wasi.wasiImport.sock_accept = (fd, flags, fd_ptr) => {
        if (fd != listenfd) {
            console.log("sock_accept: unknown fd " + fd);
            return ERRNO_INVAL;
        }
        if (connfdUsed) {
            console.log("sock_accept: multi-connection is unsupported");
            return ERRNO_INVAL;
        }
        if (!sockAccept()) {
            return ERRNO_AGAIN;
        }
        connfdUsed = true;
        var buffer = new DataView(wasi.inst.exports.memory.buffer);
        buffer.setUint32(fd_ptr, connfd, true);
        return 0;
    }
    wasi.wasiImport.sock_send = (fd, iovs_ptr, iovs_len, si_flags/*not defined*/, nwritten_ptr) => {
        if (fd != connfd) {
            console.log("sock_send: unknown fd " + fd);
            return ERRNO_INVAL;
        }
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
            var ret = sockSend(buf.buffer.slice(0, iovec.buf_len));
            if (ret == errStatus) {
                return ERRNO_INVAL;
            }
            wtotal += buf.length;
        }
        buffer.setUint32(nwritten_ptr, wtotal, true);
        return 0;
    }
    wasi.wasiImport.sock_recv = (fd, iovs_ptr, iovs_len, ri_flags, nread_ptr, ro_flags_ptr) => {
        if (ri_flags != 0) {
            console.log("ri_flags are unsupported"); // TODO
        }
        if (fd != connfd) {
            console.log("sock_recv: unknown fd " + fd);
            return ERRNO_INVAL;
        }
        var sockreadable = sockWaitForReadable();
        if (sockreadable == errStatus) {
            return ERRNO_INVAL;
        } else if (sockreadable == false) {
            return ERRNO_AGAIN;
        }
        var buffer = new DataView(wasi.inst.exports.memory.buffer);
        var buffer8 = new Uint8Array(wasi.inst.exports.memory.buffer);
        var iovecs = Iovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
        var nread = 0;
        for (i = 0; i < iovecs.length; i++) {
            var iovec = iovecs[i];
            if (iovec.buf_len == 0) {
                continue;
            }
            var data = sockRecv(iovec.buf_len);
            if (data == errStatus) {
                return ERRNO_INVAL;
            }
            buffer8.set(data, iovec.buf);
            nread += data.length;
        }
        buffer.setUint32(nread_ptr, nread, true);
        // TODO: support ro_flags_ptr
        return 0;
    }
    wasi.wasiImport.sock_shutdown = (fd, sdflags) => {
        if (fd == connfd) {
            connfdUsed = false;
        }
        return 0;
    }
}
