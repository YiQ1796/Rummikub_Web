# 猴三毛拉密 Rummikub — V0.1.0 單機 AI 測試版

獨立 GitHub Pages 網頁遊戲，不屬於猴三毛遊戲中心程式庫。

- 2–4 人座位：1 位真人，其他由 AI 補足
- 完全無回合倒數計時
- 106 張牌，含 2 張 Joker；首次破冰 30 分
- 支援合法群組、順組、桌面重組、撤銷、抽牌、結算與本機進度保存
- 數字牌使用 CSS + 文字佔位；後續只替換兩張猴三毛頭像 Joker

**限制：尚未支援多位真人即時連線、完整 Joker 交換和手機拖曳功能。** 請勿將本版本誤認成正式多人對戰版。

原始碼規劃：`src/` 為規則及對局，`assets/` 為 CSS 及美術設定，`tests/` 為測試，`.github/workflows/pages.yml` 由 GitHub Actions 部署。

部署目標：https://yiq1796.github.io/Rummikub_Web/
