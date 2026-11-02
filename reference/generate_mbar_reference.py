"""Independent MBAR roots and diagnostics at 90 decimal digits."""
import json
from pathlib import Path
import mpmath as mp
mp.mp.dps=90

def solve(rows, origins):
    u=[[mp.mpf(str(x)) for x in row] for row in rows]
    k=len(u[0]); n=len(u); counts=[origins.count(i) for i in range(k)]
    def weights(f):
        return [[mp.exp(f[i]-row[i])/sum(counts[j]*mp.exp(f[j]-row[j]) for j in range(k)) for i in range(k)] for row in u]
    def equations(*tail):
        w=weights([mp.mpf(0),*tail]);return tuple(sum(row[i] for row in w)-1 for i in range(1,k))
    root=mp.findroot(equations,tuple(mp.mpf(0) for _ in range(k-1)),tol=mp.mpf('1e-80'),maxsteps=100)
    f=[mp.mpf(0),*list(root)];w=weights(f)
    overlap=[[counts[j]*sum(row[i]*row[j] for row in w) for j in range(k)] for i in range(k)]
    ess=[sum(row[i] for row in w)**2/sum(row[i]**2 for row in w) for i in range(k)]
    denominators=[mp.log(sum(counts[j]*mp.exp(f[j]-row[j]) for j in range(k))) for row in u]
    return {'f':[mp.nstr(x,85) for x in f],'log_denominators':[mp.nstr(x,85) for x in denominators],
            'weight_sums':[mp.nstr(sum(row[i] for row in w),85) for i in range(k)],
            'ess':[mp.nstr(x,85) for x in ess],'overlap':[[mp.nstr(x,85) for x in row] for row in overlap]}

def fixture():
    xs=[mp.mpf(x)/2 for x in [-2,-1,0,1,2,3]]
    rows=[[0,mp.mpf('0.25')+x/32,mp.mpf('-0.5')-x/32] for x in xs]
    rows=[[mp.nstr(x,85) for x in row] for row in rows]; origins=[0,1,1,2,2,2]
    return {'schema_version':'orvia.mbar.reference.v1','method':'90-digit Newton root of normalized MBAR weights; independent of Solidity fixed-point iteration',
            'scope':'Synthetic equilibrium-analysis fixture only, not molecular samples or a free-energy validation of ORVIA-001',
            'rows':rows,'origins':origins,'expected':solve(rows,origins)}
if __name__=='__main__':
    Path(__file__).with_name('mbar_reference.json').write_text(json.dumps(fixture(),indent=2)+'\n')
