# Polytrack 戰略審計報告

> 角色：資深產品技術顧問
> 範圍：戰略 / 商業邏輯（跳過實作細節）
> 日期：2026-04-25
> 對應 commit：`f954605`
> 審計階段：2（邏輯謬誤）+ 3（核心價值）+ 7（尖銳問題）

---

## ⚡ 執行摘要

**這個項目實際上是什麼？**

一個**個人自用的 Polymarket 跟單 bot**，包了一層讓人誤以為是 SaaS / 開源工具的殼。核心戰略邏輯（「3+ ELITE 共識自動下單」）在當下版本**根本不會觸發**，但團隊已經迭代了 3 個 PR 在優化「auto-import 候選池」這個不在主軸上的支線。

**最危險的盲點**

1. README 第 38 行說「跟 ELITE 共識下單」→ 實際 `1 個 ELITE wallet`、`minWallets: 3`、永遠不會觸發。**核心戰略目前等於關機**。
2. `V1 Gate` 在 dashboard 顯示「累積 30 天才能 live」，但**程式碼沒有任何位置 enforce 這個 gate**——任何人 `state.autoEnabled = true` + 設 `PRIVATE_KEY` 立刻就能下單。Gate 是觀感，不是 guard。
3. 整個 `trading.js` + `clob-auth.js` + `risk.js`（總計 ~700 行 + 測試）在從未 live 過的狀態下迭代了 5+ PR。**真正的 bug 必須等到 live 才會出現**，目前所有「修 bug」都是修書本上的 bug。

**真實價值主張 vs 表面價值主張**

| 表面（README） | 真實（程式碼） |
|---|---|
| Auto-copy trading bot | 個人 leaderboard observability tool + 訊號 dashboard |
| 「3+ ELITE 共識下單」 | 至今 0 真實下單；ELITE = 1 |
| 解決 CORS + 自動跟單兩個問題 | 真正在解決：「我自己想知道 Polymarket 上誰在賺錢」 |

**三個必須回答的問題**（詳見階段 7）

1. 你**真的要靠這個賺錢**，還是這是一個 dressed-up 的副業 portfolio？
2. 如果 V1 Gate 30 天到了發現「看起來厲害的 wallet 跟單下去其實虧」，你已經沉沒成本太深會收手嗎？
3. 為什麼你寧可加 4 個策略，也不肯把 1 個策略做到能上線實測？

---

## 🚨 階段二：邏輯謬誤與內部矛盾

### P0-1 ｜核心戰略目前等於關機（信心度：高）

**證據**

`src/strategies/consensus.js:12-22`：
```js
defaults() {
  return {
    enabled: true,
    minWallets: 3,        // 至少 3 個 ELITE 才觸發
    ...
  };
}
```

`src/signals.js:43-45`：
```js
const elites = wallets.filter(w => w.tier === "ELITE");
if (elites.length === 0) return this.getActiveSignals();
```

`/health` 即時回傳：`"eliteCount":1`。

**問題**

README 第 38 行（也是首頁第一個價值主張）寫「**fires when 3+ ELITE wallets align**」，然後預設 `minWallets: 3`，目前 ELITE wallet 數量 = 1。**這個策略此刻不可能觸發**，往後幾週也不會——因為 ELITE 的 tier gate（`scoring.js:288`）要求 `score>70 + closedPositions≥20 + totalPnL>500 + ROI>2%`，能爬上來的速度受限於 auto-import 找到符合條件的人 + 各 wallet 累積 closed position 數量。

**這不是 bug，是戰略上的死結**：

- 把門檻 `minWallets: 3 → 2` 又會把訊號意義稀釋（2 個人的「共識」幾乎是雜訊）
- 把 ELITE 門檻放鬆 → 跟錯人虧更多
- 兩條都不動 → 你**主推的價值主張在你 V1 累積期內完全提供不了任何價值**

**修復建議**

承認「consensus 是 30 天後的功能」，現在主軸應該收斂到 1 個能立刻產生訊號的策略（比如「single-ELITE big bet」——某個 ELITE wallet 突然進了 >$10k 倉位就跟）。或者反向思考：dashboard 主功能改定位為「monitoring」，把 auto-trade 從 v2 主推降級到 v3 規劃。

**嚴重度：P0**

---

### P0-2 ｜V1 Gate 是觀感不是 guard（信心度：高）

**證據**

`src/db.js:565`：
```js
v1ReadyPct: Math.min(100, Math.round((daysCovered / 30) * 100)),
```

