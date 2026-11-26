/**
 * Deploys EmergencyReview (decision D12: emergency sign-in reviews on-chain, k of n administrators).
 *   ROLE_REGISTRY_ADDRESS=0x... [RECORDER=0xHospitalKeyAddress] npx hardhat run scripts/deployEmergencyReview.js --network <net>
 * The governors and k are read from the RoleRegistry, so both contracts always agree on them.
 * RECORDER is the address of the API's CHAIN_PRIVATE_KEY (the hospital); it defaults to the deployer.
 * Prints EMERGENCY_REVIEW_ADDRESS for the API .env.
 */
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  let registry = process.env.ROLE_REGISTRY_ADDRESS;
  if (!registry) {
    const saved = path.join(__dirname, '..', 'role-registry.json');
    if (fs.existsSync(saved)) registry = JSON.parse(fs.readFileSync(saved, 'utf8')).address;
  }
  if (!registry) throw new Error('Set ROLE_REGISTRY_ADDRESS (deploy the RoleRegistry first)');
  const recorder = process.env.RECORDER || deployer.address;
  const Review = await hre.ethers.getContractFactory('EmergencyReview');
  const review = await Review.deploy(registry, recorder);
  await review.waitForDeployment();
  const address = await review.getAddress();
  const out = { address, network: hre.network.name, roleRegistry: registry, recorder, deployer: deployer.address, deployedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, '..', 'emergency-review.json'), JSON.stringify(out, null, 2));
  console.log(`EmergencyReview deployed to ${address} (governors and k from RoleRegistry ${registry}; recorder ${recorder})`);
  console.log(`EMERGENCY_REVIEW_ADDRESS=${address}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
