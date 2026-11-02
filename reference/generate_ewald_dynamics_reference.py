#!/usr/bin/env python3
"""Scalar-energy differentiated Ewald + bonded/LJ velocity-Verlet fixture."""
from __future__ import annotations
import json
from copy import deepcopy
from pathlib import Path
import mpmath as mp
from generate_ewald_reference import FIXTURE, energy as electrostatic_energy, mic, norm, string, q

PRECISION = 90
DT = '0.00390625'
VELOCITIES = [['0.00390625','-0.001953125','0'],['-0.001953125','0.00390625','0.0009765625']]
MASSES = ['1','2']

def total_energy(positions, exception=False):
    d = mic(positions[0],positions[1],list(map(mp.mpf,FIXTURE['box'])))
    r = norm(d)
    e = electrostatic_energy(positions, exception='-.25' if exception else None)
    e += mp.mpf('.25') / 2 * (r-mp.mpf('1'))**2
    sigma, epsilon = (mp.mpf('.625'),mp.mpf('.0625')) if exception else (mp.mpf('.5'),mp.mpf('.125'))
    if exception or r < mp.mpf(FIXTURE['cutoff']):
        lj = 4*epsilon*((sigma/r)**12-(sigma/r)**6)
        if not exception and r > 1:
            x = (r-1)/(mp.mpf(FIXTURE['cutoff'])-1)
            lj *= 1-10*x**3+15*x**4-6*x**5
        e += lj
    return e

def forces(positions, exception=False):
    flat = [v for p in positions for v in p]
    def energy_at(values):return total_energy([values[:3],values[3:]],exception)
    out = [-mp.diff(lambda z:energy_at(flat[:i]+[z]+flat[i+1:]),x) for i,x in enumerate(flat)]
    return [out[:3],out[3:]]

def trajectory(exception=False,steps=2):
    positions = [list(map(mp.mpf,p)) for p in FIXTURE['positions']]
    velocity = [list(map(mp.mpf,v)) for v in VELOCITIES]
    masses = list(map(mp.mpf,MASSES));dt=mp.mpf(DT)
    force = forces(positions,exception)
    frames=[]
    for step in range(steps+1):
        frames.append({'step':step,'positions':string(positions),'velocities':string(velocity),
                       'forces':string(force),'energy':string(total_energy(positions,exception))})
        if step == steps:break
        half = [[velocity[i][d]+dt/(2*masses[i])*force[i][d] for d in range(3)] for i in range(2)]
        positions = [[positions[i][d]+dt*half[i][d] for d in range(3)] for i in range(2)]
        force = forces(positions,exception)
        velocity = [[half[i][d]+dt/(2*masses[i])*force[i][d] for d in range(3)] for i in range(2)]
    return frames

def generate():
    mp.mp.dps=PRECISION
    values={'positions':[[q(x) for x in p] for p in FIXTURE['positions']],
        'particles':[[q(m),*[q(v) for v in vs]] for m,vs in zip(MASSES,VELOCITIES)],
        'bonds':[[0,1,q('.25'),q('1')]],'angles':[],'torsions':[],'pairs':[],
        'nonbonded':[[q('.5'),q('.125'),q(c)] for c in FIXTURE['charges']],
        'exceptions':[], 'box':[q(x) for x in FIXTURE['box']],
        'switchDistance':q('1'),'cutoff':q(FIXTURE['cutoff']),'prefactor':q('1'),
        'dt':q(DT),'alpha':q(FIXTURE['alpha']),'maxMode':1,'steps':2}
    exception=deepcopy(values);exception['exceptions']=[[0,1,2,q('.625'),q('.0625'),q('-.25')]];exception['steps']=1
    return {'schema_version':'orvia.ewald.dynamics.reference.v0.5','precision_digits':PRECISION,
        'scope':'Two-atom finite Ewald NVE oracle with nonzero bond and LJ terms; not a converged molecular model.',
        'method':'Forces independently differentiated from scalar total energy, then high precision velocity Verlet.',
        'input':values,'trajectory':trajectory(False,2),
        'exception_input':exception,'exception_trajectory':trajectory(True,1)}

if __name__ == '__main__':
    out=Path(__file__).with_name('ewald_dynamics_reference.json')
    out.write_text(json.dumps(generate(),indent=2)+'\n');print(out)
