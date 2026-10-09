import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execute = promisify(execFile)
const helper = fileURLToPath(new URL('./agy-account-sync.py', import.meta.url))
export function cockpitSyncEnabled(platform = process.platform, env = process.env, exists = existsSync) {
  if (env.AGY_COCKPIT_SYNC === '0') return false
  if (platform !== 'win32') {
    if (env.AGY_COCKPIT_SYNC === '1') throw new Error('Cockpit account sync currently requires Windows')
    return false
  }
  return env.AGY_COCKPIT_SYNC === '1' || exists(join(env.AGY_COCKPIT_DATA_DIR ?? join(homedir(), '.antigravity_cockpit'), 'accounts.json'))
}

export async function accountIdentity(repair = false) {
  if (!cockpitSyncEnabled()) return { enabled: false }
  const candidates = process.env.AGY_SYNC_PYTHON
    ? [[process.env.AGY_SYNC_PYTHON, []]] : [['py', ['-3']], ['python', []], ['python3', []]]
  try {
    for (const [python, prefix] of candidates) {
      try {
        const { stdout } = await execute(python, [...prefix, helper, ...(repair ? ['--sync'] : [])],
          { windowsHide: true, timeout: 20000, maxBuffer: 4096 })
        const value = JSON.parse(stdout)
        if (!value.accountId || value.error) throw new Error('Invalid synchronization state')
        return { enabled: true, ...value }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    throw new Error('Python 3 unavailable')
  } catch {
    throw new Error('Antigravity account synchronization unavailable; no CLI request sent')
  }
}

export async function retireMismatchedSessions(sessions, accountId, credentialDrift) {
  const closed = []
  for (const value of sessions) {
    const session = await value
    if (session.closed || (!credentialDrift && session.accountId === accountId)) continue
    if (session.child && session.child.exitCode === null) {
      closed.push(new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Old AGY process did not exit')), 5000)
        session.child.once('close', () => { clearTimeout(timer); resolve() })
      }))
    }
    session.dispose(new Error('Antigravity account changed; old CLI session stopped'))
  }
  await Promise.all(closed)
}
