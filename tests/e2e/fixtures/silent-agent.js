// Offline stand-in for a command line that starts and then never draws anything
// (Claude Code waiting on a macOS "downloaded from the Internet" dialog). It never
// reads its input, so the tty's line discipline shows whatever is typed at it.
setInterval(() => {}, 1 << 30);
