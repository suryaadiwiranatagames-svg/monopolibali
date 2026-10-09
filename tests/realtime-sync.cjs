const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync('index.html', 'utf8');
const body = html.slice(html.indexOf('const App = () => {'), html.indexOf('// Inisialisasi Tampilan Three.js')) + '\n return { setScreen, setIsOnline, setRoomCode, setIsHost, setMySetupId, setPlayers, setTurnIndex, setTurnPhase, setDebtAction, setActiveCard, players, turnIndex, turnPhase, debtAction, activeCard, canDriveTurn, playerMeshesRef, gameRevisionRef }; }; globalThis.App = App;';
const bus = [];
let database = { status: 'LOBBY', lobby_players: [] };
const writes = [];
function client() {
    const hooks = [], previous = [], cleanups = [];
    let cursor = 0, pending = [], api;
    const polls = [];
    const React = {
        useState(initial) {
            const index = cursor++;
            if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
            return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
        },
        useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
        useEffect(fn, deps) {
            const index = cursor++;
            const source = fn.toString();
            // Exercise synchronization and mesh effects without audio or a WebGL renderer.
            const selected = source.includes('const applyRoom') || source.includes('sharedFingerprint ===') || source.includes('animatedPawnsRef.current.has');
            if (selected && (!previous[index] || deps.some((value, i) => value !== previous[index][i]))) {
                pending.push(() => { cleanups[index]?.(); cleanups[index] = fn(); });
            }
            previous[index] = deps;
        }
    };
    const supabase = {
        channel() {
            const listeners = [];
            const channel = {
                on(type, filter, fn) { listeners.push({ type, event: filter.event, fn }); return channel; },
                subscribe(fn) { bus.push(channel); fn('SUBSCRIBED'); return channel; },
                send(message) {
                    for (const peer of bus) if (peer !== channel) peer.receive(message);
                    return Promise.resolve('ok');
                },
                receive(message) { listeners.filter(l => l.type === 'broadcast' && l.event === message.event).forEach(l => l.fn({ payload: message.payload })); }
            };
            return channel;
        },
        removeChannel(channel) { const i = bus.indexOf(channel); if (i >= 0) bus.splice(i, 1); },
        from() { return {
            select() { return { eq() { return { single: async () => ({ data: database }) }; } }; },
            update(value) { return { eq: () => ({ or: async () => { if (!database.game_state || database.game_state.revision < value.game_state.revision) database = value; writes.push(value); return { error: null }; } }) }; }
        }; }
    };
    const context = vm.createContext({ React, supabase, boardData: [], createInitialCardDecks: () => ({}),
        window: { addEventListener() {}, removeEventListener() {} },
        getTileCoordinates: n => ({ x: n, z: -n }),
        Date, Math, JSON, Promise, setInterval: fn => { polls.push(fn); return polls.length; }, clearInterval() {} });
    vm.runInContext(body, context);
    return {
        render() { cursor = 0; pending = []; api = context.App(); pending.forEach(fn => fn()); return api; },
        async poll() { for (const fn of polls) await fn(); },
        get api() { return api; }
    };
}
(async () => {
    const host = client(), guest = client();
    for (const [c, id] of [[host, 'host'], [guest, 'guest']]) {
        let a = c.render(); a.setMySetupId(id); a.setIsOnline(true); a.setIsHost(id === 'host'); a.setRoomCode('TEST'); c.render();
    }
    await Promise.resolve();
    const players = [{ id: 0, setupId: 'host', position: 0 }, { id: 1, setupId: 'guest', position: 0 }];
    host.api.setPlayers(players); host.api.setScreen('GAME'); host.render(); guest.render();
    assert.equal(guest.api.players.length, 2, 'guest receives game start');
    host.api.setPlayers([{ ...players[0], position: 7 }, players[1]]); host.render(); guest.render();
    assert.equal(guest.api.players[0].position, 7, 'guest receives host position');
    let meshPosition;
    guest.api.playerMeshesRef.current[0] = { position: { set(...coords) { meshPosition = coords; } } };
    host.api.setPlayers([{ ...players[0], position: 8 }, players[1]]); host.render(); guest.render();
    assert.deepEqual(meshPosition, [8, 1.6, -8], 'remote state moves the 3D mesh');
    const revision = guest.api.gameRevisionRef.current;
    guest.render(); assert.equal(guest.api.gameRevisionRef.current, revision, 'remote snapshot is not echoed');
    guest.api.setTurnPhase('END'); guest.render(); host.render();
    assert.equal(host.api.turnPhase, 'ROLL', 'inactive guest cannot overwrite host');
    host.api.setTurnIndex(1); host.render(); guest.render();
    assert.equal(guest.api.turnIndex, 1, 'outgoing player publishes turn handoff');
    assert.equal(guest.api.canDriveTurn, true);
    guest.api.setPlayers([{ ...players[0], position: 8 }, { ...players[1], position: 4 }]);
    guest.api.setTurnPhase('DEBT'); guest.api.setDebtAction({ amount: 500 }); guest.api.setActiveCard({ title: 'Test' });
    guest.render(); host.render();
    assert.equal(host.api.players[1].position, 4, 'host receives guest move');
    assert.equal(host.api.debtAction.amount, 500, 'pending debt is shared');
    assert.equal(host.api.activeCard.title, 'Test', 'active card is shared');
    for (let i = 0; i < 25; i++) await Promise.resolve();
    assert.equal(database.game_state.turnIndex, 1, 'serialized database writes retain the latest turn');
    assert.equal(database.game_state.players[1].position, 4);
    assert.ok(writes.length >= 5);
    database = { status: 'GAME', game_state: { ...database.game_state,
        revision: database.game_state.revision + 1,
        players: [{ ...players[0], position: 12 }, { ...players[1], position: 4 }] } };
    await host.poll(); host.render();
    assert.equal(host.api.players[0].position, 12, 'polling recovers a missed broadcast');
    console.log('PASS: start, two-way moves, 3D position, no echo, turn authority, handoff, card/debt, ordered persistence, missed-event recovery');
})().catch(error => { console.error(error); process.exitCode = 1; });
