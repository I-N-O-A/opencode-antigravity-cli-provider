import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { retireMismatchedSessions, cockpitSyncEnabled } from '../agy-account-sync.mjs';
test('non-Windows users retain ordinary CLI authentication', () => {
 assert.equal(cockpitSyncEnabled('linux',{},()=>true),false);
 assert.equal(cockpitSyncEnabled('darwin',{},()=>true),false);
});
test('Windows auto-detects Cockpit and supports an explicit opt-out', () => {
 assert.equal(cockpitSyncEnabled('win32',{},()=>true),true);
 assert.equal(cockpitSyncEnabled('win32',{},()=>false),false);
 assert.equal(cockpitSyncEnabled('win32',{AGY_COCKPIT_SYNC:'0'},()=>true),false);
 assert.equal(cockpitSyncEnabled('win32',{AGY_COCKPIT_SYNC:'1'},()=>false),true);
});
test('changed account retires only old sessions', async () => {
 let stopped=[]; const sessions=[{accountId:'old',dispose(){stopped.push('old')}},{accountId:'new',dispose(){stopped.push('new')}}];
 await retireMismatchedSessions(sessions,'new',false);
 assert.deepEqual(stopped,['old']);
});
test('credential drift retires every CLI session before repair',async()=>{
 let stopped=0;await retireMismatchedSessions([{accountId:'new',dispose(){stopped++}}],'new',true);assert.equal(stopped,1);
});
test('retirement waits for the old process to close', async () => {
 const child=new EventEmitter();child.exitCode=null;let closed=false;
 await retireMismatchedSessions([{accountId:'old',child,dispose(){setImmediate(()=>{closed=true;child.emit('close');});}}],'new',false);
 assert.equal(closed,true);
});
