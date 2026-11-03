const { expect } = require('chai');
const { ethers } = require('hardhat');

const key = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const sha = (s) => ethers.sha256(ethers.toUtf8Bytes(s));

describe('HealthRecordRegistry', () => {
  let registry;
  let owner;
  let hospitalB;
  let outsider;

  beforeEach(async () => {
    [owner, hospitalB, outsider] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory('HealthRecordRegistry')).deploy();
  });

  it('stores only the hashes it is given and verifies them', async () => {
    const k = key('record:abc:1');
    const patientRef = sha('hmac-of-patient');
    await expect(registry.anchor(k, sha('content v1'), patientRef, 1))
      .to.emit(registry, 'Anchored').withArgs(k, patientRef, sha('content v1'), 1, owner.address);

    const a = await registry.getAnchor(k);
    expect(a.dataHash).to.equal(sha('content v1'));
    expect(a.kind).to.equal(1n);
    expect(await registry.verify(k, sha('content v1'))).to.equal(true);
    expect(await registry.verify(k, sha('content edited'))).to.equal(false);
    expect(await registry.anchorsOf(patientRef)).to.deep.equal([k]);
  });

  it('refuses to overwrite an anchor', async () => {
    const k = key('file:f1:1');
    await registry.anchor(k, sha('bytes'), ethers.ZeroHash, 2);
    await expect(registry.anchor(k, sha('other bytes'), ethers.ZeroHash, 2)).to.be.revertedWith('already anchored');
  });

  it('lets only authorised hospitals write', async () => {
    const k = key('record:x:1');
    await expect(registry.connect(outsider).anchor(k, sha('c'), ethers.ZeroHash, 1)).to.be.revertedWith('not an authorised hospital');
    await expect(registry.connect(outsider).setHospital(outsider.address, true)).to.be.revertedWith('not owner');

    await registry.setHospital(hospitalB.address, true);
    await registry.connect(hospitalB).anchor(k, sha('c'), ethers.ZeroHash, 1);
    expect((await registry.getAnchor(k)).hospital).to.equal(hospitalB.address);
  });

  it('rejects empty hashes and unknown kinds', async () => {
    await expect(registry.anchor(key('a'), ethers.ZeroHash, ethers.ZeroHash, 1)).to.be.revertedWith('empty hash');
    await expect(registry.anchor(key('b'), sha('x'), ethers.ZeroHash, 9)).to.be.revertedWith('bad kind');
  });
});
