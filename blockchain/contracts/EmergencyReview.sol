// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The part of RoleRegistry this contract relies on: who the governors are and how many must agree.
interface IGovernors {
    function isGovernor(address account) external view returns (bool);
    function threshold() external view returns (uint8);
    function governorEpoch() external view returns (uint32);
}

/**
 * @title EmergencyReview
 * @notice On-chain review of every emergency sign-in (decision D12, guide 26 Nov 2026).
 *
 * The hospital server opens a case on-chain the moment someone uses emergency sign-in, so it
 * cannot later hide that it happened. A case is closed only when k of the n governors (the same
 * administrators and the same k as the RoleRegistry) give the SAME verdict with their own keys,
 * so no single administrator can quietly close the review of an emergency sign-in.
 *
 * Nothing personal is stored: the subject is the same salted hash RoleRegistry uses, the reason is
 * stored as a hash (the text stays in the hospital's ledger), and the case id is the hash of the
 * ledger entry that recorded the emergency sign-in.
 */
contract EmergencyReview {
    enum Verdict { None, Justified, Misuse }

    struct Case {
        bytes32 subject;     // keccak256("medichain-user:<user id>:<salt>") as in RoleRegistry
        bytes32 reasonHash;  // sha-256 of the stated clinical reason
        uint64 openedAt;
        uint64 closedAt;
        uint8 justifiedVotes;
        uint8 misuseVotes;
        Verdict verdict;     // None while the case is open
        uint32 epoch;        // governor set the votes belong to
    }

    IGovernors public immutable governors;
    /// The hospital server's key: the only account that may open cases.
    address public immutable recorder;

    mapping(bytes32 => Case) private cases;
    bytes32[] private caseIds;
    /// caseId => governor epoch => governor => has voted
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) public hasVoted;

    event CaseOpened(bytes32 indexed caseId, bytes32 indexed subject, bytes32 reasonHash);
    event Voted(bytes32 indexed caseId, address indexed governor, Verdict verdict, uint8 votesForVerdict);
    event CaseClosed(bytes32 indexed caseId, Verdict verdict);

    constructor(address roleRegistry, address hospitalRecorder) {
        require(roleRegistry != address(0) && hospitalRecorder != address(0), "zero address");
        governors = IGovernors(roleRegistry);
        recorder = hospitalRecorder;
    }

    /// Called by the hospital server when an emergency sign-in happens.
    function openCase(bytes32 caseId, bytes32 subject, bytes32 reasonHash) external {
        require(msg.sender == recorder, "not the hospital recorder");
        require(caseId != bytes32(0) && subject != bytes32(0) && reasonHash != bytes32(0), "empty value");
        require(cases[caseId].openedAt == 0, "case exists");
        Case storage c = cases[caseId];
        c.subject = subject;
        c.reasonHash = reasonHash;
        c.openedAt = uint64(block.timestamp);
        c.epoch = governors.governorEpoch();
        caseIds.push(caseId);
        emit CaseOpened(caseId, subject, reasonHash);
    }

    /// A governor's verdict. The case closes when k governors agree on the same verdict.
    function review(bytes32 caseId, Verdict verdict) external {
        require(governors.isGovernor(msg.sender), "not a governor");
        require(verdict == Verdict.Justified || verdict == Verdict.Misuse, "bad verdict");
        Case storage c = cases[caseId];
        require(c.openedAt != 0, "no such case");
        require(c.verdict == Verdict.None, "case closed");

        // A change of governors voids the votes given under the old set (as in RoleRegistry).
        uint32 epoch = governors.governorEpoch();
        if (c.epoch != epoch) {
            c.epoch = epoch;
            c.justifiedVotes = 0;
            c.misuseVotes = 0;
        }
        require(!hasVoted[caseId][epoch][msg.sender], "already voted");
        hasVoted[caseId][epoch][msg.sender] = true;

        uint8 votes;
        if (verdict == Verdict.Justified) votes = ++c.justifiedVotes;
        else votes = ++c.misuseVotes;
        emit Voted(caseId, msg.sender, verdict, votes);

        if (votes >= governors.threshold()) {
            c.verdict = verdict;
            c.closedAt = uint64(block.timestamp);
            emit CaseClosed(caseId, verdict);
        }
    }

    function getCase(bytes32 caseId) external view returns (Case memory) {
        require(cases[caseId].openedAt != 0, "no such case");
        return cases[caseId];
    }

    function caseCount() external view returns (uint256) {
        return caseIds.length;
    }

    function caseIdAt(uint256 index) external view returns (bytes32) {
        return caseIds[index];
    }
}
