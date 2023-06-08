// startWasi starts the specified wasi image.
function startWasi(ttyClient, chunks, prefix) {
    var args = [];
    var cmd = getArgs();
    if (cmd) {
        args = ['--', '-entrypoint', '/bin/sh', '--', '-c', cmd]
    }
    var env = [];
    var fds = [];
    var wasi = new WASI(args, env, fds);
    wasiHack(ttyClient, wasi);
    fetchChunks(chunks, s => prefix + s + '.wasm', wasm => {
        WebAssembly.instantiate(wasm, {
            "wasi_snapshot_preview1": wasi.wasiImport,
        }).then((inst) => {
            wasi.start(inst.instance);
        })
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

// fetchChunks fetches specified number of consecutive chunks and
// passes the concatinated array buffer to the callback.
function fetchChunks(chunks, format, f) {
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

// wasiHack patches wasi object for integrating it to xterm-pty.
function wasiHack(ttyClient, wasi) {
    const ERRNO_INVAL = 28;
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
        }
        return ERRNO_INVAL;
    }
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
        }
        return ERRNO_INVAL;
    }
    wasi.wasiImport.poll_oneoff = (in_ptr, out_ptr, nsubscriptions, nevents_ptr) => {
        if (nsubscriptions == 0) {
            return ERRNO_INVAL;
        }
        let buffer = new DataView(wasi.inst.exports.memory.buffer);
        let in_ = Subscription.read_bytes_array(buffer, in_ptr, nsubscriptions);
        let isReadPoll = false;
        let isClockPoll = false;
        let pollSub;
        let clockSub;
        let timeout = Number.MAX_VALUE;
        for (let sub of in_) {
            if (sub.u.tag.variant == "fd_read") {
                if (sub.u.data.fd != 0) {
                    return ERRNO_INVAL; // only fd=0 is supported as of now (FIXME)
                }
                isReadPoll = true;
                pollSub = sub;
            } else if (sub.u.tag.variant == "clock") {
                if (sub.u.data.timeout < timeout) {
                    timeout = sub.u.data.timeout
                    isClockPoll = true;
                    clockSub = sub;
                }
            } else {
                return ERRNO_INVAL; // FIXME
            }
        }
        let events = [];
        if (isReadPoll || isClockPoll) {
            var readable = ttyClient.onWaitForReadable(timeout / 1000000000);
            if (readable && isReadPoll) {
                let event = new Event();
                event.userdata = pollSub.userdata;
                event.error = 0;
                event.type = new EventType("fd_read");
                events.push(event);
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

////////////////////////////////////////////////////////////
//
// event-related classes adopted from the on-going discussion
// towards poll_oneoff support in browser_wasi_sim project.
// Ref: https://github.com/bjorn3/browser_wasi_shim/issues/14#issuecomment-1450351935
//
////////////////////////////////////////////////////////////

class EventType {
    /*:: variant: "clock" | "fd_read" | "fd_write"*/

    constructor(variant/*: "clock" | "fd_read" | "fd_write"*/) {
        this.variant = variant;
    }

    static from_u8(data/*: number*/)/*: EventType*/ {
        switch (data) {
            case EVENTTYPE_CLOCK:
                return new EventType("clock");
            case EVENTTYPE_FD_READ:
                return new EventType("fd_read");
            case EVENTTYPE_FD_WRITE:
                return new EventType("fd_write");
            default:
                throw "Invalid event type " + String(data);
        }
    }

    to_u8()/*: number*/ {
        switch (this.variant) {
            case "clock":
                return EVENTTYPE_CLOCK;
            case "fd_read":
                return EVENTTYPE_FD_READ;
            case "fd_write":
                return EVENTTYPE_FD_WRITE;
            default:
                throw "unreachable";
        }
    }
}

class Event {
    /*:: userdata: UserData*/
    /*:: error: number*/
    /*:: type: EventType*/
    /*:: fd_readwrite: EventFdReadWrite | null*/

    write_bytes(view/*: DataView*/, ptr/*: number*/) {
        view.setBigUint64(ptr, this.userdata, true);
        view.setUint8(ptr + 8, this.error);
        view.setUint8(ptr + 9, 0);
        view.setUint8(ptr + 10, this.type.to_u8());
        // if (this.fd_readwrite) {
        //     this.fd_readwrite.write_bytes(view, ptr + 16);
        // }
    }

    static write_bytes_array(view/*: DataView*/, ptr/*: number*/, events/*: Array<Event>*/) {
        for (let i = 0; i < events.length; i++) {
            events[i].write_bytes(view, ptr + 32 * i);
        }
    }
}

class SubscriptionClock {
    /*:: timeout: number*/

    static read_bytes(view/*: DataView*/, ptr/*: number*/)/*: SubscriptionFdReadWrite*/ {
        let self = new SubscriptionClock();
        self.timeout = Number(view.getBigUint64(ptr + 8, true));
        return self;
    }
}

class SubscriptionFdReadWrite {
    /*:: fd: number*/

    static read_bytes(view/*: DataView*/, ptr/*: number*/)/*: SubscriptionFdReadWrite*/ {
        let self = new SubscriptionFdReadWrite();
        self.fd = view.getUint32(ptr, true);
        return self;
    }
}

class SubscriptionU {
    /*:: tag: EventType */
    /*:: data: SubscriptionClock | SubscriptionFdReadWrite */

    static read_bytes(view/*: DataView*/, ptr/*: number*/)/*: SubscriptionU*/ {
        let self = new SubscriptionU();
        self.tag = EventType.from_u8(view.getUint8(ptr));
        switch (self.tag.variant) {
            case "clock":
                self.data = SubscriptionClock.read_bytes(view, ptr + 8);
                break;
            case "fd_read":
            case "fd_write":
                self.data = SubscriptionFdReadWrite.read_bytes(view, ptr + 8);
                break;
            default:
                throw "unreachable";
        }
        return self;
    }
}

class Subscription {
    /*:: userdata: UserData */
    /*:: u: SubscriptionU */

    static read_bytes(view/*: DataView*/, ptr/*: number*/)/*: Subscription*/ {
        let subscription = new Subscription();
        subscription.userdata = view.getBigUint64(ptr, true);
        subscription.u = SubscriptionU.read_bytes(view, ptr + 8);
        return subscription;
    }

    static read_bytes_array(view/*: DataView*/, ptr/*: number*/, len/*: number*/)/*: Array<Subscription>*/ {
        let subscriptions = [];
        for (let i = 0; i < len; i++) {
            subscriptions.push(Subscription.read_bytes(view, ptr + 48 * i));
        }
        return subscriptions;
    }
}
