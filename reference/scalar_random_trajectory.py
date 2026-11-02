#!/usr/bin/env python3
"""Independent BAOAB trajectory from scalar molecular energies and hash-derived uniforms."""
from copy import deepcopy
import json
import sys
import mpmath as mp
from scalar_random_reference import quad
from generate_periodic_reference import potential, forces, initial_state

mp.mp.dps = 100


def decode(value):
    if isinstance(value, str) and value.startswith('0x'):
        return quad(value)
    if isinstance(value, list):
        return [decode(v) for v in value]
    if isinstance(value, dict):
        return {k: decode(v) for k, v in value.items()}
    return value


def generate(payload):
    source = decode(payload['source'])
    gamma, kt = map(quad, payload['thermostat'])
    dt = source['dt']
    x, v, masses = initial_state(source)
    force = forces(x, source)
    history = []

    def checkpoint(step):
        return {'step': step, 'positions': [[str(a) for a in r] for r in x],
                'velocities': [[str(a) for a in r] for r in v],
                'forces': [[str(a) for a in r] for r in force], 'energy': str(potential(x, source))}

    history.append(checkpoint(0))
    decay = mp.exp(-gamma*dt)
    noise = [mp.sqrt(kt/mass * -mp.expm1(-2*gamma*dt)) for mass in masses]
    for step in range(source['steps']):
        normals = []
        for raw in payload['uniforms'][step]:
            u, w, u2, w2 = map(quad, raw)
            radius = mp.sqrt(-2*mp.log(u))
            normals.append([radius*mp.cos(2*mp.pi*w), radius*mp.sin(2*mp.pi*w),
                            mp.sqrt(-2*mp.log(u2))*mp.cos(2*mp.pi*w2)])
        half = [[v[i][d] + dt*force[i][d]/(2*masses[i]) for d in range(3)] for i in range(len(x))]
        thermal = [[decay*half[i][d] + noise[i]*normals[i][d] for d in range(3)] for i in range(len(x))]
        x = [[x[i][d] + dt*(half[i][d]+thermal[i][d])/2 for d in range(3)] for i in range(len(x))]
        force = forces(x, source)
        v = [[thermal[i][d] + dt*force[i][d]/(2*masses[i]) for d in range(3)] for i in range(len(x))]
        history.append(checkpoint(step+1))
    return {'scope': 'Two-atom, three-step stochastic periodic cutoff-model fixture; not a sampled protein ensemble.',
            'reference': 'mpmath 1.3.0 at 100 digits; forces from scalar-energy differentiation; normals from independently encoded hash uniforms',
            'inputs': deepcopy(payload), 'checkpoints': history}


def compare(payload):
    reference = generate(payload['input'])
    actual = payload['actual']
    if len(actual) != len(reference['checkpoints']):
        raise AssertionError('Checkpoint count mismatch')
    reports = []
    for got, want in zip(actual, reference['checkpoints']):
        if got['step'] != want['step']:
            raise AssertionError('Step mismatch')
        errors = []
        for field in ['positions', 'velocities', 'forces']:
            for actual_row, expected_row in zip(got[field], want[field]):
                for a, b in zip(actual_row, expected_row):
                    value = mp.mpf(b)
                    error = abs(quad(a)-value)
                    if error > mp.mpf('1e-25')+abs(value)*mp.mpf('1e-24'):
                        raise AssertionError(f'Step {got["step"]} {field}: {error}')
                    errors.append(error)
        value = mp.mpf(want['energy'])
        error = abs(quad(got['energy'])-value)
        if error > mp.mpf('1e-25')+abs(value)*mp.mpf('1e-24'):
            raise AssertionError(f'Step {got["step"]} energy: {error}')
        errors.append(error)
        reports.append({'step': got['step'], 'scalar_values_checked': len(errors),
                        'maximum_absolute_error': str(max(errors)), 'passed': True})
    return {'scope': reference['scope'], 'reference': reference['reference'],
            'absolute_tolerance': '1e-25', 'relative_tolerance': '1e-24',
            'checkpoints': reports}


if __name__ == '__main__':
    payload = json.load(sys.stdin)
    print(json.dumps(compare(payload) if 'actual' in payload else generate(payload), indent=2))
