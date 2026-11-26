const { expect } = require('chai');
const { ethers } = require('hardhat');

// D12 (guide, 26 Nov 2026): the review of every emergency sign-in is recorded on-chain and closed
// only by k of n administrators, so no single administrator can quietly close it.
const h = (text) => ethers.keccak256(ethers.toUtf8Bytes(text));
const VERDICT = { None: 0, Justified: 1, Misuse: 2 };
const ACTION = { RemoveGovernor: 3 };

describe('EmergencyReview (k of n from RoleRegistry)', () => {
  let registry;
  let review;
  let hospital;
  let a1;
  let a2;
  let a3;
  let outsider;

  beforeEach(async () => {
    [hospital, a1, a2, a3, outsider] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory('RoleRegistry')).deploy([a1.address, a2.address, a3.address], 2);
    review = await (await ethers.getContractFactory('EmergencyReview')).deploy(await registry.getAddress(), hospital.address);
  });

  const open = (id = 'case1') => review.connect(hospital).openCase(h(id), h('subject'), h('reason'));

  it('only the hospital recorder opens cases, once, and without empty values', async () => {
    await expect(review.connect(outsider).openCase(h('x'), h('s'), h('r'))).to.be.revertedWith('not the hospital recorder');
    await expect(review.connect(a1).openCase(h('x'), h('s'), h('r'))).to.be.revertedWith('not the hospital recorder');
    await expect(review.connect(hospital).openCase(ethers.ZeroHash, h('s'), h('r'))).to.be.revertedWith('empty value');
    await expect(open()).to.emit(review, 'CaseOpened').withArgs(h('case1'), h('subject'), h('reason'));
    await expect(open()).to.be.revertedWith('case exists');
    expect(await review.caseCount()).to.equal(1n);
    expect(await review.caseIdAt(0)).to.equal(h('case1'));
  });

  it('one administrator cannot close a case; the second matching verdict closes it', async () => {
    await open();
    await expect(review.connect(a1).review(h('case1'), VERDICT.Misuse)).to.emit(review, 'Voted').withArgs(h('case1'), a1.address, VERDICT.Misuse, 1);
    expect((await review.getCase(h('case1'))).verdict).to.equal(VERDICT.None); // k - 1 votes: still open

    await expect(review.connect(a2).review(h('case1'), VERDICT.Misuse)).to.emit(review, 'CaseClosed').withArgs(h('case1'), VERDICT.Misuse);
    const c = await review.getCase(h('case1'));
    expect(c.verdict).to.equal(VERDICT.Misuse);
    expect(c.closedAt).to.be.greaterThan(0n);
    await expect(review.connect(a3).review(h('case1'), VERDICT.Justified)).to.be.revertedWith('case closed');
  });

  it('disagreeing verdicts do not close a case', async () => {
    await open();
    await review.connect(a1).review(h('case1'), VERDICT.Justified);
    await review.connect(a2).review(h('case1'), VERDICT.Misuse);
    const c = await review.getCase(h('case1'));
    expect(c.verdict).to.equal(VERDICT.None);
    expect(c.justifiedVotes).to.equal(1n);
    expect(c.misuseVotes).to.equal(1n);
    await expect(review.connect(a3).review(h('case1'), VERDICT.Justified)).to.emit(review, 'CaseClosed').withArgs(h('case1'), VERDICT.Justified);
  });

  it('an administrator cannot vote twice, an outsider or the hospital cannot vote at all', async () => {
    await open();
    await review.connect(a1).review(h('case1'), VERDICT.Justified);
    await expect(review.connect(a1).review(h('case1'), VERDICT.Justified)).to.be.revertedWith('already voted');
    await expect(review.connect(a1).review(h('case1'), VERDICT.Misuse)).to.be.revertedWith('already voted');
    await expect(review.connect(outsider).review(h('case1'), VERDICT.Justified)).to.be.revertedWith('not a governor');
    await expect(review.connect(hospital).review(h('case1'), VERDICT.Justified)).to.be.revertedWith('not a governor');
    await expect(review.connect(a2).review(h('case1'), VERDICT.None)).to.be.revertedWith('bad verdict');
    await expect(review.connect(a2).review(h('nope'), VERDICT.Justified)).to.be.revertedWith('no such case');
  });

  it('removing an administrator voids the votes given under the old governor set', async () => {
    await open();
    await review.connect(a1).review(h('case1'), VERDICT.Justified); // 1 vote under epoch 0
    // a1 and a2 remove a3 from the registry (2 of 3): the epoch changes
    await registry.connect(a1).propose(ACTION.RemoveGovernor, ethers.ZeroHash, 0, a3.address, 0);
    await registry.connect(a2).approve(0);
    // a2 alone cannot close the case with a1's old vote
    await review.connect(a2).review(h('case1'), VERDICT.Justified);
    expect((await review.getCase(h('case1'))).verdict).to.equal(VERDICT.None);
    expect((await review.getCase(h('case1'))).justifiedVotes).to.equal(1n);
    // the removed administrator can no longer vote; a1 may vote again under the new set
    await expect(review.connect(a3).review(h('case1'), VERDICT.Justified)).to.be.revertedWith('not a governor');
    await expect(review.connect(a1).review(h('case1'), VERDICT.Justified)).to.emit(review, 'CaseClosed');
  });

  it('rejects bad constructor arguments', async () => {
    const F = await ethers.getContractFactory('EmergencyReview');
    await expect(F.deploy(ethers.ZeroAddress, hospital.address)).to.be.revertedWith('zero address');
    await expect(F.deploy(await registry.getAddress(), ethers.ZeroAddress)).to.be.revertedWith('zero address');
  });
});