搜遍 `src/`，**沒有任何位置在 trade execution 路徑上引用 `daysCovered` / `v1ReadyPct` / `v1Ready`**：

```bash
$ grep -rn "daysCovered|v1ReadyPct|v1Ready" /src --include="*.js" \
    | grep -v "db.js|datacapture.js"
# (空)
```

`src/server.js:387` 是**唯一的 gate**：
```js
if (state.autoEnabled) {            // ← 唯一的 gate
  for (const sig of signals) {
    ...
    const trade = await executeCopyTrade(sig, { privateKey: PRIVATE_KEY, ... });
```

**問題**

「V1 Gate 30 天累積到 100% → 才能 live trading」一直被當作系統的安全機制。**它不是。它是一個 dashboard 上的進度條**。任何人（包括操作者半夜手滑）只要：

1. `.env` 設 `PRIVATE_KEY`
2. UI 點 auto-toggle 或 `POST /auto {enabled:true}`

下一輪 scan 就會用真錢下單，**完全不檢查 daysCovered 是否到 30**。

風險在於：正在養成一個「等 V1 Gate 滿了就放心開」的心智模型，但這個 gate 在系統層面**不存在**。等到某天真的開了，發現還有 sentinel-class bug 殘留，gate 不會擋。

**修復建議**

把「V1 Gate ≥ 100%」做成 `checkRiskLimits()` 的硬性前置條件之一，並且加一個 env override（`I_KNOW_WHAT_IM_DOING_BYPASS_V1_GATE=true`）給操作者自用。dashboard 上的進度條才會跟代碼對齊。

**嚴重度：P0**

---

### P1-1 ｜Wallet 評分有兩個版本，文件說了一套、程式碼跑另一套（信心度：高）

**證據**

`README.md:220`：
```
Score = (WinRate × 40%) + (ROI × 35%) + (TimingScore × 25%)
```

`src/scoring.js:6`：
```
Score = winRate(0.25) + sharpe(0.25) + pnlPercentile(0.25) + timing(0.15) + consistency(0.10)
```

`src/scoring.js:276-282`：
```js
const score = Math.round(
  winRate     * 0.25 +
  sharpeNorm  * 0.25 +
  pnlNorm     * 0.25 +
  timing      * 0.15 +
  consistency * 0.10
);
```

**問題**

README 是「3 個指標、權重 40/35/25」，程式碼是「5 個指標、權重 25/25/25/15/10」。`Sharpe` 和 `Consistency` 在文件裡完全不存在。

更糟的是 `README:225` 寫「WinRate = % of closed positions that exited at price > 0.60」——程式碼 (`scoring.js:84-89`) 是「% of closed positions with positive PnL」。**完全不同的定義**。

這意味著任何依據 README 預期 wallet 行為的人會 confused，包括 6 個月後回來看代碼的自己。

**修復建議**

更新 README scoring section 對齊 scoring.js v2 算法，或反過來把 scoring.js 的算法回退到 README 描述的版本（**不推薦**——v2 算法更合理）。

**嚴重度：P1**

---

### P1-2 ｜跟單訊號完全不看「對方現在還在賺嗎」（信心度：高）

**證據**

`src/signals.js:69-83` —— 訊號生成只看：
```js
const posValue = p.currentValue || p.size || 0;     // 倉位大小
if (posValue < cfg.minPositionSize) continue;
const weight = Math.min(posValue, cfg.sizeCapPerWallet) / ...;
directions[dir].push({
  addr: w.addr,
  score: w.score,
  posValue,
  weight,
  avgPrice: p.avgPrice,                              // 進場價（記了但沒用）
});
```

`src/strategies/consensus.js:30-32` —— 沒有任何地方比對：

- ELITE wallet 的 `avgPrice` vs 當下 `mid_price`（我跟進去是不是已經被拉高了？）
- ELITE wallet 進場後這個倉位**現在賺還是虧**
- ELITE wallet 進場到現在過了多久（是 1 小時前還是 6 天前？）

**問題**

策略邏輯隱含一個假設：「ELITE 看好 → 你就跟」。但跟單最關鍵的問題是「**對方在 0.30 進場我在 0.55 跟，剩餘 upside 還剩多少？**」。當下版本：

- 一個 ELITE 在 0.10 抄底進了某市場
- 市場跑到 0.85
- dashboard 還在顯示「3 個 ELITE 共識做 YES」訊號 → autoEnable 後 0.85 跟進
- 對方在 0.30 早就賣掉跑了，你站在 0.85 山頂

