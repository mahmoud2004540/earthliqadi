// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ExchangeVault} from "../src/ExchangeVault.sol";
import {TestToken} from "../src/TestToken.sol";
import {TestPriceFeed} from "../src/TestPriceFeed.sol";

/// Minimal Foundry cheatcode interface (self-contained; no external test library).
interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external returns (address);
    function assume(bool) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function eq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    /// Deposit caps for `n` tokens, all uncapped.
    function noCaps(uint256 n) internal pure returns (uint256[] memory caps) {
        caps = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            caps[i] = type(uint256).max;
        }
    }
}

contract ExchangeVaultTest is TestBase {
    uint256 internal constant OPERATOR_KEY = 0xA11CE;
    uint256 internal constant DELAY = 7 days;
    address internal operator;
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    TestToken internal usd;
    TestToken internal other;
    ExchangeVault internal vault;

    function setUp() public {
        operator = vm.addr(OPERATOR_KEY);
        usd = new TestToken("Test USD (no value)", "TUSD", 6, 1e15);
        other = new TestToken("Unlisted", "UNL", 18, 1e30);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        vault = new ExchangeVault(operator, DELAY, tokens, noCaps(1));
        for (uint256 i = 0; i < 2; i++) {
            address u = i == 0 ? alice : bob;
            usd.mint(u, 1_000_000e6);
            vm.prank(u);
            usd.approve(address(vault), type(uint256).max);
        }
    }

    // ----------------------------------------------------------- helpers

    function _deposit(address u, uint256 amount) internal returns (uint64) {
        vm.prank(u);
        return vault.deposit(address(usd), amount);
    }

    function _w(address u, uint256 amount, uint64 afterState) internal view returns (ExchangeVault.Withdrawal memory) {
        return ExchangeVault.Withdrawal({
            id: keccak256(abi.encode(u, amount, afterState, block.timestamp)),
            user: u,
            token: address(usd),
            amount: amount,
            afterState: afterState,
            expiry: uint64(block.timestamp + 1 hours)
        });
    }

    function _sign(ExchangeVault.Withdrawal memory w, uint256 key) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, this.digest(w));
        return abi.encodePacked(r, s, v);
    }

    function digest(ExchangeVault.Withdrawal calldata w) external view returns (bytes32) {
        return vault.hashWithdrawal(w);
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    // ---------------------------------------------------------- deposits

    function test_deposit_creditsAndRecords() public {
        uint64 id = _deposit(alice, 250e6);
        eq(id, 1, "id");
        (address u, address t, uint256 a) = vault.deposits(1);
        require(u == alice && t == address(usd), "record");
        eq(a, 250e6, "amount");
        eq(usd.balanceOf(address(vault)), 250e6, "vault balance");
    }

    function test_deposit_rejectsUnknownTokenAndZero() public {
        vm.expectRevert(ExchangeVault.UnknownToken.selector);
        vault.deposit(address(other), 1);
        vm.expectRevert(ExchangeVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.deposit(address(usd), 0);
    }

    // ------------------------------------------------------- withdrawals

    function test_withdraw_operatorSignedGoesToUserOnce() public {
        _deposit(alice, 500e6);
        ExchangeVault.Withdrawal memory w = _w(alice, 200e6, 0);
        bytes memory sig = _sign(w, OPERATOR_KEY);
        uint256 before = usd.balanceOf(alice);
        vm.prank(bob); // anyone may relay it
        vault.withdraw(w, sig);
        eq(usd.balanceOf(alice) - before, 200e6, "paid to user");
        eq(vault.withdrawnAt(alice, address(usd), 0), 200e6, "recorded");
        vm.expectRevert(ExchangeVault.AlreadyUsed.selector);
        vault.withdraw(w, sig);
    }

    function test_withdraw_rejectsForgedExpiredMalleableAndFutureState() public {
        _deposit(alice, 500e6);
        ExchangeVault.Withdrawal memory w = _w(alice, 1e6, 0);
        bytes memory forged = _sign(w, 0xBAD); // sign first: expectRevert applies to the next call
        vm.expectRevert(ExchangeVault.BadSignature.selector);
        vault.withdraw(w, forged);

        bytes memory sig = _sign(w, OPERATOR_KEY);
        // Malleated copy: s' = n - s, v flipped.
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        uint256 n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory malleated = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(ExchangeVault.BadSignature.selector);
        vault.withdraw(w, malleated);

        ExchangeVault.Withdrawal memory future = _w(alice, 1e6, 2); // stateIndex is 0
        bytes memory futureSig = _sign(future, OPERATOR_KEY);
        vm.expectRevert(ExchangeVault.BadStateIndex.selector);
        vault.withdraw(future, futureSig);

        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(ExchangeVault.Expired.selector);
        vault.withdraw(w, sig);
    }

    // ------------------------------------------------------- deposit cap

    function test_cap_limitsNewDepositsOnly() public {
        vm.expectRevert(ExchangeVault.NotOperator.selector);
        vault.setDepositCap(address(usd), 1000e6);
        vm.expectRevert(ExchangeVault.UnknownToken.selector);
        vm.prank(operator);
        vault.setDepositCap(address(other), 1000e6);
        vm.prank(operator);
        vault.setDepositCap(address(usd), 1000e6);
        eq(vault.depositCap(address(usd)), 1000e6, "cap set");

        _deposit(alice, 600e6);
        _deposit(bob, 400e6); // exactly at the cap
        eq(vault.held(address(usd)), 1000e6, "held");
        vm.expectRevert(ExchangeVault.DepositCapExceeded.selector);
        vm.prank(alice);
        vault.deposit(address(usd), 1);

        // A withdrawal frees room, and is never blocked by the cap.
        ExchangeVault.Withdrawal memory w = _w(alice, 100e6, 0);
        vault.withdraw(w, _sign(w, OPERATOR_KEY));
        eq(vault.held(address(usd)), 900e6, "released");
        _deposit(alice, 100e6);

        // Lowering the cap below what is held stops deposits but not withdrawals.
        vm.prank(operator);
        vault.setDepositCap(address(usd), 10e6);
        vm.expectRevert(ExchangeVault.DepositCapExceeded.selector);
        vm.prank(bob);
        vault.deposit(address(usd), 1);
        ExchangeVault.Withdrawal memory w2 = _w(bob, 400e6, 0);
        vault.withdraw(w2, _sign(w2, OPERATOR_KEY));
        eq(vault.held(address(usd)), 600e6, "still released");
    }

    function test_cap_escapesAreNeverBlockedAndRelease() public {
        vm.prank(operator);
        vault.setDepositCap(address(usd), 500e6);
        _deposit(alice, 300e6); // id 1
        bytes32 la = vault.leaf(alice, address(usd), 300e6);
        vm.prank(operator);
        vault.commitState(1, la, 1);
        uint64 late = _deposit(bob, 200e6); // id 2, after the root; cap now full
        vm.prank(operator);
        vault.setDepositCap(address(usd), 0); // even a zero cap blocks no exit
        vm.warp(block.timestamp + DELAY + 1);
        vault.freeze();
        vm.prank(alice);
        vault.escape(address(usd), 300e6, new bytes32[](0));
        vm.prank(bob);
        vault.escapeDeposit(late);
        eq(vault.held(address(usd)), 0, "all released");
        eq(usd.balanceOf(address(vault)), 0, "drained exactly");
    }

    function test_cap_directTransfersDoNotCountAndHeldNeverUnderflows() public {
        vm.prank(operator);
        vault.setDepositCap(address(usd), 100e6);
        // Tokens sent without deposit() do not use up the cap ...
        vm.prank(bob);
        require(usd.transfer(address(vault), 500e6), "transfer");
        _deposit(alice, 100e6);
        // ... and a payout larger than held stops at zero instead of reverting.
        ExchangeVault.Withdrawal memory w = _w(alice, 300e6, 0);
        vault.withdraw(w, _sign(w, OPERATOR_KEY));
        eq(vault.held(address(usd)), 0, "floored at zero");
    }

    // --------------------------------------------------- state commitments

    function test_commit_onlyOperatorInSequence() public {
        vm.expectRevert(ExchangeVault.NotOperator.selector);
        vault.commitState(1, bytes32(uint256(1)), 0);
        vm.startPrank(operator);
        vm.expectRevert(ExchangeVault.BadStateIndex.selector);
        vault.commitState(2, bytes32(uint256(1)), 0);
        vm.expectRevert(ExchangeVault.BadStateIndex.selector);
        vault.commitState(1, bytes32(uint256(1)), 5); // beyond depositCount
        vault.commitState(1, bytes32(uint256(1)), 0);
        vm.stopPrank();
        eq(vault.stateIndex(), 1, "index");
    }

    // -------------------------------------------------------- escape hatch

    function test_freeze_onlyAfterOperatorSilence() public {
        vm.expectRevert(ExchangeVault.TooEarly.selector);
        vault.freeze();
        vm.warp(block.timestamp + DELAY + 1);
        vault.freeze();
        require(vault.frozen(), "frozen");
        vm.expectRevert(ExchangeVault.IsFrozen.selector);
        vm.prank(alice);
        vault.deposit(address(usd), 1);
        vm.expectRevert(ExchangeVault.IsFrozen.selector);
        vm.prank(operator);
        vault.commitState(1, bytes32(0), 0);
    }

    function test_escape_paysCommittedBalanceMinusLaterWithdrawalsAndLateDeposits() public {
        _deposit(alice, 600e6); // id 1
        _deposit(bob, 400e6); // id 2
        // Ledger after trading: alice 700, bob 300 (zero-sum), both deposits included.
        bytes32 la = vault.leaf(alice, address(usd), 700e6);
        bytes32 lb = vault.leaf(bob, address(usd), 300e6);
        vm.prank(operator);
        vault.commitState(1, _pair(la, lb), 2);

        // Alice withdraws 100 signed against snapshot 1 (after it) - must reduce her escape.
        ExchangeVault.Withdrawal memory w = _w(alice, 100e6, 1);
        vault.withdraw(w, _sign(w, OPERATOR_KEY));
        // Bob deposits again after the snapshot (id 3): reclaimable separately.
        uint64 late = _deposit(bob, 50e6);

        vm.warp(block.timestamp + DELAY + 1);
        vault.freeze();

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = lb;
        uint256 a0 = usd.balanceOf(alice);
        vm.prank(alice);
        vault.escape(address(usd), 700e6, proofA);
        eq(usd.balanceOf(alice) - a0, 600e6, "alice: 700 - 100 withdrawn");
        vm.expectRevert(ExchangeVault.AlreadyUsed.selector);
        vm.prank(alice);
        vault.escape(address(usd), 700e6, proofA);

        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = la;
        vm.expectRevert(ExchangeVault.BadProof.selector);
        vm.prank(bob);
        vault.escape(address(usd), 999e6, proofB); // inflated balance
        uint256 b0 = usd.balanceOf(bob);
        vm.prank(bob);
        vault.escape(address(usd), 300e6, proofB);
        vm.expectRevert(ExchangeVault.NotDepositor.selector);
        vm.prank(alice);
        vault.escapeDeposit(late);
        vm.expectRevert(ExchangeVault.BadStateIndex.selector);
        vm.prank(bob);
        vault.escapeDeposit(2); // already in the committed root
        vm.prank(bob);
        vault.escapeDeposit(late);
        eq(usd.balanceOf(bob) - b0, 350e6, "bob: 300 + late 50");
        // Every token is accounted for: 1000 + 50 in, 100 + 600 + 350 out.
        eq(usd.balanceOf(address(vault)), 0, "vault drained exactly");
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_escapeNeverPaysMoreThanCommitted(uint96 balanceSeed, uint96 withdrawnSeed) public {
        // Alice holds 1,000,000 TUSD (1e12 units): keep the deposit within it.
        uint256 balance = bound(balanceSeed, 1, 4e11);
        uint256 withdrawn = bound(withdrawnSeed, 0, 4e11);
        _deposit(alice, uint256(balance) + uint256(withdrawn) + 1);
        bytes32 la = vault.leaf(alice, address(usd), balance);
        vm.prank(operator);
        vault.commitState(1, la, 1); // single-leaf tree: root = leaf
        if (withdrawn > 0) {
            ExchangeVault.Withdrawal memory w = _w(alice, withdrawn, 1);
            vault.withdraw(w, _sign(w, OPERATOR_KEY));
        }
        vm.warp(block.timestamp + DELAY + 1);
        vault.freeze();
        uint256 a0 = usd.balanceOf(alice);
        vm.prank(alice);
        vault.escape(address(usd), balance, new bytes32[](0));
        uint256 paid = usd.balanceOf(alice) - a0;
        require(paid <= balance, "never more than committed");
        eq(paid, balance > withdrawn ? balance - withdrawn : 0, "exact payout");
    }

    function testFuzz_withdrawRejectsAnyNonOperatorKey(uint256 key) public {
        key = bound(key, 1, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140);
        vm.assume(key != OPERATOR_KEY);
        _deposit(alice, 10e6);
        ExchangeVault.Withdrawal memory w = _w(alice, 1e6, 0);
        bytes memory sig = _sign(w, key);
        vm.expectRevert(ExchangeVault.BadSignature.selector);
        vault.withdraw(w, sig);
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }
}

/// Random deposits and operator-signed withdrawals; the vault must hold exactly
/// Σ deposits − Σ withdrawals at all times.
contract VaultHandler is TestBase {
    ExchangeVault public vault;
    TestToken public usd;
    uint256 public immutable key;
    uint256 public ghostIn;
    uint256 public ghostOut;
    uint256 private nonce;

    constructor(ExchangeVault v, TestToken t, uint256 k) {
        vault = v;
        usd = t;
        key = k;
        usd.approve(address(vault), type(uint256).max);
    }

    function deposit(uint256 amount) external {
        amount = 1 + (amount % 1e12);
        usd.mint(address(this), amount);
        vault.deposit(address(usd), amount);
        ghostIn += amount;
    }

    function withdraw(uint256 amount) external {
        uint256 available = ghostIn - ghostOut;
        if (available == 0) return;
        amount = 1 + (amount % available);
        ExchangeVault.Withdrawal memory w = ExchangeVault.Withdrawal({
            id: keccak256(abi.encode(++nonce)),
            user: address(this),
            token: address(usd),
            amount: amount,
            afterState: 0,
            expiry: uint64(block.timestamp + 1 hours)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.hashWithdrawal(w));
        vault.withdraw(w, abi.encodePacked(r, s, v));
        ghostOut += amount;
    }
}

contract ExchangeVaultInvariantTest is TestBase {
    ExchangeVault internal vault;
    TestToken internal usd;
    VaultHandler internal handler;

    function setUp() public {
        uint256 key = 0xA11CE;
        usd = new TestToken("Test USD (no value)", "TUSD", 6, type(uint256).max);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        vault = new ExchangeVault(vm.addr(key), 7 days, tokens, noCaps(1));
        handler = new VaultHandler(vault, usd, key);
    }

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(handler);
    }

    function invariant_vaultHoldsExactlyNetDeposits() public view {
        require(usd.balanceOf(address(vault)) == handler.ghostIn() - handler.ghostOut(), "conservation");
        require(vault.held(address(usd)) == handler.ghostIn() - handler.ghostOut(), "held tracks net deposits");
    }
}

contract TestPriceFeedTest is TestBase {
    function testOnlyOwnerPostsAnswersAndRoundsAdvance() public {
        TestPriceFeed feed = new TestPriceFeed(8, "TEST BTC / USD");
        (uint80 r0,,, uint256 u0,) = feed.latestRoundData();
        eq(r0, 0, "no round yet");
        eq(u0, 0, "never updated");
        vm.warp(1000);
        feed.setAnswer(65_000e8);
        (uint80 r1, int256 a1,, uint256 u1, uint80 ans1) = feed.latestRoundData();
        eq(r1, 1, "round 1");
        // forge-lint: disable-next-line(unsafe-typecast)
        eq(uint256(a1), 65_000e8, "answer");
        eq(u1, 1000, "updatedAt");
        eq(ans1, 1, "answeredInRound");
        vm.prank(address(0xBAD));
        vm.expectRevert(TestPriceFeed.NotOwner.selector);
        feed.setAnswer(1);
    }
}
