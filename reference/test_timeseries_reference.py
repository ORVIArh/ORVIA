import json,random,unittest
from pathlib import Path
import mpmath as mp
from generate_timeseries_reference import analyze,fixture
class TestTimeSeriesReference(unittest.TestCase):
 def test_fixture_regeneration(self):self.assertEqual(fixture(),json.loads(Path(__file__).with_name('timeseries_reference.json').read_text()))
 def test_shift_scale_invariance(self):
  f=fixture();r=analyze([100+3*x for x in f['values']],7)
  self.assertLess(abs(mp.mpf(r['g'])-mp.mpf(f['expected']['g'])),mp.mpf('1e-60'));self.assertEqual(r['usedLag'],f['expected']['usedLag'])
 def test_constant_short_and_truncation_flags(self):
  self.assertTrue(analyze([7]*16,7)['constant']);self.assertFalse(analyze([7]*16,7)['validEstimate'])
  self.assertTrue(analyze([1,-1],1)['shortSeries']);self.assertTrue(analyze(list(range(16)),1)['truncated'])
 def test_negative_correlation_clamp(self):
  r=analyze([1,-1]*8,7);self.assertEqual(mp.mpf(r['g']),1);self.assertEqual(mp.mpf(r['effectiveSamples']),16)
 def test_ar1_sanity(self):
  random.seed(403);x=0.;values=[]
  for i in range(9216):
   x=.5*x+random.gauss(0,1)
   if i>=1024:values.append(x)
  r=analyze(values,63);self.assertFalse(r['truncated']);self.assertTrue(mp.mpf('2.4')<mp.mpf(r['g'])<mp.mpf('3.6'),r['g'])
if __name__=='__main__':unittest.main()
