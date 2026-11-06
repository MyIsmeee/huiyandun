# 第三方许可证声明

本文件由 `make licenses` 生成，依赖变化后重新生成并提交，不手工修改。

容器镜像、检测规则、场景资产与 Python 包自带的二进制库，逐项登记在 `deploy/third-party.yaml`
（名称、版本、许可证、用途，C-RU-01）。随产品分发的语言包见下文，许可证由 CI-09 按 HYD-ARCH-001 G-08
白名单检查。

## GPL 组件（独立进程运行）

以下组件以独立进程运行、不修改源码、不与自研代码链接（G-08、C-RU-02）：

| 组件 | 许可证 | 所在镜像 | 用途 |
|---|---|---|---|
| Suricata | GPL-2.0-only | `suricata` | 网络入侵检测（REUSE-08） |
| FFmpeg（GPL 构建） | GPL-2.0-or-later | MediaMTX 镜像（`mediamtx`、`rtsp-target`、`nvr-sim`、`recorder`、`ingest`） | 演示素材推流、持续录像与片段截取 |
| iproute2、ethtool | GPL-2.0 | `capture-tap`（Debian 包） | 配置抓包源的流量镜像 |
| nftables | GPL-2.0 | `privileged-helper`（Debian 包） | 封禁与解封（D-074） |

## 随产品分发的语言包

### Python（`uv.lock` 的运行时依赖）

| 包 | 版本 | 许可证 |
|---|---|---|
| alembic | 1.20.1 | MIT |
| annotated-doc | 0.0.5 | MIT |
| annotated-types | 0.8.0 | MIT |
| anyio | 4.15.1 | MIT |
| asyncpg | 0.32.0 | Apache-2.0 |
| certifi | 2026.10.23 | Mozilla Public License 2.0 (MPL 2.0) |
| cffi | 2.1.1 | MIT-0 |
| charset-normalizer | 3.5.2 | MIT |
| click | 8.5.0 | BSD-3-Clause |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause |
| defusedxml | 0.7.1 | Python Software Foundation License |
| fastapi | 0.162.0 | MIT |
| flatbuffers | 25.12.19 | Apache Software License |
| greenlet | 3.5.6 | MIT AND PSF-2.0 |
| h11 | 0.16.0 | MIT License |
| httpcore2 | 2.16.0 | BSD-3-Clause |
| httpx2 | 2.16.0 | BSD-3-Clause |
| idna | 3.20 | BSD-3-Clause |
| Jinja2 | 3.1.6 | BSD License |
| jiter | 0.18.0 | MIT |
| Mako | 1.4.3 | MIT |
| markdown-it-py | 4.2.0 | MIT License |
| MarkupSafe | 3.0.4 | BSD-3-Clause |
| mdurl | 0.1.2 | MIT License |
| narwhals | 2.28.0 | MIT |
| nats-py | 2.16.0 | Apache-2.0 |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| onnxruntime-gpu | 1.31.1 | MIT License |
| openai | 3.42.0 | Apache-2.0 |
| opencv-python-headless | 5.0.0.93 | Apache Software License |
| opentelemetry-api | 1.45.1 | Apache-2.0 |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| pillow | 13.0.0 | MIT-CMU |
| protobuf | 7.36.2 | 3-Clause BSD License |
| pycparser | 3.12 | BSD-3-Clause |
| pydantic | 2.14.1 | MIT |
| pydantic_core | 2.50.1 | MIT |
| pyDeprecate | 0.13.0 | Apache-2.0 |
| Pygments | 2.21.0 | BSD-2-Clause |
| PyYAML | 6.0.3 | MIT License |
| requests | 2.34.2 | Apache Software License |
| rich | 15.0.0 | MIT License |
| river | 0.26.1 | BSD-3-Clause |
| rtmlib | 0.0.16 | Apache License 2.0 |
| scipy | 1.18.1 | BSD License |
| sniffio | 1.3.1 | Apache Software License; MIT License |
| SQLAlchemy | 2.1.6 | MIT |
| starlette | 1.10.0 | BSD-3-Clause |
| supervision | 0.31.2 | MIT |
| tqdm | 4.70.1 | MPL-2.0 AND MIT |
| trackers | 2.6.1 | Apache Software License |
| truststore | 0.10.5 | MIT |
| typing-inspection | 0.4.4 | MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| urllib3 | 2.8.0 | MIT |
| uvicorn | 0.54.0 | BSD-3-Clause |
| websockets | 17.3 | BSD-3-Clause |

