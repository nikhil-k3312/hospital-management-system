// Deploys HealthRecordRegistry and prints the values the API needs in its .env.
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const Registry = await hre.ethers.getContractFactory('HealthRecordRegistry');
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  const address = await registry.getAddress();

  const out = { address, network: hre.network.name, deployer: deployer.address, deployedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, '..', 'deployment.json'), JSON.stringify(out, null, 2));
  console.log(`HealthRecordRegistry deployed to ${address}`);
  console.log(`CHAIN_CONTRACT_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
