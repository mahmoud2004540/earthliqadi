// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title TestPriceFeed — LOCAL/TEST CHAINS ONLY. Not a real price.
/// @notice Implements the read side of Chainlink's AggregatorV3Interface so the
/// exchange's oracle index source can be exercised in tests. On public testnets
/// and mainnet the index uses real Chainlink feeds instead. Only the deployer
/// can post answers.
contract TestPriceFeed {
    address public immutable owner;
    uint8 public immutable decimals;
    string public description;

    uint80 private round;
    int256 private answer;
    uint256 private updatedAt;

    error NotOwner();

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    constructor(uint8 decimals_, string memory description_) {
        owner = msg.sender;
        decimals = decimals_;
        description = description_;
    }

    function setAnswer(int256 value) external {
        if (msg.sender != owner) revert NotOwner();
        round += 1;
        answer = value;
        updatedAt = block.timestamp;
        emit AnswerUpdated(value, round, block.timestamp);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 value, uint256 startedAt, uint256 updated, uint80 answeredInRound)
    {
        return (round, answer, updatedAt, updatedAt, round);
    }
}