### 前端（`pnpm-lock.yaml` 的 dependencies）

| 包 | 版本 | 许可证 |
|---|---|---|
| @babel/runtime | 7.29.10 | MIT |
| @react-three/fiber | 9.8.2 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-reconciler | 0.28.9 | MIT |
| @types/webxr | 0.5.24 | MIT |
| base64-js | 1.5.1 | MIT |
| buffer | 6.0.3 | MIT |
| csstype | 3.2.3 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |
| its-fine | 2.1.1 | MIT |
| lucide-react | 1.61.0 | ISC |
| react | 19.3.1 | MIT |
| react-dom | 19.3.1 | MIT |
| react-use-measure | 2.1.7 | MIT |
| scheduler | 0.28.0 | MIT |
| suspend-react | 0.1.3 | MIT |
| three | 0.186.1 | MIT |
| use-sync-external-store | 1.7.0 | MIT |
| zustand | 5.0.16 | MIT |

## 构建期依赖（不随产品分发）

只在开发、测试、构建阶段使用，不进入运行镜像，不受 G-08 白名单限制，按 G-08 末句登记。

### Python（`uv.lock` 的 dev 组）

| 包 | 版本 | 许可证 |
|---|---|---|
| argcomplete | 3.7.2 | Apache Software License |
| black | 26.10.1 | MIT |
| cfgv | 3.5.0 | MIT |
| datamodel-code-generator | 0.86.0 | MIT |
| distlib | 0.4.4 | Python Software Foundation License |
| filelock | 4.2.4 | MIT |
| genson | 1.4.0 | MIT License |
| identify | 2.6.20 | MIT |
| inflect | 7.6.0 | MIT |
| iniconfig | 2.3.1 | MIT |
| isort | 8.0.1 | MIT |
| jaraco.functools | 4.6.0 | MIT |
| more-itertools | 11.2.1 | MIT |
| mypy_extensions | 1.1.0 | MIT |
| nodeenv | 1.11.0 | BSD License |
| pathspec | 1.1.1 | Mozilla Public License 2.0 (MPL 2.0) |
| pip-licenses | 5.5.5 | MIT |
| platformdirs | 4.13.5 | MIT |
| pluggy | 1.7.0 | MIT License |
| pre_commit | 4.7.0 | MIT |
| pre_commit_hooks | 6.0.0 | MIT |
| prettytable | 3.18.0 | BSD-3-Clause |
| pytest | 9.1.1 | MIT |
| python-discovery | 1.6.4 | MIT License |
| pytokens | 0.4.1 | MIT License |
| ruamel.yaml | 0.19.1 | MIT License |
| ruff | 0.17.2 | MIT |
| typeguard | 4.6.0 | MIT |
| virtualenv | 21.14.13 | MIT |
| wcwidth | 0.9.4 | MIT License |

### 前端（`pnpm-lock.yaml` 的 devDependencies）

