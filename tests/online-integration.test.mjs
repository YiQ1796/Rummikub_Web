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
  await host.host(4, '房主');
  await guest.join(host.code, '玩家二');
  assert.equal(guest.connected, true);
  assert.equal(guest.seat, 1);
  assert.match(guest.lastStatus, /已進入房間/);
  guest.receiveGuestMessage({ type: 'error', message: '房主拒絕加入' });
  assert.equal(guest.connected, false);
  assert.match(guest.lastStatus, /拒絕/);
  guest.leave(); host.leave();
});

test('host/guest reactions are synced, seat-authenticated, rate-limited and never alter tiles or turn', async () => {
  const hostEvents = [], guestEvents = [];
  const host = new OnlineController({
    onMatch: () => {}, onStatus: () => {},
    onInteraction: message => hostEvents.push(message)
  });
  const guest = new OnlineController({
    onMatch: () => {}, onStatus: () => {},
    onInteraction: message => guestEvents.push(message)
  });
  let channel;
  host.createTransport = () => ({
    host: async () => {}, close: () => {},
    sendHost: (conn,msg) => { guest.receiveGuestMessage(structuredClone(msg)); return true; }
  });
  guest.createTransport = () => ({
    join: async () => {}, close: () => {},
    sendGuest: msg => { host.receiveHostMessage(structuredClone(msg),channel); return true; }
  });
  await host.host(4,'房主');
  await guest.join(host.code,'好友');
  channel={open:true,close:()=>{}};
  guest.sendHello();
  host.start();
  assert.equal(guest.seat,1);
  assert.equal(host.room.match.currentSeat,0, 'Guest may react outside their turn');
  const revision=host.room.revision;
  const before=JSON.stringify(host.room.match);

  guest.sendReaction('t01');
  assert.deepEqual(hostEvents,[{seat:1,id:'t01'}]);
  assert.deepEqual(guestEvents,[{seat:1,id:'t01'}]);
  assert.throws(()=>guest.sendReaction('t02'),/稍等/);
  host.receiveHostMessage({type:'reaction',id:'t02',seat:0},channel);
  assert.equal(hostEvents.length,1,'Untrusted guest cannot bypass host cooldown or spoof seat');
  host.receiveHostMessage({type:'reaction',id:'not-allowed'},channel);
  assert.equal(hostEvents.length,1,'Unlisted text is rejected by host');

  host.sendReaction('e05');
  assert.deepEqual(hostEvents[1],{seat:0,id:'e05'});
  assert.deepEqual(guestEvents[1],{seat:0,id:'e05'});
  guest.receiveGuestMessage({type:'reaction',seat:99,id:'t01'});
  guest.receiveGuestMessage({type:'reaction',seat:0,id:'<b>fake</b>'});
  assert.equal(guestEvents.length,2,'Malformed network payloads are ignored');

  assert.equal(host.room.revision,revision,'Reactions do not trigger game state publications');
  assert.equal(JSON.stringify(host.room.match),before,'Reactions never alter the deck, hands or turn');
  host.leave(); guest.leave();
});

test('guest cannot send chat before joining, and host rejects unknown codes', () => {
  const guest = new OnlineController({onMatch:()=>{},onStatus:()=>{}});
  assert.throws(()=>guest.sendReaction('t01'),/尚未連線/);
  assert.throws(()=>guest.sendReaction('untrusted'),/無效/);
});
