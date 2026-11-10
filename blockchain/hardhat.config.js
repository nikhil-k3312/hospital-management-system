require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');

/**
 * Local development chain: `npx hardhat node` starts it on http://127.0.0.1:8545.
 * For a shared test network set CHAIN_RPC_URL and CHAIN_PRIVATE_KEY and deploy with
 * `npx hardhat run scripts/deploy.js --network custom`.
 */
module.exports = {
  // evmVersion "paris" (no PUSH0) so the same bytecode runs on the Besu QBFT network (Problem 25)
  solidity: { version: '0.8.24', settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris' } },
  networks: {
    localhost: { url: 'http://127.0.0.1:8545' },
    // 4-validator Hyperledger Besu QBFT network from chain/besu-qbft (Problem 25)
    besu: {
      url: process.env.BESU_RPC_URL || 'http://127.0.0.1:8545',
      accounts: process.env.CHAIN_PRIVATE_KEY ? [process.env.CHAIN_PRIVATE_KEY] : [],
      gasPrice: 0,
    },
    custom: {
      url: process.env.CHAIN_RPC_URL || 'http://127.0.0.1:8545',
      accounts: process.env.CHAIN_PRIVATE_KEY ? [process.env.CHAIN_PRIVATE_KEY] : [],
    },
  },
};
