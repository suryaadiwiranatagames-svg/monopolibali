// Run with NODE_PATH pointing to React 18, react-test-renderer, Babel and Tween.js.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const React = require('react'), Renderer = require('react-test-renderer'), Babel = require('@babel/standalone');
const Tween = require('@tweenjs/tween.js');
const { act } = Renderer;
const source = fs.readFileSync('index.html', 'utf8').match(/<script type="text\/babel">([\s\S]*?)<\/script>/)[1];
const prefix = source.slice(0, source.indexOf('// --- 3. RENDER LAYAR LOGIN ---'));
const expose = `globalThis.game = { players, board, turnIndex, turnPhase, currentRoll, isRolling, isMoving, motion,
  setMySetupId, setIsHost, setIsOnline, setRoomCode, setLobbyPlayers, setScreen,
  startGame, handleRollDice, endTurn, setPlayers, setTurnPhase, setMotion,
  playerMeshesRef, diceMeshesRef, syncStatus, gameRevisionRef, ownsTurn, latestStateRef };
  return null; }; globalThis.App = App;`;
const code = Babel.transform(prefix + expose, { presets: ['react'] }).code;
let now = 1000000000000, database = { status: 'LOBBY', lobby_players: [] };
let loseBroadcast = false;
const live = process.env.MONOPOLI_LIVE === '1';
let liveAdmin, liveRoom;
const channels = [], clients = [], timers = new Map(); let nextTimer = 0;
const MockDate = class extends Date { static now() { return now; } };
function schedule(fn, ms, repeat = false) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms, ms, repeat }); return id; }
function client(id) {
 const frames = [];
 const rolls = [];
 const testMath = Object.create(Math); testMath.random = () => rolls.shift() ?? Math.random();
 const tweenGroup = new Tween.Group();
 const window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {},
   TWEEN: { ...Tween, Tween: class extends Tween.Tween { constructor(target) { super(target, tweenGroup); } } } };
 let supabase = {
  channel() {
   const listeners = [];
   const channel = {
    on(type, filter, fn) { listeners.push({type, event:filter.event, fn}); return channel; },
    subscribe(fn) { channels.push(channel); queueMicrotask(() => fn('SUBSCRIBED')); return channel; },
    async send(message) {
     if (!loseBroadcast) for (const peer of channels) if (peer !== channel) peer.receive(message);
     return 'ok';
    },
    receive(message) { listeners.filter(l=>l.type==='broadcast' && l.event===message.event).forEach(l=>l.fn({payload:message.payload})); }
   };
   return channel;
  },
  removeChannel(channel) { const i=channels.indexOf(channel); if(i>=0) channels.splice(i,1); },
  from() { return {
   select() { return {eq() {return { single:async()=>({data:database}) };}}; },
   update(value) { return {eq() { return {or:async()=>{if(!database.game_state || database.game_state.revision<value.game_state.revision) database=value; return {error:null};}};}}; }
  }; }
 };
 if (live) {
  const createClient = new Function(fs.readFileSync('/tmp/monopoli-supabase.js','utf8')+'; return supabase;')().createClient;
  supabase = createClient(source.match(/SUPABASE_URL = '([^']+)'/)[1],source.match(/SUPABASE_ANON_KEY = '([^']+)'/)[1]);
  const originalChannel = supabase.channel.bind(supabase);
  supabase.channel = (...args) => {
   const channel = originalChannel(...args);
   const send = channel.send.bind(channel); channel.send = message => loseBroadcast ? Promise.resolve('ok') : send(message);
   // Intentionally omit database events to verify the polling recovery path.
   const on = channel.on.bind(channel); channel.on = (type,...args) => type === 'postgres_changes' ? channel : on(type,...args);
   return channel;
  };
 }
 window.supabase = {createClient:()=>supabase};
 // Keep the actual React dispatcher, batching, cleanup and effect lifecycle.
 const filteredReact = {...React, useEffect(fn, deps) {
  const text = fn.toString();
  if (text.includes('new Audio') || text.includes('new THREE.Scene') || text.includes('buildingMeshesRef.current')) return React.useEffect(()=>{},deps);
  React.useEffect(fn,deps);
 }};
 const context = vm.createContext({ React: filteredReact, window, console, Date:MockDate, Math:testMath, performance:{now:()=>now},
  localStorage:{getItem:()=>null,setItem(){}}, alert() {},
  setTimeout:(fn,ms)=>schedule(fn,ms),clearTimeout:id=>timers.delete(id),
  setInterval:(fn,ms)=>schedule(fn,ms,true),clearInterval:id=>timers.delete(id),
  requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){} });
 vm.runInContext(code,context);
 const root = Renderer.create(React.createElement(context.App));
 const c = { rolls, supabase, get game(){return context.game;},frames,tweenGroup,root,id}; clients.push(c); return c;
}
async function flush(fn=()=>{}) { await act(async()=>{fn();for(let i=0;i<15;i++)await Promise.resolve(); if(live) await new Promise(r=>setTimeout(r,75));}); }
async function waitFor(predicate, label) { for(let i=0;i<100 && !predicate();i++) await flush(); assert.ok(predicate(), label + ' ' + clients.map(c=>c.game.syncStatus+':'+c.game.players.length).join(',')); }
async function tick(ms) {
 for(let elapsed=0;elapsed<ms;elapsed+=50) {
  now+=50;
  await flush(()=>{
   for(const [id,timer] of [...timers]) if(timer.at<=now) {if(timer.repeat)timer.at=now+timer.ms;else timers.delete(id);timer.fn();}
   for(const c of clients) { c.tweenGroup.update(now); const pending=c.frames.splice(0);pending.forEach(fn=>fn(now)); }
  });
 }
}
function meshes(c) {
 for(const p of c.game.players) c.game.playerMeshesRef.current[p.id] = {position:{x:0,y:1.6,z:0,set(x,y,z){Object.assign(this,{x,y,z});}}};
 c.game.diceMeshesRef.current = [0,1].map(()=>({position:{set(x,y,z){Object.assign(this,{x,y,z});}},rotation:{set(x,y,z){Object.assign(this,{x,y,z});}}}));
}
(async()=>{
 let host,guest;
 if(live) {
  const createClient = new Function(fs.readFileSync('/tmp/monopoli-supabase.js','utf8')+'; return supabase;')().createClient;
  liveAdmin = createClient(source.match(/SUPABASE_URL = '([^']+)'/)[1],source.match(/SUPABASE_ANON_KEY = '([^']+)'/)[1]);
  liveRoom = ('T'+Math.random().toString(36).slice(2,7)).toUpperCase();
  const {error} = await liveAdmin.from('games').insert({room_code:liveRoom,status:'LOBBY',room_name:'Automated multiplayer verification',lobby_players:[{setupId:'host',name:'Host',token:'🏄',color:'#f00'},{setupId:'guest',name:'Guest',token:'🌺',color:'#00f'}]});
  if(error) throw new Error(error.message);
 }
 await flush(()=>{host=client('host');guest=client('guest');});
 await flush(()=>{for(const c of clients){c.game.setMySetupId(c.id);c.game.setIsHost(c.id==='host');c.game.setIsOnline(true);c.game.setRoomCode(liveRoom || 'REACT-TEST');c.game.setScreen('LOBBY');}});
 if(live) { for(let i=0;i<80 && clients.some(c=>c.game.syncStatus !== 'Terhubung');i++) await flush(); assert.ok(clients.every(c=>c.game.syncStatus==='Terhubung'),'both live channels subscribed'); }
 await flush(()=>host.game.setLobbyPlayers([{setupId:'host',name:'Host',token:'🏄',color:'#f00'},{setupId:'guest',name:'Guest',token:'🌺',color:'#00f'}]));
 await flush(()=>host.game.startGame());
 await waitFor(()=>guest.game.players.length===2,'actual React guest starts');
 meshes(host);meshes(guest);
 host.rolls.push(.2,.4);
 await flush(()=>host.game.handleRollDice());
 await waitFor(()=>guest.game.isRolling,'remote HUD shows rolling');
 assert.equal(guest.game.motion.type,'dice');
 assert.deepEqual(JSON.parse(JSON.stringify(guest.game.currentRoll)),JSON.parse(JSON.stringify(host.game.currentRoll)));
 await tick(1900);
 assert.equal(host.game.isMoving,true,'real dice completion starts movement');
 assert.equal(guest.game.isMoving,true,'remote HUD shows movement');
 await tick(700);
 assert.ok(host.game.players[0].position>0,'host shares intermediate steps');
 assert.equal(guest.game.players[0].position,host.game.players[0].position,'guest gets each tile before movement completes');
 const hp=host.game.playerMeshesRef.current[0].position, gp=guest.game.playerMeshesRef.current[0].position;
 assert.ok(Math.abs(hp.x-gp.x)<0.001 && Math.abs(hp.z-gp.z)<0.001,'real remote pawn follows shared motion');
 loseBroadcast=true;
 await tick(700);
 const intermediate = host.game.players[0].position;
 await tick(1600);
 assert.equal(guest.game.players[0].position,host.game.players[0].position,'database polling recovers missed movement broadcasts');
 loseBroadcast=false;
 await tick(5000);
 // Skip local purchasing/card handling to focus on synchronization of turn handoff.
 await flush(()=>{host.game.setTurnPhase('END');});
 await flush(()=>host.game.endTurn());
 await waitFor(()=>guest.game.turnIndex===1,'actual React turn handoff');
 guest.rolls.push(.2,.4);
 await flush(()=>guest.game.handleRollDice());
 await waitFor(()=>host.game.isRolling,'host sees guest rolling');
 await tick(1900);await tick(700);
 assert.equal(host.game.players[1].position,guest.game.players[1].position,'reverse-direction movement is shared');
 assert.ok(guest.game.players[1].position>0);
 await flush(()=>clients.forEach(c=>c.root.unmount()));
 if(live) await Promise.all(clients.map(c=>c.supabase.removeAllChannels()));
 console.log((live ? 'LIVE ' : '')+'PASS: actual React start, real Tween dice, intermediate positions, matching pawn animation, missed-event recovery and guest turn');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 if(liveAdmin && liveRoom) {
  const {error}=await liveAdmin.from('games').delete().eq('room_code',liveRoom);
  if(error){console.error('Test room cleanup failed:',error.message);process.exitCode=1;}
 }
 if(live) process.exit(process.exitCode || 0);
});
