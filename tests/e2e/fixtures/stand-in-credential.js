'use strict';
// A signed-in seat for an isolated test profile: the shape Claude stores, with stand-in tokens.
// The seat list parses it (claude-seats-main credentialFileStatus); test profiles never poll usage
// or renew, so it never leaves the machine. A real credential never goes in a fixture.
module.exports = JSON.stringify({ claudeAiOauth: { accessToken: 'stand-in-access', refreshToken: 'stand-in-refresh', scopes: ['user:profile'] } });
