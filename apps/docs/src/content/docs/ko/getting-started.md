---
title: 시작하기
description: Lumen Timeline 워크스페이스를 받아 빌드하고 브라우저 예제를 실행하며 첫 타임라인을 마운트하는 방법을 안내합니다.
---

Lumen Timeline은 첫 npm 릴리스를 검증하는 마일스톤 6을 준비 중이며, 현재 워크스페이스 저장소에서 개발되고 있습니다. 여덟 개 패키지는 모두 엄격한 TypeScript로 작성되어 [tsrs](https://github.com/oxc-project/tsrs)로 ES 모듈과 타입 선언을 생성합니다.

## 저장소 받아 빌드하기

Node 26(`.node-version` 참고)이 필요합니다.

```sh
git clone https://github.com/kjmin-dev/lumen-timeline && cd lumen-timeline
npm ci
npm run check
```

`npm ci`는 워크스페이스를 연결하고 `tsrs -b`로 각 패키지의 `dist/`를 빌드합니다. `npm run check`는 포맷(`oxfmt`), 타입 인식 린트(`oxlint`), 빌드, 소스·빌드 양쪽 단위 테스트, `tsrs`/`tsc` 동등성 검사, 공개 API 스냅샷 검증, 마크다운 링크 검사를 한 번에 실행합니다.

## 인터랙티브 예제 실행

```sh
npm run example:vanilla
```

출력된 로컬 주소로 접속하면 외부 미디어 서버 없이 세 가지 워크스페이스를 바로 실행해 볼 수 있습니다.

- **비디오 더빙 워크스페이스** (`/examples/vanilla/index.html`) — 기준 비디오, 화자별 트랙, 대사 목록 및 구간 재생, 후보 테이크 오디션, 웨이브폼, 시뮬레이션 테이크 생성기.
- **오디오 전용 워크스페이스** (`/examples/vanilla/audio.html`) — 오디오 출력 클록, 겹치는 트랙, 저장된 마커 및 마커 통과 이벤트.
- **공유 세션** (`/examples/sync/index.html`) — 여러 탭에서 열면 `@lumen-timeline/sync`가 `BroadcastChannel`과 Web Lock 리더 인계로 편집 내용을 동기화합니다.

## 최소 연동 예시

바닐라 JavaScript로 마운트하거나, 같은 `editor`와 `transport`를 [React](/ko/frameworks/react/), [Svelte](/ko/frameworks/svelte/), [SolidJS](/ko/frameworks/solid/), [Vue](/ko/frameworks/vue/) 래퍼에 그대로 전달할 수 있습니다.

```js
import { commands, createEditor, unitsToTicks } from "@lumen-timeline/core";
import { createAudioTransport } from "@lumen-timeline/media";
import { mountTimeline } from "@lumen-timeline/timeline";
import "@lumen-timeline/timeline/style.css";

const sec = (n) => unitsToTicks(n, 1);
const editor = createEditor({
  project: {
    schemaVersion: 1,
    duration: sec(30),
    tracks: [{ id: "voice", name: "Voice", overlap: "exclusive" }],
    clips: [
      {
        id: "line-1",
        name: "Opening line",
        trackId: "voice",
        kind: "audio",
        start: sec(2),
        duration: sec(4),
        contentIn: 0,
        takeIds: ["take-a"],
        activeTakeId: "take-a",
      },
    ],
    takes: [
      {
        id: "take-a",
        label: "Take 1",
        assetId: "voice-a",
        streamId: "mono",
        sourceAtContentZero: 0,
      },
    ],
  },
});

const context = new AudioContext({ sampleRate: 48000 });
const transport = createAudioTransport({ editor, context, catalog, resolveBuffer });
const view = mountTimeline(document.querySelector("#timeline"), { editor, transport });

// 포인터 제스처, 키보드, 호스트 패널 모두 동일한 트랜잭션 커맨드를 사용합니다.
editor.dispatch(commands.splitClip({ clipId: "line-1", at: sec(4) }));
editor.history.undo();
```

## 다음에 볼 것

- [코어 아키텍처](/ko/architecture/core/): 패키지 경계, 트랜잭션 커밋 프로토콜, 재생 스케줄링 (영문)
- [헤드리스 클립 편집](/ko/guides/editing/): 이동·트림·분할·마커·테이크·디스패치 게이트 (영문)
- [타임라인 뷰와 렌더링](/ko/guides/timeline-view/): WebGL2·WebGPU·Canvas 2D 렌더링과 디바이스 손실 복구 (영문)
- [프레임워크 래퍼](/ko/frameworks/overview/): React 19, Svelte 5, SolidJS 2, Vue 3 래퍼 규격과 벤치마크 (영문)
- [전체 패키지](/ko/packages/): 여덟 개 패키지의 런타임 경계와 공개 API 목록 (영문)
