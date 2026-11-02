import json, sys
import mpmath as mp
mp.mp.dps=110
def q(h):
    x=int(h,16); s=-1 if x>>127 else 1; e=(x>>112)&32767; f=x&((1<<112)-1)
    assert e!=32767
    return s*mp.mpf((1<<112)+f if e else f)*mp.power(2,(e or 1)-16383-112)
def dot(a,b): return mp.fsum(x*y for x,y in zip(a,b))
def dif(a,b): return [y-x for x,y in zip(a,b)]
def project_v(p,v,m):
    d=dif(p[0],p[1]); g=dot(d,dif(v[0],v[1]))/dot(d,d)
    for k in range(3):
        v[0][k]+=m[1]/(m[0]+m[1])*g*d[k]
        v[1][k]-=m[0]/(m[0]+m[1])*g*d[k]
def drift(p,v,m,h):
    old=[row[:] for row in p]; trial=[[p[a][k]+h*v[a][k] for k in range(3)] for a in range(3)]
    d=dif(old[0],old[1]); r=dif(trial[0],trial[1]); cross=dot(d,r); defect=dot(r,r)-1
    x=(cross-mp.sqrt(cross*cross-dot(d,d)*defect))/dot(d,d)
    p[:]=[row[:] for row in trial]
    for k in range(3):
        p[0][k]+=m[1]/(m[0]+m[1])*x*d[k]
        p[1][k]-=m[0]/(m[0]+m[1])*x*d[k]
    for a in range(3):
        for k in range(3): v[a][k]+=(p[a][k]-trial[a][k])/h
    project_v(p,v,m)
def force(p):
    # Independent coordinate differentiation of U=k/2*(r12-r0)^2, k=2,r0=1.
    def energy(flat):
        r=mp.sqrt(mp.fsum((flat[6+k]-flat[3+k])**2 for k in range(3)))
        return (r-1)**2
    flat=sum(p,[]); out=[]
    for i in range(9):
        def evaluate(x):
            changed=flat[:];changed[i]=x;return energy(changed)
        out.append(-mp.diff(evaluate,flat[i]))
    return [out[3*a:3*a+3] for a in range(3)]
def case(row):
    initial=row['initial']; p=[[q(x) for x in atom[0]] for atom in initial]
    v=[[q(x) for x in atom[1]] for atom in initial]; masses=[mp.mpf(1),mp.mpf(2),mp.mpf(3)]
    dt=mp.mpf(1)/64;h=dt/2;gamma=mp.mpf(1)/2;kt=mp.mpf(1)/4
    f=force(p)
    initial_error=max(abs(q(initial[a][2][k])-f[a][k]) for a in range(3) for k in range(3))
    assert initial_error<mp.mpf('1e-24')
    for a in range(3):
        for k in range(3):v[a][k]+=h*f[a][k]/masses[a]
    project_v(p,v,masses);drift(p,v,masses,h)
    decay=mp.exp(-gamma*dt)
    for a in range(3):
        noise=mp.sqrt(kt/masses[a]*(-mp.expm1(-2*gamma*dt)))
        for k in range(3):v[a][k]=decay*v[a][k]+noise*q(row['normal'][a][k])
    project_v(p,v,masses);drift(p,v,masses,h);f=force(p)
    for a in range(3):
        for k in range(3):v[a][k]+=h*f[a][k]/masses[a]
    project_v(p,v,masses)
    expected=[[p[a],v[a],f[a]] for a in range(3)]
    error=max(abs(q(row['actual'][a][field][k])-expected[a][field][k]) for a in range(3) for field in range(3) for k in range(3))
    assert error<mp.mpf('1e-24'), (row['step'],str(error))
    return {'step':row['step'],'maximumAbsoluteError':str(error),'initialForceReferenceError':str(initial_error)}
data=json.load(sys.stdin)
print(json.dumps({'passed':True,'precisionDigits':110,'normalSource':'Conditions on exact CounterRandom binary128 draws; does not independently rederive the generator or establish an ensemble.',
    'method':'Independent scalar-potential force differentiation plus projected B/A/O/A/B reference with actual half-drift duration.',
    'cases':[case(row) for row in data]}))
