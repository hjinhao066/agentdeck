// Claude Code's PreCompact hook for the 队长 (see agent-sessions.js captainCompactSettings): what a
// successful PreCompact hook prints is added to the instructions of that compaction, manual or auto.
// Runs from the board-control tools folder next to main-core.js. Prints nothing else, reads no input.
'use strict';
process.stdout.write(require('./main-core').COMPACT_NOTE + '\n');