| 包 | 版本 | 许可证 |
|---|---|---|
| @asamuzakjp/css-color | 7.1.9 | MIT |
| @asamuzakjp/dom-selector | 10.0.5 | MIT |
| @babel/code-frame | 7.29.7 | MIT |
| @babel/compat-data | 7.29.7 | MIT |
| @babel/core | 7.29.7 | MIT |
| @babel/generator | 7.29.8 | MIT |
| @babel/helper-compilation-targets | 7.29.7 | MIT |
| @babel/helper-globals | 7.29.7 | MIT |
| @babel/helper-module-imports | 7.29.7 | MIT |
| @babel/helper-module-transforms | 7.29.7 | MIT |
| @babel/helper-string-parser | 7.29.11 | MIT |
| @babel/helper-validator-identifier | 7.29.7 | MIT |
| @babel/helper-validator-option | 7.29.7 | MIT |
| @babel/helpers | 7.29.10 | MIT |
| @babel/parser | 7.29.11 | MIT |
| @babel/runtime | 7.29.10 | MIT |
| @babel/template | 7.29.7 | MIT |
| @babel/traverse | 7.29.10 | MIT |
| @babel/types | 7.29.11 | MIT |
| @bramus/specificity | 2.4.3 | MIT |
| @cacheable/memory | 2.2.0 | MIT |
| @cacheable/utils | 2.5.0 | MIT |
| @csstools/color-helpers | 6.1.2 | MIT-0 |
| @csstools/css-calc | 3.4.3 | MIT |
| @csstools/css-color-parser | 4.2.6 | MIT |
| @csstools/css-parser-algorithms | 4.0.2 | MIT |
| @csstools/css-syntax-patches-for-csstree | 1.1.15 | MIT-0 |
| @csstools/css-tokenizer | 4.0.2 | MIT |
| @dimforge/rapier3d-compat | 0.12.0 | Apache-2.0 |
| @eslint-community/eslint-utils | 4.10.1 | MIT |
| @eslint-community/regexpp | 4.12.2 | MIT |
| @eslint/config-array | 0.23.5 | Apache-2.0 |
| @eslint/config-helpers | 0.7.0 | Apache-2.0 |
| @eslint/core | 1.2.1 | Apache-2.0 |
| @eslint/js | 10.0.1 | MIT |
| @eslint/object-schema | 3.0.5 | Apache-2.0 |
| @eslint/plugin-kit | 0.7.3 | Apache-2.0 |
| @exodus/bytes | 1.16.0 | MIT |
| @humanfs/core | 0.19.2 | Apache-2.0 |
| @humanfs/node | 0.16.8 | Apache-2.0 |
| @humanfs/types | 0.15.0 | Apache-2.0 |
| @humanwhocodes/module-importer | 1.0.1 | Apache-2.0 |
| @humanwhocodes/retry | 0.4.3 | Apache-2.0 |
| @jridgewell/gen-mapping | 0.3.13 | MIT |
| @jridgewell/remapping | 2.3.5 | MIT |
| @jridgewell/resolve-uri | 3.1.2 | MIT |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT |
| @jridgewell/trace-mapping | 0.3.31 | MIT |
| @keyv/bigmap | 1.3.1 | MIT |
| @keyv/serialize | 1.1.1 | MIT |
| @oxc-project/types | 0.155.0 | MIT |
| @playwright/test | 1.64.1 | Apache-2.0 |
| @redocly/ajv | 8.11.2 | MIT |
| @redocly/config | 0.22.0 | MIT |
| @redocly/openapi-core | 1.34.22 | MIT |
| @rolldown/binding-linux-x64-gnu | 1.2.15 | MIT |
| @rolldown/pluginutils | 1.0.1 | MIT |
| @tailwindcss/node | 4.3.3 | MIT |
| @tailwindcss/oxide | 4.3.3 | MIT |
| @tailwindcss/oxide-linux-x64-gnu | 4.3.3 | MIT |
| @tailwindcss/vite | 4.3.3 | MIT |
| @testing-library/dom | 10.4.2 | MIT |
| @testing-library/react | 16.3.3 | MIT |
| @tweenjs/tween.js | 23.1.3 | MIT |
| @types/aria-query | 5.0.4 | MIT |
| @types/chai | 5.2.3 | MIT |
| @types/deep-eql | 4.0.2 | MIT |
| @types/esrecurse | 4.3.1 | MIT |
| @types/estree | 1.0.9 | MIT |
| @types/json-schema | 7.0.15 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-dom | 19.3.0 | MIT |
| @types/stats.js | 0.17.4 | MIT |
| @types/three | 0.186.0 | MIT |
| @types/webxr | 0.5.24 | MIT |
| @typescript-eslint/eslint-plugin | 8.72.0 | MIT |
| @typescript-eslint/parser | 8.72.0 | MIT |
| @typescript-eslint/project-service | 8.72.0 | MIT |
| @typescript-eslint/scope-manager | 8.72.0 | MIT |
| @typescript-eslint/tsconfig-utils | 8.72.0 | MIT |
| @typescript-eslint/type-utils | 8.72.0 | MIT |
| @typescript-eslint/types | 8.72.0 | MIT |
| @typescript-eslint/typescript-estree | 8.72.0 | MIT |
| @typescript-eslint/utils | 8.72.0 | MIT |
| @typescript-eslint/visitor-keys | 8.72.0 | MIT |
| @vitejs/plugin-react | 6.1.2 | MIT |
| @vitest/mocker | 5.0.5 | MIT |
| @vitest/spy | 5.0.5 | MIT |
| acorn | 8.19.0 | MIT |
| acorn-jsx | 5.3.2 | MIT |
| agent-base | 7.1.4 | MIT |
| ajv | 6.15.0 | MIT |
| ansi-colors | 4.1.3 | MIT |
| ansi-regex | 5.0.1 | MIT |
| ansi-styles | 5.2.0 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| aria-query | 5.3.0 | Apache-2.0 |
| assertion-error | 2.0.1 | MIT |
| balanced-match | 1.0.2, 4.0.4 | MIT |
| baseline-browser-mapping | 2.11.33 | Apache-2.0 |
| bidi-js | 1.1.0 | MIT |
| brace-expansion | 2.1.7, 5.0.12 | MIT |
| browserslist | 4.29.4 | MIT |
| cacheable | 2.5.0 | MIT |
| caniuse-lite | 1.0.30001819 | CC-BY-4.0 |
| chai | 6.3.0 | MIT |
| change-case | 5.4.4 | MIT |
| colorette | 1.4.0 | MIT |
| convert-source-map | 2.0.0 | MIT |
| cross-spawn | 7.0.6 | MIT |
| css-tree | 3.2.1 | MIT |
| csstype | 3.2.3 | MIT |
| data-urls | 8.0.0 | MIT |
| debug | 4.4.3 | MIT |
| decimal.js | 10.6.0 | MIT |
| deep-is | 0.1.4 | MIT |
| dequal | 2.0.3 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| dom-accessibility-api | 0.5.16 | MIT |
| electron-to-chromium | 1.5.464 | ISC |
| enhanced-resolve | 5.26.0 | MIT |
| entities | 8.1.0 | BSD-2-Clause |
| es-module-lexer | 2.3.2 | MIT |
| escalade | 3.2.0 | MIT |
| escape-string-regexp | 4.0.0 | MIT |
| eslint | 10.13.0 | MIT |
| eslint-plugin-react-hooks | 7.1.1 | MIT |
| eslint-scope | 9.1.2 | BSD-2-Clause |
| eslint-visitor-keys | 3.4.3, 5.0.1 | Apache-2.0 |
| espree | 11.2.0 | BSD-2-Clause |
| esquery | 1.7.0 | BSD-3-Clause |
| esrecurse | 4.3.0 | BSD-2-Clause |
| estraverse | 5.3.0 | BSD-2-Clause |
| estree-walker | 3.0.3 | MIT |
| esutils | 2.0.3 | BSD-2-Clause |
| expect-type | 1.4.0 | Apache-2.0 |
| fast-deep-equal | 3.1.3 | MIT |
| fast-json-stable-stringify | 2.1.0 | MIT |
| fast-levenshtein | 2.0.6 | MIT |
| fdir | 6.5.0 | MIT |
| fflate | 0.8.3 | MIT |
| file-entry-cache | 11.1.5 | MIT |
| find-up | 5.0.0 | MIT |
| flat-cache | 6.1.23 | MIT |
| flatted | 3.4.4 | ISC |
| gensync | 1.0.0-beta.2 | MIT |
| glob-parent | 6.0.2 | ISC |
| globals | 17.13.0 | MIT |
| graceful-fs | 4.2.11 | ISC |
| hashery | 1.5.1 | MIT |
| hermes-estree | 0.25.1 | MIT |
| hermes-parser | 0.25.1 | MIT |
| hookified | 1.15.1, 2.2.0 | MIT |
| html-encoding-sniffer | 7.0.0 | MIT |
| https-proxy-agent | 7.0.6 | MIT |
| ignore | 5.3.2, 7.0.14 | MIT |
| imurmurhash | 0.1.4 | MIT |
| index-to-position | 1.2.0 | MIT |
| is-extglob | 2.1.1 | MIT |
| is-glob | 4.0.3 | MIT |
| is-potential-custom-element-name | 1.0.1 | MIT |
| isexe | 2.0.0 | ISC |
| jiti | 2.7.0 | MIT |
| js-levenshtein | 1.1.6 | MIT |
| js-tokens | 4.0.0 | MIT |
| js-yaml | 4.3.2 | MIT |
| jsdom | 30.1.3 | MIT |
| jsesc | 3.1.0 | MIT |
| json-schema-traverse | 0.4.1, 1.0.0 | MIT |
| json-stable-stringify-without-jsonify | 1.0.1 | MIT |
| json5 | 2.2.3 | MIT |
| keyv | 5.6.0 | MIT |
| levn | 0.4.1 | MIT |
| lightningcss | 1.32.0, 1.33.0 | MPL-2.0 |
| lightningcss-linux-x64-gnu | 1.32.0, 1.33.0 | MPL-2.0 |
| locate-path | 6.0.0 | MIT |
| lru-cache | 5.1.1 | ISC |
| lru-cache | 11.5.3 | BlueOak-1.0.0 |
| lz-string | 1.5.0 | MIT |
| magic-string | 0.30.21, 1.4.4 | MIT |
| mdn-data | 2.27.1 | CC0-1.0 |
| meshoptimizer | 1.1.1 | MIT |
| minimatch | 5.1.9 | ISC |
| minimatch | 10.2.6 | BlueOak-1.0.0 |
| ms | 2.1.3 | MIT |
| nanoid | 3.3.20 | MIT |
| natural-compare | 1.4.0 | MIT |
| node-releases | 2.0.60 | MIT |
| obug | 3.0.0 | MIT |
| openapi-typescript | 7.13.0 | MIT |
| optionator | 0.9.4 | MIT |
| p-limit | 3.1.0 | MIT |
| p-locate | 5.0.0 | MIT |
| parse-json | 8.3.0 | MIT |
| parse5 | 8.0.1 | MIT |
| path-exists | 4.0.0 | MIT |
| path-key | 3.1.1 | MIT |
| picocolors | 1.1.1 | ISC |
| picomatch | 4.0.7 | MIT |
| playwright | 1.64.1 | Apache-2.0 |
| playwright-core | 1.64.1 | Apache-2.0 |
| pluralize | 8.0.0 | MIT |
| postcss | 8.5.31 | MIT |
| prelude-ls | 1.2.1 | MIT |
| pretty-format | 27.5.1 | MIT |
| punycode | 2.3.1 | MIT |
| qified | 0.10.1 | MIT |
| react | 19.3.1 | MIT |
| react-dom | 19.3.1 | MIT |
| react-is | 17.0.2 | MIT |
| require-from-string | 2.0.2 | MIT |
| rolldown | 1.2.15 | MIT |
| saxes | 6.0.0 | ISC |
| scheduler | 0.28.0 | MIT |
| semver | 6.3.1, 7.8.5 | ISC |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| source-map-js | 1.2.2 | BSD-3-Clause |
| std-env | 4.3.0 | MIT |
| supports-color | 10.2.2 | MIT |
| tailwindcss | 4.3.3 | MIT |
| tapable | 2.3.3 | MIT |
| tinybench | 6.2.2 | MIT |
| tinyexec | 1.3.1 | MIT |
| tinyglobby | 0.2.17 | MIT |
| tldts | 7.4.19 | MIT |
| tldts-core | 7.4.19 | MIT |
| tough-cookie | 6.0.2 | BSD-3-Clause |
| tr46 | 7.0.0 | MIT |
| ts-api-utils | 2.5.0 | MIT |
| type-check | 0.4.0 | MIT |
| type-fest | 4.41.0 | (MIT OR CC0-1.0) |
| typescript | 5.9.3 | Apache-2.0 |
| typescript-eslint | 8.72.0 | MIT |
| undici | 8.12.3 | MIT |
| update-browserslist-db | 1.3.4 | MIT |
| uri-js | 4.4.1 | BSD-2-Clause |
| uri-js-replace | 1.0.2 | MIT |
| vite | 8.3.5 | MIT |
| vitest | 5.0.5 | MIT |
| w3c-xmlserializer | 6.0.0 | MIT |
| webidl-conversions | 8.0.1 | BSD-2-Clause |
| whatwg-mimetype | 5.0.0 | MIT |
| whatwg-url | 17.3.0 | MIT |
| which | 2.0.2 | ISC |
| why-is-node-running | 3.2.1 | MIT |
| word-wrap | 1.2.5 | MIT |
| xml-name-validator | 5.0.0 | Apache-2.0 |
| xmlchars | 2.2.0 | MIT |
| yallist | 3.1.1 | ISC |
| yaml-ast-parser | 0.0.43 | Apache-2.0 |
| yargs-parser | 21.1.1 | ISC |
| yocto-queue | 0.1.0 | MIT |
| zod | 4.6.7 | MIT |
| zod-validation-error | 4.0.2 | MIT |
