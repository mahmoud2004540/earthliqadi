// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ExchangeVault} from "../src/ExchangeVault.sol";
import {TestToken} from "../src/TestToken.sol";
import {TestBase} from "./ExchangeVault.t.sol";

/// Token whose transfer / transferFrom can be told to return false (no revert).
contract FalseToken {
    mapping(address => uint256) public balanceOf;
    bool public failTransfer;
    bool public failTransferFrom;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function setFail(bool t, bool tf) external {
        failTransfer = t;
        failTransferFrom = tf;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        if (failTransfer) return false;
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        if (failTransferFrom) return false;
        balanceOf[from] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// Token that takes the whole amount as a fee: the vault receives nothing.
contract EatingToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transferFrom(address from, address, uint256 a) external returns (bool) {
        balanceOf[from] -= a; // burnt
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// Token that tries to re-enter the vault from inside transferFrom and records the outcome.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    ExchangeVault public vault;
    bytes4 public reentryError;

    function setVault(ExchangeVault v) external {
        vault = v;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        try vault.deposit(address(this), 1) {
            reentryError = 0xffffffff; // must never happen
        } catch (bytes memory reason) {
            reentryError = bytes4(reason);
        }
        balanceOf[from] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/**
 * Edge cases and failure branches of ExchangeVault (audit preparation).
 * Complements ExchangeVault.t.sol: every revert branch is exercised.
 */
contract ExchangeVaultEdgeTest is TestBase {
    uint256 internal constant OPERATOR_KEY = 0xA11CE;
    uint256 internal constant DELAY = 7 days;
    address internal operator;
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    TestToken internal usd;
    FalseToken internal falsy;
    EatingToken internal eater;
    ReentrantToken internal reentrant;
    ExchangeVault internal vault;

    function setUp() public {
        operator = vm.addr(OPERATOR_KEY);
        usd = new TestToken("Test USD (no value)", "TUSD", 6, 1e15);
        falsy = new FalseToken();
        eater = new EatingToken();
        reentrant = new ReentrantToken();
        address[] memory tokens = new address[](4);
        tokens[0] = address(usd);
        tokens[1] = address(falsy);
        tokens[2] = address(eater);
        tokens[3] = address(reentrant);
        vault = new ExchangeVault(operator, DELAY, tokens);
        reentrant.setVault(vault);
        usd.mint(alice, 1_000e6);
        vm.prank(alice);
        usd.approve(address(vault), type(uint256).max);
    }

    function digest(ExchangeVault.Withdrawal calldata w) external view returns (bytes32) {
        return vault.hashWithdrawal(w);
    }

    function _w(address token, address u, uint256 amount, uint64 afterState)
        internal
        view
        returns (ExchangeVault.Withdrawal memory)
    {
        return ExchangeVault.Withdrawal({
            id: keccak256(abi.encode(token, u, amount, afterState, block.timestamp)),
            user: u,
            token: token,
            amount: amount,
            afterState: afterState,
            expiry: uint64(block.timestamp + 1 hours)
        });
    }

    function _sign(ExchangeVault.Withdrawal memory w) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_KEY, this.digest(w));
        return abi.encodePacked(r, s, v);
    }

    function _freeze() internal {
        vm.warp(vault.lastCommitAt() + DELAY + 1);
        vault.freeze();
    }

    // ------------------------------------------------------------ config

    function test_constructor_refusesUnsafeConfig() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        vm.expectRevert(ExchangeVault.BadConfig.selector);
        new ExchangeVault(address(0), DELAY, tokens);
        vm.expectRevert(ExchangeVault.BadConfig.selector);
        new ExchangeVault(operator, 1 hours - 1, tokens);
        vm.expectRevert(ExchangeVault.BadConfig.selector);
        new ExchangeVault(operator, DELAY, new address[](0));
        tokens[0] = address(0xBEEF); // not a contract
        vm.expectRevert(ExchangeVault.BadConfig.selector);
        new ExchangeVault(operator, DELAY, tokens);
    }

    // ------------------------------------------------------------ tokens

    function test_deposit_feeTakingEverythingCreditsNothing() public {
        eater.mint(alice, 10);
        vm.prank(alice);
        vm.expectRevert(ExchangeVault.ZeroAmount.selector);
        vault.deposit(address(eater), 10);
    }

    function test_reentrancy_isRefused() public {
        reentrant.mint(alice, 10);
        vm.prank(alice);
        vault.deposit(address(reentrant), 10);
        require(reentrant.reentryError() == ExchangeVault.Reentrancy.selector, "re-entry blocked");
        eq(vault.depositCount(), 1, "only the outer deposit counted");
    }

    function test_transfer_returningFalseReverts() public {
        falsy.mint(alice, 100);
        falsy.setFail(false, true);
        vm.prank(alice);
        vm.expectRevert(ExchangeVault.TransferFailed.selector);
        vault.deposit(address(falsy), 10);

        falsy.setFail(false, false);
        vm.prank(alice);
        vault.deposit(address(falsy), 10);
        falsy.setFail(true, false);
        ExchangeVault.Withdrawal memory w = _w(address(falsy), alice, 5, 0);
        bytes memory sig = _sign(w);
        vm.expectRevert(ExchangeVault.TransferFailed.selector);
        vault.withdraw(w, sig);
        require(!vault.withdrawalUsed(w.id), "failed withdrawal not consumed");
    }

    // ------------------------------------------------------- withdrawals

    function test_withdraw_rejectsUnknownTokenZeroAndFrozen() public {
        TestToken other = new TestToken("x", "X", 6, 1e15);
        ExchangeVault.Withdrawal memory w = _w(address(other), alice, 1, 0);
        bytes memory sig = _sign(w);
        vm.expectRevert(ExchangeVault.UnknownToken.selector);
        vault.withdraw(w, sig);

        w = _w(address(usd), alice, 0, 0);
        sig = _sign(w);
        vm.expectRevert(ExchangeVault.ZeroAmount.selector);
        vault.withdraw(w, sig);

        vm.prank(alice);
        vault.deposit(address(usd), 10e6);
        _freeze();
        w = _w(address(usd), alice, 1e6, 0);
        w.expiry = uint64(block.timestamp + 1 hours);
        sig = _sign(w);
        vm.expectRevert(ExchangeVault.IsFrozen.selector);
        vault.withdraw(w, sig);
    }

    function test_signature_badLengthBadVAndZeroSigner() public {
        vm.prank(alice);
        vault.deposit(address(usd), 10e6);
        ExchangeVault.Withdrawal memory w = _w(address(usd), alice, 1e6, 0);
        bytes memory good = _sign(w);

        vm.expectRevert(ExchangeVault.BadSignature.selector);
        vault.withdraw(w, abi.encodePacked(bytes32(0), bytes32(0))); // 64 bytes

        bytes memory badV = good;
        badV[64] = bytes1(uint8(29));
        vm.expectRevert(ExchangeVault.BadSignature.selector);
        vault.withdraw(w, badV);

        // r = 0 makes ecrecover return address(0).
        vm.expectRevert(ExchangeVault.BadSignature.selector);
        vault.withdraw(w, abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27)));
    }

    function test_domainSeparator_isStandardEip712() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ExchangeVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        require(vault.domainSeparator() == expected, "domain separator");
    }

    // -------------------------------------------------- commits and escape

    function test_commit_refusedOnceFrozen() public {
        _freeze();
        vm.expectRevert(ExchangeVault.IsFrozen.selector);
        vault.freeze(); // only once
        vm.prank(operator);
        vm.expectRevert(ExchangeVault.IsFrozen.selector);
        vault.commitState(1, bytes32(uint256(1)), 0);
    }

    function test_escape_needsAFreezeAndWorksOnce() public {
        vm.prank(alice);
        uint64 id = vault.deposit(address(usd), 10e6);
        bytes32[] memory none = new bytes32[](0);
        vm.expectRevert(ExchangeVault.NotFrozen.selector);
        vault.escape(address(usd), 0, none);
        vm.expectRevert(ExchangeVault.NotFrozen.selector);
        vault.escapeDeposit(id);

        _freeze();
        vm.prank(bob);
        vm.expectRevert(ExchangeVault.NotDepositor.selector);
        vault.escapeDeposit(id);
        vm.prank(alice);
        vault.escapeDeposit(id);
        vm.prank(alice);
        vm.expectRevert(ExchangeVault.AlreadyUsed.selector);
        vault.escapeDeposit(id);
        eq(usd.balanceOf(alice), 1_000e6, "deposit reclaimed in full");
    }

    /**
     * KNOWN LIMITATION (documented for auditors, see docs/security/audit-readiness.md):
     * a withdrawal signed after snapshot S, but never submitted, is excluded from
     * root S+1. If the vault freezes while root S+1 is current, withdraw() is
     * closed and escape() pays the root balance, so that amount stays in the vault.
     */
    function test_limitation_unsubmittedWithdrawalAtFreezeIsStranded() public {
        vm.prank(alice);
        vault.deposit(address(usd), 100e6);
        // Root 1: alice holds 100 (single-leaf tree: the root is the leaf).
        bytes32 root1 = vault.leaf(alice, address(usd), 100e6);
        vm.prank(operator);
        vault.commitState(1, root1, 1);
        // The operator holds 40 and signs it against snapshot 1; alice never submits it.
        ExchangeVault.Withdrawal memory w = _w(address(usd), alice, 40e6, 1);
        bytes memory sig = _sign(w);
        // Root 2 no longer contains the held 40.
        bytes32 root2 = vault.leaf(alice, address(usd), 60e6);
        vm.prank(operator);
        vault.commitState(2, root2, 1);
        _freeze();
        vm.expectRevert(ExchangeVault.IsFrozen.selector);
        vault.withdraw(w, sig);
        vm.prank(alice);
        vault.escape(address(usd), 60e6, new bytes32[](0));
        eq(usd.balanceOf(alice), 900e6 + 60e6, "escape pays the committed balance only");
        eq(usd.balanceOf(address(vault)), 40e6, "the unsubmitted withdrawal stays stranded");
    }
}