**這個盲點是跟單策略的最大風險**，比 sentinel bug 嚴重多了——sentinel bug 是「假訊號」，這個是「**真訊號但會虧錢**」。

**修復建議**

在 consensus 訊號生成時加 `expectedEdgePct`：
```js
const currentPrice = getCurrentMidPrice(conditionId, dir);
const eliteEntryPrice = weighted_avg(aligned.map(a => a.avgPrice));
const remainingEdge = (1 - currentPrice) * (currentPrice / eliteEntryPrice - 1);
if (remainingEdge < MIN_REMAINING_EDGE) continue;   // 已經跑太遠，不跟
```

**嚴重度：P1**

---

### P1-3 ｜Auto-import 用無時間衰減的 PnL（信心度：中）

**證據**

`src/leaderboard-poller.js:144-152`：
```js
export function walletPassesFilter(wallet, { minPnl, minRoi }) {
  const pnl = Number(wallet?.totalPnL || 0);
  const volume = Number(wallet?.volume || 0);
  if (pnl < minPnl) return { pass: false, ... };
  ...
  const roi = pnl / volume;
  if (roi < minRoi) return { pass: false, ... };
  return { pass: true, roi };
}
```

`scoring.js:312-313`（這是給 wallet.totalPnL 餵料的）：
```js
totalPnL:    Math.round(totalPnL * 100) / 100,   // 累計 PnL，沒有時間衰減
totalVolume: Math.round(totalVolume * 100) / 100,
```

`scoring.js:187-196` 有 `applyRecencyWeight()` 但**沒有任何呼叫者**：

```bash
$ grep -rn "applyRecencyWeight" src/
src/scoring.js:187:export function applyRecencyWeight(trades, halfLifeDays = 30) {
# (沒有其他引用)
```

**問題**

Auto-import 拿總體 PnL > $100k 篩 wallet，**全程沒有時間衰減**。某個 wallet 可能：

- 2024 年靠選舉行情大賺 $500k
- 2026 年連虧 9 個月 → 還是過 filter（總 PnL 還剩 $200k）
- 7 天 rejection cache 到期後再被「重新評估」、結果又通過

V1 30 天累積期結束後看到的 ELITE wallet，**很可能是一年前的英雄、現在是廢人**。`applyRecencyWeight` 函數寫了但從沒接到 scoring pipeline——典型的 dead code，還誤導讀者以為有處理時效性。

**修復建議**

把 `applyRecencyWeight` 接到 `scoreWallet()` 的 `trades` 入口；或在 `walletPassesFilter` 加一個「近 90 天 PnL」的二次條件。

**嚴重度：P1**

---

### P2-1 ｜版本號至少有三套，互相不一致（信心度：高）

**證據**

| 來源 | 版本 |
|---|---|
| `package.json` | `"version": "2.0.0"` |
| Dashboard footer | `v2.1.0 · 14 wallets` |
| Schema migrations | V1 → V11 |
| 「V1 累積期」 | 不是上述任何一個 |
| README `## 🗺 Roadmap` | 沒有版本概念 |

**問題**

「V1」這個詞在心智模型裡是「累積資料的第一階段」，但代碼裡 V1 也是「migration 編號 1」、又是「CLOB V1（trading.js:5 的註解 V1 vs V2）」。三個 V1 是三件事，沒有命名空間隔離。團隊變大或 onboarding 新人時這是地雷。

**修復建議**

把「累積期」的命名換成 `Phase 1` 或 `Bootstrap`、或具體 `30-day-warmup`。

**嚴重度：P2**

---

### P2-2 ｜Auto-trade 風險上限是 env 寫死、不是 config 動態（信心度：高）

**證據**

`src/risk.js:14-17`：
```js
const DAILY_LOSS_LIMIT   = Number(process.env.MAX_DAILY_LOSS_USDC       || 200);
const MARKET_EXPOSURE    = Number(process.env.MAX_MARKET_EXPOSURE_USDC  || 300);
const TOTAL_EXPOSURE     = Number(process.env.MAX_TOTAL_EXPOSURE_USDC   || 1000);
const MARKET_COOLDOWN_MS = Number(process.env.MARKET_COOLDOWN_MIN || 30) * 60_000;
```

`src/config.js:18-22` 同時定義了 config 版的：
```js
maxDailyLossUsdc: 200,
maxMarketExposureUsdc: 300,
maxTotalExposureUsdc: 1000,
marketCooldownMin: 30,
```

**問題**

risk.js 的限制**讀的是 env**（部署時固定），但 config.js 暴露了同名欄位讓 UI 改——**改了沒用**。UI 上調 `maxDailyLossUsdc: 200 → 50`，risk.js 還是用 200。

