#!/usr/bin/env python3
"""Local synthetic integrity tests; no cloud, engine loads or GPU contexts."""
from pathlib import Path
import hashlib,importlib.util,subprocess,tempfile,unittest
spec=importlib.util.spec_from_file_location('export_engine',Path(__file__).with_name('model_repair_export_engine.py'))
export=importlib.util.module_from_spec(spec);spec.loader.exec_module(export)
class Licenses(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
  self.git('init','-q')
 def tearDown(self):self.temp.cleanup()
 def git(self,*args):
  return subprocess.run(['git','-C',str(self.root),*args],check=True,capture_output=True).stdout.decode().strip()
 def commit(self):
  self.git('add','.');self.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','license fixture')
  return self.git('rev-parse','HEAD')
 def seed(self):
  folder=self.root/'docs-source/licenses';folder.mkdir(parents=True)
  (folder/'Licenses.txt').write_text('Synthetic index, not an upstream license.\n')
  (folder/'LGPL.txt').write_text('Synthetic subordinate fixture.\n')
  return self.commit()
 def test_exact_entire_subtree(self):
  commit=self.seed();files=export.upstream_license_files(self.root,commit)
  self.assertEqual({n for _,n,_ in files},{'docs-source/licenses/Licenses.txt','docs-source/licenses/LGPL.txt'})
  for f,_,h in files:self.assertEqual(h,hashlib.sha256(f.read_bytes()).hexdigest())
 def test_missing_index_rejected(self):
  (self.root/'README.md').write_text('fixture');commit=self.commit()
  with self.assertRaisesRegex(ValueError,'license index is missing'):export.upstream_license_files(self.root,commit)
 def test_dirty_license_rejected(self):
  commit=self.seed();(self.root/'docs-source/licenses/LGPL.txt').write_text('changed')
  with self.assertRaisesRegex(ValueError,'differs from pinned Git object'):export.upstream_license_files(self.root,commit)
 def test_missing_subordinate_rejected(self):
  commit=self.seed();(self.root/'docs-source/licenses/LGPL.txt').unlink()
  with self.assertRaisesRegex(ValueError,'Missing or unsafe'):export.upstream_license_files(self.root,commit)
 def test_external_symlink_rejected(self):
  commit=self.seed();f=self.root/'docs-source/licenses/LGPL.txt';f.unlink()
  with tempfile.TemporaryDirectory()as other:
   dest=Path(other)/'license';dest.write_text('Synthetic subordinate fixture.\n');f.symlink_to(dest)
   with self.assertRaisesRegex(ValueError,'Missing or unsafe'):export.upstream_license_files(self.root,commit)
if __name__=='__main__':unittest.main()
