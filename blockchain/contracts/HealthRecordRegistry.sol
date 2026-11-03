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
 *   - kind       1 = record version, 2 = file, 3 = ledger head
 * The data itself stays off-chain: record fields in MongoDB, files encrypted on IPFS.
 */
contract HealthRecordRegistry {
    struct Anchor {
        bytes32 dataHash;
        bytes32 patientRef;
        uint64 anchoredAt;
        address hospital;
        uint8 kind;
    }

    address public owner;
    mapping(address => bool) public hospitals;          // hospital nodes allowed to write
    mapping(bytes32 => Anchor) private anchors;
    mapping(bytes32 => bytes32[]) private patientAnchors; // patientRef => keys, for audits

    event HospitalSet(address indexed hospital, bool allowed);
    event Anchored(bytes32 indexed key, bytes32 indexed patientRef, bytes32 dataHash, uint8 kind, address indexed hospital);

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
}