這違反「Source of truth」原則（CLAUDE.md A.8）。要嘛 UI 不要顯示，要嘛 risk.js 改讀 config。

**嚴重度：P2**

---

### 階段二小結

| ID | 問題 | 嚴重度 |
|---|---|---|
| P0-1 | Consensus 戰略當下不會觸發（README 主推 vs 現實） | P0 |
| P0-2 | V1 Gate 是進度條不是 guard | P0 |
| P1-1 | Scoring 文件 vs 程式碼不一致 | P1 |
| P1-2 | 訊號不看「對方現在賺不賺」 | P1 |
| P1-3 | Auto-import 用無時間衰減的 PnL | P1 |
| P2-1 | 版本命名混亂 | P2 |
| P2-2 | risk.js env vs config 雙來源 | P2 |

---

## 💎 階段三：核心價值釐清

### 奶奶測試

**「對非技術人解釋這項目存在的理由，一句話」**

- ❌ 想說的：「我做了一個能自動跟單 Polymarket 高手的機器人。」
- ✅ 程式碼證據說的：「我做了一個能在我自己房間裡看 Polymarket 上誰在賺錢的儀表板。」

差別在於 **agency**：bot 是「機器自己賺錢」，dashboard 是「我看了之後我手動賺錢」。前者風險自擔（你信機器），後者風險自擔（你信自己）。**目前實際做的是後者，但行銷自己是前者**。

### 替代品測試

**使用者不用 Polytrack 的話會用什麼？**

| 替代品 | 痛點 | Polytrack 真的解決了嗎？ |
|---|---|---|
| **Polymarket 官網 Leaderboard** | 只看 top 20，沒個人化、沒 alert | ✅ Polytrack 有 active-trader 撈 ~550 人 + auto-import |
| **PolymarketAnalytics.com / similar** | 公開可見，沒 trade exec | 🟡 你做了 trade exec，但沒人實測過 |
| **Discord「神單」群組（人類訊號）** | 延遲、雜訊、沒系統化 | 🟡 你的 ELITE 評分是嘗試系統化，但 30 天才能用 |
| **手動盯盤 + 自己下單** | 需要時間、會睡著 | ✅ Polytrack 有 60s cron，省人力 |

**Polytrack 真正的差異化**：

1. **撈到 leaderboard 上看不到的活躍交易者**（active-trader 源 + rejection cache + soft-delete）—— **這個是真本事，沒人在做**
2. **自動執行**（trading.js + EIP-712 + risk gates）—— **未驗證 vapor**
3. **共識訊號**（consensus）—— **設計上有意義，現實中觸發不了**

**剩下哪一半使用者離不開？砍掉 trade exec、砍掉 momentum/meanrev/arbitrage**——剩「wallet observability + auto-import + soft-delete」**仍然是會用的東西**。這就是真正的 MVP。

### 可證偽性

**有什麼數據能證明價值主張？**

| 主張 | 可證偽方式 | 目前有沒有？ |
|---|---|---|
| 「ELITE wallet 真的比較賺」 | 對比 ELITE 訊號 vs 對照組（隨機 wallet 訊號）的 30 天命中率 | ❌ Backtest 模組有，從沒跑過完整對比 |
| 「跟單能賺錢」 | 至少 N 筆真實成交 + 結算 PnL > 0 | ❌ 0 trades executed，simulation 也沒驗證 |
| 「auto-import 找的 wallet 比 leaderboard 更好」 | 對比新加入 wallet vs leaderboard top 20 的 30 天 ROI | ❌ 沒有對照組設計 |

**結論**：**目前 0 個價值主張被證偽過、也沒有驗證過**。整個項目站在「它聽起來很合理」上面。

### 表面價值 vs 真實價值的和解建議

**和解版的定位**：

> 「Polymarket 上 leaderboard 只有 20 名、且不告訴你 wallet 過去的 PnL 全貌。Polytrack 是個自架的 wallet observability tool——它從活躍市場撈出 top 5% 交易者、建檔、用我們的指標排名，並把訊號透過 dashboard + Discord webhook 送到你眼前。**自動下單功能是 V3 才上的高級選項**，主要使用者是把 Polytrack 當成 alert system，自己看訊號自己決定。」

這句話**和你的程式碼對齊**、且不需要立刻證明任何「賺錢」主張就能站得住。

---

## 🔥 階段七：三個尖銳的問題

### 問題 1：你**真的要靠這個賺錢**，還是這是 dressed-up 的副業 portfolio？

