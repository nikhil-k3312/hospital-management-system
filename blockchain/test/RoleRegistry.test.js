const { expect } = require('chai');
const { ethers } = require('hardhat');

// Problem 26: staff roles change only with k of n administrator approvals.
const subject = (userId) => ethers.keccak256(ethers.toUtf8Bytes(`medichain-user:${userId}`));
const ACTION = { Grant: 0, Revoke: 1, AddGovernor: 2, RemoveGovernor: 3, SetThreshold: 4 };
const DOCTOR = 1;
const ADMIN = 3;
const ZERO = ethers.ZeroAddress;
const NONE = ethers.ZeroHash;

describe('RoleRegistry (2 of 3)', () => {
  let registry;
  let deployer;
  let a1;
  let a2;
  let a3;
  let outsider;
  let newAdmin;

  beforeEach(async () => {
    [deployer, a1, a2, a3, outsider, newAdmin] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory('RoleRegistry')).deploy([a1.address, a2.address, a3.address], 2);
  });

  const proposeGrant = (signer, userId, role = DOCTOR) => registry.connect(signer).propose(ACTION.Grant, subject(userId), role, ZERO, 0);

  it('starts with the given governors and threshold', async () => {
    expect(await registry.threshold()).to.equal(2n);
    expect(await registry.governorCount()).to.equal(3n);
    expect(await registry.isGovernor(a1.address)).to.equal(true);
    expect(await registry.isGovernor(outsider.address)).to.equal(false);
  });

  it('one approval is not enough; the second executes the grant', async () => {
    await expect(proposeGrant(a1, 'doc1')).to.emit(registry, 'Approved').withArgs(0, a1.address, 1);
    expect(await registry.hasRole(subject('doc1'), DOCTOR)).to.equal(false); // k - 1 approvals

    await expect(registry.connect(a2).approve(0)).to.emit(registry, 'RoleGranted').withArgs(subject('doc1'), DOCTOR);
    expect(await registry.hasRole(subject('doc1'), DOCTOR)).to.equal(true);
    expect((await registry.getProposal(0)).executed).to.equal(true);
  });

  it('a governor cannot approve twice, and an outsider cannot propose or approve', async () => {
    await proposeGrant(a1, 'doc1');
    await expect(registry.connect(a1).approve(0)).to.be.revertedWith('already approved');
    await expect(registry.connect(outsider).approve(0)).to.be.revertedWith('not a governor');
    await expect(proposeGrant(outsider, 'doc2')).to.be.revertedWith('not a governor');
    expect(await registry.hasRole(subject('doc1'), DOCTOR)).to.equal(false);
  });

  it('revocation also needs k approvals', async () => {
    await proposeGrant(a1, 'doc1');
    await registry.connect(a2).approve(0);
    await registry.connect(a3).propose(ACTION.Revoke, subject('doc1'), DOCTOR, ZERO, 0);
    expect(await registry.hasRole(subject('doc1'), DOCTOR)).to.equal(true);
    await registry.connect(a1).approve(1);
    expect(await registry.hasRole(subject('doc1'), DOCTOR)).to.equal(false);
  });

  it('cannot grant a second role or revoke a role the subject does not hold', async () => {
    await proposeGrant(a1, 'doc1');
    await registry.connect(a2).approve(0);
    await expect(proposeGrant(a1, 'doc1', ADMIN)).to.be.revertedWith('subject already has a role');
    await expect(registry.connect(a1).propose(ACTION.Revoke, subject('doc1'), ADMIN, ZERO, 0)).to.be.revertedWith('subject does not hold this role');
    await expect(proposeGrant(a1, 'x', 9)).to.be.revertedWith('bad role or subject');
  });

  it('changing the governor set and the threshold needs k approvals too', async () => {
    await registry.connect(a1).propose(ACTION.AddGovernor, NONE, 0, newAdmin.address, 0);
    expect(await registry.isGovernor(newAdmin.address)).to.equal(false);
    await registry.connect(a2).approve(0);
    expect(await registry.isGovernor(newAdmin.address)).to.equal(true);
    expect(await registry.governorCount()).to.equal(4n);

    await registry.connect(newAdmin).propose(ACTION.SetThreshold, NONE, 0, ZERO, 3);
    await registry.connect(a3).approve(1);
    expect(await registry.threshold()).to.equal(3n);

    // cannot remove governors below the threshold
    await registry.connect(a1).propose(ACTION.RemoveGovernor, NONE, 0, a3.address, 0);
    await registry.connect(a2).approve(2);
    await registry.connect(newAdmin).approve(2);
    expect(await registry.governorCount()).to.equal(3n);
    await expect(registry.connect(a1).propose(ACTION.RemoveGovernor, NONE, 0, a2.address, 0)).to.be.revertedWith('would fall below threshold');
  });

  it('removing a governor voids the approvals he already gave on pending proposals', async () => {
    // a1 (compromised) proposes a grant; before anyone else approves, a2 + a3 remove a1
    await proposeGrant(a1, 'attacker');
    await registry.connect(a2).propose(ACTION.RemoveGovernor, NONE, 0, a1.address, 0);
    await registry.connect(a3).approve(1);
    expect(await registry.isGovernor(a1.address)).to.equal(false);
    // a1's approval on proposal 0 no longer counts: a second approval cannot execute it
    await expect(registry.connect(a2).approve(0)).to.be.revertedWith('governors changed: propose again');
    expect(await registry.hasRole(subject('attacker'), DOCTOR)).to.equal(false);
  });

  it('proposals expire after 7 days and can be cancelled by the proposer', async () => {
    await proposeGrant(a1, 'doc1');
    await ethers.provider.send('evm_increaseTime', [7 * 24 * 3600 + 1]);
    await ethers.provider.send('evm_mine', []);
    await expect(registry.connect(a2).approve(0)).to.be.revertedWith('proposal expired');

    await proposeGrant(a1, 'doc2');
    await expect(registry.connect(a2).cancel(1)).to.be.revertedWith('not proposer');
    await registry.connect(a1).cancel(1);
    await expect(registry.connect(a2).approve(1)).to.be.revertedWith('already closed');
  });

  it('bootstrap registers existing staff once, only by the deployer, and then closes for good', async () => {
    await expect(registry.connect(a1).bootstrapGrant([subject('d')], [DOCTOR])).to.be.revertedWith('not bootstrapper');
    await registry.connect(deployer).bootstrapGrant([subject('d'), subject('adm')], [DOCTOR, ADMIN]);
    expect(await registry.hasRole(subject('adm'), ADMIN)).to.equal(true);
    await registry.connect(deployer).closeBootstrap();
    expect(await registry.bootstrapOpen()).to.equal(false);
    await expect(registry.connect(deployer).bootstrapGrant([subject('e')], [DOCTOR])).to.be.revertedWith('bootstrap closed');
  });

  it('rejects bad constructor arguments', async () => {
    const Factory = await ethers.getContractFactory('RoleRegistry');
    await expect(Factory.deploy([a1.address, a2.address], 3)).to.be.revertedWith('bad threshold');
    await expect(Factory.deploy([a1.address, a1.address], 1)).to.be.revertedWith('duplicate governor');
    await expect(Factory.deploy([], 1)).to.be.revertedWith('1-50 governors');
  });
});
