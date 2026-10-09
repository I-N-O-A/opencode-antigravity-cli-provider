"""Synchronize AGY's shared Windows credential with Cockpit's desktop account.

Secrets stay in memory and Windows Credential Manager; stdout is metadata only.
"""
import base64
import ctypes
from ctypes import wintypes as w
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class Credential(ctypes.Structure):
    _fields_ = [('Flags', w.DWORD), ('Type', w.DWORD), ('TargetName', w.LPWSTR),
                ('Comment', w.LPWSTR), ('LastWritten', w.FILETIME),
                ('CredentialBlobSize', w.DWORD),
                ('CredentialBlob', ctypes.POINTER(ctypes.c_ubyte)),
                ('Persist', w.DWORD), ('AttributeCount', w.DWORD),
                ('Attributes', ctypes.c_void_p), ('TargetAlias', w.LPWSTR),
                ('UserName', w.LPWSTR)]


def build_payload(account):
    token = account.get('token') or {}
    if not token.get('refresh_token') or not token.get('access_token'):
        raise ValueError('Selected account has no usable login')
    expiry = datetime.fromtimestamp(token['expiry_timestamp'], timezone.utc).isoformat()
    return {'token': {'access_token': token['access_token'],
                      'refresh_token': token['refresh_token'],
                      'token_type': 'Bearer', 'expiry': expiry},
            'auth_method': 'consumer'}


def same_account(left, right):
    refresh = (left.get('token') or {}).get('refresh_token')
    return bool(refresh) and refresh == (right.get('token') or {}).get('refresh_token')


def api():
    lib = ctypes.WinDLL('advapi32', use_last_error=True)
    lib.CredReadW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD,
                             ctypes.POINTER(ctypes.POINTER(Credential))]
    lib.CredReadW.restype = w.BOOL
    lib.CredWriteW.argtypes = [ctypes.POINTER(Credential), w.DWORD]
    lib.CredWriteW.restype = w.BOOL
    lib.CredFree.argtypes = [ctypes.c_void_p]
    return lib


def read_credential():
    lib = api()
    ptr = ctypes.POINTER(Credential)()
    if not lib.CredReadW('gemini:antigravity', 1, 0, ctypes.byref(ptr)):
        if ctypes.get_last_error() == 1168:
            return {}
        raise ValueError('Cannot read Windows login')
    try:
        blob = ctypes.string_at(ptr.contents.CredentialBlob,
                                ptr.contents.CredentialBlobSize)
        return json.loads(blob)
    finally:
        lib.CredFree(ptr)


def write_credential(payload):
    blob = json.dumps(payload, separators=(',', ':')).encode()
    buffer = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
    cred = Credential(Type=1, TargetName='gemini:antigravity',
                      UserName='antigravity', CredentialBlobSize=len(blob),
                      CredentialBlob=buffer, Persist=2)
    if not api().CredWriteW(ctypes.byref(cred), 0):
        raise ValueError('Cannot update Windows login')


def cockpit_root():
    return Path(os.environ.get('AGY_COCKPIT_DATA_DIR', Path.home() / '.antigravity_cockpit'))


def selected_account():
    root = cockpit_root()
    paths = [root / 'accounts.json', root / 'antigravity_legacy_instances.json',
             root / 'current_account.json']
    before = [p.read_bytes() for p in paths]
    index, binding, current = map(json.loads, before)
    account_id = index.get('current_account_id')
    if not account_id or binding.get('defaultSettings', {}).get('bindAccountId') != account_id:
        raise ValueError('Desktop account switch is in progress')
    if Path(account_id).name != account_id or '/' in account_id or '\\' in account_id:
        raise ValueError('Invalid selected account')
    envelope = json.loads((root / 'accounts' / (account_id + '.json')).read_bytes())
    key = base64.b64decode((root / 'secure-account-storage.key').read_text().strip())
    account = json.loads(AESGCM(key).decrypt(base64.b64decode(envelope['nonce']),
                        base64.b64decode(envelope['ciphertext']), None))
    if account.get('id') != account_id or account.get('email') != current.get('email'):
        raise ValueError('Desktop account identity is inconsistent')
    if account.get('disabled'):
        raise ValueError('Selected desktop account is disabled')
    if before != [p.read_bytes() for p in paths]:
        raise ValueError('Desktop account changed during synchronization')
    return account, paths, before


