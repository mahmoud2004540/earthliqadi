import { checkListUpdate, parseOfacSdnAddresses } from './ofac';

// Synthetic rows in the SDN.CSV format (not real list entries).
const A = `0x${'ab'.repeat(20)}`;
const B = `0x${'Cd'.repeat(20)}`;
const csv = [
  `36001,"EXAMPLE ONE","individual","CYBER2",-0- ,"Digital Currency Address - ETH ${A}; Digital Currency Address - XBT 1BoatSLRHtKNngkdXEeobR76b53LETtpyT; alt."`,
  `36002,"EXAMPLE TWO","-0- ","CYBER2",-0- ,"Digital Currency Address - USDT ${B}; Digital Currency Address - ETH ${A}."`,
  `36003,"EXAMPLE THREE","-0- ","SDGT",-0- ,"Digital Currency Address - TRX TXmVpin5vq5gdZsciyyjdZgKRUju4st1wM; Website 0x${'1'.repeat(40)}."`,
  `36004,"EXAMPLE FOUR","-0- ","CYBER2",-0- ,"Digital Currency Address - ETH 0x${'2'.repeat(41)}."`,
].join('\n');

describe('parseOfacSdnAddresses', () => {
  it('extracts unique lower-case EVM addresses from digital currency remarks only', () => {
    expect(parseOfacSdnAddresses(csv)).toEqual([A, B.toLowerCase()].sort());
  });
  it('returns nothing for text without digital currency remarks', () => {
    expect(parseOfacSdnAddresses('36005,"NOBODY","-0- "')).toEqual([]);
  });
});

describe('checkListUpdate', () => {
  it('refuses empty or sharply shrunk lists', () => {
    expect(checkListUpdate(0, 0)).toMatch(/no EVM addresses/);
    expect(checkListUpdate(100, 49)).toMatch(/less than half/);
    expect(checkListUpdate(100, 50)).toBeNull();
    expect(checkListUpdate(0, 3)).toBeNull();
  });
});
