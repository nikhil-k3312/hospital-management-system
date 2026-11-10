/**
 * Problem 26: registers the staff that already exist in MongoDB in the RoleRegistry contract,
 * once, before the registry is used. Only the account that deployed the contract can do this.
 *
 *   npm run roles:bootstrap              list what would be registered (dry run)
 *   npm run roles:bootstrap -- --write   register approved doctors/agents and all admins
 *   npm run roles:bootstrap -- --close   close the bootstrap for good (afterwards: k of n only)
 *
 * The deployer key is read from ROLE_BOOTSTRAP_PRIVATE_KEY, or CHAIN_PRIVATE_KEY.
 */
require('../src/config/config');
const { ethers } = require('ethers');
const config = require('../src/config/config');
const { connectMongo, disconnectMongo } = require('../src/db/mongo');
const User = require('../src/models/User');
const { RoleService, ROLE_CODE } = require('../src/services/roleService');

const ABI = [
  'function bootstrapGrant(bytes32[] subjects, uint8[] roles)',
  'function closeBootstrap()',
  'function bootstrapOpen() view returns (bool)',
  'function roleOf(bytes32) view returns (uint8)',
];

async function main() {
  if (!config.chain.rpcUrl || !config.chain.roleRegistryAddress) throw new Error('Set CHAIN_RPC_URL and ROLE_REGISTRY_ADDRESS first.');
  const key = process.env.ROLE_BOOTSTRAP_PRIVATE_KEY || config.chain.privateKey;
  const wallet = new ethers.Wallet(key, new ethers.JsonRpcProvider(config.chain.rpcUrl));
  const registry = new ethers.Contract(config.chain.roleRegistryAddress, ABI, wallet);
  if (!(await registry.bootstrapOpen())) { console.log('The bootstrap is already closed: use the Role Registry page (k of n).'); return; }

  if (process.argv.includes('--close')) {
    await (await registry.closeBootstrap()).wait();
    console.log('Bootstrap closed. Every role change now needs k of n administrator approvals.');
    return;
  }

  await connectMongo();
  const staff = await User.find({ $or: [{ role: 'admin' }, { role: { $in: ['doctor', 'insurance_agent'] }, approvalStatus: 'approved' }], isActive: true })
    .select('fullName email role roleSalt');
  const todo = [];
  for (const u of staff) {
    const subject = RoleService.subjectOf(u._id.toString(), await RoleService.ensureSalt(u));
    if (Number(await registry.roleOf(subject)) === 0) todo.push({ u, subject, code: ROLE_CODE[u.role] });
  }
  todo.forEach(({ u }) => console.log(`  ${u.role.padEnd(16)} ${u.fullName} <${u.email}>`));
  console.log(`${todo.length} account(s) to register.`);
  if (!process.argv.includes('--write')) { console.log('Dry run. Add --write to register them.'); return; }

  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const receipt = await (await registry.bootstrapGrant(batch.map((t) => t.subject), batch.map((t) => t.code))).wait();
    console.log(`registered ${batch.length} (gas ${receipt.gasUsed})`);
  }
  console.log('Done. Check the Role Registry page, then run with --close.');
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => disconnectMongo().catch(() => {}));
