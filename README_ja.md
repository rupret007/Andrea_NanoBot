# Andrea_NanoBot 日本語サマリー

Andrea_NanoBot は、NanoClaw の分離ランタイムを土台にした Andrea の実運用向けアシスタントです。

## 現在の要点

- Telegram が標準の会話フロントドアです
- `/cursor` は主要なオペレーター向けワークフローです
- Codex/OpenAI ランタイムは統合済みですが、`/runtime-*` は補助的な明示コマンドです
- Alexa は **Companion Mode** として強化され、日次ガイダンス、短い会話継続、家族文脈、同意ベースのパーソナライズに対応しています
- Alexa のホスト検証はサポート対象の Node `22.x`（`>=22 <23`）を使用してください。リポジトリ、CI、コンテナの再現性検証は `22.22.2` に固定されています

## Alexa の現状

- リポジトリ側の検証は強い状態です
- live 証明は期限切れになるため、現在の状態は `npm run services:status` で確認してください。完全な live 受け入れには、実際の Alexa アプリ / 端末 / 認証済みシミュレーターからの新しい署名付き発話が必要です

## まず読むドキュメント

- 英語の全体 README: [README.md](README.md)
- ユーザー向け: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- 管理者向け: [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)
- セットアップ: [docs/SETUP_AND_FEATURES_GUIDE.md](docs/SETUP_AND_FEATURES_GUIDE.md)
- Alexa: [docs/ALEXA_VOICE_INTEGRATION.md](docs/ALEXA_VOICE_INTEGRATION.md)

詳細は英語 README を正本として参照してください。
