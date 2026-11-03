require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');

/**
 * Local development chain: `npx hardhat node` starts it on http://127.0.0.1:8545.
 * For a shared test network set CHAIN_RPC_URL and CHAIN_PRIVATE_KEY and deploy with
 * `npx hardhat run scripts/deploy.js --network custom`.
 */
module.exports = {
  solidity: { version: '0.8.24', settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    localhost: { url: 'http://127.0.0.1:8545' },
    custom: {
      url: process.env.CHAIN_RPC_URL || 'http://127.0.0.1:8545',
      accounts: process.env.CHAIN_PRIVATE_KEY ? [process.env.CHAIN_PRIVATE_KEY] : [],
    },
  },
};
