const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

function color(on) {
  return on ? (c, s) => `${c}${s}${OFF}` : (_c, s) => s;
}

export function renderText(result, { useColor = process.stdout.isTTY } = {}) {
  const c = color(useColor);
  const lines = [];
  const errors = result.violations.filter((v) => v.severity === 'error');
  const warnings = result.violations.filter((v) => v.severity === 'warn');

  if (!result.violations.length) {
    lines.push(c(GREEN, 'tirithgate: all clear') + c(DIM, ` (run ${result.run_id})`));
    return lines.join('\n');
  }

  const counts = [];
  if (errors.length) counts.push(`${errors.length} problem${errors.length === 1 ? '' : 's'}`);
  if (warnings.length) counts.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);

  const who = result.unit ? `, unit '${result.unit}'` : '';
  lines.push(
    c(BOLD, 'tirithgate: ') + counts.join(', ') + c(DIM, ` (run ${result.run_id}${who})`)
  );
  lines.push('');

  for (const v of result.violations) {
    const tag = v.severity === 'error' ? c(RED, v.code) : c(YELLOW, v.code);
    lines.push(`${tag}  ${v.path ?? ''}`.trimEnd());
    for (const line of wrap(v.message, 74)) lines.push(`       ${line}`);
    if (v.fix) {
      lines.push('');
      for (const line of wrap(`Fix: ${v.fix}`, 74)) lines.push(`       ${c(DIM, line)}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current.length) current = word;
    else if (current.length + 1 + word.length <= width) current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function renderJson(result) {
  return JSON.stringify(result, null, 2);
}

export function renderSarif(result) {
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'tirithgate',
              informationUri: 'https://github.com/GregPat22/tirithgate',
              rules: [...new Set(result.violations.map((v) => v.code))].map((id) => ({ id })),
            },
          },
          results: result.violations.map((v) => ({
            ruleId: v.code,
            level: v.severity === 'error' ? 'error' : 'warning',
            message: { text: v.fix ? `${v.message}\n\nFix: ${v.fix}` : v.message },
            locations: v.path
              ? [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: v.path },
                      region: { startLine: 1 },
                    },
                  },
                ]
              : [],
          })),
        },
      ],
    },
    null,
    2
  );
}

/**
 * Lines GitHub Actions understands, so the problem shows up right on the
 * changed line in the pull request instead of buried in the log.
 */
export function renderAnnotations(result) {
  return result.violations
    .map((v) => {
      const level = v.severity === 'error' ? 'error' : 'warning';
      const where = v.path ? `file=${v.path},line=1,` : '';
      const text = (v.fix ? `${v.message} Fix: ${v.fix}` : v.message).replace(/\n/g, '%0A');
      return `::${level} ${where}title=tirithgate ${v.code}::${text}`;
    })
    .join('\n');
}
