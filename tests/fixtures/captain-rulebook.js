'use strict';
// Everything a Captain can read: the core prompt, then every built-in rule file
// (docs/captain/*.md). A test that pins a rule's wording checks it here, wherever
// the rule lives; a test about what is pasted every time checks M.instructions().
const path = require('path');
const M = require('../../main-core');
const Rules = require('../../captain-rules');

// A home with no ~/.agents/captain: the built-in text only, whatever this machine has.
const NO_HOME = path.join(__dirname, 'no-such-home');
const topic = (name) => Rules.topic(name, { home: NO_HOME });
const rulebook = (...args) => [M.instructions(...args), ...Rules.NAMES.map(topic)].join('\n');

module.exports = { rulebook, topic };
