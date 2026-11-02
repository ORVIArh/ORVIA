import json,sys
import mpmath as m
m.mp.dps=110
def quad(h):
    x=int(h,16);sign=-1 if x>>127 else 1;exp=(x>>112)&32767;frac=x&((1<<112)-1)
    assert exp!=32767
    return sign*m.mpf((1<<112)+frac if exp else frac)*m.power(2,(exp-16383-112) if exp else -16494)
actual=json.load(sys.stdin)
# Independent exact-circle solution of the two free RATTLE half-drifts.
# Relative speed remains 3/2; each half-drift rotates by asin(h*relative_speed).
theta=2*m.asin(-m.mpf(3)/256)
d=[m.cos(theta),m.sin(theta),m.mpf(0)];w=[-(-m.mpf('1.5'))*d[1],-m.mpf('1.5')*d[0],m.mpf(0)]
center=[m.mpf(2)/3,0,0]
p=[[center[k]-m.mpf(2)/3*d[k] for k in range(3)],[center[k]+d[k]/3 for k in range(3)]]
v=[[-m.mpf(2)/3*w[k] for k in range(3)],[w[k]/3 for k in range(3)]]
errors=[]
for atom in range(2):
    for field,expected in enumerate([p[atom],v[atom]]):
        for axis in range(3): errors.append(abs(quad(actual[atom][field][axis])-expected[axis]))
maximum=max(errors);print(json.dumps({'passed':maximum<m.mpf('1e-24'),'maximumAbsoluteError':str(maximum),'decimalPrecision':110,'method':'Exact free-dimer circle rotation, two RATTLE half-drifts; independently derived, no Solidity arithmetic replay.'}))
