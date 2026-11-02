#!/usr/bin/env python3
"""Independent scalar-energy hybrid/finite-Ewald reference; no Solidity force formulas.

The model is explicitly bounded finite Ewald and switched LJ, not a converged
protein force field. Forces and lambda derivatives use 90-digit differentiation.
"""
import itertools
import json
import sys
import mpmath as mp
from scalar_random_reference import quad
from generate_periodic_reference import displacement, unique_displacement
from generate_dynamics_reference import dot, cross, norm

mp.mp.dps = 90


def decode(x):
    if isinstance(x, str):
        return quad(x) if x.startswith('0x') else mp.mpf(x)
    if isinstance(x, list):
        return [decode(v) for v in x]
    if isinstance(x, dict):
        return {k: decode(v) for k, v in x.items()}
    return x


def bonded(positions, endpoint, box):
    out = [mp.mpf(0)] * 3
    for a, b, k, r0 in endpoint['bonds']:
        if k:
            out[0] += k * (norm(unique_displacement(positions[a], positions[b], box))-r0)**2/2
    for a, b, c, k, theta0 in endpoint['angles']:
        if k:
            u = unique_displacement(positions[b], positions[a], box)
            v = unique_displacement(positions[b], positions[c], box)
            out[1] += k*(mp.acos(dot(u,v)/(norm(u)*norm(v)))-theta0)**2/2
    for a, b, c, d, n, k, phase in endpoint['torsions']:
        if k:
            u = unique_displacement(positions[a], positions[b], box)
            v = unique_displacement(positions[b], positions[c], box)
            w = unique_displacement(positions[c], positions[d], box)
            p, q = cross(u,v), cross(v,w)
            phi = mp.atan2(dot(v,cross(p,q))/norm(v),dot(p,q))
            out[2] += k*(1+mp.cos(n*phi-phase))
    return out


def terms(positions, source, lam):
    a, b = source['a'], source['b']
    box, alpha, rc, rs, K = [source[k] for k in ['box','alpha','cutoff','switchDistance','prefactor']]
    ba, bb = bonded(positions,a,box), bonded(positions,b,box)
    out = [(1-lam)*u+lam*v for u,v in zip(ba,bb)] + [mp.mpf(0)]*6
    charges = [(1-lam)*x[2]+lam*y[2] for x,y in zip(a['nonbonded'],b['nonbonded'])]
    exceptions_a = {(x[0],x[1]):x for x in a['exceptions']}
    exceptions_b = {(x[0],x[1]):x for x in b['exceptions']}
    for i in range(len(positions)):
        for j in range(i+1,len(positions)):
            exception = exceptions_a.get((i,j))
            delta = (unique_displacement if exception else displacement)(positions[i],positions[j],box)
            r = norm(delta)
            if exception:
                ea, eb = exception, exceptions_b[(i,j)]
                sa, la, sb, lb = ea[3],ea[4],eb[3],eb[4]
                desired = (1-lam)*ea[5]+lam*eb[5]
                if ea[2] == 1:
                    sa = sb = mp.mpf(1);la = lb = mp.mpf(0)
            else:
                sa = (a['nonbonded'][i][0]+a['nonbonded'][j][0])/2
                sb = (b['nonbonded'][i][0]+b['nonbonded'][j][0])/2
                la = mp.sqrt(a['nonbonded'][i][1]*a['nonbonded'][j][1])
                lb = mp.sqrt(b['nonbonded'][i][1]*b['nonbonded'][j][1])
            if exception or r < rc:
                if sa == sb and la == lb:
                    lj = 4*la*((sa/r)**12-(sa/r)**6) if la else mp.mpf(0)
                else:
                    def endpoint(sigma, epsilon, soft):
                        if not epsilon:return mp.mpf(0)
                        t = sigma**6/(r**6+source['softcoreAlpha']*sigma**6*soft**2)
                        return 4*epsilon*(t*t-t)
                    lj = (1-lam)*endpoint(sa,la,lam)+lam*endpoint(sb,lb,1-lam)
                if not exception and r > rs:
                    x = (r-rs)/(rc-rs)
                    lj *= 1-10*x**3+15*x**4-6*x**5
                out[3] += lj
            product = charges[i]*charges[j]
            if exception:
                if r:
                    out[8] += K*(desired-product*mp.erf(alpha*r))/r
                elif desired:
                    raise ValueError('charged direct collision')
                else:
                    out[8] -= K*product*2*alpha/mp.sqrt(mp.pi)
            elif product and r < rc:
                out[4] += K*product*mp.erfc(alpha*r)/r
    volume = mp.fprod(box)
    # Independent full reciprocal cube; the Solidity traversal uses half-space.
    for n in itertools.product(range(-int(source['extent']),int(source['extent'])+1),repeat=3):
        if n == (0,0,0):continue
        wave = [2*mp.pi*x/L for x,L in zip(n,box)]
        k2 = dot(wave,wave)
        S = sum(q*mp.exp(1j*dot(wave,p)) for q,p in zip(charges,positions))
        out[5] += K*2*mp.pi/volume*mp.exp(-k2/(4*alpha*alpha))/k2*abs(S)**2
    out[6] = -K*alpha/mp.sqrt(mp.pi)*sum(q*q for q in charges)
    out[7] = -K*mp.pi*sum(charges)**2/(2*alpha*alpha*volume)
    return out


def evaluate(payload):
    source = decode(payload['source'])
    positions = decode(payload['positions'])
    lam = decode(payload['lambda'])
    flat = [v for row in positions for v in row]
    def potential(values,l=lam):return sum(terms([values[i:i+3] for i in range(0,len(values),3)],source,l))
    force = [-mp.diff(lambda z:potential(flat[:i]+[z]+flat[i+1:]),x) for i,x in enumerate(flat)]
    components = terms(positions,source,lam)
    return {'components':[str(sum(components))]+[str(x) for x in components],
            'forces':[[str(x) for x in force[i:i+3]] for i in range(0,len(force),3)],
            'derivativeLambda':str(mp.diff(lambda l:potential(flat,l),lam)),
            'scope':'Independent 90-digit scalar-energy differentiation of the declared finite model; not full molecular accuracy or ensemble acceptance.'}


if __name__ == '__main__':
    print(json.dumps(evaluate(json.load(sys.stdin)),indent=2))
