// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title RoleRegistry
 * @notice Decentralized register of MediChain staff roles (Problem 26).
 *
 * A doctor, insurance-agent or administrator role is valid only if this contract holds it.
 * Changing a role needs k of the n governors (the hospital administrators, each with their own
 * key) to approve. So no single administrator, and nobody who can edit the hospital database,
 * can grant clinical or administrative access alone.
 *
 * Subjects are opaque: keccak256("medichain-user:<user id>"). No personal data is stored.
 *
 * Life cycle:
 *   1. deploy with the governor addresses and k
 *   2. bootstrapGrant(...) registers the staff that already exist (deployer only, once)
 *   3. closeBootstrap(): from then on every change needs k approvals
 */
contract RoleRegistry {
    uint8 public constant DOCTOR = 1;
    uint8 public constant INSURANCE_AGENT = 2;
    uint8 public constant ADMIN = 3;

    uint64 public constant PROPOSAL_TTL = 7 days;

    enum Action { Grant, Revoke, AddGovernor, RemoveGovernor, SetThreshold }

    struct Proposal {
        Action action;
        bytes32 subject;      // Grant / Revoke
        uint8 role;           // Grant / Revoke
        address account;      // AddGovernor / RemoveGovernor
        uint8 newThreshold;   // SetThreshold
        address proposer;
        uint64 createdAt;
        uint8 approvals;
        bool executed;
        bool cancelled;
    }

    mapping(address => bool) public isGovernor;
    uint8 public governorCount;
    uint8 public threshold;

    address public immutable bootstrapper;
    bool public bootstrapOpen = true;

    mapping(bytes32 => uint8) public roleOf; // subject => role (0 = none)

    Proposal[] private proposals;
    mapping(uint256 => mapping(address => bool)) public hasApproved;

    event Proposed(uint256 indexed id, Action action, bytes32 indexed subject, uint8 role, address account, uint8 newThreshold, address indexed proposer);
    event Approved(uint256 indexed id, address indexed governor, uint8 approvals);
    event Executed(uint256 indexed id);
    event Cancelled(uint256 indexed id);
    event RoleGranted(bytes32 indexed subject, uint8 role);
    event RoleRevoked(bytes32 indexed subject, uint8 role);
    event GovernorAdded(address indexed account);
    event GovernorRemoved(address indexed account);
    event ThresholdChanged(uint8 threshold);
    event BootstrapClosed();

    modifier onlyGovernor() {
        require(isGovernor[msg.sender], "not a governor");
        _;
    }

    constructor(address[] memory governors, uint8 k) {
        require(governors.length > 0 && governors.length <= 50, "1-50 governors");
        require(k >= 1 && k <= governors.length, "bad threshold");
        for (uint256 i = 0; i < governors.length; i++) {
            address g = governors[i];
            require(g != address(0), "zero address");
            require(!isGovernor[g], "duplicate governor");
            isGovernor[g] = true;
            emit GovernorAdded(g);
        }
        governorCount = uint8(governors.length);
        threshold = k;
        bootstrapper = msg.sender;
        emit ThresholdChanged(k);
    }

    function _validRole(uint8 role) private pure returns (bool) {
        return role == DOCTOR || role == INSURANCE_AGENT || role == ADMIN;
    }

    /* ------------------------------------------------------------ bootstrap */

    /// Registers the staff that exist before the registry is used. Deployer only, before closeBootstrap().
    function bootstrapGrant(bytes32[] calldata subjects, uint8[] calldata roles) external {
        require(msg.sender == bootstrapper, "not bootstrapper");
        require(bootstrapOpen, "bootstrap closed");
        require(subjects.length == roles.length, "length mismatch");
        for (uint256 i = 0; i < subjects.length; i++) {
            require(subjects[i] != bytes32(0), "empty subject");
            require(_validRole(roles[i]), "bad role");
            roleOf[subjects[i]] = roles[i];
            emit RoleGranted(subjects[i], roles[i]);
        }
    }

    function closeBootstrap() external {
        require(msg.sender == bootstrapper, "not bootstrapper");
        require(bootstrapOpen, "bootstrap closed");
        bootstrapOpen = false;
        emit BootstrapClosed();
    }

    /* ------------------------------------------------------------ proposals */

    /// Creates a proposal; the proposer's own approval is counted at once.
    function propose(Action action, bytes32 subject, uint8 role, address account, uint8 newThreshold)
        external onlyGovernor returns (uint256 id)
    {
        if (action == Action.Grant) {
            require(subject != bytes32(0) && _validRole(role), "bad role or subject");
            require(roleOf[subject] == 0, "subject already has a role");
        } else if (action == Action.Revoke) {
            require(subject != bytes32(0) && roleOf[subject] == role && role != 0, "subject does not hold this role");
        } else if (action == Action.AddGovernor) {
            require(account != address(0) && !isGovernor[account], "bad or existing governor");
        } else if (action == Action.RemoveGovernor) {
            require(isGovernor[account], "not a governor");
            require(governorCount - 1 >= threshold, "would fall below threshold");
        } else {
            require(newThreshold >= 1 && newThreshold <= governorCount, "bad threshold");
        }

        // filled field by field (a 10-argument struct literal can exceed the EVM stack limit)
        Proposal storage p = proposals.push();
        p.action = action;
        p.subject = subject;
        p.role = role;
        p.account = account;
        p.newThreshold = newThreshold;
        p.proposer = msg.sender;
        p.createdAt = uint64(block.timestamp);
        id = proposals.length - 1;
        emit Proposed(id, action, subject, role, account, newThreshold, msg.sender);
        _approve(id);
    }

    function approve(uint256 id) external onlyGovernor {
        _approve(id);
    }

    /// The proposer can withdraw a proposal that has not been executed.
    function cancel(uint256 id) external {
        require(id < proposals.length, "no such proposal");
        Proposal storage p = proposals[id];
        require(msg.sender == p.proposer, "not proposer");
        require(!p.executed && !p.cancelled, "already closed");
        p.cancelled = true;
        emit Cancelled(id);
    }

    function _approve(uint256 id) private {
        require(id < proposals.length, "no such proposal");
        Proposal storage p = proposals[id];
        require(!p.executed && !p.cancelled, "already closed");
        require(block.timestamp <= p.createdAt + PROPOSAL_TTL, "proposal expired");
        require(!hasApproved[id][msg.sender], "already approved");
        hasApproved[id][msg.sender] = true;
        p.approvals += 1;
        emit Approved(id, msg.sender, p.approvals);
        if (p.approvals >= threshold) _execute(id, p);
    }

    function _execute(uint256 id, Proposal storage p) private {
        p.executed = true;
        if (p.action == Action.Grant) {
            require(roleOf[p.subject] == 0, "subject already has a role");
            roleOf[p.subject] = p.role;
            emit RoleGranted(p.subject, p.role);
        } else if (p.action == Action.Revoke) {
            require(roleOf[p.subject] == p.role, "subject does not hold this role");
            roleOf[p.subject] = 0;
            emit RoleRevoked(p.subject, p.role);
        } else if (p.action == Action.AddGovernor) {
            require(!isGovernor[p.account], "already a governor");
            require(governorCount < 50, "too many governors");
            isGovernor[p.account] = true;
            governorCount += 1;
            emit GovernorAdded(p.account);
        } else if (p.action == Action.RemoveGovernor) {
            require(isGovernor[p.account], "not a governor");
            require(governorCount - 1 >= threshold, "would fall below threshold");
            isGovernor[p.account] = false;
            governorCount -= 1;
            emit GovernorRemoved(p.account);
        } else {
            require(p.newThreshold >= 1 && p.newThreshold <= governorCount, "bad threshold");
            threshold = p.newThreshold;
            emit ThresholdChanged(p.newThreshold);
        }
        emit Executed(id);
    }

    /* ------------------------------------------------------------ views */

    function hasRole(bytes32 subject, uint8 role) external view returns (bool) {
        return role != 0 && roleOf[subject] == role;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        require(id < proposals.length, "no such proposal");
        return proposals[id];
    }
}
