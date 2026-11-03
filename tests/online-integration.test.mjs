import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineController } from '../src/online-controller.js';
import { checkTileIntegrity } from '../src/rules.js';

/** In-memory PeerRoom stand-in. Exercises the same handshake/command callbacks. */
test('host/guest: join lobby, AI fill, private hand, guest turn, reconnect same seat', async () => {
  let hostMatch, guestMatch;
  const host = new OnlineController({ onMatch: value => { hostMatch = value; }, onStatus: () => {} });
  const guest = new OnlineController({ onMatch: value => { guestMatch = value; }, onStatus: () => {} });
  let channel;
  host.createTransport = () => ({
    host: async () => {},
    close: () => {},
    sendHost: (conn, message) => { guest.receiveGuestMessage(JSON.parse(JSON.stringify(message))); return true; }
  });
  guest.createTransport = () => ({
    join: async () => {},
    close: () => {},
    sendGuest: message => { host.receiveHostMessage(JSON.parse(JSON.stringify(message)), channel); return true; },
    reconnect: () => {}
  });
  await host.host(4, '房主');
  await guest.join(host.code, '好友一');
  channel = { open: true, close: () => {} };
  guest.sendHello();
  assert.equal(guest.seat, 1);
  assert.equal(host.room.members.length, 2);
  assert.equal(guest.view.phase, 'lobby');
  assert.equal(guest.view.seat, 1);
  host.start();
  assert.deepEqual(hostMatch.players.map(p => p.isAi), [false, false, true, true]);
  assert.equal(guestMatch.players[1].hand.length, 14);
  assert.equal(guestMatch.players[0].hand.length, 0);
  assert.equal(guestMatch.players[2].hand.length, 0);
  assert.ok(checkTileIntegrity(hostMatch));
  // Fast forward host turn as a unit test of the P2P message boundary.
  host.room.match.currentSeat = 1;
  host.room.match.draft = null;
  host.room.revision++;
  host.publish();
  assert.ok(guestMatch.draft);
  assert.equal(guestMatch.currentSeat, 1);
  const before = hostMatch.players[1].hand.length;
  guest.sendTurn('draw');
  assert.equal(hostMatch.players[1].hand.length, before + 1);
  assert.equal(hostMatch.currentSeat, 2);
  assert.ok(checkTileIntegrity(hostMatch));
  assert.equal(guestMatch.currentSeat, 2);
  assert.equal(guest.pending, false);
  host.connectionClosed(channel);
  assert.equal(host.room.members[1].connected, false);
  const newConn = { open: true, close: () => {} };
  channel = newConn;
  guest.sendHello();
  assert.equal(guest.seat, 1);
  assert.equal(host.room.members.length, 2);
  assert.equal(host.room.members[1].connected, true);
  host.leave();
  guest.leave();
});


test('fast welcome keeps success state instead of reverting to searching message', async () => {
  let guest, channel;
  const host = new OnlineController({ onMatch: () => {}, onStatus: () => {} });
  guest = new OnlineController({ onMatch: () => {}, onStatus: () => {} });
  host.createTransport = () => ({
    host: async () => {}, close: () => {},
    sendHost: (conn, msg) => { guest.receiveGuestMessage(structuredClone(msg)); return true; }
  });
  guest.createTransport = () => ({
    join: async () => {
      channel = { open: true, close: () => {} };
      guest.sendHello();
    },
    close: () => {},
    sendGuest: msg => { host.receiveHostMessage(structuredClone(msg), channel); return true; }
  });
  await host.host(3, '房主');
  await guest.join(host.code, '玩家二');
  assert.equal(guest.connected, true);
  assert.equal(guest.seat, 1);
  assert.match(guest.lastStatus, /已進入房間/);
  guest.receiveGuestMessage({ type: 'error', message: '房主拒絕加入' });
  assert.equal(guest.connected, false);
  assert.match(guest.lastStatus, /拒絕/);
  guest.leave(); host.leave();
});
