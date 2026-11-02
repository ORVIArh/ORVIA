#!/usr/bin/env python3
"""Independent scalar-energy Ewald oracle, with explicit finite sums and conventions."""
from __future__ import annotations
import itertools
import json
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
import mpmath as mp
from generate_bond_vectors import binary128_nearest

PRECISION = 90
FIXTURE = {'positions':[['0.25','0.5','0.75'],['1.25','1','0.875']],
           'charges':['1','-1'],'box':['4','4','4'],'alpha':'0.75','cutoff':'1.75',
           'prefactor':'1','max_mode':1}

def norm(v): return mp.sqrt(mp.fsum(x*x for x in v))
def dot(a,b): return mp.fsum(x*y for x,y in zip(a,b))
def mic(a,b,box):
    d=[y-x for x,y in zip(a,b)]
    return [x-L*mp.floor(x/L+mp.mpf('.5')) for x,L in zip(d,box)]
def half_modes(n):
    return [v for v in itertools.product(range(-n,n+1),repeat=3)
            if v!=(0,0,0) and next(x for x in v if x)!=0 and next(x for x in v if x)>0]
def real_energy(d,q,k,a,rc):
    r=norm(d)
    if r==0: raise ValueError('singular real pair')
    return k*q*mp.erfc(a*r)/r if r<rc else mp.mpf(0)
def exception_energy(d,q,desired,k,a):
    r=norm(d)
    if r==0:
        if desired: raise ValueError('singular direct exception')
        return -2*k*q*a/mp.sqrt(mp.pi)
    return k*(desired-q*mp.erf(a*r))/r
def pair_force(fn,d):
    return [mp.diff(lambda t:fn(d[:i]+[t]+d[i+1:]),d[i]) for i in range(3)]
def reciprocal_mode_energy(positions,charges,box,alpha,k,mode):
    wave=[2*mp.pi*n/L for n,L in zip(mode,box)]
    coeff=4*mp.pi*k/mp.fprod(box)*mp.exp(-dot(wave,wave)/(4*alpha*alpha))/dot(wave,wave)
    cs=[q*mp.cos(dot(wave,p)) for p,q in zip(positions,charges)]
    ss=[q*mp.sin(dot(wave,p)) for p,q in zip(positions,charges)]
    return coeff*(mp.fsum(cs)**2+mp.fsum(ss)**2)
def energy(positions,source=FIXTURE,exception=None,max_mode=None,real_images=None):
    charges=list(map(mp.mpf,source['charges']));box=list(map(mp.mpf,source['box']))
    a=mp.mpf(source['alpha']);k=mp.mpf(source['prefactor']);rc=mp.mpf(source['cutoff'])
    result=mp.mpf(0)
    if real_images is None:
        for i in range(len(positions)):
            for j in range(i+1,len(positions)):
                d=mic(positions[i],positions[j],box)
                result += (exception_energy(d,charges[i]*charges[j],mp.mpf(exception),k,a)
                           if exception is not None and (i,j)==(0,1)
                           else real_energy(d,charges[i]*charges[j],k,a,rc))
    else:
        # Independent full real-space lattice sum, including nonzero self images.
        if exception is not None: raise ValueError('full-lattice exception not used here')
        for i,p in enumerate(positions):
            for j,z in enumerate(positions):
                for image in itertools.product(range(-real_images,real_images+1),repeat=3):
                    if i==j and image==(0,0,0):continue
                    d=[z[d]-p[d]+box[d]*image[d] for d in range(3)];r=norm(d)
                    result += k*charges[i]*charges[j]*mp.erfc(a*r)/(2*r)
    for mode in half_modes(source['max_mode'] if max_mode is None else max_mode):
        result+=reciprocal_mode_energy(positions,charges,box,a,k,mode)
    result-=k*a/mp.sqrt(mp.pi)*mp.fsum(q*q for q in charges)
    result-=k*mp.pi*mp.fsum(charges)**2/(2*a*a*mp.fprod(box))
    return result

