#!/usr/bin/env python3
"""Independent 100-digit angular references using mpmath's scalar energies.

Forces are -mpmath.diff(energy), not a port of the Solidity analytic gradients.
The binary128 encoder is shared only to serialize the exact dyadic inputs.
"""
import json
from pathlib import Path
import mpmath as mp
from generate_bond_vectors import binary128_nearest

mp.mp.dps = 100

def decimal(x): return mp.nstr(x, 105)
def decode(h):
    b=int(h,16); e=(b>>112)&32767; f=b&((1<<112)-1)
    if e==32767: raise ValueError('nonfinite')
    x=mp.mpf(f)*mp.power(2,-16382-112) if e==0 else mp.mpf((1<<112)+f)*mp.power(2,e-16383-112)
    return -x if b>>127 else x

def vector(xs): return [mp.mpf(x) for x in xs]
def sub(a,b): return [x-y for x,y in zip(a,b)]
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def cross(a,b): return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]

def angle_energy(points,k,theta0):
    u=sub(points[0],points[1]);v=sub(points[2],points[1])
    theta=mp.acos(dot(u,v)/mp.sqrt(dot(u,u)*dot(v,v)))
    return mp.mpf(k)*(theta-mp.mpf(theta0))**2/2

def torsion_energy(points,n,k,phase):
    b1=sub(points[1],points[0]);b2=sub(points[2],points[1]);b3=sub(points[3],points[2])
    n1=cross(b1,b2);n2=cross(b2,b3)
    phi=mp.atan2(dot(b2,cross(n1,n2))/mp.sqrt(dot(b2,b2)),dot(n1,n2))
    return mp.mpf(k)*(1+mp.cos(n*phi-mp.mpf(phase)))

def force_reference(points,energy):
    forces=[]
    for atom in range(len(points)):
        f=[]
        for axis in range(3):
            def varied(value):
                p=[list(v) for v in points];p[atom][axis]=value
                return energy(p)
            f.append(decimal(-mp.diff(varied,points[atom][axis])))
        forces.append(f)
    return forces

def main():
    atan=[]
    for y,x in [('1','1'),('1','-1'),('-1','-1'),('-1','1'),('3','0.5'),('0.125','7'),('0','-1'),('1','0'),('-1','0'),('0.000000000000000000000000000001','1')]:
        yh,xh=binary128_nearest(y),binary128_nearest(x)
        atan.append({'y':yh,'x':xh,'expected':decimal(mp.atan2(decode(yh),decode(xh)))})
    trig=[]
    encodings=[binary128_nearest(x) for x in ['0','0.25','-0.75','1.5','-3','7','-25','100']]
    encodings+=['0x4000921fb54442d18469898cc51701b8','0x4005921fb54442d18469898cc51701b8']
    for h in encodings:
        x=decode(h);trig.append({'angle':h,'sin':decimal(mp.sin(x)),'cos':decimal(mp.cos(x))})
    angle_cases=[
        ('right_angle',[['1','0','0'],['0','0','0'],['0','1','0']],'2','1'),
        ('general_angle',[['0.25','-1','0.5'],['1','0.25','-0.5'],['1.5','2','0.75']],'0.75','1.5'),
        ('obtuse_angle',[['-1','0.25','0'],['0','0','0'],['2','1','0.5']],'3','2.5'),
        ('zero_angle_strength',[['1','0','0'],['0','0','0'],['0','1','1']],'0','0.25')]
    angles=[]
    for name,p,k,theta0 in angle_cases:
        points=[vector(v) for v in p]
        e=lambda x:angle_energy(x,k,theta0)
        angles.append({'name':name,'positions':[[binary128_nearest(x) for x in row] for row in p],
            'k':binary128_nearest(k),'theta0':binary128_nearest(theta0),
            'expected':{'energy':decimal(e(points)),'forces':force_reference(points,e)}})
    torsion_cases=[
        ('right_dihedral',[['0','0','0'],['1','0','0'],['1','1','0'],['1','1','1']],1,'2','0.25'),
        ('general_dihedral',[['0','0','0'],['1','0','0'],['1.5','1','0.125'],['2','1.25','1.125']],2,'0.125','0.25'),
        ('negative_dihedral',[['0.5','-0.25','1'],['1','0','0'],['1.5','1','0.125'],['2','1.25','-1.125']],6,'0.75','-0.5'),
        ('planar_cis',[['0','1','0'],['0','0','0'],['1','0','0'],['1','1','0']],3,'1.25','0.5'),
        ('planar_trans',[['0','1','0'],['0','0','0'],['1','0','0'],['1','-1','0']],2,'1','-0.25'),
        ('zero_torsion_strength',[['0','0','0'],['1','0','0'],['1','1','0'],['2','1','1']],1,'0','0')]
    torsions=[]
    for name,p,n,k,phase in torsion_cases:
        points=[vector(v) for v in p]
        e=lambda x:torsion_energy(x,n,k,phase)
        torsions.append({'name':name,'positions':[[binary128_nearest(x) for x in row] for row in p],
            'periodicity':n,'k':binary128_nearest(k),'phase':binary128_nearest(phase),
            'expected':{'energy':decimal(e(points)),'forces':force_reference(points,e)}})
    payload={'schema_version':1,'oracle':'mpmath 1.3.0, 100 digits; forces by arbitrary-precision numerical differentiation of independent scalar energies',
        'comparison':{'relative_tolerance':'1e-27','absolute_tolerance':'1e-29'},
        'atan2':atan,'sinCos':trig,'angles':angles,'torsions':torsions}
    dest=Path(__file__).with_name('angular_vectors.json');dest.write_text(json.dumps(payload,indent=2)+'\n')
    print('Wrote',len(atan)+len(trig),'elementary and',len(angles)+len(torsions),'angular force fixtures')

if __name__=='__main__':main()
