import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';
import { OnlineController } from '../src/online-controller.js';
import { checkTileIntegrity } from '../src/rules.js';
import { describeRoomJoin } from '../src/room-join-status.js';
import { RELAY_BROKERS } from '../src/relay-transport.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const clients = new Set(), brokerPackets = [];
function matches(pattern, topic) {
  const a=pattern.split('/'), b=topic.split('/');
  return a.length === b.length && a.every((x,i) => x === '+' || x === b[i]);
}
class FakeMqttClient extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.subscriptions = new Set();
    this.connected = false;
    clients.add(this);
    setImmediate(() => {
      if (!clients.has(this)) return;
      this.connected = true;
      this.emit('connect');
    });
  }
  subscribe(path, options, cb) {
    this.subscriptions.add(path);
    cb(null);
  }
  publish(path, text, options) {
    if (!this.connected) throw new Error('Broker disconnected');
    brokerPackets.push({path, text});
    for (const c of clients) {
      if (!c.connected || c.url !== this.url ||
          ![...c.subscriptions].some(pattern => matches(pattern,path))) continue;
      queueMicrotask(() => {
        if (c.connected) c.emit('message',path,Buffer.from(text,'utf8'));
      });
    }
  }
  end() {
    if (!clients.has(this)) return;
    this.connected=false;
    clients.delete(this);
    this.emit('close');
  }
}
function installMockBrowser() {
  globalThis.window = {
    mqtt:{connect:(url,options) => new FakeMqttClient(url,options)},
    addEventListener() {}, removeEventListener() {}
  };
  globalThis.document = {
    hidden:false, addEventListener() {}, removeEventListener() {}
  };
}
async function until(condition, timeoutMs = 12000) {
  const started=Date.now();
  while (!condition()) {
    if (Date.now()-started>timeoutMs) throw new Error('WSS encrypted handshake timed out');
    await new Promise(resolve=>setTimeout(resolve,35));
  }
}

test('two mobile clients join same four-seat host through encrypted WSS when WebRTC is unavailable', async () => {
  installMockBrowser();
  assert.equal(RELAY_BROKERS.length,2);
  const hostInteractions=[], guestInteractions=[];
  const host = new OnlineController({
    onMatch:()=>{}, onStatus:()=>{}, onInteraction:x=>hostInteractions.push(x)
  });
  const guest = new OnlineController({
    onMatch:()=>{}, onStatus:()=>{}, onInteraction:x=>guestInteractions.push(x)
  });
  try {
    // No window.Peer on purpose: this exercises NAT-safe WSS-only fallback.
    await host.host(4,'手機房主');
    assert.equal(host.room.members.length,1);
    await guest.join(host.code,'手機好友');
    await until(()=>guest.connected && guest.seat===1 && host.room.members.length===2);
    assert.equal(guest.view.phase,'lobby');
    assert.match(guest.lastStatus,/已進入房間/);
    assert.match(describeRoomJoin({
      active:true,connected:true,seat:1,phase:'lobby'
    }).notice,/已成功加入房間/);
    host.start();
    await until(()=>guest.view?.phase==='playing' && guest.view.game?.players.length===4);
    assert.equal(host.room.match.players.filter(p=>p.isAi).length,2);
    assert.equal(guest.view.game.players[1].hand.length,14);
    assert.equal(guest.view.game.players[0].hand.length,0);
    assert.ok(checkTileIntegrity(host.room.match));
    const before=JSON.stringify(host.room.match);
    const revision=host.room.revision;
    guest.sendReaction('t01');
    await until(()=>hostInteractions.length===1 && guestInteractions.length===1);
    assert.deepEqual(hostInteractions[0],{seat:1,id:'t01'});
    assert.deepEqual(guestInteractions[0],{seat:1,id:'t01'});
    assert.equal(host.room.revision,revision,'Chat may not modify the match revision');
    assert.equal(JSON.stringify(host.room.match),before,'Chat may not reveal or move tiles');
    assert.ok(brokerPackets.some(x=>JSON.parse(x.text).type==='secure'));
    assert.ok(!brokerPackets.some(x=>x.text.includes('手機好友') || x.text.includes('red-1-1')),
      'No plain names or physical tile IDs may appear in public MQTT messages');
  } finally {
    guest.leave();
    host.leave();
    for (const client of [...clients]) client.end(true);
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('joining status distinguishes unconfirmed seat from completed admission',()=>{
  const waiting=describeRoomJoin({
    active:true,isHost:false,connected:false,lastStatus:'優先嘗試加密 WSS 中繼（第 1/6 次）'
  });
  assert.equal(waiting.kind,'waiting');
  assert.match(waiting.notice,/WSS 中繼/);
  assert.equal(waiting.canRetry,true);
  const failed=describeRoomJoin({
    active:true,isHost:false,connected:false,
    lastStatus:'WebRTC 直連逾時：4G／5G NAT 可能阻擋 P2P'
  });
  assert.equal(failed.kind,'problem');
  assert.match(failed.notice,/重新連線/);
});
