# 给 hello.py 添加斐波那契函数 Spec

## Why
用户希望在 hello.py 中增加一个斐波那契（Fibonacci）计算函数，以便演示基本的算法实现和函数调用。

## What Changes
- 在 `hello.py` 中新增一个 `fibonacci(n)` 函数，返回第 n 个斐波那契数（从 0 开始：0, 1, 1, 2, 3, 5...）。
- 在 `if __name__ == "__main__":` 块中增加对 `fibonacci` 函数的调用示例并打印结果。

## Impact
- 受影响文件：`hello.py`
- 无其他系统或配置变更

## ADDED Requirements
### Requirement: 新增斐波那契函数
The system SHALL 在 `hello.py` 中提供一个 `fibonacci(n)` 函数，用于计算第 n 个斐波那契数。

#### Scenario: 正常输入
- **WHEN** 调用 `fibonacci(10)`
- **THEN** 返回 `55`

#### Scenario: 边界输入
- **WHEN** 调用 `fibonacci(0)`
- **THEN** 返回 `0`
- **WHEN** 调用 `fibonacci(1)`
- **THEN** 返回 `1`

## MODIFIED Requirements
无

## REMOVED Requirements
无
