const { ethers } = require('ethers');
const config = require('../config/config');
const redisClient = require('../db/redis');
const logger = require('../utils/logger');

/**
 * Decentralized stakeholder registry (Problem 26).
 *
 * Staff roles (doctor, insurance agent, administrator) are valid only if the RoleRegistry
 * contract says so. The contract changes a role only after k of n administrators have
 * approved, each with their own wallet key; this server builds the transaction data but
 * never holds an administrator key. A role edited directly in MongoDB, or granted by one
 * compromised administrator account, therefore gives no access.
 *
 * On chain a user is identified only by keccak256("medichain-user:<user id>"): no names,
 * emails or other personal data. Answers are cached in Redis for ROLE_CACHE_SECONDS; if the
 * chain cannot be reached, an older answer (at most ROLE_STALE_SECONDS) is used, after that
 * the check fails closed.
 */
const ROLE_CODE = { doctor: 1, insurance_agent: 2, admin: 3 };
const ROLE_NAME = Object.fromEntries(Object.entries(ROLE_CODE).map(([name, code]) => [code, name]));
const ACTION = { grant: 0, revoke: 1, add_governor: 2, remove_governor: 3, set_threshold: 4 };
const ACTION_NAME = Object.fromEntries(Object.entries(ACTION).map(([name, code]) => [code, name]));
const STAFF_ROLES = Object.keys(ROLE_CODE);

const ABI = [
  'function roleOf(bytes32 subject) view returns (uint8)',
  'function hasRole(bytes32 subject, uint8 role) view returns (bool)',
  'function threshold() view returns (uint8)',
  'function governorCount() view returns (uint8)',
  'function isGovernor(address account) view returns (bool)',
  'function bootstrapOpen() view returns (bool)',
  'function proposalCount() view returns (uint256)',
  'function getProposal(uint256 id) view returns (tuple(uint8 action, bytes32 subject, uint8 role, address account, uint8 newThreshold, address proposer, uint64 createdAt, uint8 approvals, bool executed, bool cancelled))',
  'function hasApproved(uint256 id, address governor) view returns (bool)',
  'function propose(uint8 action, bytes32 subject, uint8 role, address account, uint8 newThreshold) returns (uint256)',
  'function approve(uint256 id)',
  'function cancel(uint256 id)',
  'function PROPOSAL_TTL() view returns (uint64)',
];

const iface = new ethers.Interface(ABI);
const freshKey = (userId) => `role:chain:${userId}`;
const staleKey = (userId) => `role:chain:stale:${userId}`;

class RoleService {
  constructor(cfg = config.chain) {
    this.cfg = cfg;
    this.contract = null;
  }

  get enabled() {
    return Boolean(this.cfg.rpcUrl && this.cfg.roleRegistryAddress);
  }

  registry() {
    if (!this.contract) {
      const provider = new ethers.JsonRpcProvider(this.cfg.rpcUrl);
      this.contract = new ethers.Contract(this.cfg.roleRegistryAddress, ABI, provider); // read-only
    }
    return this.contract;
  }

  static subjectOf(userId) {
    return ethers.keccak256(ethers.toUtf8Bytes(`medichain-user:${userId}`));
  }

  /** The role code the contract holds for a user (0 = none), with the cache described above. */
  async roleCode(userId) {
    const id = String(userId);
    const cached = await redisClient.get(freshKey(id));
    if (cached !== null) return Number(cached);
    try {
      const code = Number(await this.registry().roleOf(RoleService.subjectOf(id)));
      await redisClient.setEx(freshKey(id), this.cfg.roleCacheSeconds, String(code));
      await redisClient.setEx(staleKey(id), this.cfg.roleStaleSeconds, String(code));
      return code;
    } catch (error) {
      const stale = await redisClient.get(staleKey(id));
      if (stale !== null) {
        logger.warn(`Role registry unreachable, using cached role for ${id}: ${error.shortMessage || error.message}`);
        return Number(stale);
      }
      throw new Error('ROLE_REGISTRY_UNAVAILABLE');
    }
  }

  /** True when the contract holds exactly this staff role for the user. Patients are never checked. */
  async hasRole(userId, role) {
    if (!this.enabled || !STAFF_ROLES.includes(role)) return true;
    return (await this.roleCode(userId)) === ROLE_CODE[role];
  }

  async invalidate(userId) {
    await redisClient.del([freshKey(String(userId)), staleKey(String(userId))]);
  }

  /** Unsigned transaction for an administrator's wallet (MetaMask) to sign and send. */
  tx(functionName, args) {
    return { to: this.cfg.roleRegistryAddress, data: iface.encodeFunctionData(functionName, args) };
  }

  proposeTx({ action, userId, role, account, newThreshold }) {
    const subject = userId ? RoleService.subjectOf(userId) : ethers.ZeroHash;
    return this.tx('propose', [ACTION[action], subject, role ? ROLE_CODE[role] : 0, account || ethers.ZeroAddress, newThreshold || 0]);
  }

  approveTx(id) {
    return this.tx('approve', [id]);
  }

  async status() {
    if (!this.enabled) return { enabled: false };
    const c = this.registry();
    const [threshold, governorCount, bootstrapOpen, proposalCount] = await Promise.all([c.threshold(), c.governorCount(), c.bootstrapOpen(), c.proposalCount()]);
    return { enabled: true, address: this.cfg.roleRegistryAddress, threshold: Number(threshold), governorCount: Number(governorCount), bootstrapOpen, proposalCount: Number(proposalCount) };
  }

  /** The newest proposals (newest first). `subjectToUser` maps a subject hash to a user summary. */
  async proposals({ limit = 50, subjectToUser = new Map() } = {}) {
    const c = this.registry();
    const count = Number(await c.proposalCount());
    const ttl = Number(await c.PROPOSAL_TTL());
    const out = [];
    for (let id = count - 1; id >= 0 && out.length < limit; id -= 1) {
      const p = await c.getProposal(id);
      const createdAt = Number(p.createdAt);
      out.push({
        id,
        action: ACTION_NAME[Number(p.action)],
        role: ROLE_NAME[Number(p.role)] || null,
        subject: p.subject,
        user: subjectToUser.get(p.subject) || null,
        account: p.account === ethers.ZeroAddress ? null : p.account,
        newThreshold: Number(p.newThreshold) || null,
        proposer: p.proposer,
        createdAt: new Date(createdAt * 1000).toISOString(),
        expiresAt: new Date((createdAt + ttl) * 1000).toISOString(),
        approvals: Number(p.approvals),
        executed: p.executed,
        cancelled: p.cancelled,
      });
    }
    return out;
  }
}

module.exports = new RoleService();
module.exports.RoleService = RoleService;
module.exports.ROLE_CODE = ROLE_CODE;
module.exports.ACTION = ACTION;
module.exports.STAFF_ROLES = STAFF_ROLES;
