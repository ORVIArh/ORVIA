"""Direct high-precision centered autocovariances and Geyer IMS reference."""
import json
from pathlib import Path
import mpmath as mp
mp.mp.dps=80

def analyze(values,max_lag,minimum_samples=16):
    x=list(map(mp.mpf,values));n=len(x);mean=mp.fsum(x)/n
    c=[v-mean for v in x]
    gamma=[mp.fsum(c[i]*c[i+t] for i in range(n-t))/n for t in range(max_lag+1)]
    constant=all(v==x[0] for v in x);short=n<minimum_samples;truncated=False;used=0
    if constant:g=neff=mp.mpf(0)
    else:
        pairs=[gamma[i]+gamma[i+1] for i in range(0,max_lag+1,2)]
        positive=[]
        for pair in pairs:
            if pair<=0:break
            positive.append(pair)
        monotone=[min(positive[:i+1]) for i in range(len(positive))]
        used=2*len(monotone)-1 if monotone else 0
        truncated=len(positive)==len(pairs)
        g=max(mp.mpf(1),-1+2*mp.fsum(monotone)/gamma[0]);neff=n/g
    show=lambda a:mp.nstr(a,75)
    return {'mean':show(mean),'populationVariance':show(gamma[0]),'sampleVariance':show(gamma[0]*n/(n-1)) if n>1 else '0',
            'covariance':list(map(show,gamma)),'g':show(g),'effectiveSamples':show(neff),'usedLag':used,
            'constant':constant,'shortSeries':short,'truncated':truncated,'validEstimate':not(constant or short or truncated)}

def fixture():
    values=[0,1,2,3,2,1,0,-1,-2,-3,-2,-1,0,1,0,-1]
    return {'schema_version':'orvia.timeseries.reference.v1','scope':'Synthetic chronological observable; not proof of stationary molecular sampling',
            'method':'Two-pass centered moments and direct autocovariance sums, then initial-positive/initial-monotone adjacent pairs',
            'values':values,'maxLag':7,'minimumSamples':16,'expected':analyze(values,7)}
if __name__=='__main__':Path(__file__).with_name('timeseries_reference.json').write_text(json.dumps(fixture(),indent=2)+'\n')
