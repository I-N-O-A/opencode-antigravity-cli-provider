import sys, unittest, importlib.util, tempfile, json
from pathlib import Path
from unittest.mock import patch
path=Path(__file__).resolve().parents[1] / 'agy-account-sync.py'
spec=importlib.util.spec_from_file_location('agy_account_sync',path)
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class Tests(unittest.TestCase):
 def test_payload_uses_selected_token(self):
  a={'token':{'access_token':'access','refresh_token':'refresh','expiry_timestamp':1791536000}}
  p=mod.build_payload(a)
  self.assertEqual(p['token']['refresh_token'],'refresh');self.assertEqual(p['auth_method'],'consumer')
 def test_missing_refresh_token_rejected(self):
  with self.assertRaises(ValueError):mod.build_payload({'token':{}})
 def test_credential_identity_ignores_rotating_access_token(self):
  self.assertTrue(mod.same_account({'token':{'refresh_token':'r','access_token':'old'}},{'token':{'refresh_token':'r','access_token':'new'}}))
 def test_other_account_rejected(self):
  self.assertFalse(mod.same_account({'token':{'refresh_token':'old'}},{'token':{'refresh_token':'new'}}))
 def test_rotation_stops_old_cli_before_writing_login(self):
  with tempfile.TemporaryDirectory() as temp:
   home=Path(temp);(home/'.antigravity_cockpit').mkdir()
   paths=[home/'state'];paths[0].write_bytes(b'fixed')
   a={'id':'new','email':'new@example.com','token':{'access_token':'a','refresh_token':'new','expiry_timestamp':1791536000}}
   events=[];old={'token':{'refresh_token':'old'}};new=mod.build_payload(a)
   with patch.object(mod.Path,'home',return_value=home),patch.object(mod,'selected_account',return_value=(a,paths,[b'fixed'])),patch.object(mod,'read_credential',side_effect=[old,new]),patch.object(mod,'stop_old_cli_processes',side_effect=lambda:events.append('stop') or [42]),patch.object(mod,'write_credential',side_effect=lambda p:events.append('write')):
    result=mod.synchronize_locked(True)
   self.assertEqual(events,['stop','write']);self.assertTrue(result['credentialMatches']);self.assertEqual(result['retiredProcesses'],[42])
   self.assertEqual(json.loads((home/'.antigravity_cockpit'/'agy-sync-state.json').read_text()),{'accountId':'new'})
 def test_inspection_never_stops_processes_or_writes_credentials(self):
  with tempfile.TemporaryDirectory() as temp:
   home=Path(temp);(home/'.antigravity_cockpit').mkdir(); p=home/'selection';p.write_bytes(b'x')
   a={'id':'new','email':'new@example.com','token':{'access_token':'a','refresh_token':'new','expiry_timestamp':1791536000}}
   with patch.object(mod.Path,'home',return_value=home),patch.object(mod,'selected_account',return_value=(a,[p],[b'x'])),patch.object(mod,'read_credential',return_value={'token':{'refresh_token':'old'}}),patch.object(mod,'stop_old_cli_processes') as stop,patch.object(mod,'write_credential') as write:
    result=mod.synchronize_locked(False)
    stop.assert_not_called();write.assert_not_called();self.assertFalse(result['credentialMatches'])
if __name__=='__main__':unittest.main()
