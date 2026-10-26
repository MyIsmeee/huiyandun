// 提交规范见 HYD-PROC-002 §2.2；pre-commit 与 CI-01 共用本配置（CM-05）
const ISSUE_REF = /^(Refs|Closes): #\d+$/m;

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        // CM-03；docs 与 chore(deps) 可不关联 Issue（P-04）
        'issue-ref': ({ type, scope, raw }) => [
          type === 'docs' || (type === 'chore' && scope === 'deps') || ISSUE_REF.test(raw),
          'footer 须包含 Refs: #<issue> 或 Closes: #<issue>（CM-03）',
        ],
        // CM-01；config-conventional 的 subject-full-stop 只拦截英文句号
        'subject-cjk-full-stop': ({ subject }) => [
          !subject?.endsWith('。'),
          'subject 不得以句号结尾（CM-01）',
        ],
      },
    },
  ],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'security', 'perf', 'rules', 'model', 'revert',
        'refactor', 'docs', 'test', 'build', 'ci', 'chore'],
    ],
    'scope-enum': [
      2,
      'always',
      ['api', 'correlator', 'playbook', 'helper', 'evidence', 'audit', 'llm-gw', 'vision',
        'sensor', 'host-agent', 'adapter', 'console', 'contracts', 'rules', 'models',
        'prompts', 'demo', 'deploy', 'ci', 'docs', 'deps'],
    ],
    'subject-max-length': [2, 'always', 72],
    'subject-cjk-full-stop': [2, 'always'],
    'issue-ref': [2, 'always'],
  },
};
