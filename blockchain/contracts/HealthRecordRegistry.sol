// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title HealthRecordRegistry
 * @notice Write-once registry of fingerprints of medical data.
 *
 * Nothing stored here is personal data. For every record version or file the
 * hospital API writes only:
 *   - key        keccak256("<entityType>:<entityId>:<version>"), a lookup id
 *   - dataHash   SHA-256 of the record content or of the file bytes
 *   - patientRef HMAC-SHA256 of the patient id, keyed with a secret the chain
 *                never sees, so anchors cannot be linked back to a person
 *   - kind       1 = record version, 2 = file, 3 = ledger head (legacy, see below)
 * The data itself stays off-chain: record fields in MongoDB, files encrypted on IPFS.
 *
 * Ledger heads (Problem 10): every few minutes the API anchors the head of each hash-chained
 * ledger ("access" = every sign-in and access decision, "records" = every data change) as
 * (sequence number, hash of that entry). Heads are kept per hospital and per chain in order,
 * and the sequence number must always increase, so neither a consistent rewrite of the ledger
 * nor deleting its newest entries can go unnoticed once an anchor covers them. A verifier needs
 * nothing from the hospital's database to find the latest head.
 */
contract HealthRecordRegistry {
    struct Anchor {
        bytes32 dataHash;
        bytes32 patientRef;
        uint64 anchoredAt;
        address hospital;
        uint8 kind;
    }

    struct LedgerHead {
        uint64 seq;
        bytes32 headHash;
        uint64 anchoredAt;
    }

    address public owner;
    mapping(address => mapping(bytes32 => LedgerHead[])) private ledgerHeads; // hospital => chainId => heads
    mapping(address => bool) public hospitals;          // hospital nodes allowed to write
    mapping(bytes32 => Anchor) private anchors;
    mapping(bytes32 => bytes32[]) private patientAnchors; // patientRef => keys, for audits

    event HospitalSet(address indexed hospital, bool allowed);
    event Anchored(bytes32 indexed key, bytes32 indexed patientRef, bytes32 dataHash, uint8 kind, address indexed hospital);
    event LedgerHeadAnchored(address indexed hospital, bytes32 indexed chainId, uint64 seq, bytes32 headHash);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyHospital() {
        require(hospitals[msg.sender], "not an authorised hospital");
        _;
    }

    constructor() {
        owner = msg.sender;
        hospitals[msg.sender] = true;
        emit HospitalSet(msg.sender, true);
    }

    /// Adds or removes a hospital node (e.g. Hospital B joining the network).
    function setHospital(address hospital, bool allowed) external onlyOwner {
        require(hospital != address(0), "zero address");
        hospitals[hospital] = allowed;
        emit HospitalSet(hospital, allowed);
    }

    /// Stores one fingerprint. A key can be written once only, so history cannot be rewritten.
    function anchor(bytes32 key, bytes32 dataHash, bytes32 patientRef, uint8 kind) external onlyHospital {
        require(dataHash != bytes32(0), "empty hash");
        require(kind >= 1 && kind <= 3, "bad kind");
        require(anchors[key].anchoredAt == 0, "already anchored");

        anchors[key] = Anchor(dataHash, patientRef, uint64(block.timestamp), msg.sender, kind);
        if (patientRef != bytes32(0)) patientAnchors[patientRef].push(key);
        emit Anchored(key, patientRef, dataHash, kind, msg.sender);
    }

    function getAnchor(bytes32 key) external view returns (Anchor memory) {
        return anchors[key];
    }

    /// True only if the key was anchored with exactly this hash.
    function verify(bytes32 key, bytes32 dataHash) external view returns (bool) {
        return anchors[key].anchoredAt != 0 && anchors[key].dataHash == dataHash;
    }

    function anchorsOf(bytes32 patientRef) external view returns (bytes32[] memory) {
        return patientAnchors[patientRef];
    }

    /// Anchors the head of one ledger chain. chainId = keccak256("access") or keccak256("records").
    function anchorLedgerHead(bytes32 chainId, uint64 seq, bytes32 headHash) external onlyHospital {
        require(headHash != bytes32(0), "empty hash");
        LedgerHead[] storage heads = ledgerHeads[msg.sender][chainId];
        require(heads.length == 0 || seq > heads[heads.length - 1].seq, "seq must increase");
        heads.push(LedgerHead(seq, headHash, uint64(block.timestamp)));
        emit LedgerHeadAnchored(msg.sender, chainId, seq, headHash);
    }

    function ledgerHeadCount(address hospital, bytes32 chainId) external view returns (uint256) {
        return ledgerHeads[hospital][chainId].length;
    }

    function ledgerHeadAt(address hospital, bytes32 chainId, uint256 index) external view returns (LedgerHead memory) {
        return ledgerHeads[hospital][chainId][index];
    }

    /// The newest anchored head; seq and headHash are zero (anchoredAt 0) when nothing was anchored yet.
    function latestLedgerHead(address hospital, bytes32 chainId) external view returns (LedgerHead memory) {
        LedgerHead[] storage heads = ledgerHeads[hospital][chainId];
        if (heads.length == 0) return LedgerHead(0, bytes32(0), 0);
        return heads[heads.length - 1];
    }
}
