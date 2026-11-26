# TesterArmy/e2e 测试工程

平台使用本包内锁定版本的 e2e CLI 和 Web Engine，以单浏览器、单工作进程串行执行。模型和目标环境由 API 执行器按运行模式传入。用例脚本位于 `tests/generated/`，运行证据由平台归档到 `storage/artifacts/`。

工作台中发起运行会绑定用例版本和环境，并记录缓存命中和模型调用。排查运行器可使用下面的命令。

```powershell
pnpm --filter e2e-project exec e2e doctor
pnpm --filter e2e-project exec e2e guide running
pnpm --filter e2e-project exec e2e list
```

pnpm 安装时会为工作区部署 e2e Agent Skill。需要在编码助手中临时查看用法时，也可运行 `pnpm --filter e2e-project exec e2e guide`。

