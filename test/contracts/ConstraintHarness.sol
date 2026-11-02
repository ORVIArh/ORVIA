// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ConstraintSolver} from "../../contracts/core/ConstraintSolver.sol";

/// @dev Test-only stand-in for a future coordinator; never a production input path.
contract ConstraintHarness {
    address public immutable owner;
    ConstraintSolver public solver;
    constructor() { owner = msg.sender; }
    modifier onlyOwner() { require(msg.sender == owner); _; }
    function bind(address solver_) external onlyOwner { require(address(solver) == address(0)); solver = ConstraintSolver(solver_); }
    function create(bytes32 id, bytes32 sourceCommitment, ConstraintSolver.Mode mode,
        uint32 atomCount, uint32 constraintCount, bytes16 tolerance, uint32 maxIterations) external onlyOwner
    { solver.createProblem(id, sourceCommitment, mode, atomCount, constraintCount, tolerance, maxIterations); }
    function atoms(bytes32 id, ConstraintSolver.AtomInput[] calldata values) external onlyOwner { solver.appendAtoms(id, values); }
    function constraints(bytes32 id, ConstraintSolver.Constraint[] calldata values) external onlyOwner { solver.appendConstraints(id, values); }
    function seal(bytes32 id) external onlyOwner { solver.sealProblem(id); }
}