**為什麼問**：你的工程行為和「靠這個賺錢」**不一致**。

- 真心要賺錢的人會：先在 simulation 跑一週、看哪些訊號有 +EV、收斂到 1 個策略、用 $50 開 live、每天記 PnL
- 你做的是：4 個策略並行 + 多用戶系統 + invite token + 多套版本演進敘事 + Backtest UI

**只有兩種人會做你做的事**：

1. 為 SaaS 上線做準備的人（但你沒在賣）
2. **把 portfolio code 包裝成 product** 的工程師

如果是 #2，沒問題——但**請承認**。承認後你應該砍掉「自動下單」整條路、把精力放在「能寫進履歷的特色」（演算法、scaling、UI）。如果是 #1，你應該明天就 `MAX_TRADE_USDC=10` 跑真實。

我看到的證據傾向 **#2**，但希望你打臉我。

---

### 問題 2：如果 V1 Gate 30 天滿了發現「跟 ELITE 下單其實虧」，你會收手嗎？

**為什麼問**：你已經對「30 天累積期」做了重大心理承諾。整個 dashboard 主視覺就是那個進度條。

- 樂觀劇本：30 天到、3 個 ELITE 出現、跟單第一個月 +15% → 你成功
- 真實劇本機率分布：
  - 跟單 ROI < market beta（跟 polymarket index 比沒打贏）：~50%
  - 跟單 ROI 高但 max drawdown > 30%：~20%
  - 跟單 ROI > index：~25%
  - 系統 bug 導致虧損：~5%

**前兩個劇本佔 70%。你會收手嗎？**

我猜你不會——你會說「再給它 30 天」、「換 minWallets: 2」、「再多 import 一些」。這是**沉沒成本陷阱經典案例**。建議：在 V1 Gate 滿之前，**現在**就把「停損條件」寫死：

- 連續 4 週跟單 PnL < 0 → 自動關閉 auto-trade
- 跟單組合 max drawdown > 25% → 自動關閉
- ELITE wallet 數量在 30 天到 90 天之間沒從 1 漲到 5 → 戰略無效，砍掉 consensus

寫成 `state.bootstrapKillSwitch`，**部署當下就 enable**。

---

### 問題 3：為什麼你寧可加 4 個策略，也不肯把 1 個策略做到能上線實測？

**為什麼問**：

`src/strategies/` 有 4 個策略，每一個都：

- 有 defaults
- 有 detect() 函數
- 有測試（共 16 個 test）

**但實際在用的是 0 個**——因為從沒 live 過任何一筆。consensus 因為 ELITE=1 不觸發，momentum/meanrev/arbitrage 預設 disabled，arbitrage 開了發現有 sentinel bug 又改名…

工程上「廣度 vs 深度」的選擇明顯偏廣度。為什麼？

**可能解釋**：

- (a) 你還不確定哪個策略會贏、所以全押 → 但你也沒在 backtest 對比哪個贏
- (b) 寫策略比實測有趣 → 工程師 default 行為
- (c) 「我們框架可以擴展」是給自己/別人看的 → 表演性工程

**真正能賺錢的對手**早就在做：

- 1 個策略
- 跑 1 個月真實小額
- 看 Sharpe > 0.5 才擴大、否則砍掉

**建議**：選 1 個（推薦：consensus，門檻先降到 `minWallets: 2` + 加「current-vs-entry edge」過濾，PR P1-2）、$50 live 跑 4 週、用 Sharpe / Calmar 評分。**砍掉其他 3 個策略到 archive 分支**。砍代碼比加代碼更難——這是一個能力測試。

---

## 📌 結語

這份報告不是要否定 Polytrack。**Wallet observability + auto-import 的工程品質很好**——尤其是過去 5 個 PR（leaderboard 20 cap 突破、active-trader 源、rejection cache、sentinel filter）展現了在生產系統上做縝密 root-cause analysis 的能力。

但**戰略層面有個無法迴避的不一致**：項目在做 A，但口徑在賣 B。這個落差會在三個地方顯化：

1. **30 天 V1 累積期到了**——consensus 觸發不了、auto-trade 沒驗證、會陷入 sunk cost 困境
2. **想找投資人/合作者**——demo 不出「跟單能賺錢」，價值主張站不住
3. **6 個月後回來看代碼**——版本命名混亂、scoring 雙版本、dead code（applyRecencyWeight）會讓自己困惑

**最重要的下一步**：先回答階段七那三個問題給自己聽。回答清楚之後，項目該收斂的方向自然會浮現。
