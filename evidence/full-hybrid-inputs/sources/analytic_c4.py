"""Independent exact direct C4 and pinned OpenMM no-switch LRC mathematics.

No OpenMM import. Sparse coefficient dict keys are (class_id,class_id), with
missing entries zero. Diagnostic zero classes do not authorize dummy activity.
"""
from collections import Counter
from fractions import Fraction
import mpmath as mp

def _fraction(value):
    return value if isinstance(value,Fraction) else Fraction(value)

def _coefficient(coefficients,a,b):
    value=coefficients.get((a,b),coefficients.get((b,a),0))
    if (a,b)in coefficients and (b,a)in coefficients and coefficients[a,b]!=coefficients[b,a]:
        raise ValueError('Asymmetric C4 matrix')
    return value

def analytic_lrc_energy(class_counts,coefficients,box_nm,cutoff_nm,decimal_digits=100):
    """Return mpf: -4*pi*N/(N+1)*sum(n_ij*Cij)/(V*rc).

    Applicable to CutoffPeriodic, no interaction groups, no switch. Exclusions
    are deliberately absent: the pinned implementation does not subtract them.
    Same-class n_ii=Ni*(Ni+1)/2; cross-class n_ij=Ni*Nj.
    """
    counts={int(k):int(v)for k,v in class_counts.items()if int(v)>0}
    if any(int(v)!=v or v<0 for v in class_counts.values()):raise ValueError('Invalid class count')
    N=sum(counts.values());rc=_fraction(cutoff_nm);box=list(map(_fraction,box_nm))
    if N<=0 or rc<=0 or len(box)!=3 or any(x<=0 for x in box):raise ValueError('Invalid domain')
    weighted=Fraction(0)
    keys=sorted(counts)
    for i,a in enumerate(keys):
        for b in keys[i:]:
            n=counts[a]*(counts[a]+1)//2 if a==b else counts[a]*counts[b]
            weighted+=n*_fraction(_coefficient(coefficients,a,b))
    volume=box[0]*box[1]*box[2]
    with mp.workdps(decimal_digits):
        ratio=Fraction(N,N+1)*weighted/(volume*rc)
        return -4*mp.pi*mp.mpf(ratio.numerator)/ratio.denominator

def analytic_direct(positions_nm,types,coefficients,box_nm,cutoff_nm,exclusions=()):
    """Exact Fraction scalar energy and its analytic Cartesian gradient.

    U=-C/(r^2)^2, F_first=4*C*delta/(r^2)^3. Exact nearest images and
    squared-cutoff classification; test geometries avoid cutoff ambiguity.
    """
    xyz=[[ _fraction(v)for v in row]for row in positions_nm];box=list(map(_fraction,box_nm));rc=_fraction(cutoff_nm)
    excluded={tuple(sorted(pair))for pair in exclusions};energy=Fraction(0);forces=[[Fraction(0)]*3for _ in xyz];pairs=[]
    for a in range(len(xyz)):
        for b in range(a+1,len(xyz)):
            d=[]
            for axis in range(3):
                value=xyz[b][axis]-xyz[a][axis];value-=int(value/box[axis])*box[axis]
                if value>box[axis]/2:value-=box[axis]
                elif value< -box[axis]/2:value+=box[axis]
                d.append(value)
            r2=sum(x*x for x in d);c=_fraction(_coefficient(coefficients,types[a],types[b]));included=(a,b)not in excluded and r2<rc*rc
            if r2==0:raise ValueError('Fixture coincidence is outside this oracle domain')
            e= -c/r2**2 if included else Fraction(0)
            f=[4*c*x/r2**3 for x in d]if included else [Fraction(0)]*3
            energy+=e
            for axis in range(3):forces[a][axis]+=f[axis];forces[b][axis]-=f[axis]
            pairs.append(dict(atoms=[a,b],excluded=(a,b)in excluded,inside_cutoff=r2<rc*rc,C4=str(c),r2=str(r2),energy=str(e)))
    return dict(energy=energy,forces=forces,pairs=pairs,class_counts=dict(Counter(types)))
