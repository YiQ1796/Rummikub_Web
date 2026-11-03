import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineController } from '../src/online-controller.js';
import { newRoom, startRoom, ROOM_PROTOCOL } from '../src/online-core.js';

function fakeStorage() {
  const items = new Map();
  return {
    getItem(key){return items.has(key) ? items.get(key):null;},
    setItem(key,value){items.set(key,String(value));},
    removeItem(key){items.delete(key);},
    items
  };
}
const HOST_KEY='sanmao-rummikub-host-room-v1';
const LAST_GUEST_KEY='sanmao-rummikub-last-guest-v1';
const TOKEN_PREFIX='sanmao-rummikub-seat-v1-';

test('host resume metadata reads saved room but never starts a connection',()=>{
  const previous=globalThis.localStorage;
  const storage=fakeStorage();
  globalThis.localStorage=storage;
  try{
    const room=newRoom({code:'123456',seats:4,hostName:'房主'});
    startRoom(room,()=>0.35);
    storage.setItem(HOST_KEY,JSON.stringify(room));
    const online=new OnlineController({onMatch:()=>{},onStatus:()=>{}});
    assert.equal(online.hasStoredHost,true);
    assert.deepEqual(online.storedHostSummary,{code:'123456',phase:'playing'});
    assert.equal(online.active,false);
    assert.equal(online.transport,null);
    online.discardStoredSessions();
    assert.equal(storage.getItem(HOST_KEY),null);
  }finally{
    if(previous === undefined)delete globalThis.localStorage;
    else globalThis.localStorage=previous;
  }
});

test('guest entry is saved only after host welcome and can be explicitly discarded',()=>{
  const previous=globalThis.localStorage;
  const storage=fakeStorage();
  globalThis.localStorage=storage;
  try{
    const code='654321', token='11111111111111111111111111111111';
    storage.setItem(TOKEN_PREFIX+code,token);
    const online=new OnlineController({onMatch:()=>{},onStatus:()=>{}});
    online.mode='guest';
    online.code=code;
    online.token=token;
    online.name='好友甲';
    online.transport={close:()=>{}};
    assert.equal(online.previousGuestRoom,null);
    online.receiveGuestMessage({type:'welcome',seat:1,snapshot:{
      protocol:ROOM_PROTOCOL,code,seats:4,phase:'lobby',revision:0,seat:1,
      roster: [{seat:0,name:'房主',connected:true},{seat:1,name:'好友甲',connected:true}]
    }});
    assert.equal(online.connected,true);
    assert.deepEqual(online.previousGuestRoom,{code,name:'好友甲',seat:1});
    online.forgetPreviousGuest();
    assert.equal(online.previousGuestRoom,null);
    assert.equal(storage.getItem(TOKEN_PREFIX+code),null);
  }finally{
    if(previous === undefined)delete globalThis.localStorage;
    else globalThis.localStorage=previous;
  }
});

test('corrupt guest marker or expired seat token cannot offer a false resume',()=>{
  const previous=globalThis.localStorage;
  const storage=fakeStorage();
  globalThis.localStorage=storage;
  try{
    const online=new OnlineController({onMatch:()=>{},onStatus:()=>{}});
    storage.setItem(LAST_GUEST_KEY,'not-json');
    assert.equal(online.previousGuestRoom,null);
    storage.setItem(LAST_GUEST_KEY,JSON.stringify({code:'654321',name:'友',seat:1}));
    assert.equal(online.previousGuestRoom,null);
    storage.setItem(TOKEN_PREFIX+'654321','not-a-token');
    assert.equal(online.previousGuestRoom,null);
  }finally{
    if(previous === undefined)delete globalThis.localStorage;
    else globalThis.localStorage=previous;
  }
});

test('discard previous sessions removes host key and guest marker together',()=>{
  const previous=globalThis.localStorage;
  const storage=fakeStorage();
  globalThis.localStorage=storage;
  try{
    storage.setItem(HOST_KEY,'some-state');
    storage.setItem(TOKEN_PREFIX+'654321','a'.repeat(32));
    storage.setItem(LAST_GUEST_KEY,JSON.stringify({code:'654321',name:'好友',seat:3}));
    const online=new OnlineController({onMatch:()=>{},onStatus:()=>{}});
    online.discardStoredSessions();
    assert.equal(storage.getItem(HOST_KEY),null);
    assert.equal(storage.getItem(LAST_GUEST_KEY),null);
    assert.equal(storage.getItem(TOKEN_PREFIX+'654321'),null);
  }finally{
    if(previous === undefined)delete globalThis.localStorage;
    else globalThis.localStorage=previous;
  }
});
