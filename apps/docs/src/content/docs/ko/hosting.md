---
title: 사이트 호스팅
description: Lumen Timeline 공식 문서 사이트를 빌드·검증하고 Cloudflare Workers(lumen-timeline.studiocyf.app) 또는 자체 도메인에 배포하는 방법을 안내합니다.
---

이 문서 사이트는 `apps/docs`에 있는 [Astro Starlight](https://starlight.astro.build) 프로젝트이며, Cloudflare Workers의 정적 에셋으로 `https://lumen-timeline.studiocyf.app`에 배포됩니다.

| 사이트    | 주소                                   | 소스        | 워크플로                     |
| --------- | -------------------------------------- | ----------- | ---------------------------- |
| 공식 문서 | `https://lumen-timeline.studiocyf.app` | `apps/docs` | `.github/workflows/docs.yml` |

## 빌드

```sh
npm run build            # @lumen-timeline/* 워크스페이스 패키지 빌드
npm run docs:dev         # http://localhost:4321
npm run docs:build       # apps/docs/dist 생성
npm run check:docs       # 빌드, 타입 검사, 단위·브라우저 테스트 실행
```

`astro dev`와 `astro build` 실행 전에 `apps/docs/scripts/generate.ts`가 저장소의 원본 문서(`docs/*.md`, `ROADMAP.md`), 패키지 선언(`packages/*/api/index.d.ts`), 벤치마크 기록(`docs/measurements/*.json`)에서 페이지를 생성하므로 사이트 내용이 코드와 어긋나지 않습니다.

빌드 시 `/llms.txt`, `/llms-full.txt`, `/llms-small.txt`와 함께 모든 영문 페이지의 순수 마크다운 사본(예: `/guides/editing.md`, `/index.md`)도 함께 생성됩니다.

## Cloudflare Workers 배포

`apps/docs/wrangler.jsonc`는 `apps/docs/dist`를 정적 에셋으로 배포합니다. Worker 스크립트가 실행되지 않으므로 요청이 무료 플랜의 일일 Worker 호출 한도에 포함되지 않습니다.

로컬에서 배포하려면 먼저 빌드한 뒤 `tools/deploy`에 고정된 Wrangler로 배포합니다.

```sh
npm run build && npm run check:docs
npm ci --prefix tools/deploy --ignore-scripts
npm run deploy:docs
```

`.github/workflows/docs.yml` 워크플로는 아래 설정을 완료하기 전까지 배포를 실행하지 않습니다.

1. Cloudflare API 토큰을 발급합니다. 필요한 최소 권한은 계정의 **Workers Scripts: Edit**와 `studiocyf.app` 존의 **Workers Routes: Edit** 두 가지입니다.
2. GitHub 저장소 설정에서 `cloudflare` 환경을 만들고 배포 브랜치를 `main`으로만 제한합니다. 환경 시크릿으로 `CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID`를 등록합니다.
3. 저장소 변수 `DOCS_SITE`를 `https://lumen-timeline.studiocyf.app`으로 설정합니다. canonical 링크, 사이트맵, `llms.txt`가 이 주소로 생성됩니다.
4. Actions 탭에서 **Docs** 워크플로를 수동(`workflow_dispatch`)으로 한 번 실행해 배포를 확인합니다.
5. 이후 `main` 푸시마다 자동 배포하려면 저장소 변수 `DOCS_DEPLOY`를 `true`로 설정합니다.

### 토큰 보호 구조

- 풀 리퀘스트에서는 배포 워크플로가 실행되지 않으며, 포크 PR에는 환경 시크릿이 전달되지 않습니다.
- 빌드(`build`) 잡과 배포(`deploy`) 잡이 분리되어 있습니다. 빌드 잡은 시크릿 없이 실행되고, 배포 잡은 `tools/deploy/package-lock.json`에 체크섬이 고정된 Wrangler만 `--ignore-scripts`와 `cache: false`로 설치해 업로드된 `docs-site` 아티팩트만 배포합니다.
- 모든 GitHub Action은 커밋 SHA로 고정되어 있으며 `.github/dependabot.yml`이 14일 쿨다운 후 월 1회 갱신 PR을 제안합니다.
- `apps/docs/wrangler.jsonc`에는 `account_id`를 넣지 않으며 `.wrangler/`와 `.dev.vars`는 `.gitignore`에 포함됩니다.

## 자체 도메인 또는 GitHub Pages

포크에서 다른 도메인을 쓰려면 `apps/docs/wrangler.jsonc`의 `routes[0].pattern`과 `DOCS_SITE` 변수를 변경하세요. `workers.dev` 주소를 쓰려면 `routes`를 제거하고 `"workers_dev": true`로 바꿉니다.

Cloudflare DNS 없이 GitHub Pages에 올리려면 `DOCS_SITE=https://<your-host> npm run docs:build`로 빌드한 `apps/docs/dist`를 `actions/upload-pages-artifact`와 `actions/deploy-pages`로 배포할 수 있습니다. 다만 GitHub Pages는 `apps/docs/public/_headers`를 무시합니다.
