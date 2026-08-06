<div>
<img src="screenshots/banner.jpg" width="100%">
</div>

<div align="center">

[English](readme.md) | [Deutsch](readme-de_de.md) | [中文](readme-zh_cn.md) | [繁體中文](readme-zh_tw.md) | [日本語](readme-ja_jp.md) | [Русский](readme-ru_ru.md) | 한국어

</div>

<div align="center">

**최신 릴리스: v1.7.0.** [변경 기록은 Releases에서 확인하세요.](https://github.com/SillyBunnyTeam/SillyBunny/releases)

</div>

---

## 목차
* [소개](#소개)
    * [둘러보기](#둘러보기)
        * [데스크톱](#데스크톱)
        * [모바일](#모바일)
* [설치](#설치)
    * [스테이징 브랜치](#스테이징-브랜치)
    * [macOS 참고 사항](#macos-참고-사항)
    * [Termux (Android) 참고 사항](#termux-android-참고-사항)
    * [업데이트 방법](#업데이트-방법)
* [프로젝트 목표 (이 포크를 만든 이유)](#프로젝트-목표-이-포크를-만든-이유)
* [변경 사항과 기능](#변경-사항과-기능)
* [업스트림 정보](#업스트림-정보)
* [기여자](#기여자)
***

## 소개

SillyBunny는 [SillyTavern](https://github.com/SillyTavern/SillyTavern)을 기반으로 한 세련된 포크입니다. [GNOME 프로젝트](https://www.gnome.org/)와 [KDE Plasma](https://kde.org/plasma-desktop/)에서 영감을 얻어 데스크톱과 모바일 모두에 깔끔한 그래픽 셸 UI를 제공합니다. 성능 향상을 위한 Bun 기반 런타임, 튜토리얼·가이드·추천 확장 기능을 갖춘 빠른 접근용 Home 페이지, 최신 에이전트 기능을 지원하는 가벼운 채팅 내 에이전트 시스템, 캐릭터 카드 활용 범위를 넓혀 주는 추가 채팅 모드, 그리고 수많은 버그 수정과 전반적인 개선 사항을 담았습니다!

> [!WARNING]
> 저희는 SillyTavern의 뛰어난 백엔드를 활용하면서, 그동안 SillyTavern에서 늘 보고 싶었던 모든 기능을 갖춘 단순하고 효율적인 프런트엔드를 만들고자 열정을 쏟는 3명의 소규모 팀입니다.
>
> 따라서 이 포크는 현재 개발 중이며 베타 품질로 간주됩니다. [SillyBunny에만 해당하는 문제는 이 프로젝트의 이슈 트래커에 알려 주세요.](https://github.com/SillyBunnyTeam/SillyBunny/issues) 업스트림 SillyTavern에서도 재현되는 문제라면 업스트림에 보고해 주세요.
>
> 공개 고지: 이 포크의 개발에는 LLM을 적극적으로 활용하며, LLM 없이는 이 프로젝트를 실현하기 어려웠을 것입니다. 다만 프로그램과 소프트웨어의 전반적인 설계, 프롬프팅, 테스트, 문서화는 모두 사람이 직접 담당합니다. 저희는 업스트림 호환성과 프로젝트 범위를 엄격한 기준으로 관리합니다.

<details>
<summary><h2>둘러보기</h2></summary>

다음 스크린샷은 데스크톱과 모바일의 Workspace, Customize, Agents, Characters, Search, Conversation 모드와 채팅 내 Bunny Guide 화면을 보여 줍니다.

#### 데스크톱

| 데스크톱 Workspace 메뉴 | 데스크톱 Customize 메뉴 |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-navigate-v1.7.0.png" alt="데스크톱 Workspace 메뉴" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-customize-v1.7.0.png" alt="데스크톱 Customize 메뉴" width="100%"> |

| 데스크톱 Agents 메뉴 | 데스크톱 Characters 메뉴 |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-agents-v1.7.0.png" alt="데스크톱 Agents 메뉴" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-characters-v1.7.0.png" alt="데스크톱 Characters 메뉴" width="100%"> |

| 데스크톱 Search | 데스크톱 채팅 |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-search-v1.7.0.png" alt="데스크톱 Search" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-in-chat-v1.7.0.png" alt="데스크톱 Bunny Guide 채팅" width="100%"> |

| 데스크톱 Conversation 모드 |
| :---: |
| <img src="screenshots/sillybunny-ui-desktop-conversation-v1.7.0.png" alt="데스크톱 Conversation 모드" width="100%"> |

#### 모바일

| 모바일 Workspace 메뉴 | 모바일 Customize 메뉴 | 모바일 Agents 메뉴 |
| :---: | :---: | :---: |
| <img src="screenshots/sillybunny-ui-mobile-navigate-v1.7.0.png" alt="모바일 Workspace 메뉴" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-customize-v1.7.0.png" alt="모바일 Customize 메뉴" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-agents-v1.7.0.png" alt="모바일 Agents 메뉴" width="100%"> |

| 모바일 Characters 메뉴 | 모바일 Search | 모바일 채팅 |
| :---: | :---: | :---: |
| <img src="screenshots/sillybunny-ui-mobile-characters-v1.7.0.png" alt="모바일 Characters 메뉴" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-search-v1.7.0.png" alt="모바일 Search" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-in-chat-v1.7.0.png" alt="모바일 Bunny Guide 채팅" width="100%"> |

| 모바일 Conversation 모드 |
| :---: |
| <img src="screenshots/sillybunny-ui-mobile-conversation-v1.7.0.png" alt="모바일 Conversation 모드" width="100%"> |

</details>

---

## 설치

[여기에서 최신 릴리스를 받으세요.](https://github.com/SillyBunnyTeam/SillyBunny/releases/latest)

또는 다음 명령어를 실행하세요.

```bash
git clone https://github.com/SillyBunnyTeam/SillyBunny.git
cd SillyBunny
```

그런 다음 운영체제에 맞는 런처를 실행하세요. 런처는 모든 의존성을 자동으로 설치하고 업데이트를 확인한 뒤 서버 인스턴스를 시작합니다. 브라우저에서 `http://127.0.0.1:4444`를 직접 열 수도 있습니다. 기본 런처는 권장 런타임을 자동으로 선택합니다. Node.js 또는 Bun을 강제로 사용하려면 런타임별 런처를 사용하세요.

| 플랫폼 | 기본 / 자동 | Node.js 강제 사용 | Bun 강제 사용 |
|----------|----------------|---------------|-----------|
| Windows | `.\Start.bat` | `.\Start-Node.bat` | `.\Start-Bun.bat` |
| macOS (터미널) | `./Start.command` | `./Start-Node.command` | `./Start-Bun.command` |
| macOS (Finder) | `Start.command` 더블 클릭 | `Start-Node.command` 더블 클릭 | `Start-Bun.command` 더블 클릭 |
| Linux / WSL | `./start.sh` | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start.sh` | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |
| Docker | `docker compose --project-directory . -f docker/docker-compose.yml up --build` | 해당 없음 | 해당 없음 |

Bun 설치를 직접 관리하고 있다면 `bun run start`로 실행하세요. 그 밖의 실행 방식은 다음과 같습니다.

```bash
bun run start:mobile   # 저메모리 모드(--smol)
bun run start:global   # SillyBunny가 관리하는 데이터 경로
bun run start:no-csrf  # CSRF 비활성화(로컬 개발용)
```

pm2, systemd, Docker, Termux처럼 `bun run` 대신 스크립트로 실행하는 경우, `start:mobile`과 동일한 저메모리 모드를 사용하려면 `SILLYBUNNY_BUN_SMOL=1`을 설정하세요.

```bash
SILLYBUNNY_BUN_SMOL=1 ./start.sh
```

Docker에서는 `docker/docker-compose.yml`의 `environment:` 아래에 설정하세요.

`--smol`은 Bun 플래그이므로 Node.js 모드에서는 아무 효과가 없습니다.

Termux, macOS, ARM 호스트는 Bun 호환성 문제로 인해 기본적으로 Node.js에서 실행됩니다. Bun을 `--smol`과 함께 사용하려면 `./start-bun.sh`(Termux: `bash start-termux-bun.sh`)를 사용하세요. Node.js가 선택된 상태에서 이 플래그를 설정하면 런처가 경고를 표시합니다.

### 스테이징 브랜치

`staging` 브랜치는 `main` 브랜치보다 자주 업데이트되며, 아직 프로덕션 환경에 준비되지 않은 작업이 포함될 수 있습니다. 안정성이 떨어지거나 호환성을 깨는 변경 사항이 포함될 수 있으므로 위험을 감수할 수 있을 때만 사용하세요.

기존 Git 체크아웃에서 다음 명령어를 실행하세요.

```bash
git fetch origin staging
git switch --track origin/staging
```

로컬 `staging` 브랜치가 이미 있다면 대신 `git switch staging`을 실행하세요. 업스트림이 구성된 후에는 런처가 스테이징 브랜치를 자동으로 업데이트할 수 있지만, 작업 트리는 여전히 변경 사항이 없는 깨끗한 상태여야 합니다.

### macOS 참고 사항

- 런처 창이 너무 빨리 닫히면 터미널에서 `./Start.command`를 실행하여 출력이 계속 보이게 하세요.
- Finder에서 실행: `Start*.command` 파일을 더블 클릭하세요(Gatekeeper 경고가 표시되면 마우스 오른쪽 버튼 클릭 > 열기).
- Git이 없으면 런처가 `xcode-select --install`을 자동으로 실행합니다.
- ZIP 다운로드에 격리 메타데이터가 설정된 경우: `xattr -dr com.apple.quarantine /path/to/SillyBunny`
- 압축 해제 과정에서 실행 권한이 제거된 경우: `chmod +x Start*.command start*.sh scripts/*.sh`

### Termux (Android) 참고 사항

```bash
pkg update && pkg upgrade -y
pkg install -y git curl unzip
git clone https://github.com/SillyBunnyTeam/SillyBunny.git
cd SillyBunny
bash start-termux-node.sh
```

- 네이티브 Termux와 ARM 기기에서 Node.js를 사용할 수 있으면 `bash start.sh`는 기본적으로 Node.js + npm을 사용합니다.
- Node.js를 명시적으로 강제 사용하려면 `bash start-termux-node.sh`를 실행하세요.
- Bun을 명시적으로 강제 사용하려면 `bash start-termux-bun.sh`를 실행하세요(처음 실행할 때 glibc를 설치하고 `bun-termux`를 자동으로 부트스트랩합니다).
- 저장소는 `~/storage/shared` 또는 `/storage/emulated/0`이 아닌 Termux 홈(예: `~/SillyBunny`)에 두세요. Android 공유 저장소는 Bun과 npm에 필요한 `node_modules` 링크를 차단합니다.
- SillyBunny에 공유 파일 접근 권한을 부여하려면 `termux-setup-storage`를 한 번만 실행하세요. 저장소를 공유 저장소에 클론하면 안 됩니다.

Termux의 Bun은 glibc를 통해 실행되며, 런처가 `glibc-repo`와 `glibc-runner`를 사용해 이를 설치합니다. `start-termux-bun.sh`에서 해당 패키지를 사용할 수 없다고 보고하면 `pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner`를 실행하여 근본적인 오류를 확인하세요. glibc가 `$PREFIX/glibc` 이외의 위치에 있다면 `GLIBC_ROOT`를 설정하세요. Node.js에는 이 과정이 전혀 필요하지 않으므로 `bash start-termux-node.sh`를 언제든 대체 수단으로 사용할 수 있습니다.

### 업데이트 방법

Git 체크아웃은 런처 또는 SillyBunny 자체에서 업데이트할 수 있습니다. ZIP/릴리스 폴더에서는 런처 자동 업데이트를 사용할 수 없지만, Customize > Server의 릴리스 ZIP 업데이터를 통해 업데이트할 수 있습니다.

| 원하는 작업 | 명령어 |
|---------------|---------|
| 실행 중인 앱에서 업데이트(Git 또는 ZIP 설치) | Customize > Server를 열고 내장 업데이터 사용 |
| 일반 실행(업데이트 자동 확인) | `./start.sh` |
| 강제 업데이트 후 실행 | `./start.sh --self-update` |
| 업데이트만 하고 실행하지 않기 | `./start.sh --self-update-only` |
| 업데이트 확인 한 번 건너뛰기 | `./start.sh --skip-self-update` |
| 자동 업데이트 영구 비활성화 | `SILLYBUNNY_AUTO_UPDATE=0 ./start.sh` |

---

## 프로젝트 목표 (이 포크를 만든 이유)

SillyBunny는 다음과 같은 주요 목표를 염두에 두고 개발했습니다.

1. **기본은 단순하게, 필요할 때는 강력하게.** SillyBunny는 기본적으로 이해하기 쉽고 직관적으로 사용할 수 있도록 설계했으며, 복잡한 설정 대부분은 기본 Workspace에서 숨겼습니다. 엄선된 휴먼 인터페이스 가이드라인(HIG)에 따라 합리적인 기본값을 적용하여 기본 채팅 창에 집중할 수 있게 합니다. 추가적인 복잡성과 설정은 기본 화면에서 숨겨집니다. 그래픽 셸은 필요할 때까지 방해하지 않음으로써 이 철학을 가장 잘 구현합니다.
2. **Roleplay와 스토리텔링에 집중.** SillyBunny는 업스트림 SillyTavern보다 더 뚜렷한 목적을 지향합니다. 저희의 목표는 모델을 활용하는 창작 글쓰기 분야와 밀접하게 맞닿아 있으며, 이 포크의 전반적인 방향도 해당 사용 사례에 초점을 맞춥니다. LLM 창작 글쓰기를 재미있게 시작할 수 있도록 튜토리얼, 프리셋, 확장 기능, 캐릭터 카드를 기본으로 제공합니다.
3. **현대화된 기능.** 최신 모델의 강력한 에이전트 기능을 활용할 수 있는 새롭고 흥미로운 기능을 꾸준히 구현하고자 합니다. 여기에는 작은 작업을 수행하여 주 생성을 보완하는 채팅 내 사전, 사이드카, 사후 에이전트의 완전한 지원이 포함됩니다. 캐릭터 카드와 상호작용할 수 있는 추가 채팅 모드도 구현합니다. 이와 함께 프롬프트 버그 수정과 새로운 모델 지원도 제공합니다.
4. **더 나은 성능.** SillyBunny는 Bun을 런타임으로 사용합니다. Bun은 일반적으로 Node.js보다 성능과 시작 속도가 뛰어나며, 최신 기기에서 더 최적화되고 전력 효율적입니다. 대체 수단과 호환성을 위해 Node.js도 계속 지원합니다.
5. **업스트림 호환성.** SillyTavern의 견고한 백엔드를 활용하면서 업스트림과 최대한 하위 호환성을 유지하고자 합니다. 이를 통해 업스트림에서 쉽게 전환하고 마이그레이션할 수 있습니다. 또한 모든 신규 기능이 프런티어급 최첨단 모델뿐만 아니라 모든 규모의 모델과 호환되도록 하는 것을 목표로 합니다.

## 변경 사항과 기능

### 그래픽 셸

사용자 인터페이스는 데스크톱과 모바일을 위해 설계된, 탐색하기 쉬운 맞춤형 그래픽 셸을 제공합니다.

- **상단 표시줄**: 언제든 프로그램 기능에 빠르게 접근할 수 있는 상시 표시줄입니다. Workspace, Customize, Home, Characters 메뉴 옵션과 빠른 작업 바로 가기로 구성됩니다.
    - **Workspace**: 모델 구성에 필요한 모든 설정에 한곳에서 빠르게 접근할 때 사용합니다.
    - **Customize**: 사용자 인터페이스와 SillyBunny 백엔드를 사용자 지정할 때 사용합니다.
    - **Agents**: 에이전트에 접근하기 위한 빠른 접근 바로 가기입니다. 사용자 지정할 수 있습니다.
    - **Global search**: 프리셋, 로어, 확장 기능, 페르소나, 설정을 한 번에 검색하는 빠른 접근용 전역 검색창입니다. 사용자 지정할 수 있습니다.
    - **Home**: 여러 위치, SillyBunny 문서, 추천 확장 기능에 빠르게 접근하는 시작 페이지 런치패드입니다.
    - **Characters**: 캐릭터 카드와 상호작용하거나 카드를 가져오고 생성·수정할 때 사용합니다.

- **하단 표시줄**: 일반 사용자 입력 필드로 작동하는 상시 표시줄이며, 페르소나 전환, 채팅 전환, 검색, Guided Generations 등 채팅 제어 기능에 빠르게 접근하도록 설계되었습니다!

- **계층형 탐색**: 상단 표시줄에서 모든 설정에 쉽게 접근할 수 있으며, 여러 하위 탭으로 구분됩니다. 모든 항목을 명확한 계층으로 구성하여 클릭이나 탭 횟수를 줄이고 메뉴를 찾아다니는 시간을 최소화합니다.
- **플랫폼 대응**: 데스크톱과 모바일 모두를 위해 설계했으며, 휴대폰과 태블릿 전용 탐색 계층을 제공합니다.
- **유연성**: 전체 테마와 확장 기능을 지원하며, CSS와 팔레트 교체 등을 통해 셸과 사용자 입력 필드를 쉽게 수정할 수 있습니다.

### 기본 제공 콘텐츠와 튜토리얼

SillyBunny는 창작 글쓰기를 바로 시작할 수 있도록 몇 가지 추가 콘텐츠를 기본으로 제공합니다.

- 자세한 SillyBunny 튜토리얼과 LLM Roleplay를 시작하기 위한 일반 가이드.
- 사용자 인터페이스 가이드.
- Guided Generations, Input History, Quick Image Gen, Prompt Inspector, Pathfinder 확장 기능 내장 지원.
- 앱에서 쉽게 설치할 수 있도록 자주 쓰이는 확장 기능을 엄선한 추가 저장소. Dialogue Colors, Summary Sharder, 향상된 매크로 등이 포함됩니다.
- purachina와 Geechan이 만든 Roleplay/스토리 작성용 Chat Completion 프리셋 2개, Geechan이 만든 여러 Text Completion 프리셋과 채팅방 프리셋 1개, TheLonelyDevil이 만든 카드 변환기 프리셋 1개.
- 추가 문의에 도움을 주는 어시스턴트 카드 2개: Bunny Guide와 Assistant Nahida.
- 그 밖에도 더 많은 콘텐츠가 있습니다!

### 성능 개선

SillyBunny는 지원되는 대부분의 클라이언트에서 Node.js 대신 Bun으로 시작하므로 시작 시간과 전반적인 성능을 크게 개선하고 배터리 지속 시간을 늘릴 수 있습니다. Bun을 제대로 지원하지 않는 클라이언트에서는 Node.js도 지원하며, 이 경우에도 전반적인 개선 사항이 적용됩니다.

### 채팅 내 에이전트

SillyBunny는 최신 모델의 강력한 에이전트 기능을 염두에 두고 설계한 에이전트 워크플로를 완전히 지원합니다. 이 시스템은 캐릭터 카드에 직접 연결되며, 필요와 취향에 맞게 완전히 사용자 지정할 수 있습니다. 에이전트는 주 모델의 생성과 나란히 실행되도록 다른 모델에 맡기는 추가 작업이라고 생각하면 됩니다. 이를 통해 최종 출력을 다양한 방식으로 강화하거나 수정할 수 있습니다.

기본적으로 다양한 목적에 맞는 여러 에이전트 템플릿을 포함했습니다. 트래커, 선택지 표시기, 무작위화 도구, 콘텐츠 변경 도구, 문장 다듬기 도구 등이 있습니다. 사용자가 직접 에이전트를 만들 수도 있도록 설계했으며, 실제로 적극 권장합니다!

에이전트는 생성 과정의 여러 단계에 연결할 수 있습니다.

**파이프라인:**

1. **사전 생성 에이전트:** 주 모델이 프롬프트를 읽기 전에 콘텐츠를 생성합니다. 주 프리셋이나 시스템 프롬프트를 수정하지 않고 특정 규칙, 조건, 트래커를 설정할 때 유용합니다.
2. **주 생성:** 모델이 시스템 프롬프트의 내용을 참고하여 주 응답을 생성합니다.
3. **사이드카 에이전트:** 주 생성이 끝난 뒤 옆에 연결되어, 주 생성과 독립적인 추가 해설이나 부가 메모를 제공할 수 있습니다.
4. **사후 생성 에이전트:** 주 출력이 완전히 생성된 후 이를 수정합니다. 생성된 콘텐츠를 한 번 더 처리할 수 있어 문제 수정, 문장 다듬기, 출력 방향 변경에 매우 유용합니다.

### 채팅 모드

**Roleplay**

캐릭터 카드 및 모델과 직접 상호작용할 수 있는 기본 환경입니다. 다른 LLM 프런트엔드를 사용해 본 적이 있다면 익숙하고 편안하게 느껴질 것입니다. 하단 표시줄에서 최근 선택한 채팅을 수정하거나 탐색하는 제어 기능에 쉽게 접근할 수 있습니다.

**Conversation**

Conversation 모드는 캐릭터와 대화할 때 인터넷 메신저 클라이언트를 모방하도록 UI를 바꿉니다. 이에 맞는 시스템 프롬프트와 사용자 인터페이스는 물론, 시간 기반 일정 관리, 상태, 후속 메시지, 메모리 관리, 이미지 생성 지원 등 다양한 기능이 함께 제공됩니다! 기본 Roleplay 모드보다 가볍고 일상적인 환경으로 생각하면 됩니다.

---

## 업스트림 정보

SillyBunny는 SillyTavern의 포크입니다. 업스트림 호환성을 최대한 유지하므로 SillyTavern의 동작, 데이터 형식, 생태계 관련 지식 대부분이 그대로 적용됩니다. SillyBunny에만 해당하는 문제는 이곳에 보고하고, SillyTavern과 관련된 문제는 업스트림에 보고해 주세요.

| 리소스 | 링크 |
|----------|------|
| 업스트림 저장소 | [SillyTavern/SillyTavern](https://github.com/SillyTavern/SillyTavern) |
| 업스트림 문서 | [docs.sillytavern.app](https://docs.sillytavern.app/) |
| 업스트림 Discord | [discord.gg/sillytavern](https://discord.gg/sillytavern) |
| 업스트림 Subreddit | [r/SillyTavernAI](https://reddit.com/r/SillyTavernAI) |

무언가 이상하게 느껴진다면 먼저 업스트림 `release` 브랜치와 비교해 보세요.

## 기여자

- [Platberlitz](https://github.com/platberlitz)
- [Geechan](https://github.com/Geechan)
- [TheLonelyDevil9](https://github.com/TheLonelyDevil9)

[AGPL-3.0에 따라 자유 소프트웨어로 라이선스가 부여됩니다.](https://www.gnu.org/licenses/agpl-3.0.en.html)
