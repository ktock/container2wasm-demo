function startVM(elemId, workerFileName){
    const xterm = new Terminal();
    xterm.open(document.getElementById(elemId));
    const { master, slave } = openpty();
    var termios = slave.ioctl("TCGETS");
    termios.iflag &= ~(/*IGNBRK | BRKINT | PARMRK |*/ ISTRIP | INLCR | IGNCR | ICRNL | IXON);
    termios.oflag &= ~(OPOST);
    termios.lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
    //termios.cflag &= ~(CSIZE | PARENB);
    //termios.cflag |= CS8;
    slave.ioctl("TCSETS", new Termios(termios.iflag, termios.oflag, termios.cflag, termios.lflag, termios.cc));
    xterm.loadAddon(master);
    const worker = new Worker(workerFileName);
    new TtyServer(slave).start(worker);
};