def forces(positions,source=FIXTURE,exception=None):
    flat=[x for p in positions for x in p]
    def f(values):return energy([values[i:i+3] for i in range(0,len(values),3)],source,exception)
    ans=[-mp.diff(lambda t:f(flat[:i]+[t]+flat[i+1:]),x) for i,x in enumerate(flat)]
    return [ans[i:i+3] for i in range(0,len(ans),3)]
def q(x):return binary128_nearest(Decimal(str(x)))
def encode(v):
    if isinstance(v,list):return [encode(x) for x in v]
    if isinstance(v,dict):return {k:encode(x) if k!='max_mode' else x for k,x in v.items()}
    if isinstance(v,int):return v
    return q(v)
def string(v):
    if isinstance(v,list):return [string(x) for x in v]
    return mp.nstr(v,85)
def generate():
    mp.mp.dps=PRECISION
    real=[]
    for d,q0,k,a,rc in [(['.125','0','0'],'-1','1','.5','2'),(['1','.5','.125'],'-.5','2','.75','1.75'),(['1.74999904632568359375','0','0'],'1','1','.75','1.75'),(['1.75','0','0'],'1','1','.75','1.75'),(['2','0','0'],'-1','1','.75','1.75'),(['15.5','0','0'],'1','1','1','16'),(['1','0','0'],'0','1','1','2')]:
        args=list(map(mp.mpf,[q0,k,a,rc]));dv=list(map(mp.mpf,d));fn=lambda z:real_energy(z,*args)
        real.append({'input':{'displacement':list(map(q,d)),'chargeProduct':q(q0),'prefactor':q(k),'alpha':q(a),'cutoff':q(rc)},'energy':string(fn(dv)),'force':string(pair_force(fn,dv) if norm(dv)<args[3] else [mp.mpf(0)]*3)})
    exceptions=[]
    for d,original,desired,k,a in [(['1','.5','.125'],'-1','-.25','1','.75'),(['3','0','0'],'1','0','1','.75'),(['.0000000000009094947017729282379150390625','0','0'],'1','0','1','1'),(['0','0','0'],'-1','0','1','.75'),(['1','0','0'],'0','.5','2','.5')]:
        args=list(map(mp.mpf,[original,desired,k,a]));dv=list(map(mp.mpf,d));fn=lambda z:exception_energy(z,*args)
        exceptions.append({'input':{'displacement':list(map(q,d)),'original':q(original),'desired':q(desired),'prefactor':q(k),'alpha':q(a)},'energy':string(fn(dv)),'force':string([mp.mpf(0)]*3 if norm(dv)==0 else pair_force(fn,dv))})
    p=[list(map(mp.mpf,v)) for v in FIXTURE['positions']]
    fixture={'input':encode(FIXTURE),'input_decimal':FIXTURE,'modes':[list(v) for v in half_modes(FIXTURE['max_mode'])],
             'ordinary':{'energy':string(energy(p)),'forces':string(forces(p))},
             'exception':{'desired_charge_product':q('-.25'),'energy':string(energy(p,exception='-.25')),'forces':string(forces(p,exception='-.25'))}}
    return {'schema_version':'orvia.ewald.reference.v0.5','precision_digits':PRECISION,
      'scope':'Finite orthorhombic Ewald component fixture, not PME or a converged biomolecular model.',
      'convention':'Canonical half reciprocal space includes both signs; tin-foil boundary and uniform neutralizing plasma when net charge is nonzero.',
      'forces':'Independent differentiation of scalar energies; no Solidity forces imported.',
      'real_pairs':real,'exceptions':exceptions,'fixture':fixture}
if __name__=='__main__':
    out=Path(__file__).with_name('ewald_reference.json');out.write_text(json.dumps(generate(),indent=2)+'\n');print(out)
