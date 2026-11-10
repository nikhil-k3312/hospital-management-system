/**
 * Deploys RoleRegistry (Problem 26).
 *   GOVERNORS=0xAdmin1,0xAdmin2,0xAdmin3 THRESHOLD=2 npx hardhat run scripts/deployRoleRegistry.js --network <net>
 * GOVERNORS are the wallet addresses of the hospital administrators (each keeps their own key,
 * e.g. in MetaMask). Prints ROLE_REGISTRY_ADDRESS for the API .env.
 */
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

async function main() {
  const signers = await hre.ethers.getSigners();
  let governors = (process.env.GOVERNORS || '').split(',').map((a) => a.trim()).filter(Boolean);
  if (!governors.length) {
    if (!['hardhat', 'localhost'].includes(hre.network.name)) throw new Error('Set GOVERNORS (comma-separated administrator wallet addresses)');
    governors = signers.slice(1, 4).map((s) => s.address); // local demo: Hardhat accounts #1-#3
    console.log('GOVERNORS not set: using Hardhat accounts #1-#3 (local demo only)');
  }
  const k = Number(process.env.THRESHOLD || 2);
  const Registry = await hre.ethers.getContractFactory('RoleRegistry');
  const registry = await Registry.deploy(governors, k);
  await registry.waitForDeployment();
  const address = await registry.getAddress();
  const out = { address, network: hre.network.name, governors, threshold: k, deployer: signers[0].address, deployedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, '..', 'role-registry.json'), JSON.stringify(out, null, 2));
  console.log(`RoleRegistry (${k} of ${governors.length}) deployed to ${address}`);
  console.log(`ROLE_REGISTRY_ADDRESS=${address}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
