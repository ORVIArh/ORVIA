# Staged C4 mathematical candidate

This is a reviewable, unaccepted proposal for the frozen ADP/phosphate candidate. It does not replace the selected original vanadate model, validate a complete trajectory or authorize mainnet deployment. The Solidity implementation is separate work in progress.

The [proposal](PROPOSAL.md) defines explicit atom activity and three phases: remove disappearing-atom charges while their repulsive core remains physical, transform the uncharged core/C4 interactions, then restore appearing-atom charges after their physical core is present. Every electrostatic term must use the same charge controls. The shared softened radial form and long-range correction retain the declared endpoint component definitions.

The source audit found an introduced attractive short-distance divergence in the existing linear-charge transformation. It also records inherited native point-charge singularities and the native C4 hard cutoff. The candidate does not claim universal stability or global smoothness that would contradict those endpoint definitions. Its intermediate net charge requires a separately accepted periodic-charge treatment.

The [summary](candidate-summary.json) reports 3,546 mathematical/source checks and a separate caller/source supplement with 1,440 OpenMM Reference force components. These are bounded component checks, not scientific production acceptance. The archive retains the exact scripts, reports, inputs, counterexamples and earlier attempts.

Download and extract [review-packet.zip](review-packet.zip) to inspect all 59 payload files in their original relative layout. [review-manifest.json](review-manifest.json) binds their exact bytes; [publication.json](publication.json) binds the archive and records the independent packaging check. The separately described large raw input archives remain local and are identified by hashes. References to those raw files are not claims that they are contained in this compact packet.

No public transaction, wallet access or testnet activity occurred in this work. Current production readiness remains false.
