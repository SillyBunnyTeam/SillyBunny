<div>
<img src="screenshots/banner.jpg" width="100%">
</div>

<div align="center">

[English](readme.md) | [Deutsch](readme-de_de.md) | [中文](readme-zh_cn.md) | 繁體中文 | [日本語](readme-ja_jp.md) | [Русский](readme-ru_ru.md) | [한국어](readme-ko_kr.md)

</div>

<div align="center">

**最新版本：v1.7.0。** [請至 Releases 查看更新日誌。](https://github.com/SillyBunnyTeam/SillyBunny/releases)

</div>

---

## 目錄
* [關於](#關於)
    * [展示](#展示)
        * [桌面版](#桌面版)
        * [行動版](#行動版)
* [安裝](#安裝)
    * [Staging 分支](#staging-分支)
    * [macOS 注意事項](#macos-注意事項)
    * [Termux（Android）注意事項](#termuxandroid注意事項)
    * [如何更新](#如何更新)
* [專案目標（也就是我們建立這個分支的原因）](#專案目標也就是我們建立這個分支的原因)
* [變更與功能](#變更與功能)
* [上游資訊](#上游資訊)
* [貢獻者](#貢獻者)
***

## 關於

SillyBunny 是 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 風格優雅的分支，受到 [GNOME 專案](https://www.gnome.org/)與 [KDE Plasma](https://kde.org/plasma-desktop/) 啟發，為桌面與行動裝置設計了簡潔的圖形化外殼介面。SillyBunny 採用 Bun 執行環境以提升效能；提供可快速前往各項功能的 Home 頁面，並內建教學、指南與推薦擴充功能；搭載輕量的聊天內代理系統，以支援現代化的代理功能；加入額外的聊天模式，擴充角色卡的互動方式；此外還包含大量錯誤修正與整體改進！

> [!WARNING]
> 我們是一支由三人組成的小型團隊，致力於打造簡潔且實用的前端，納入我們一直希望在 SillyTavern 中看到的各項功能，同時善用其出色的後端成果。
>
> 因此，這仍是開發中的分支，目前視為 Beta 品質。[SillyBunny 特有的問題請回報至本專案的問題追蹤系統。](https://github.com/SillyBunnyTeam/SillyBunny/issues) 若問題也能在上游 SillyTavern 重現，請改向上游回報。
>
> 公開聲明：我們在此分支的開發過程中大量運用 LLM，若沒有這些工具，專案便無法實現。不過，整體程式與軟體設計、提示詞設計、測試及文件皆完全由人類負責。我們對上游相容性與專案範圍採取嚴格標準。

<details>
<summary><h2>展示</h2></summary>

以下螢幕截圖展示圖形化外殼介面在桌面與行動裝置上的 Workspace、Customize、Agents、Characters、搜尋、Conversation 模式，以及聊天內 Bunny Guide 畫面。

#### 桌面版

| 桌面版 Workspace 選單 | 桌面版 Customize 選單 |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-navigate-v1.7.0.png" alt="桌面版 Workspace 選單" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-customize-v1.7.0.png" alt="桌面版 Customize 選單" width="100%"> |

| 桌面版 Agents 選單 | 桌面版 Characters 選單 |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-agents-v1.7.0.png" alt="桌面版 Agents 選單" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-characters-v1.7.0.png" alt="桌面版 Characters 選單" width="100%"> |

| 桌面版搜尋 | 桌面版聊天 |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-search-v1.7.0.png" alt="桌面版搜尋" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-in-chat-v1.7.0.png" alt="桌面版 Bunny Guide 聊天" width="100%"> |

| 桌面版 Conversation 模式 |
| :---: |
| <img src="screenshots/sillybunny-ui-desktop-conversation-v1.7.0.png" alt="桌面版 Conversation 模式" width="100%"> |

#### 行動版

| 行動版 Workspace 選單 | 行動版 Customize 選單 | 行動版 Agents 選單 |
| :---: | :---: | :---: |
| <img src="screenshots/sillybunny-ui-mobile-navigate-v1.7.0.png" alt="行動版 Workspace 選單" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-customize-v1.7.0.png" alt="行動版 Customize 選單" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-agents-v1.7.0.png" alt="行動版 Agents 選單" width="100%"> |

| 行動版 Characters 選單 | 行動版搜尋 | 行動版聊天 |
| :---: | :---: | :---: |
| <img src="screenshots/sillybunny-ui-mobile-characters-v1.7.0.png" alt="行動版 Characters 選單" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-search-v1.7.0.png" alt="行動版搜尋" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-in-chat-v1.7.0.png" alt="行動版 Bunny Guide 聊天" width="100%"> |

| 行動版 Conversation 模式 |
| :---: |
| <img src="screenshots/sillybunny-ui-mobile-conversation-v1.7.0.png" alt="行動版 Conversation 模式" width="100%"> |

</details>

---

## 安裝

[在此取得最新版本。](https://github.com/SillyBunnyTeam/SillyBunny/releases/latest)

或者執行：

```bash
git clone https://github.com/SillyBunnyTeam/SillyBunny.git
cd SillyBunny
```

接著，執行適用於您作業系統的啟動器；它會自動安裝所有相依套件、檢查更新並啟動伺服器執行個體。您也可以在瀏覽器中手動開啟 `http://127.0.0.1:4444`。預設啟動器會自動選擇建議的執行環境；若要強制使用 Node.js 或 Bun，請改用指定執行環境的啟動器。

| 平台 | 預設／自動 | 強制使用 Node.js | 強制使用 Bun |
|----------|----------------|---------------|-----------|
| Windows | `.\Start.bat` | `.\Start-Node.bat` | `.\Start-Bun.bat` |
| macOS（終端機） | `./Start.command` | `./Start-Node.command` | `./Start-Bun.command` |
| macOS（Finder） | 按兩下 `Start.command` | 按兩下 `Start-Node.command` | 按兩下 `Start-Bun.command` |
| Linux / WSL | `./start.sh` | `./start-node.sh` | `./start-bun.sh` |
| Android（Termux） | `bash start.sh` | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |
| Docker | `docker compose --project-directory . -f docker/docker-compose.yml up --build` | 不適用 | 不適用 |

若您自行管理 Bun 安裝，請執行 `bun run start`。其他啟動方式如下：

```bash
bun run start:mobile   # 較低記憶體用量（--smol）
bun run start:global   # 使用 SillyBunny 管理的資料路徑
bun run start:no-csrf  # 停用 CSRF（本機開發）
```

若您是透過腳本而非 `bun run` 啟動，例如 pm2、systemd、Docker 或 Termux，請設定 `SILLYBUNNY_BUN_SMOL=1`，即可使用與 `start:mobile` 相同的低記憶體模式：

```bash
SILLYBUNNY_BUN_SMOL=1 ./start.sh
```

使用 Docker 時，請將其設於 `docker/docker-compose.yml` 的 `environment:` 下。

`--smol` 是 Bun 的旗標，因此在 Node.js 模式下不會產生任何作用。

由於 Bun 的相容性問題，Termux、macOS 與 ARM 主機預設使用 Node.js。使用 `./start-bun.sh`（Termux：`bash start-termux-bun.sh`）即可搭配 `--smol` 使用 Bun。若選用 Node.js 時仍設定了該旗標，啟動器會發出警告。

### Staging 分支

`staging` 分支的更新頻率高於 `main` 分支，其中包含可能尚未準備好投入正式環境的工作。它的穩定性可能較低，也可能包含破壞性變更，請自行承擔使用風險。

若已有 Git checkout，請執行：

```bash
git fetch origin staging
git switch --track origin/staging
```

若本機已有 `staging` 分支，請改為執行 `git switch staging`。設定好上游後，啟動器可以自動更新 `staging` 分支，但工作目錄仍須保持乾淨。

### macOS 注意事項

- 若啟動器視窗關閉得太快，請從終端機執行 `./Start.command`，讓輸出內容保持可見
- 從 Finder 啟動：按兩下 `Start*.command` 檔案（若 Gatekeeper 發出警告，請按右鍵 >「打開」）
- 若缺少 Git，啟動器會自動觸發 `xcode-select --install`
- 移除 ZIP 下載檔的隔離中繼資料：`xattr -dr com.apple.quarantine /path/to/SillyBunny`
- 若解壓縮時執行權限遭移除：`chmod +x Start*.command start*.sh scripts/*.sh`

### Termux（Android）注意事項

```bash
pkg update && pkg upgrade -y
pkg install -y git curl unzip
git clone https://github.com/SillyBunnyTeam/SillyBunny.git
cd SillyBunny
bash start-termux-node.sh
```

- 在原生 Termux 與 ARM 裝置上，若 Node.js 可用，`bash start.sh` 預設會使用 Node.js + npm
- 明確強制使用 Node.js：`bash start-termux-node.sh`
- 明確強制使用 Bun：`bash start-termux-bun.sh`（首次執行時會自動安裝 glibc 並完成 `bun-termux` 的引導設定）
- 請將儲存庫放在 Termux 主目錄內（例如 `~/SillyBunny`），不要放在 `~/storage/shared` 或 `/storage/emulated/0`；Android 共用儲存空間會封鎖 Bun 與 npm 所需的 `node_modules` 連結
- `termux-setup-storage` 只需執行一次，以授予 SillyBunny 存取共用檔案的權限；請勿將儲存庫複製到共用儲存空間

Termux 上的 Bun 透過 glibc 執行，啟動器會經由 `glibc-repo` 與 `glibc-runner` 安裝 glibc。若 `start-termux-bun.sh` 回報無法取得這些套件，請執行 `pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner` 以查看底層錯誤。若您的 glibc 不在 `$PREFIX/glibc`，請設定 `GLIBC_ROOT`。Node.js 不需要上述任何項目，因此 `bash start-termux-node.sh` 永遠可作為備用方案。

### 如何更新

Git checkout 可以透過啟動器或 SillyBunny 本身更新。ZIP／發行版資料夾不會使用啟動器自動更新，但可以透過 Customize > Server 下的發行版 ZIP 更新程式進行更新。

| 您要執行的操作 | 指令 |
|---------------|---------|
| 從執行中的應用程式更新（Git 或 ZIP 安裝） | 開啟 Customize > Server，使用內建更新程式 |
| 一般啟動（自動檢查更新） | `./start.sh` |
| 強制更新後啟動 | `./start.sh --self-update` |
| 僅更新，不啟動 | `./start.sh --self-update-only` |
| 略過一次更新檢查 | `./start.sh --skip-self-update` |
| 永久停用自動更新 | `SILLYBUNNY_AUTO_UPDATE=0 ./start.sh` |

---

## 專案目標（也就是我們建立這個分支的原因）

我們開發 SillyBunny 時，心中有幾項主要目標：

1. **預設簡單，需要時則功能強大。** SillyBunny 的預設設計易於理解且直覺好用，大部分複雜設定均隱藏於預設工作區之外。我們依循精心挑選的人機介面指南（HIG）實作合理的預設值，讓您能專注於主要聊天視窗。額外的複雜功能與設定不會出現在預設畫面中。圖形化外殼最能體現這套理念：平時不打擾您，直到您需要存取某項功能為止。
2. **專注於角色扮演與故事創作。** 相較於上游 SillyTavern，SillyBunny 的用途定位更加明確。我們的目標與使用模型進行創意寫作的社群高度契合，這個分支的整體方向也以此使用情境為核心。我們預先內建教學、預設集、擴充功能與角色卡，讓您能以有趣的方式開始使用 LLM 進行創意寫作。
3. **現代化功能。** 我們致力於持續實作新穎有趣的功能，善用現代模型強大的代理能力。這包括完整支援聊天內的前置、伴隨與後置代理，透過較小的任務輔助主要生成。我們也實作額外的聊天模式，讓您能以不同方式與角色卡互動，並同步修正提示詞錯誤及支援新模型。
4. **更佳效能。** SillyBunny 使用 Bun 作為執行環境；與 Node.js 相比，Bun 通常效能更佳、啟動更快，也針對現代裝置提供更好的最佳化與能源效率。我們仍支援 Node.js，以確保備援與相容性。
5. **上游相容性。** 我們盡可能維持與上游 SillyTavern 的向後相容性，並運用其穩固的後端成果，讓使用者能輕鬆從上游轉換及移轉。此外，我們也致力讓所有新功能支援各種規模的模型，而非僅限最前沿的頂尖模型。

## 變更與功能

### 圖形化外殼

使用者介面採用專為桌面與行動裝置設計、易於瀏覽的自訂圖形化外殼：

- **頂端列**：常駐的頂端列，讓您隨時快速存取程式功能。其選單分為 Workspace、Customize、Home 與 Characters，並附有快速操作捷徑。
    - **Workspace**：用於在單一位置快速存取設定模型所需的全部設定。
    - **Customize**：用於自訂使用者介面與 SillyBunny 後端。
    - **Agents**：用於存取代理的快速捷徑，可自訂。
    - **全域搜尋**：快速存取的全域搜尋列，可一次查詢預設集、世界書、擴充功能、角色身分與設定。可自訂。
    - **Home**：作為起始頁面的入口，可快速前往各個位置、SillyBunny 文件及推薦擴充功能。
    - **Characters**：用於與角色卡互動，以及匯入、建立或修改角色卡。

- **底部列**：作為一般使用者輸入欄位的常駐底部列，專為快速存取聊天控制項而設計，包括切換角色身分、切換聊天、搜尋、引導式生成等功能！

- **分層導覽**：可從頂端列輕鬆存取所有設定，並分為不同子分頁。所有內容皆按層次清楚劃分，減少點擊／輕觸次數，並將翻找選單的時間降到最低。
- **平台感知設計**：同時針對桌面與行動裝置設計，並提供專用的手機／平板導覽層。
- **高度可塑性**：外殼與使用者輸入欄位皆可透過 CSS、調換調色盤等方式輕鬆修改，並完整支援佈景主題與擴充功能。

### 內建實用內容與教學

SillyBunny 預設內建一些額外內容，協助您立即開始創意寫作：

- 詳盡的 SillyBunny 教學，以及開始使用 LLM 進行角色扮演的通用指南。
- 使用者介面指南。
- 內建支援 Guided Generations、Input History、Quick Image Gen、Prompt Inspector 與 Pathfinder 擴充功能。
- 額外提供精選的常用擴充功能儲存庫，可直接在應用程式內輕鬆安裝，例如 Dialogue Colors、Summary Sharder 與增強型巨集。
- 兩組由 purachina 與 Geechan 製作的角色扮演／故事寫作 Chat Completion 預設集、多組由 Geechan 製作的 Text Completion 預設集、一組由 Geechan 製作的聊天室預設集，以及一組由 TheLonelyDevil 製作的角色卡轉換預設集。
- 兩張可協助您進一步詢問問題的助理卡：Bunny Guide 與 Assistant Nahida。
- 以及更多內容！

### 效能改進

對大多數受支援的用戶端而言，SillyBunny 會以 Bun 而非 Node.js 啟動，可顯著改善啟動時間、整體效能與電池續航力。對於無法妥善支援 Bun 的用戶端，我們也支援 Node.js，且整體改進仍然適用。

### 聊天內代理

SillyBunny 完整支援代理工作流程，其設計著眼於現代模型強大的代理能力。此系統直接與您的角色卡連動，並可依照需求與偏好全面自訂。您可以將代理視為交由其他模型處理、與主要模型生成同步執行的額外任務；它們能以各種方式強化或修改最終輸出。

我們預設提供許多用途不同的代理範本，包括追蹤器、選項標記器、隨機化工具、內容修改器與文句潤飾工具。此系統也允許使用者自行製作代理；事實上，我們非常鼓勵您這麼做！

代理可以串接至生成流程的不同階段：

**流程：**

1. **生成前代理：** 在主要模型讀取提示詞之前生成內容。這類代理適合設定特定規則、條件或追蹤項目，且不必修改主要預設集或系統提示詞。
2. **主要生成：** 模型以系統提示詞的內容作為參考，生成主要回覆。
3. **伴隨代理：** 在主要生成完成後附加在主要生成內容旁，可提供獨立於主要生成內容之外的額外評論或旁註。
4. **生成後代理：** 在主要輸出完整生成後加以修改。您可以藉此對生成內容進行第二輪處理，特別適合修正問題、潤飾文句或改變輸出方向。

### 聊天模式

**Roleplay**

這是預設體驗，讓您能直接與角色卡及模型互動。若您曾使用任何 LLM 前端，應該會覺得熟悉且容易上手。此模式可透過底部列輕鬆存取控制項，以修改或瀏覽最近選取的聊天。

**Conversation**

Conversation 模式會模擬網路即時通訊用戶端，改變您與角色對話時的使用者介面。此模式同時搭配合適的系統提示詞與使用者介面，具備依時間排程、狀態、後續訊息、記憶管理、圖片生成支援等功能！相較於預設的 Roleplay 模式，您可以將它視為更輕鬆隨性的體驗。

---

## 上游資訊

SillyBunny 是 SillyTavern 的分支。SillyTavern 絕大多數的行為、資料格式與生態系知識仍然適用，我們也會盡可能維持上游相容性。SillyBunny 特有的問題請在此回報，與 SillyTavern 相關的問題則請向上游回報。

| 資源 | 連結 |
|----------|------|
| 上游儲存庫 | [SillyTavern/SillyTavern](https://github.com/SillyTavern/SillyTavern) |
| 上游文件 | [docs.sillytavern.app](https://docs.sillytavern.app/) |
| 上游 Discord | [discord.gg/sillytavern](https://discord.gg/sillytavern) |
| 上游 Subreddit | [r/SillyTavernAI](https://reddit.com/r/SillyTavernAI) |

若有任何異常，請先與上游的 `release` 分支比較。

## 貢獻者

- [Platberlitz](https://github.com/platberlitz)
- [Geechan](https://github.com/Geechan)
- [TheLonelyDevil9](https://github.com/TheLonelyDevil9)

[本專案依 AGPL-3.0 授權，為自由軟體。](https://www.gnu.org/licenses/agpl-3.0.en.html)
