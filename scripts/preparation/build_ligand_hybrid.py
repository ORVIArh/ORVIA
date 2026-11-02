#!/usr/bin/env python3
"""Align explicit endpoints with a declared single-anchor dummy bond-tree policy."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'data/prepared_candidate/ligand_endpoints_v0_1'


def word(value,index=False):
    if index:return '0x'+int(value).to_bytes(32,'big').hex()
    value=float(value)
    if not math.isfinite(value):raise ValueError('Nonfinite stream value')
    bits=struct.unpack('>Q',struct.pack('>d',value))[0]
    sign,exponent,mantissa=bits>>63,(bits>>52)&2047,bits&((1<<52)-1)
    if exponent==0:
        if mantissa:raise ValueError('Subnormal binary64 source value requires explicit conversion support')
        result=0
    else:result=(sign<<127)|((exponent-1023+16383)<<112)|(mantissa<<60)
    return '0x'+result.to_bytes(32,'big').hex()


def ghost_tree(endpoint,mapping,unique):
    """Reject cyclic or multiply anchored inactive networks."""
    unique=set(unique);edges=[];adjacency={}
    for a,b,r,k in endpoint['harmonic_bonds']:
        a,b=mapping[a],mapping[b]
        if a not in unique and b not in unique:continue
        if k<=0:raise ValueError('Dummy confinement requires positive bond stiffness')
        edges.append((a,b,r,k));adjacency.setdefault(a,set()).add(b);adjacency.setdefault(b,set()).add(a)
    if not unique.issubset(adjacency):raise ValueError('Unconfined unique atom')
    remaining=set(adjacency);components=[]
    while remaining:
        stack=[min(remaining)];component=set()
        while stack:
            node=stack.pop()
            if node in component:continue
            component.add(node);stack.extend(adjacency[node]-component)
        remaining-=component
        roots=component-unique
        local=[edge for edge in edges if edge[0] in component]
        if len(roots)!=1 or len(local)!=len(component)-1:raise ValueError('Dummy network is not a singly anchored tree')
        components.append(dict(root=min(roots),unique_atoms=sorted(component&unique),bonds=[list(row) for row in local]))
    return components


def build(directory):
    mapping=json.loads((directory/'explicit_hydrogen_map.json').read_text())
    endpoints={name:json.loads((directory/name/'parameters.json').read_text()) for name in ['A','B']}
    maps={'A':mapping['endpoint_a_to_hybrid'],'B':mapping['endpoint_b_to_hybrid']}
    unique={'A':[maps['A'][i] for i in mapping['a_only_indices']], 'B':[maps['B'][i] for i in mapping['b_only_indices']]}
    trees={name:ghost_tree(endpoints[name],maps[name],unique[name]) for name in ['A','B']}
    count=mapping['hybrid_atom_count'];masses=[None]*count;positions=[None]*count
    particles={name:[None]*count for name in ['A','B']}
    for name in ['A','B']:
        endpoint=endpoints[name]
        for i,j in enumerate(maps[name]):
            mass=endpoint['masses_Da'][i];xyz=endpoint['positions_nm'][i]
            if masses[j] is not None:
                if masses[j]!=mass or max(abs(a-b) for a,b in zip(positions[j],xyz))>1e-5:
                    raise ValueError('Common atom mass or initial coordinate mismatch')
            else:masses[j],positions[j]=mass,xyz
            particles[name][j]=endpoint['particles'][i]
    for name,other in [('A','B'),('B','A')]:
        for i in range(count):
            if particles[name][i] is None:
                _,sigma,_=particles[other][i];particles[name][i]=[0.,sigma,0.]
    aligned={name:dict(atom_count=count,masses_Da=masses,positions_nm=positions,particles=particles[name],harmonic_bonds=[],harmonic_angles=[],periodic_torsions=[],exceptions=[],nonbonded=endpoints[name]['nonbonded']) for name in ['A','B']}
    for term,width in [('harmonic_bonds',2),('harmonic_angles',3),('periodic_torsions',5)]:
        tables={}
        for name in ['A','B']:
            table={}
            for row in endpoints[name][term]:
                transformed=[maps[name][int(i)] for i in row[:2 if term=='harmonic_bonds' else 3 if term=='harmonic_angles' else 4]]
                if term=='periodic_torsions':transformed.append(row[4])
                # Phase is part of a Fourier-component key; no improper atom reordering.
                key=tuple(transformed)+((row[5],) if term=='periodic_torsions' else ())
                if key in table:raise ValueError('Duplicate source term needs an explicit multiplicity policy')
                table[key]=transformed+row[width:]
            tables[name]=table
        keys=list(tables['A'])+[key for key in tables['B'] if key not in tables['A']]
        for key in keys:
            for name,other in [('A','B'),('B','A')]:
                if key in tables[name]:row=list(tables[name][key])
                else:
                    row=list(tables[other][key])
                    if term!='harmonic_bonds':row[-1]=0. # inactive angle/torsion k
                    # Missing unique-atom bonds are retained as confinement terms.
                    elif not any(int(i) in unique[other] for i in row[:2]):row[-1]=0.
                aligned[name][term].append(row)
    source_exceptions={}
    for name in ['A','B']:
        source_exceptions[name]={tuple(sorted((maps[name][a],maps[name][b]))):(q,s,e) for a,b,q,s,e in endpoints[name]['exceptions']}
    cross={(min(a,b),max(a,b)) for a in unique['A'] for b in unique['B']}
    pairs=sorted(set(source_exceptions['A'])|set(source_exceptions['B'])|cross)
    for a,b in pairs:
        values={}
        for name in ['A','B']:
            if (a,b) in cross:q,s,e=0.,0.,0.
            elif (a,b) in source_exceptions[name]:q,s,e=source_exceptions[name][a,b]
            else:
                qa,sa,ea=particles[name][a];qb,sb,eb=particles[name][b]
                q,s,e=qa*qb,(sa+sb)/2,math.sqrt(ea*eb)
            values[name]=[q,s,e]
        kind=1 if all(values[name][0]==0 and values[name][2]==0 for name in ['A','B']) else 2
        for name in ['A','B']:
            q,s,e=values[name]
            if kind==1:q,s,e=0.,0.,0.
            elif s<=0:s=(particles[name][a][1]+particles[name][b][1])/2
            aligned[name]['exceptions'].append([a,b,q,s,e])
    policy=dict(schema='orvia.rooted-dummy-bond-tree-policy.v1',status='EXPLICIT_RESEARCH_CANDIDATE_REQUIRES_REVIEW',
        inactive_unique_nonbonded='q=epsilon=0',inactive_unique_angles_torsions='k=0',
        inactive_unique_bonds='Native positive harmonic bond tree retained unchanged',
        trees=trees,cross_unique_pairs_always_excluded=[list(pair) for pair in sorted(cross)],
        masses='Positive native element masses retained at every lambda; identical endpoint masses.',
        campaign_condition='Complex and solvent legs must use identical orthorhombic periodic box vectors and the identical ghost-tree policy.',
        partition_argument='For each singly anchored tree, transform every ghost coordinate to its parent-relative displacement on the periodic torus. The transformation has unit Jacobian; the harmonic bond potential is a sum over independent edge displacements. Integration therefore factors into edge partition integrals independent of physical anchor coordinates. Identical box vectors and edge potentials make these factors cancel between complex and solvent transformations.',
        limitations=['Instantaneous physical-anchor forces include ghost bonds; only the integrated physical marginal is unchanged.',
            'Additional inactive angles/torsions, nonbonded interactions, multiple anchors, cycles or differing leg boxes invalidate this cancellation argument.',
            'No complete solvated model or production sampling protocol is accepted by this construction.'])
    streams={'positions':[word(x) for row in positions for x in row]}
    for name in ['A','B']:
        p=aligned[name]
        values={'particles':[[m,0.,0.,0.] for m in masses],
            'nonbonded':[[s,e,q] for q,s,e in p['particles']],
            'bonds':[[a,b,k,r] for a,b,r,k in p['harmonic_bonds']],
            'angles':[[a,b,c,k,t] for a,b,c,t,k in p['harmonic_angles']],
            'torsions':[[a,b,c,d,n,k,phase] for a,b,c,d,n,phase,k in p['periodic_torsions']],
            'exceptions':[[a,b,1 if q==0 and e==0 and s==0 else 2,s,e,q] for a,b,q,s,e in p['exceptions']]}
        widths={'particles':0,'nonbonded':0,'bonds':2,'angles':3,'torsions':5,'exceptions':3}
        for key,rows in values.items():streams[name+'.'+key]=[word(x,index=i<widths[key]) for row in rows for i,x in enumerate(row)]
    encoded=lambda x:(json.dumps(x,indent=2,sort_keys=True)+'\n').encode()
    model=dict(schema='orvia.aligned-ligand-hybrid.v1',status='PARAMETERIZED_LIGAND_HYBRID_CANDIDATE_NOT_A_SOLVATED_EXPERIMENT',
        atom_count=count,term_counts={key:len(aligned['A'][key]) for key in ['harmonic_bonds','harmonic_angles','periodic_torsions','exceptions']},
        endpoint_maps=maps,unique_atoms=unique,model_policy=policy,model_policy_sha256=hashlib.sha256(encoded(policy)).hexdigest(),
        endpoint_parameters=aligned,input_sha256={str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in [directory/'explicit_hydrogen_map.json',directory/'A/parameters.json',directory/'B/parameters.json']},
        stream_encoding='Each scalar is the exact binary128 embedding of its binary64 source value, stored in the low 128 bits of bytes32; indices are uint256. No new numerical precision is invented.',
        total_stream_words=sum(map(len,streams.values())),production_ready=False)
    (directory/'hybrid_model.json').write_bytes(encoded(model));(directory/'hybrid_streams.json').write_bytes(encoded(streams))
    return model


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,default=OUT)
    model=build(parser.parse_args().root);print(json.dumps({'atoms':model['atom_count'],'terms':model['term_counts'],'stream_words':model['total_stream_words'],'production_ready':False}))
