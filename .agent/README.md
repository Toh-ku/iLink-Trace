# Agent Context Index

`.agent/` 保存面向自动化编码 Agent 的执行上下文。这里不是产品文档，也不能代替根目录 `AGENTS.md`。

## 必读顺序

1. [`../AGENTS.md`](../AGENTS.md)：全仓库规则和完成定义。
2. [`../docs/technical-design.zh-CN.md`](../docs/technical-design.zh-CN.md)：产品、架构和技术选型的事实来源。
3. [`implementation-plan.md`](implementation-plan.md)：当前阶段、任务顺序和阶段出口。
4. [`architecture-guardrails.md`](architecture-guardrails.md)：不可破坏的运行时与安全边界。
5. [`verification.md`](verification.md)：按变更类型选择验证命令和测试场景。

## 文档优先级

当信息冲突时，优先级如下：

```text
用户当前明确要求
  > AGENTS.md 中的安全和仓库规则
  > 已接受的 ADR
  > docs/technical-design.zh-CN.md
  > .agent/implementation-plan.md
  > 局部代码注释
```

如果当前用户要求会改变安全边界、公开协议或既有技术栈，应先把影响写清楚，并通过 ADR 记录最终决定。

## 维护方式

- 阶段推进时更新 `implementation-plan.md` 的 Current Phase。
- 新增架构例外时，在 `docs/adr/` 添加 ADR，并同步 guardrails。
- 新增根脚本、测试层或支持平台时，同步 `verification.md` 和 CI。
- 不要把临时对话、个人路径、token 或真实流量样本写入 `.agent/`。

