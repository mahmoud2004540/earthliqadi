// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title ExchangeVault (ADR-0014) — TESTNET ONLY, NOT AUDITED.
/// @notice Non-custodial collateral vault for the off-chain matching engine.
///         Users deposit ERC-20 tokens here; the exchange operator cannot move
///         them except through a withdrawal it signed for the user.
///
/// Safety model:
///  - Withdrawals: the operator signs an EIP-712 `Withdrawal` after holding the
///    amount in its ledger; anyone may submit it, funds always go to `user`.
///  - State commitments: the operator periodically commits a Merkle root of
///    every user's balance (per token) and the last deposit included.
///  - Escape hatch: if no commitment arrives for `freezeDelay` seconds, anyone
///    can freeze the vault. Users then withdraw on their own with a Merkle
///    proof of their committed balance, plus their later deposits, minus
///    withdrawals signed against the latest commitments. The operator is not
///    needed and cannot stop it.
contract ExchangeVault {
    // ------------------------------------------------------------------ types

    struct Withdrawal {
        bytes32 id; // unique per withdrawal (single use)
        address user; // receives the funds
        address token;
        uint256 amount;
        uint64 afterState; // latest state index the operator had snapshotted when signing
        uint64 expiry; // unix seconds
    }

    struct DepositRecord {
        address user;
        address token;
        uint256 amount;
    }

    // ----------------------------------------------------------------- config

    address public immutable operator;
    uint256 public immutable freezeDelay;
    bytes32 private immutable DOMAIN_SEPARATOR_;

    bytes32 public constant WITHDRAWAL_TYPEHASH =
        keccak256("Withdrawal(bytes32 id,address user,address token,uint256 amount,uint64 afterState,uint64 expiry)");
    // secp256k1n / 2: signatures with a higher s are malleable copies.
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    mapping(address => bool) public isToken;

    // ------------------------------------------------------------------ state

    uint64 public depositCount;
    mapping(uint64 => DepositRecord) public deposits;

    uint64 public stateIndex;
    bytes32 public stateRoot;
    /// Deposits with an id above this are not part of `stateRoot`.
    uint64 public stateLastDepositId;
    uint256 public lastCommitAt;
    bool public frozen;

    mapping(bytes32 => bool) public withdrawalUsed;
    /// Executed withdrawals per user/token, keyed by the state index they were signed against.
    mapping(address => mapping(address => mapping(uint64 => uint256))) public withdrawnAt;
    mapping(address => mapping(address => bool)) public escaped;
    mapping(uint64 => bool) public depositEscaped;

    uint256 private locked = 1;

    // ----------------------------------------------------------------- events

    event Deposited(uint64 indexed id, address indexed user, address indexed token, uint256 amount);
    event Withdrawn(bytes32 indexed id, address indexed user, address indexed token, uint256 amount);
    event StateCommitted(uint64 indexed index, bytes32 root, uint64 lastDepositId);
    event Frozen(uint256 at);
    event Escaped(address indexed user, address indexed token, uint256 amount);

    // ----------------------------------------------------------------- errors

    error NotOperator();
    error IsFrozen();
    error NotFrozen();
    error UnknownToken();
    error ZeroAmount();
    error Expired();
    error AlreadyUsed();
    error BadSignature();
    error BadStateIndex();
    error TooEarly();
    error BadProof();
    error NotDepositor();
    error TransferFailed();
    error Reentrancy();
    error BadConfig();

    /// Shortest allowed silence before anyone may freeze (stops instant-freeze griefing).
    uint256 public constant MIN_FREEZE_DELAY = 1 hours;

    modifier nonReentrant() {
        _enter();
        _;
        _exit();
    }

    function _exit() private {
        locked = 1;
    }

    function _enter() private {
        if (locked != 1) revert Reentrancy();
        locked = 2;
    }

    constructor(address operator_, uint256 freezeDelay_, address[] memory tokens) {
        // A zero operator could never sign or commit; a tiny delay would let anyone freeze at once.
        if (operator_ == address(0) || freezeDelay_ < MIN_FREEZE_DELAY || tokens.length == 0) revert BadConfig();
        operator = operator_;
        freezeDelay = freezeDelay_;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i].code.length == 0) revert BadConfig(); // tokens must be contracts
            isToken[tokens[i]] = true;
        }
        lastCommitAt = block.timestamp;
        DOMAIN_SEPARATOR_ = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ExchangeVault"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return DOMAIN_SEPARATOR_;
    }

    // --------------------------------------------------------------- deposits

    /// @notice Deposits `amount` of `token` for the caller. The credited amount is
    ///         what the vault actually received (safe with fee-on-transfer tokens).
    function deposit(address token, uint256 amount) external nonReentrant returns (uint64 id) {
        if (frozen) revert IsFrozen();
        if (!isToken[token]) revert UnknownToken();
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        id = ++depositCount;
        deposits[id] = DepositRecord({user: msg.sender, token: token, amount: received});
        emit Deposited(id, msg.sender, token, received);
    }

    // ------------------------------------------------------------ withdrawals

    function hashWithdrawal(Withdrawal calldata w) public view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(WITHDRAWAL_TYPEHASH, w.id, w.user, w.token, w.amount, w.afterState, w.expiry));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR_, structHash));
    }

    /// @notice Executes an operator-signed withdrawal. Anyone may submit it.
    function withdraw(Withdrawal calldata w, bytes calldata signature) external nonReentrant {
        if (frozen) revert IsFrozen();
        if (block.timestamp > w.expiry) revert Expired();
        if (withdrawalUsed[w.id]) revert AlreadyUsed();
        if (!isToken[w.token]) revert UnknownToken();
        if (w.amount == 0) revert ZeroAmount();
        // At most one snapshot ahead of the latest committed root (see ADR-0014).
        if (w.afterState > stateIndex + 1) revert BadStateIndex();
        if (_recover(hashWithdrawal(w), signature) != operator) revert BadSignature();
        withdrawalUsed[w.id] = true;
        withdrawnAt[w.user][w.token][w.afterState] += w.amount;
        _safeTransfer(w.token, w.user, w.amount);
        emit Withdrawn(w.id, w.user, w.token, w.amount);
    }

    // ---------------------------------------------------- state commitments

    function commitState(uint64 index, bytes32 root, uint64 lastDepositId) external {
        if (msg.sender != operator) revert NotOperator();
        if (frozen) revert IsFrozen();
        if (index != stateIndex + 1) revert BadStateIndex();
        if (lastDepositId < stateLastDepositId || lastDepositId > depositCount) revert BadStateIndex();
        stateIndex = index;
        stateRoot = root;
        stateLastDepositId = lastDepositId;
        lastCommitAt = block.timestamp;
        emit StateCommitted(index, root, lastDepositId);
    }

    // ------------------------------------------------------------ escape hatch

    /// @notice Anyone can freeze the vault once the operator has been silent too long.
    function freeze() external {
        if (frozen) revert IsFrozen();
        if (block.timestamp <= lastCommitAt + freezeDelay) revert TooEarly();
        frozen = true;
        emit Frozen(block.timestamp);
    }

    /// @notice Leaf of the balance tree: double-hashed to rule out second-preimage tricks.
    function leaf(address user, address token, uint256 balance) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(user, token, balance))));
    }

    /// @notice After a freeze: claim the committed balance (Merkle proof), minus
    ///         withdrawals signed against the latest or the next snapshot.
    function escape(address token, uint256 balance, bytes32[] calldata proof) external nonReentrant {
        if (!frozen) revert NotFrozen();
        if (escaped[msg.sender][token]) revert AlreadyUsed();
        if (!_verify(proof, stateRoot, leaf(msg.sender, token, balance))) revert BadProof();
        escaped[msg.sender][token] = true;
        uint256 spent = withdrawnAt[msg.sender][token][stateIndex] + withdrawnAt[msg.sender][token][stateIndex + 1];
        uint256 payout = balance > spent ? balance - spent : 0;
        if (payout > 0) _safeTransfer(token, msg.sender, payout);
        emit Escaped(msg.sender, token, payout);
    }

    /// @notice After a freeze: reclaim a deposit made after the latest commitment.
    function escapeDeposit(uint64 depositId) external nonReentrant {
        if (!frozen) revert NotFrozen();
        if (depositId <= stateLastDepositId || depositId > depositCount) revert BadStateIndex();
        if (depositEscaped[depositId]) revert AlreadyUsed();
        DepositRecord memory d = deposits[depositId];
        if (d.user != msg.sender) revert NotDepositor();
        depositEscaped[depositId] = true;
        _safeTransfer(d.token, d.user, d.amount);
        emit Escaped(d.user, d.token, d.amount);
    }

    // --------------------------------------------------------------- helpers

    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 node) private pure returns (bool) {
        bytes32 h = node;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encode(h, p)) : keccak256(abi.encode(p, h));
        }
        return h == root;
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
