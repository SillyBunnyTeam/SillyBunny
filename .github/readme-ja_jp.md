<div>
<img src="screenshots/banner.jpg" width="100%">
</div>

<div align="center">

[English](readme.md) | [Deutsch](readme-de_de.md) | [中文](readme-zh_cn.md) | [繁體中文](readme-zh_tw.md) | 日本語 | [Русский](readme-ru_ru.md) | [한국어](readme-ko_kr.md)

</div>

<div align="center">

**最新リリース：v1.7.0。** [変更履歴は Releases でご確認ください。](https://github.com/SillyBunnyTeam/SillyBunny/releases)

</div>

---

## 目次
* [概要](#概要)
    * [ショーケース](#ショーケース)
        * [デスクトップ](#デスクトップ)
        * [モバイル](#モバイル)
* [インストール](#インストール)
    * [Staging ブランチ](#staging-ブランチ)
    * [macOS に関する注意](#macos-に関する注意)
    * [Termux（Android）に関する注意](#termuxandroidに関する注意)
    * [更新方法](#更新方法)
* [プロジェクトの目標（このフォークを作った理由）](#プロジェクトの目標このフォークを作った理由)
* [変更点と機能](#変更点と機能)
* [アップストリーム情報](#アップストリーム情報)
* [コントリビューター](#コントリビューター)
***

## 概要

SillyBunny は [SillyTavern](https://github.com/SillyTavern/SillyTavern) の洗練されたフォークです。[GNOME project](https://www.gnome.org/) と [KDE Plasma](https://kde.org/plasma-desktop/) に着想を得た、デスクトップとモバイルの両方に対応するすっきりとしたグラフィカルシェル UI を備えています。SillyBunny には、パフォーマンス向上のための Bun ベースのランタイム、組み込みのチュートリアル・ガイド・おすすめ拡張機能へすぐにアクセスできる Home ページ、現代的なエージェント機能を実現する軽量なチャット内エージェントシステム、キャラクターカードの活用範囲を広げる追加チャットモード、そして多数のバグ修正と全般的な改善が含まれています。

> [!WARNING]
> 私たちは 3 人の小さなチームです。SillyTavern の優れたバックエンドを活用しながら、私たちがこれまで SillyTavern に望んできた機能をすべて備える、シンプルで効果的なフロントエンドを作ることに情熱を注いでいます。
>
> そのため、これは開発中のフォークであり、現時点ではベータ品質と見なされています。[SillyBunny 固有の問題は、このプロジェクトの Issue Tracker へお寄せください。](https://github.com/SillyBunnyTeam/SillyBunny/issues) アップストリームの SillyTavern でも再現する問題は、そちらへ報告してください。
>
> 開示事項：このフォークの開発では LLM を大いに活用しており、それなしでは実現できませんでした。ただし、プログラムとソフトウェア全体の設計、プロンプト作成、テスト、ドキュメント作成は、すべて人間が担当しています。アップストリーム互換性とプロジェクトの範囲には厳格な基準を設けています。

<details>
<summary><h2>ショーケース</h2></summary>

以下のスクリーンショットでは、デスクトップとモバイルにおける Workspace、Customize、Agents、Characters、Search、Conversation モード、チャット内の Bunny Guide ビューをご覧いただけます。

#### デスクトップ

| デスクトップの Workspace メニュー | デスクトップの Customize メニュー |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-navigate-v1.7.0.png" alt="デスクトップの Workspace メニュー" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-customize-v1.7.0.png" alt="デスクトップの Customize メニュー" width="100%"> |

| デスクトップの Agents メニュー | デスクトップの Characters メニュー |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-agents-v1.7.0.png" alt="デスクトップの Agents メニュー" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-characters-v1.7.0.png" alt="デスクトップの Characters メニュー" width="100%"> |

| デスクトップの Search | デスクトップのチャット |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-search-v1.7.0.png" alt="デスクトップの Search" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-in-chat-v1.7.0.png" alt="デスクトップの Bunny Guide チャット" width="100%"> |

| デスクトップの Conversation モード |
| :---: |
| <img src="screenshots/sillybunny-ui-desktop-conversation-v1.7.0.png" alt="デスクトップの Conversation モード" width="100%"> |

#### モバイル

| モバイルの Workspace メニュー | モバイルの Customize メニュー | モバイルの Agents メニュー |
| :---: | :---: | :---: |
| <img src="screenshots/sillybunny-ui-mobile-navigate-v1.7.0.png" alt="モバイルの Workspace メニュー" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-customize-v1.7.0.png" alt="モバイルの Customize メニュー" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-agents-v1.7.0.png" alt="モバイルの Agents メニュー" width="100%"> |

| モバイルの Characters メニュー | モバイルの Search | モバイルのチャット |
| :---: | :---: | :---: |
| <img src="screenshots/sillybunny-ui-mobile-characters-v1.7.0.png" alt="モバイルの Characters メニュー" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-search-v1.7.0.png" alt="モバイルの Search" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-in-chat-v1.7.0.png" alt="モバイルの Bunny Guide チャット" width="100%"> |

| モバイルの Conversation モード |
| :---: |
| <img src="screenshots/sillybunny-ui-mobile-conversation-v1.7.0.png" alt="モバイルの Conversation モード" width="100%"> |

</details>

---

## インストール

[最新リリースはこちらから入手できます。](https://github.com/SillyBunnyTeam/SillyBunny/releases/latest)

または、次を実行します。

```bash
git clone https://github.com/SillyBunnyTeam/SillyBunny.git
cd SillyBunny
```

続いて、お使いの OS に合ったランチャーを実行してください。ランチャーはすべての依存関係を自動的にインストールし、更新を確認して、サーバーインスタンスを起動します。ブラウザーで `http://127.0.0.1:4444` を手動で開くこともできます。デフォルトのランチャーは推奨ランタイムを自動的に選択します。Node.js または Bun を指定したい場合は、ランタイム固有のランチャーを使用してください。

| プラットフォーム | デフォルト／自動 | Node.js を指定 | Bun を指定 |
|----------|----------------|---------------|-----------|
| Windows | `.\Start.bat` | `.\Start-Node.bat` | `.\Start-Bun.bat` |
| macOS（Terminal） | `./Start.command` | `./Start-Node.command` | `./Start-Bun.command` |
| macOS（Finder） | `Start.command` をダブルクリック | `Start-Node.command` をダブルクリック | `Start-Bun.command` をダブルクリック |
| Linux / WSL | `./start.sh` | `./start-node.sh` | `./start-bun.sh` |
| Android（Termux） | `bash start.sh` | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |
| Docker | `docker compose --project-directory . -f docker/docker-compose.yml up --build` | 該当なし | 該当なし |

Bun のインストールを自分で管理している場合は、`bun run start` で実行してください。その他の起動方法は次のとおりです。

```bash
bun run start:mobile   # 省メモリ（--smol）
bun run start:global   # SillyBunny が管理するデータパス
bun run start:no-csrf  # CSRF を無効化（ローカル開発用）
```

`bun run` ではなく、pm2、systemd、Docker、Termux などを介して起動する場合は、`SILLYBUNNY_BUN_SMOL=1` を設定すると `start:mobile` と同じ省メモリモードになります。

```bash
SILLYBUNNY_BUN_SMOL=1 ./start.sh
```

Docker では、`docker/docker-compose.yml` の `environment:` に設定してください。

`--smol` は Bun のフラグなので、Node.js モードでは何も行いません。

Termux、macOS、ARM ホストでは、Bun との互換性上の問題により、デフォルトで Node.js を使用します。Bun と `--smol` を併用するには `./start-bun.sh`（Termux では `bash start-termux-bun.sh`）を使用してください。Node.js が選択されている状態でこのフラグが設定されていると、ランチャーが警告を表示します。

### Staging ブランチ

`staging` ブランチは `main` ブランチより頻繁に更新され、本番環境への投入準備がまだ整っていない作業が含まれる場合があります。安定性が低く、破壊的変更を含む可能性もあるため、自己責任で使用してください。

既存の Git チェックアウトでは、次を実行します。

```bash
git fetch origin staging
git switch --track origin/staging
```

ローカルに `staging` ブランチがすでにある場合は、代わりに `git switch staging` を実行してください。`staging` ブランチにアップストリームが設定されていれば、ランチャーで自動更新できますが、作業ツリーがクリーンである必要があります。

### macOS に関する注意

- ランチャーのウィンドウがすぐ閉じてしまう場合は、出力が見えるよう Terminal から `./Start.command` を実行してください
- Finder から起動する場合は `Start*.command` ファイルをダブルクリックしてください（Gatekeeper の警告が出た場合は右クリックして「開く」を選択）
- Git が見つからない場合、ランチャーは `xcode-select --install` を自動的に実行します
- ZIP ダウンロードに付加された隔離属性を削除するには、`xattr -dr com.apple.quarantine /path/to/SillyBunny` を実行します
- 展開時に実行権限が失われた場合は、`chmod +x Start*.command start*.sh scripts/*.sh` を実行します

### Termux（Android）に関する注意

```bash
pkg update && pkg upgrade -y
pkg install -y git curl unzip
git clone https://github.com/SillyBunnyTeam/SillyBunny.git
cd SillyBunny
bash start-termux-node.sh
```

- ネイティブ Termux と ARM デバイスでは、Node.js が利用可能な場合、`bash start.sh` はデフォルトで Node.js + npm を使用します
- Node.js を明示的に指定する場合：`bash start-termux-node.sh`
- Bun を明示的に指定する場合：`bash start-termux-bun.sh`（初回実行時に glibc をインストールし、`bun-termux` を自動的にセットアップします）
- リポジトリは `~/storage/shared` や `/storage/emulated/0` ではなく、Termux のホーム内（例：`~/SillyBunny`）に置いてください。Android の共有ストレージでは、Bun と npm が必要とする `node_modules` のリンクがブロックされます
- SillyBunny に共有ファイルへのアクセスを許可するため、`termux-setup-storage` は一度だけ実行してください。共有ストレージ内にリポジトリをクローンしないでください

Termux 上の Bun は glibc 経由で動作し、ランチャーが `glibc-repo` と `glibc-runner` を使用してインストールします。`start-termux-bun.sh` でこれらのパッケージが利用できないと表示された場合は、`pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner` を実行して根本的なエラーを確認してください。glibc が `$PREFIX/glibc` 以外にある場合は、`GLIBC_ROOT` を設定してください。Node.js にはこれらが一切不要なため、`bash start-termux-node.sh` は常に代替手段として利用できます。

### 更新方法

Git チェックアウトは、ランチャーまたは SillyBunny 自体から更新できます。ZIP／リリースフォルダーではランチャーによる自動更新は使用されませんが、Customize > Server にあるリリース ZIP アップデーターから更新できます。

| 目的 | コマンド |
|---------------|---------|
| 実行中のアプリから更新する（Git または ZIP インストール） | Customize > Server を開き、組み込みアップデーターを使用 |
| 通常起動（更新を自動確認） | `./start.sh` |
| 強制更新してから起動 | `./start.sh --self-update` |
| 更新のみ行い、起動しない | `./start.sh --self-update-only` |
| 今回だけ更新確認をスキップ | `./start.sh --skip-self-update` |
| 自動更新を永続的に無効化 | `SILLYBUNNY_AUTO_UPDATE=0 ./start.sh` |

---

## プロジェクトの目標（このフォークを作った理由）

SillyBunny は、次の主要な目標に基づいて開発されています。

1. **デフォルトではシンプルに、必要なときには強力に。** SillyBunny は、デフォルトで理解しやすく直感的に使えるよう設計されており、複雑な設定のほとんどはデフォルトの Workspace で非表示になっています。厳選したヒューマンインターフェースガイドライン（HIG）に沿った実用的なデフォルト設定により、メインのチャットウィンドウに集中できます。追加の複雑な機能や設定は標準表示から隠されています。必要になるまで邪魔をせず、必要なときにアクセスできるグラフィカルシェルは、この考え方を最もよく体現しています。
2. **ロールプレイとストーリーテリングを重視。** SillyBunny は、アップストリームの SillyTavern よりも明確な目的を持っています。私たちの目標はモデルを活用した創作分野と密接に結び付いており、フォーク全体の方向性もその用途を中心に据えています。LLM を使った創作を楽しく始められるよう、チュートリアル、プリセット、拡張機能、キャラクターカードをあらかじめ同梱しています。
3. **機能のモダナイズ。** 現代的なモデルが持つ強力なエージェント能力を活かせる、新しく興味深い機能を継続的に実装することを目指しています。これには、小さなタスクを通じてメイン生成を補完する、チャット内の pre、sidecar、post エージェントの完全なサポートが含まれます。キャラクターカードとの対話に使える追加のチャットモードも実装しています。さらに、プロンプト関連のバグ修正や新しいモデルへの対応も行っています。
4. **パフォーマンスの向上。** SillyBunny はランタイムに Bun を使用しています。一般に Node.js より高いパフォーマンスと短い起動時間を実現し、現代的なデバイスに対してより最適化され、電力効率にも優れています。予備手段と互換性を確保するため、Node.js も引き続きサポートしています。
5. **アップストリームとの互換性。** SillyTavern の堅牢なバックエンドを活用し、アップストリームとの後方互換性を可能な限り維持するよう努めています。これにより、アップストリームから簡単に移行できます。また、最先端のフロンティアモデルだけでなく、あらゆる規模のモデルで新機能を利用できるようにすることも目指しています。

## 変更点と機能

### グラフィカルシェル

ユーザーインターフェースには、デスクトップとモバイル向けに設計された、独自の操作しやすいグラフィカルシェルを採用しています。

- **トップバー**：プログラムの各機能へいつでもすばやくアクセスできる常設のトップバーです。メニュー項目として Workspace、Customize、Home、Characters に分かれ、クイックアクションのショートカットも備えています。
    - **Workspace**：モデルの設定に必要な項目へ一か所からすばやくアクセスできます。
    - **Customize**：ユーザーインターフェースと SillyBunny のバックエンドをカスタマイズできます。
    - **Agents**：エージェントへアクセスするためのクイックアクセス用ショートカットです。カスタマイズできます。
    - **グローバル検索**：プリセット、ロア、拡張機能、ペルソナ、設定を横断して一度に検索できる、クイックアクセス用のグローバル検索バーです。カスタマイズできます。
    - **Home**：さまざまな場所、SillyBunny のドキュメント、おすすめの拡張機能へすばやくアクセスするためのスタートページです。
    - **Characters**：キャラクターカードとの対話、インポート、作成、編集に使用します。

- **ボトムバー**：汎用のユーザー入力欄として機能する常設のボトムバーです。ペルソナの切り替え、チャットの切り替え、検索、Guided Generations などのチャット操作へすばやくアクセスできるよう設計されています。

- **階層型ナビゲーション**：トップバーからすべての設定へ簡単にアクセスでき、各項目は複数のサブタブに分かれています。すべてが明確な階層で整理されているため、クリックやタップの回数を減らし、メニューを探し回る時間を最小限に抑えられます。
- **プラットフォーム対応**：デスクトップとモバイルの双方に対応するよう設計され、スマートフォン／タブレット専用のナビゲーションレイヤーを備えています。
- **柔軟性**：テーマと拡張機能を完全にサポートし、CSS やパレットの差し替えなどによって、シェルとユーザー入力欄を簡単に変更できます。

### 同梱コンテンツとチュートリアル

SillyBunny には、創作をすぐに始められるよう、いくつかの追加コンテンツが標準で同梱されています。

- SillyBunny の詳細なチュートリアルと、LLM ロールプレイを始めるための総合ガイド。
- ユーザーインターフェースのガイド。
- Guided Generations、Input History、Quick Image Gen、Prompt Inspector、Pathfinder の各拡張機能に対する組み込みサポート。
- アプリ内から簡単にインストールできる、よく使われる拡張機能を厳選した追加リポジトリ。Dialogue Colors、Summary Sharder、強化版マクロなどが含まれます。
- purachina と Geechan によるロールプレイ／物語執筆用 Chat Completion プリセット 2 種類、Geechan による複数の Text Completion プリセットとチャットルームプリセット 1 種類、TheLonelyDevil によるカード変換プリセット。
- さらに質問があるときに役立つ 2 枚のアシスタントカード、Bunny Guide と Assistant Nahida。
- その他にも多数あります。

### パフォーマンス改善

対応するクライアントの大部分では、SillyBunny は Node.js の代わりに Bun で起動します。これにより、起動時間、全般的なパフォーマンス、バッテリー駆動時間を大幅に改善できる場合があります。Bun を適切にサポートしていないクライアント向けには Node.js にも対応しており、全般的な改善は引き続き適用されます。

### チャット内エージェント

SillyBunny は、現代的なモデルが持つ強力なエージェント能力を念頭に設計された、エージェント型ワークフローを完全にサポートしています。このシステムはキャラクターカードと直接連携し、ニーズや好みに合わせて全面的にカスタマイズできます。エージェントとは、メインモデルによる生成と並行して別のモデルへ割り振られる追加タスクであり、さまざまな方法で最終出力を補強または変更するものと考えてください。

標準で、さまざまな目的に対応する多数のエージェントテンプレートを用意しています。トラッカー、選択肢マーカー、ランダマイザー、コンテンツ変更ツール、文章推敲ツールなどが含まれます。このシステムはユーザーが独自のエージェントを作成できるようにも設計されており、実際にその作成を強くおすすめしています。

エージェントは、生成プロセスのさまざまな段階へ接続できます。

**パイプライン：**

1. **生成前エージェント：** メインモデルがプロンプトを読み込む前にコンテンツを生成します。メインプリセットやシステムプロンプトに手を加えることなく、特定のルール、条件、トラッカーを設定するのに役立ちます。
2. **メイン生成：** モデルがシステムプロンプトの内容を参照しながら、メインの応答を生成します。
3. **Sidecar エージェント：** メイン生成の後に独立して付加されるため、メイン生成とは別のコメントや補足を追加できます。
4. **生成後エージェント：** 完全に生成されたメイン出力を変更します。生成コンテンツに二度目の処理を加えられるため、問題の修正、文章の推敲、出力方針の変更に非常に役立ちます。

### チャットモード

**Roleplay**

キャラクターカードやモデルと直接やり取りできる標準の体験です。LLM フロントエンドを使ったことがあれば、親しみやすく自然に感じられるはずです。ボトムバーから、直近で選択したチャットを変更したり移動したりするためのコントロールへ簡単にアクセスできます。

**Conversation**

Conversation モードでは、キャラクターと会話するときの UI がインターネットのメッセージングクライアント風に変わります。これに適したシステムプロンプトとユーザーインターフェースに加え、時間に基づくスケジューリング、ステータス、フォローアップメッセージ、メモリ管理、画像生成サポートなども備えています。標準の Roleplay モードよりカジュアルな体験としてお楽しみください。

---

## アップストリーム情報

SillyBunny は SillyTavern のフォークです。SillyTavern の挙動、データ形式、エコシステムに関する知識の大部分はそのまま適用でき、アップストリームとの互換性も可能な限り維持されています。SillyBunny 固有の問題はこちらへ、SillyTavern に関連する問題はアップストリームへ報告してください。

| リソース | リンク |
|----------|------|
| アップストリームのリポジトリ | [SillyTavern/SillyTavern](https://github.com/SillyTavern/SillyTavern) |
| アップストリームのドキュメント | [docs.sillytavern.app](https://docs.sillytavern.app/) |
| アップストリームの Discord | [discord.gg/sillytavern](https://discord.gg/sillytavern) |
| アップストリームの Subreddit | [r/SillyTavernAI](https://reddit.com/r/SillyTavernAI) |

何かおかしいと感じた場合は、まずアップストリームの `release` ブランチと比較してください。

## コントリビューター

- [Platberlitz](https://github.com/platberlitz)
- [Geechan](https://github.com/Geechan)
- [TheLonelyDevil9](https://github.com/TheLonelyDevil9)

[AGPL-3.0 に基づく自由ソフトウェアとしてライセンスされています。](https://www.gnu.org/licenses/agpl-3.0.en.html)
