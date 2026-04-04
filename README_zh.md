# Andrea_NanoBot 中文摘要

Andrea_NanoBot 是基于 NanoClaw 隔离运行时构建的 Andrea 实用型助手仓库。

## 当前重点

- Telegram 是默认的对话入口
- `/cursor` 是主要的运营和任务控制界面
- Codex/OpenAI 运行时已经整合进来，但 `/runtime-*` 仍然是补充性的显式控制命令
- Alexa 已升级为 **Companion Mode**，支持日常指导、短时会话连续性、家庭语境，以及显式同意的个性化
- Alexa 的真实验证应使用 Node `22.22.2`

## Alexa 当前状态

- 仓库侧和 near-live 验证已经很强
- 若要宣称完全 live，需要再完成一次来自真实 Alexa App / 设备 / 已认证模拟器的签名语音请求

## 建议先读

- 英文完整说明: [README.md](README.md)
- 用户指南: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- 管理员指南: [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)
- 安装与功能: [docs/SETUP_AND_FEATURES_GUIDE.md](docs/SETUP_AND_FEATURES_GUIDE.md)
- Alexa 集成: [docs/ALEXA_VOICE_INTEGRATION.md](docs/ALEXA_VOICE_INTEGRATION.md)

完整且最新的细节以英文 README 为准。
