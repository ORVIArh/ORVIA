import json,unittest
from pathlib import Path
import mpmath as mp
from generate_mbar_reference import fixture,solve
class TestMBARReference(unittest.TestCase):
 def test_reference_reproduces(self):
  self.assertEqual(fixture(),json.loads(Path(__file__).with_name('mbar_reference.json').read_text()))
 def test_constant_offsets_exact(self):
  r=solve([[0,2,-1]]*6,[0,0,1,1,2,2]);self.assertLess(abs(mp.mpf(r['f'][1])-2),mp.mpf('1e-70'));self.assertLess(abs(mp.mpf(r['f'][2])+1),mp.mpf('1e-70'))
 def test_gauge_invariance_and_normalizations(self):
  f=fixture();shifted=[[str(mp.mpf(v)+i*7) for v in row] for i,row in enumerate(f['rows'])];r=solve(shifted,f['origins'])
  for a,b in zip(r['f'],f['expected']['f']):self.assertLess(abs(mp.mpf(a)-mp.mpf(b)),mp.mpf('1e-70'))
  for row in r['overlap']:self.assertLess(abs(sum(map(mp.mpf,row))-1),mp.mpf('1e-70'))
  for e in r['ess']:self.assertTrue(1<=mp.mpf(e)<=6)
 def test_poor_overlap_not_solver_failure(self):
  r=solve([[0,20],[0,-20]],[0,1]);self.assertLess(abs(mp.mpf(r['f'][1])),mp.mpf('1e-70'));self.assertLess(mp.mpf(r['overlap'][0][1]),mp.mpf('1e-6'))
 def test_repeat_sem(self):
  x=list(map(mp.mpf,[1,2,4]));mean=sum(x)/3;sem=mp.sqrt(sum((v-mean)**2 for v in x)/(3*2));self.assertLess(abs(sem-mp.sqrt(7)/3),mp.mpf('1e-80'))
if __name__=='__main__':unittest.main()
