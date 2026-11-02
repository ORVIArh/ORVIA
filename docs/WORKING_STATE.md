# Working state page

`WorkingStatePage` is an onchain raw-word store for the v0.2 paged execution lane. Each nonzero `bytes32` namespace has a fixed capacity, independent indexed words, and an irreversible seal. Only the immutable writer contract can create, overwrite, or seal namespaces. Reads are public.

Deploy the coordinator first, then deploy `WorkingStatePage(coordinatorAddress)`, then bind that page in the coordinator. The page constructor requires an address with deployed code; an EOA, zero address, or a contract still executing its constructor is rejected. The page has no owner override, writer replacement, upgrade, reset, deletion, or resize function. The coordinator must enforce its own bind-once and run lifecycle rules.

## Exact Solidity API

```solidity
constructor(address writer_)

function writer() external view returns (address)
function MAX_CAPACITY_WORDS() external view returns (uint256) // 65536
function MAX_BATCH_WORDS() external view returns (uint256) // 128

function createNamespace(bytes32 namespace, uint32 capacityWords) external
function writeWord(bytes32 namespace, uint256 index, bytes32 value) external
function writeWords(bytes32 namespace, uint256 start, bytes32[] calldata values) external
function readWord(bytes32 namespace, uint256 index) external view returns (bytes32)
function readWords(bytes32 namespace, uint256 start, uint256 count)
    external view returns (bytes32[] memory values)
function namespaceInfo(bytes32 namespace)
    external view returns (uint32 capacityWords, bool isSealed)
function sealNamespace(bytes32 namespace) external
```

| Operation | Rules |
| --- | --- |
| Create | Writer only; namespace must be nonzero and unused; capacity is 1–65,536 words. |
| Write one word | Writer only; namespace must exist and be unsealed; index must be less than capacity. Existing values may be overwritten, including with zero. |
| Write a batch | Writer only; namespace must exist and be unsealed; batch length is 1–128; the full range must fit within capacity. |
| Read one word | Namespace must exist; index must be less than capacity. An unwritten word is zero. |
| Read a batch | Namespace must exist; count is 0–128; `start <= capacity` and `count <= capacity - start`. Empty reads at the capacity boundary are allowed. |
| Read metadata | Namespace must exist. Returns its immutable capacity and current seal flag. |
| Seal | Writer only; namespace must exist and be unsealed. Subsequent writes and repeated sealing revert; reads remain available. |

Every access to an unknown namespace reverts. A zero namespace cannot be created. Bounds are checked before any write, with overflow-safe range checks, and a failed batch reverts atomically. Separate namespace mappings prevent an oversized index or batch from spilling into another namespace. Namespace creation does not prepopulate storage; unwritten words use EVM zero defaults.

## Events and errors

```solidity
event NamespaceCreated(bytes32 indexed namespace, uint32 capacityWords);
event WordWritten(bytes32 indexed namespace, uint256 index, bytes32 value);
event WordsWritten(bytes32 indexed namespace, uint256 start, uint256 count);
event NamespaceFrozen(bytes32 indexed namespace);

error Unauthorized();
error InvalidWriter();
error InvalidNamespace();
error NamespaceExists();
error UnknownNamespace();
error InvalidCapacity();
error NamespaceSealed();
error InvalidBatch();
error OutOfBounds();
```

Batch event values remain available from transaction calldata and current page state; the event records the namespace and affected range. This contract does not maintain a content digest or enumerate namespaces. A coordinator that needs commitments must define them explicitly.

## Responsibility boundary

Words are arbitrary `bytes32` values. This page does not interpret coordinates, forces, binary128 encodings, progress cursors, protocol identifiers, or arithmetic validity. The coordinator defines each namespace's layout and validates its numerical operations before committing writes. The page's immutable writer is a trust boundary: it can overwrite any unsealed namespace, and the page does not inspect that writer's internal authorization or possible upgrade mechanism.

The source targets Solidity 0.8.26 and requires no `viaIR` compilation. Operations iterate over at most 128 words; single-word writes, metadata lookup, and sealing are constant-size operations. Overall namespace count is not capped. This storage primitive does not establish that a full molecular simulation or free-energy calculation is implemented or validated.