def stop_old_cli_processes():
    """Retire AGY token sources; leaving one alive can rewrite the old login."""
    class Entry(ctypes.Structure):
        _fields_ = [('dwSize', w.DWORD), ('cntUsage', w.DWORD),
                    ('th32ProcessID', w.DWORD), ('th32DefaultHeapID', ctypes.c_size_t),
                    ('th32ModuleID', w.DWORD), ('cntThreads', w.DWORD),
                    ('th32ParentProcessID', w.DWORD), ('pcPriClassBase', w.LONG),
                    ('dwFlags', w.DWORD), ('szExeFile', w.WCHAR * 260)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
    kernel.Process32FirstW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    kernel.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
    kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ValueError('Cannot enumerate old CLI sessions')
    targets = []
    try:
        entry = Entry(); entry.dwSize = ctypes.sizeof(entry)
        valid = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while valid:
            if entry.szExeFile.lower() == 'agy.exe':
                targets.append(entry.th32ProcessID)
            valid = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    stopped = []
    for pid in targets:
        handle = kernel.OpenProcess(0x00100001, False, pid)
        if not handle:
            # A process that exited during enumeration needs no intervention.
            if ctypes.get_last_error() == 87:
                continue
            raise ValueError('Cannot retire an old AGY session')
        try:
            if kernel.WaitForSingleObject(handle, 0) == 0:
                continue
            if not kernel.TerminateProcess(handle, 1):
                raise ValueError('Cannot stop an old AGY session')
            if kernel.WaitForSingleObject(handle, 5000) != 0:
                raise ValueError('Old AGY session did not exit')
            stopped.append(pid)
        finally:
            kernel.CloseHandle(handle)
    return stopped


def synchronize_locked(write=False):
    account, paths, before = selected_account()
    payload = build_payload(account)
    matches = same_account(read_credential(), payload)
    state_path = cockpit_root() / 'agy-sync-state.json'
    try:
        previous = json.loads(state_path.read_text())['accountId']
    except (OSError, ValueError, KeyError):
        previous = None
    processes_need_restart = previous != account['id']
    repaired = False
    retired = []
    if write and (not matches or processes_need_restart):
        retired = stop_old_cli_processes()
        if before != [p.read_bytes() for p in paths]:
            raise ValueError('Desktop account changed before login update')
        write_credential(payload)
        matches = same_account(read_credential(), payload)
        repaired = True
    if before != [p.read_bytes() for p in paths]:
        raise ValueError('Desktop account changed during login update')
    if write and matches:
        temporary = state_path.with_name(state_path.name + '.' + str(os.getpid()) + '.tmp')
        temporary.write_text(json.dumps({'accountId': account['id']}))
        temporary.replace(state_path)
        processes_need_restart = False
    return {'accountId': account['id'], 'email': account['email'],
            'credentialMatches': matches, 'repaired': repaired,
            'processesNeedRestart': processes_need_restart, 'retiredProcesses': retired}


def synchronize(write=False):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, w.BOOL, w.LPCWSTR]
    kernel.CreateMutexW.restype = w.HANDLE
    kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
    kernel.ReleaseMutex.argtypes = [w.HANDLE]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    mutex = kernel.CreateMutexW(None, False, 'Local\\AntigravityDesktopCliAccountSync')
    if not mutex:
        raise ValueError('Account synchronization lock unavailable')
    acquired = False
    try:
        acquired = kernel.WaitForSingleObject(mutex, 10000) in (0, 128)
        if not acquired:
            raise ValueError('Account synchronization is busy')
        return synchronize_locked(write)
    finally:
        if acquired:
            kernel.ReleaseMutex(mutex)
        kernel.CloseHandle(mutex)


if __name__ == '__main__':
    try:
        print(json.dumps(synchronize('--sync' in sys.argv)))
    except Exception:
        # Never include credential parse exceptions, payloads or tokens.
        print(json.dumps({'error': 'Antigravity account synchronization unavailable'}))
        sys.exit(1)
